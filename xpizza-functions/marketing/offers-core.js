'use strict';
// PLAN-3a-marketing-server r0 §3 (advisor APPROVED 2026-11-14; steps 1–2) — the portal «Marketing» OFFER endpoints' decisions.
// Thin HTTPS wrappers live in marketing/functions.js; every decision is here, dependency-injected.
//
//   getMarketing            GET  ?rid=                                        marketing.read → { switches, offers, bookings }
//   marketingOfferSave      POST { rid, offer_id?, expected_rev, offer }      marketing.edit → create (expected_rev 0) / edit
//   marketingOfferSetState  POST { rid, offer_id, to, expected_rev }          marketing.edit → publish / pause / resume / end
//   marketingOfferRepeat    POST { rid, offer_id }                            marketing.edit → a new draft from an ended offer
//
// AUTHORIZATION: a verified ID token (customer / handheld refused before any read — portal/ops-core verifiedContext), then
// resolveAccess per rid, then can(access, 'marketing.read' | 'marketing.edit'). An offer naming several branches needs
// marketing.edit at EVERY one of them (Q1: owner only — discounts are money); each must be a MEMBER location of the caller's brand.
// SWITCH: platform_config/marketing.offers_enabled, read fail-closed per request. OFF ⇒ every write 409 offers_disabled with
// nothing written, and the read states the switches with empty lists (one config read after auth).
// STORAGE (server-only, rules closed):
//   marketing_offers/{brandId}/{offerId} — the authored record; every write is ONE transaction with a rev CAS (Q3)
//   marketing_live/{rid}/{offerId}       — the price path's compact record (offer-model liveProjection), present only while the
//                                           offer is active. The overlap rule and MAX_LIVE are judged INSIDE a per-branch transaction on
//                                           this node (mirrorActive) — the authority; a refused activation puts the record back. A crash
//                                           between the record and its mirror leaves it un-applied (live_drift in the read; healed on the next write)
// Owner-only data is never logged; no PII is read or returned.
const crypto = require('crypto');
const { can } = require('../access/membership');
const { isBrandId } = require('../brands/brand-model');
const { verifiedContext, accessFor } = require('../portal/ops-core');   // the portal's ONE token check + rid → access (503 / 403)
const CFG = require('./config');
const OM = require('./offer-model');
const AM = require('./anuncio-model');

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { error: 'unavailable', retryable: true });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();
const opts = { isRid: isBrandId };
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const newOfferId = () => `o_${Array.from(crypto.randomBytes(12), (b) => B32[b & 31]).join('')}`;
const offersPath = (brandId) => `marketing_offers/${brandId}`;
const livePath = (rid) => `marketing_live/${rid}`;

// token + the anchor rid + one capability → { ctx, access } | { fail }
async function admit(deps, req, rid, cap) {
  const v = await verifiedContext({ verifyIdToken: deps.verifyIdToken }, req);
  if (v.fail) return { fail: v.fail };
  const r = await accessFor(deps.db, v.ctx, rid);
  if (r.fail) return { fail: r.fail };
  if (!can(r.access, cap)) return { fail: reply(403, { error: 'not_authorized' }) };
  return { ctx: v.ctx, access: r.access };
}

// every branch: marketing.edit there, a MEMBER location of the anchor's brand → null | the reply
async function authorizeBranches(deps, ctx, brandId, branches) {
  for (const rid of branches) {
    const r = await accessFor(deps.db, ctx, rid);
    if (r.fail) return r.fail;
    if (!can(r.access, 'marketing.edit') || r.access.brandId !== brandId) return reply(403, { error: 'not_authorized' });
    if (r.access.state !== 'member') return reply(409, { error: 'branch_not_live', rid });
  }
  return null;
}

