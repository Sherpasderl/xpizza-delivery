'use strict';
// PLAN-3a-marketing-server r0 §3 (advisor APPROVED 2026-11-14; steps 1–2) — the portal «Marketing» OFFER endpoints' decisions.
// Thin HTTPS wrappers live in marketing/functions.js; every decision is here, dependency-injected.
//
//   getMarketing            GET  ?rid=                                        marketing.read → { switches, offers }
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
//                                           offer is active; rewritten for EVERY branch by every state write (so a crash between the
//                                           record and the mirror heals on the next one; the read reports live_drift meanwhile)
// Owner-only data is never logged; no PII is read or returned.
const crypto = require('crypto');
const { can } = require('../access/membership');
const { isBrandId } = require('../brands/brand-model');
const { verifiedContext, accessFor } = require('../portal/ops-core');   // the portal's ONE token check + rid → access (503 / 403)
const CFG = require('./config');
const OM = require('./offer-model');

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

// an item-offer's dish keys must be on EVERY listed branch's live menu (the catalog mirror, through its one reader)
async function dishProblem(deps, value) {
  if (value.type !== 'bogo') return null;
  if (OM.usesCats(value)) return reply(409, { error: 'cats_not_supported' });   // the category → key source is not sourced yet (§3.3)
  for (const rid of value.branches) {
    let m;
    try { m = await deps.readMirror(rid); } catch (_) { return UNAVAILABLE(); }
    const menu = isObj(m) && isObj(m.menu) ? m.menu : null;
    if (!menu) return reply(409, { error: 'menu_unavailable', rid });
    const missing = value.params.items.filter((k) => !Object.prototype.hasOwnProperty.call(menu, k));
    if (missing.length) return reply(400, { error: 'bad_request', field: 'params', reason: 'unknown_dish', rid });
  }
  return null;
}