// An item-offer's dishes → { value } (a category offer with its dishes RESOLVED) | { fail }.
//  · by dish: every key on EVERY listed branch's live menu (the catalog mirror, through its one reader);
//  · by category (advisor 11-14): each category resolved on EVERY branch from its ACTIVE catalog version (deps.readCategoryMenu — one
//    version read per branch, only on a portal save / publish, never on the price path or the read); the union of the dishes is
//    stored as params.items, FROZEN until the next save / publish.
async function resolveDishes(deps, value) {
  if (value.type !== 'bogo') return { value };
  if (OM.usesCats(value)) {
    const all = new Set();
    for (const rid of value.branches) {
      let menu;
      try { menu = await deps.readCategoryMenu(rid); } catch (_) { return { fail: UNAVAILABLE() }; }
      const r = OM.resolveCats(menu, value.params.cats);
      if (!r.ok) return { fail: reply(400, { error: 'bad_request', field: 'params', reason: r.reason, rid }) };
      for (const k of r.items) all.add(k);
    }
    if (all.size > OM.LIMITS.cat_items_max) return { fail: reply(409, { error: 'category_too_large' }) };
    return { value: { ...value, params: { cats: value.params.cats, items: [...all].sort(), free_per_order: value.params.free_per_order } } };
  }
  for (const rid of value.branches) {
    let m;
    try { m = await deps.readMirror(rid); } catch (_) { return { fail: UNAVAILABLE() }; }
    const menu = isObj(m) && isObj(m.menu) ? m.menu : null;
    if (!menu) return { fail: reply(409, { error: 'menu_unavailable', rid }) };
    const missing = value.params.items.filter((k) => !Object.prototype.hasOwnProperty.call(menu, k));
    if (missing.length) return { fail: reply(400, { error: 'bad_request', field: 'params', reason: 'unknown_dish', rid }) };
  }
  return { value };
}

// THE live judgement — ONE rule, used by the cheap pre-check AND inside the per-branch transaction: this offer against one branch's
// CURRENT live set → null | { error: 'too_many_live' } | { error: 'overlap', with: [names] } (names of the clashing offers, no ids)
function liveJudgement(offerId, value, live) {
  const others = Object.entries(isObj(live) ? live : {}).filter(([id, r]) => id !== offerId && isObj(r));
  if (others.length >= OM.LIMITS.live_max) return { error: 'too_many_live' };
  const mine = new Set(OM.dishesOf(value));
  if (!mine.size) return null;
  const clash = others.filter(([, r]) => OM.dishesOf(r).some((k) => mine.has(k)) && isObj(r.schedule)
    && OM.schedulesOverlap(value.schedule, { start: r.schedule.start ?? null, end: r.schedule.end ?? null, days: r.schedule.days || [], window: r.schedule.window ?? null }));
  return clash.length ? { error: 'overlap', with: clash.map(([, r]) => r.name).filter((n) => typeof n === 'string').sort() } : null;
}
const judgementReply = (v, rid) => reply(409, { error: v.error, rid, ...(v.with ? { with: v.with } : {}) });

// the PRE-check (no write): refuse early, before the record moves, when a branch's live set already says no. Not the authority —
// mirrorActive re-judges inside each branch's transaction.
async function liveProblem(deps, offerId, value) {
  for (const rid of value.branches) {
    let live;
    try { live = await val(deps.db, livePath(rid)); } catch (_) { return UNAVAILABLE(); }
    const v = liveJudgement(offerId, value, live);
    if (v) return judgementReply(v, rid);
  }
  return null;
}

// ONE transaction on the record: `decide(cur)` → { why, next? } ; rev CAS against expected_rev. → { why, rec } | { fail }
async function casWrite(db, path, expectedRev, decide) {
  let last = null;
  let tx;
  try {
    tx = await db.ref(path).transaction((cur) => {
      const d = { why: null, current: null };
      last = d;
      if (cur === null) {   // the speculative null-first pass (or a truly absent record)
        if (expectedRev !== 0) { d.why = 'stale_null'; return null; }
        const out = decide(null, d);
        return out === undefined ? undefined : out;
      }
      if (!isObj(cur) || !Number.isSafeInteger(cur.rev)) { d.why = 'current_malformed'; return undefined; }
      if (cur.rev !== expectedRev) { d.why = 'superseded'; d.current = cur.rev; return undefined; }
      return decide(cur, d);
    });
  } catch (_) {
    return { fail: UNAVAILABLE() };
  }
  const why = last && last.why;
  const s = tx && tx.snapshot ? tx.snapshot.val() : null;
  if (why === 'superseded') return { fail: reply(409, { error: 'superseded', current_rev: last.current }) };
  if (why === 'stale_null') return { fail: s === null ? reply(404, { error: 'not_found' }) : UNAVAILABLE() };
  if (why === 'current_malformed') return { fail: reply(409, { error: 'current_malformed' }) };
  if (why !== 'write') return { fail: reply(409, { error: why || 'refused', ...(last && last.field ? { field: last.field } : {}) }) };
  if (!tx.committed || !isObj(s) || s.rev !== expectedRev + 1) return { fail: UNAVAILABLE() };
  return { rec: s };
}

// An ACTIVE record's mirrors — THE AUTHORITY on MAX_LIVE and the overlap rule (advisor 11-14, rule 5): per branch, ONE transaction on
// marketing_live/{rid} judges the CURRENT live set and adds this offer only when it passes, so two simultaneous publishes on a branch
// serialize on that node and cannot both pass. A refusal (or an outage) removes what this call already added (only entries still at
// this rev). Branches the offer no longer names lose their entry. → null | the 409 judgement | 503
async function mirrorActive(db, brandId, offerId, rec, prevBranches = []) {
  const value = OM.authoredOf(rec, opts);
  const proj = OM.liveProjection(rec, brandId);
  if (!(await unmirror(db, offerId, prevBranches.filter((rid) => !rec.branches.includes(rid))))) return UNAVAILABLE();
  const done = [];
  for (const rid of rec.branches) {
    let last = null;
    let tx;
    try {
      tx = await db.ref(livePath(rid)).transaction((cur) => {
        const d = { verdict: null };
        last = d;
        const v = liveJudgement(offerId, value, cur);
        if (v) { d.verdict = v; return undefined; }
        return { ...(isObj(cur) ? cur : {}), [offerId]: proj };
      });
    } catch (_) { await unmirror(db, offerId, done, rec.rev); return UNAVAILABLE(); }
    if (last && last.verdict) { await unmirror(db, offerId, done, rec.rev); return judgementReply(last.verdict, rid); }
    if (!tx || !tx.committed) { await unmirror(db, offerId, done, rec.rev); return UNAVAILABLE(); }
    done.push(rid);
  }
  return null;
}
// remove this offer's entry on each branch (when `rev` is given: only an entry still at that rev — never a newer write's) → ok
async function unmirror(db, offerId, rids, rev = null) {
  try {
    for (const rid of rids) {
      await db.ref(`${livePath(rid)}/${offerId}`).transaction((cur) => {
        if (cur === null) return null;   // the null-first pass: commits only if the server is null too, else re-runs on the entry
        return rev === null || (isObj(cur) && cur.rev === rev) ? null : undefined;
      });
    }
    return true;
  } catch (_) { return false; }
}
// after the record CAS: active ⇒ the judged mirrors, else every branch's entry removed. A refused activation puts the record BACK to
// what it was (a second CAS on the new rev) and answers the judgement with the record's current rev; a failed undo is a 503 (the
// record is active with no mirror — never applied by the price path; the read reports live_drift).
async function settleMirrors(db, brandId, path, offerId, rec, before, t) {
  const prevBranches = isObj(before) && Array.isArray(before.branches) ? before.branches : [];
  if (rec.state !== 'active') return (await unmirror(db, offerId, [...new Set([...prevBranches, ...rec.branches])])) ? null : UNAVAILABLE();
  const refused = await mirrorActive(db, brandId, offerId, rec, prevBranches);
  if (!refused) return null;
  if (refused.status !== 409) return refused;
  const undo = await casWrite(db, path, rec.rev, (cur, d) => { d.why = 'write'; return { ...before, rev: cur.rev + 1, updated_at: t }; });
  if (undo.fail) return UNAVAILABLE();
  if (undo.rec.state === 'active' && (await mirrorActive(db, brandId, offerId, undo.rec, rec.branches))) return UNAVAILABLE();   // a live edit undone: its old mirrors back
  return reply(409, { ...refused.body, current_rev: undo.rec.rev });
}

// Q4: the brand's ended offers older than 180 days (by their last write) — removed by the next create, in ONE update of the brand node
const endedToPrune = (all, t) => Object.entries(isObj(all) ? all : {})
  .filter(([, r]) => isObj(r) && r.state === 'ended' && Number.isSafeInteger(r.updated_at) && t - r.updated_at > OM.LIMITS.ended_retain_ms).map(([id]) => id);