// activation-time checks against each branch's live set: MAX_LIVE and the overlap rule (names of the clashing offers, no ids)
async function liveProblem(deps, offerId, value) {
  for (const rid of value.branches) {
    let live;
    try { live = (await val(deps.db, livePath(rid))) || {}; } catch (_) { return UNAVAILABLE(); }
    const others = Object.entries(isObj(live) ? live : {}).filter(([id, r]) => id !== offerId && isObj(r));
    if (others.length >= OM.LIMITS.live_max) return reply(409, { error: 'too_many_live', rid });
    const mine = new Set(OM.dishesOf(value));
    if (!mine.size) continue;
    const clash = others.filter(([, r]) => OM.dishesOf(r).some((k) => mine.has(k)) && isObj(r.schedule)
      && OM.schedulesOverlap(value.schedule, { start: r.schedule.start ?? null, end: r.schedule.end ?? null, days: r.schedule.days || [], window: r.schedule.window ?? null }));
    if (clash.length) return reply(409, { error: 'overlap', rid, with: clash.map(([, r]) => r.name).filter((n) => typeof n === 'string').sort() });
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

// the mirrors of one record, for EVERY branch it names now and every branch it named before → one multi-path update
async function writeMirrors(db, brandId, offerId, rec, prevBranches = []) {
  const up = {};
  const active = rec.state === 'active';
  for (const rid of new Set([...prevBranches, ...rec.branches])) {
    up[`${livePath(rid)}/${offerId}`] = active && rec.branches.includes(rid) ? OM.liveProjection(rec, brandId) : null;
  }
  try { await db.ref().update(up); return true; } catch (_) { return false; }
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
  if (!switches.offers_enabled) return reply(200, { ok: true, switches, offers: [] });
  let all, live;
  try { [all, live] = await Promise.all([val(db, offersPath(a.access.brandId)), val(db, livePath(rid))]); } catch (_) { return UNAVAILABLE(); }
  const t = now();
  const offers = Object.entries(isObj(all) ? all : {})
    .filter(([id, rec]) => OM.OFFER_ID_RE.test(id) && OM.recordOk(rec, opts) && rec.branches.includes(rid))
    .map(([id, rec]) => {
      const m = isObj(live) ? live[id] : undefined;
      const drift = rec.state === 'active' ? !(isObj(m) && m.rev === rec.rev) : m !== undefined && m !== null;
      return { ...offerView(id, rec, t), ...(drift ? { live_drift: true } : {}) };
    })
    .sort((x, y) => (y.updated_at - x.updated_at) || (x.id < y.id ? -1 : 1));
  return reply(200, { ok: true, switches, offers });
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
  const value = v.value;
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  const dish = await dishProblem(deps, value);
  if (dish) return dish;
  const t = now();
  const offerId = creating ? newOfferId() : body.offer_id;
  let prune = [];
  if (creating) {   // the brand's bound (every state counts) + Q4: ended offers older than 180 days leave with this write
    let all;
    try { all = (await val(db, offersPath(brandId))) || {}; } catch (_) { return UNAVAILABLE(); }
    const entries = Object.entries(isObj(all) ? all : {});
    prune = entries.filter(([, r]) => isObj(r) && r.state === 'ended' && Number.isSafeInteger(r.updated_at) && t - r.updated_at > OM.LIMITS.ended_retain_ms).map(([id]) => id);
    if (entries.length - prune.length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  }
  let prevRec = null;
  if (!creating) {   // an active / paused offer: the live-edit allowlist is checked against the record the CAS will see
    try { prevRec = await val(db, `${offersPath(brandId)}/${offerId}`); } catch (_) { return UNAVAILABLE(); }
    if (isObj(prevRec) && (prevRec.state === 'active' || prevRec.state === 'paused_owner')) {
      const live = await liveProblem(deps, offerId, value);   // a raised cap / later end can never create an overlap, but keep one rule
      if (live && live.body.error !== 'too_many_live') return live;
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
  if (w.rec.state === 'active' && !(await writeMirrors(db, brandId, offerId, w.rec, isObj(prevRec) ? prevRec.branches : []))) return UNAVAILABLE();
  if (prune.length) { try { await db.ref().update(Object.fromEntries(prune.map((id) => [`${offersPath(brandId)}/${id}`, null]))); } catch (_) { /* retried by the next create */ } }
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
  const value = OM.authoredOf(pre, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  const t = now();
  if (body.to === 'active') {   // publish / resume: the schedule is still ahead, the dishes are on the menu, no overlap, under MAX_LIVE
    if (pre.state === 'draft') { const p = OM.validatePublishable(value, t); if (!p.ok) return reply(400, { error: 'bad_request', field: p.field, reason: p.reason }); }
    if (pre.state === 'paused_owner' && value.schedule.end !== null && value.schedule.end <= t) return reply(409, { error: 'ended' });
    const dish = await dishProblem(deps, value);
    if (dish) return dish;
    const live = await liveProblem(deps, body.offer_id, value);
    if (live) return live;
  }
  const w = await casWrite(db, path, body.expected_rev, (cur, d) => {
    if (cur === null) { d.why = 'not_found'; return undefined; }
    if (!OM.recordOk(cur, opts)) { d.why = 'current_malformed'; return undefined; }
    if (!MOVES[cur.state].includes(body.to)) { d.why = 'bad_transition'; return undefined; }
    d.why = 'write';
    const next = { ...cur, state: body.to, rev: cur.rev + 1, updated_at: t };
    if (body.to === 'ended') next.ended_reason = 'owner'; else delete next.ended_reason;
    return next;
  });
  if (w.fail) return w.fail;
  if (!(await writeMirrors(db, brandId, body.offer_id, w.rec, value.branches))) return UNAVAILABLE();
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
  const entries = Object.entries(all);
  const prune = entries.filter(([, r]) => isObj(r) && r.state === 'ended' && Number.isSafeInteger(r.updated_at) && t - r.updated_at > OM.LIMITS.ended_retain_ms).map(([id]) => id);
  if (entries.length - prune.length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  const offerId = newOfferId();
  const draft = { ...value, schedule: { ...value.schedule, start: null, end: null } };
  const w = await casWrite(db, `${offersPath(brandId)}/${offerId}`, 0, (cur, d) => {
    d.why = 'write';
    return OM.stripNulls({ v: 1, rev: 1, ...draft, state: 'draft', repeated_from: body.offer_id, created_by: ctx.uid, created_at: t, updated_at: t });
  });
  if (w.fail) return w.fail;
  if (prune.length) { try { await db.ref().update(Object.fromEntries(prune.filter((id) => id !== body.offer_id).map((id) => [`${offersPath(brandId)}/${id}`, null]))); } catch (_) { /* retried by the next create */ } }
  return reply(200, { ok: true, offer: offerView(offerId, w.rec, t) });
}

module.exports = { getMarketingCore, marketingOfferSaveCore, marketingOfferSetStateCore, marketingOfferRepeatCore, MOVES, newOfferId };