async function pruneEnded(db, brandId, ids) {
  if (!ids.length) return;
  try { await db.ref(offersPath(brandId)).update(Object.fromEntries(ids.map((id) => [id, null]))); } catch (_) { /* retried by the next create */ }
}

const bodyOf = (req) => (isObj(req && req.body) ? req.body : {});
const offerView = (id, rec, nowMs) => ({
  id, rev: rec.rev, state: rec.state, status: OM.statusOf(rec, nowMs),
  ...OM.authoredOf(rec, opts),
  created_at: rec.created_at, updated_at: rec.updated_at,
  ...(rec.ended_reason ? { ended_reason: rec.ended_reason } : {}), ...(rec.repeated_from ? { repeated_from: rec.repeated_from } : {}),
});

// ── getMarketing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function getMarketingCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const rid = isObj(req.query) ? req.query.rid : undefined;
  if (!isBrandId(rid)) return reply(400, { error: 'bad_rid' });
  const a = await admit(deps, req, rid, 'marketing.read');
  if (a.fail) return a.fail;
  const cfg = await CFG.readMarketingConfig(db);
  const switches = CFG.switchesOf(cfg);   // ALWAYS stated; a failed / malformed config read states all three OFF
  if (!switches.offers_enabled && !switches.anuncio_enabled) return reply(200, { ok: true, switches, offers: [], bookings: [] });
  let all, live, booked;
  try {
    [all, live, booked] = await Promise.all([
      switches.offers_enabled ? val(db, offersPath(a.access.brandId)) : null, switches.offers_enabled ? val(db, livePath(rid)) : null,
      switches.anuncio_enabled ? val(db, `anuncio_bookings/${rid}`) : null]);
  } catch (_) { return UNAVAILABLE(); }
  const t = now();
  // this branch's Anuncio bookings (≤ 12): the derived status, the price agreed, the deadline, the days not shown — no charge field exists
  const bookings = Object.entries(isObj(booked) ? booked : {})
    .filter(([id, b]) => AM.BOOKING_ID_RE.test(id) && isObj(b) && AM.WEEK_RE.test(String(b.week)))
    .map(([id, b]) => ({ id, week: b.week, status: AM.bookingStatus(b, t), price_cents: b.price_cents, cancel_deadline: b.cancel_deadline, hidden_days: AM.hiddenDays(b) }))
    .sort((x, y) => (x.week < y.week ? 1 : x.week > y.week ? -1 : 0));
  const offers = Object.entries(isObj(all) ? all : {})
    .filter(([id, rec]) => OM.OFFER_ID_RE.test(id) && OM.recordOk(rec, opts) && rec.branches.includes(rid))
    .map(([id, rec]) => {
      const m = isObj(live) ? live[id] : undefined;
      const drift = rec.state === 'active' ? !(isObj(m) && m.rev === rec.rev) : m !== undefined && m !== null;
      return { ...offerView(id, rec, t), ...(drift ? { live_drift: true } : {}) };
    })
    .sort((x, y) => (y.updated_at - x.updated_at) || (x.id < y.id ? -1 : 1));
  return reply(200, { ok: true, switches, offers, bookings });
}

// the shared head of every write: method, anchor rid, auth (marketing.edit), the switch → { ctx, access, body } | { fail }
async function writeHead(deps, req) {
  if (!req || req.method !== 'POST') return { fail: reply(405, { error: 'method_not_allowed' }) };
  const body = bodyOf(req);
  if (!isBrandId(body.rid)) return { fail: reply(400, { error: 'bad_rid' }) };
  const a = await admit(deps, req, body.rid, 'marketing.edit');
  if (a.fail) return a;
  const cfg = await CFG.readMarketingConfig(deps.db);
  if (cfg.unavailable) return { fail: UNAVAILABLE() };
  if (cfg.offers_enabled !== true) return { fail: reply(409, { error: 'offers_disabled' }) };
  return { ctx: a.ctx, access: a.access, body };
}

// ── marketingOfferSave ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function marketingOfferSaveCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  const h = await writeHead(deps, req);
  if (h.fail) return h.fail;
  const { body, ctx } = h;
  const brandId = h.access.brandId;
  const creating = body.offer_id === undefined;
  if (!creating && !OM.OFFER_ID_RE.test(body.offer_id)) return reply(400, { error: 'bad_request', field: 'offer_id' });
  if (!Number.isSafeInteger(body.expected_rev) || body.expected_rev < 0 || (creating !== (body.expected_rev === 0))) return reply(400, { error: 'bad_request', field: 'expected_rev' });
  const v = OM.validateAuthored(body.offer, opts);
  if (!v.ok) return reply(400, { error: 'bad_request', field: v.field, reason: v.reason });
  const denied = await authorizeBranches(deps, ctx, brandId, v.value.branches);
  if (denied) return denied;
  const dish = await resolveDishes(deps, v.value);
  if (dish.fail) return dish.fail;
  const value = dish.value;
  const t = now();
  const offerId = creating ? newOfferId() : body.offer_id;
  let prune = [];
  if (creating) {   // the brand's bound (every state counts) + Q4: ended offers older than 180 days leave with this write
    let all;
    try { all = (await val(db, offersPath(brandId))) || {}; } catch (_) { return UNAVAILABLE(); }
    prune = endedToPrune(all, t);
    if (Object.keys(isObj(all) ? all : {}).length - prune.length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  }
  let prevRec = null;
  if (!creating) {   // an active / paused offer: the live-edit allowlist is checked against the record the CAS will see
    try { prevRec = await val(db, `${offersPath(brandId)}/${offerId}`); } catch (_) { return UNAVAILABLE(); }
    if (isObj(prevRec) && (prevRec.state === 'active' || prevRec.state === 'paused_owner')) {
      const live = await liveProblem(deps, offerId, value);   // a later end CAN create an overlap: the same judgement as a publish
      if (live) return live;
    }
  }
  const w = await casWrite(db, `${offersPath(brandId)}/${offerId}`, body.expected_rev, (cur, d) => {
    if (cur === null) {
      d.why = 'write';
      return OM.stripNulls({ v: 1, rev: 1, ...value, state: 'draft', created_by: ctx.uid, created_at: t, updated_at: t });
    }
    if (!OM.recordOk(cur, opts)) { d.why = 'current_malformed'; return undefined; }
    if (cur.state === 'ended') { d.why = 'ended'; return undefined; }
    if (cur.state !== 'draft') {
      const p = OM.liveEditProblem(OM.authoredOf(cur, opts), value);
      if (p) { d.why = 'live_edit_not_allowed'; d.field = p; return undefined; }
    }
    d.why = 'write';
    return OM.stripNulls({ ...cur, ...value, schedule: value.schedule, caps: value.caps, rev: cur.rev + 1, updated_at: t });
  });
  if (w.fail) return w.fail;
  if (w.rec.state === 'active') { const m = await settleMirrors(db, brandId, `${offersPath(brandId)}/${offerId}`, offerId, w.rec, prevRec, t); if (m) return m; }
  await pruneEnded(db, brandId, prune);
  return reply(200, { ok: true, offer: offerView(offerId, w.rec, t) });
}

// ── marketingOfferSetState ─────────────────────────────────────────────────────────────────────────────────────────────────
// to: 'active' (publish a draft, or resume a paused offer) | 'paused_owner' | 'ended'
const MOVES = Object.freeze({ draft: ['active', 'ended'], active: ['paused_owner', 'ended'], paused_owner: ['active', 'ended'], ended: [] });
async function marketingOfferSetStateCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  const h = await writeHead(deps, req);
  if (h.fail) return h.fail;
  const { body, ctx } = h;
  const brandId = h.access.brandId;
  if (!OM.OFFER_ID_RE.test(body.offer_id)) return reply(400, { error: 'bad_request', field: 'offer_id' });
  if (!['active', 'paused_owner', 'ended'].includes(body.to)) return reply(400, { error: 'bad_request', field: 'to' });
  if (!Number.isSafeInteger(body.expected_rev) || body.expected_rev < 1) return reply(400, { error: 'bad_request', field: 'expected_rev' });
  const path = `${offersPath(brandId)}/${body.offer_id}`;
  let pre;
  try { pre = await val(db, path); } catch (_) { return UNAVAILABLE(); }
  if (pre === null) return reply(404, { error: 'not_found' });
  if (!OM.recordOk(pre, opts)) return reply(409, { error: 'current_malformed' });
  let value = OM.authoredOf(pre, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  const t = now();
  if (body.to === 'active') {   // publish / resume: the schedule is still ahead, the dishes are on the menu, no overlap, under MAX_LIVE
    if (pre.state === 'draft') { const p = OM.validatePublishable(value, t); if (!p.ok) return reply(400, { error: 'bad_request', field: p.field, reason: p.reason }); }
    if (pre.state === 'paused_owner' && value.schedule.end !== null && value.schedule.end <= t) return reply(409, { error: 'ended' });
    const dish = await resolveDishes(deps, value);   // a category offer is RE-RESOLVED at publish / resume (frozen from here)
    if (dish.fail) return dish.fail;
    value = dish.value;
    const live = await liveProblem(deps, body.offer_id, value);
    if (live) return live;
  }
  // PAUSE / END (advisor 11-14, 5f's price-plan review): the price path loses the offer BEFORE its record says so. A failed removal is
  // a 503 with the record unchanged (still active, still applied — consistent); never a paused / ended record whose mirror still prices.
  // A lost CAS after the removal leaves an active record with no mirror: never applied, reported as live_drift, healed by the next write.
  if (body.to !== 'active' && MOVES[pre.state].includes(body.to) && !(await unmirror(db, body.offer_id, value.branches))) return UNAVAILABLE();
  const w = await casWrite(db, path, body.expected_rev, (cur, d) => {
    if (cur === null) { d.why = 'not_found'; return undefined; }
    if (!OM.recordOk(cur, opts)) { d.why = 'current_malformed'; return undefined; }
    if (!MOVES[cur.state].includes(body.to)) { d.why = 'bad_transition'; return undefined; }
    d.why = 'write';
    const next = { ...cur, state: body.to, rev: cur.rev + 1, updated_at: t, ...(body.to === 'active' ? { params: value.params } : {}) };
    if (body.to === 'ended') next.ended_reason = 'owner'; else delete next.ended_reason;
    return next;
  });
  if (w.fail) return w.fail;
  const m = await settleMirrors(db, brandId, path, body.offer_id, w.rec, pre, t);
  if (m) return m;
  return reply(200, { ok: true, offer: offerView(body.offer_id, w.rec, t) });
}

// ── marketingOfferRepeat («Repetir») ────────────────────────────────────────────────────────────────────────────────────────
// A NEW draft from an ended offer (by state, or by schedule): the same set-up, the dates cleared (the builder asks for new ones).
async function marketingOfferRepeatCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  const h = await writeHead(deps, req);
  if (h.fail) return h.fail;
  const { body, ctx } = h;
  const brandId = h.access.brandId;
  if (!OM.OFFER_ID_RE.test(body.offer_id)) return reply(400, { error: 'bad_request', field: 'offer_id' });
  let all;
  try { all = (await val(db, offersPath(brandId))) || {}; } catch (_) { return UNAVAILABLE(); }
  const src = isObj(all) ? all[body.offer_id] : null;
  if (src == null) return reply(404, { error: 'not_found' });
  if (!OM.recordOk(src, opts)) return reply(409, { error: 'current_malformed' });
  const t = now();
  if (OM.statusOf(src, t) !== 'ended') return reply(409, { error: 'not_ended' });
  const value = OM.authoredOf(src, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  const prune = endedToPrune(all, t).filter((id) => id !== body.offer_id);   // never the offer being repeated
  if (Object.keys(all).length - prune.length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  const offerId = newOfferId();
  const draft = { ...value, schedule: { ...value.schedule, start: null, end: null } };
  const w = await casWrite(db, `${offersPath(brandId)}/${offerId}`, 0, (cur, d) => {
    d.why = 'write';
    return OM.stripNulls({ v: 1, rev: 1, ...draft, state: 'draft', repeated_from: body.offer_id, created_by: ctx.uid, created_at: t, updated_at: t });
  });
  if (w.fail) return w.fail;
  await pruneEnded(db, brandId, prune);
  return reply(200, { ok: true, offer: offerView(offerId, w.rec, t) });
}

module.exports = { getMarketingCore, marketingOfferSaveCore, marketingOfferSetStateCore, marketingOfferRepeatCore, MOVES, newOfferId, admit };   // admit: the marketing endpoints' ONE token → rid → capability check (anuncio-core)
