'use strict';
// PLAN-3a-marketing-server r0 §3 (advisor APPROVED 2026-11-14; steps 1–2) — the portal «Marketing» OFFER endpoints' decisions.
// Thin HTTPS wrappers live in marketing/functions.js; every decision is here, dependency-injected.
//
//   getMarketing            GET  ?rid=                                                    marketing.read → { switches, offers, bookings }
//   marketingOfferSave      POST { rid, offer_id?, expected_rev, offer, op_id?, program? }  marketing.edit → create (expected_rev 0) / edit
//   marketingOfferSetState  POST { rid, offer_id, to, expected_rev }                      marketing.edit → publish / pause / resume / end
//   marketingOfferRepeat    POST { rid, source_id | offer_id, op_id?, program?, schedule? } marketing.edit → a copy of an ended offer
//
// AUTHORIZATION: a verified ID token (customer / handheld refused before any read — portal/ops-core verifiedContext), then
// resolveAccess per rid, then can(access, 'marketing.read' | 'marketing.edit'). An offer naming several branches needs
// marketing.edit at EVERY one of them (Q1: owner only — discounts are money); each must be a MEMBER location of the caller's brand.
// SWITCH: platform_config/marketing.offers_enabled, read fail-closed per request. OFF ⇒ every write 409 offers_disabled with
// nothing written, and the read states the switches with empty lists (one config read after auth).
// STORAGE (server-only, rules closed) — PLAN-3a-marketing-brand-root r3 (advisor ruling: co-locate; one root cause): ONE root per
// restaurant (brand), so EVERY owner action is ONE transaction that writes the record, its mirror and its op claim together — or nothing:
//   marketing_brand/{brandId}/offers/{offerId}      the authored record (rev CAS)
//   marketing_brand/{brandId}/live/{rid}/{offerId}  the price path's compact record (offer-model liveProjection) while the offer is
//                                                   active, else a tombstone { removed, rev } (readers: offers-serve, 5f offer-wire)
//   marketing_brand/{brandId}/ops/{op_id}           the idempotency claim { offer_id, kind, at, source_id?, refused? } (7-day TTL)
// Async work (auth, the switch, branch authorization, dish resolution, shape validation) runs BEFORE the transaction; inside, a PURE step
// decides on the CURRENT node: the claim (replay / conflict), the record CAS + moves, the judgement (duplicate FIRST, then the overlap
// per branch and MAX_LIVE), then writes everything or aborts with nothing written. A refused op_id create / repeat writes ONLY its claim
// (carrying the refusal), so a retry answers the same 409 and no record ever exists for it.
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
const brandPath = (brandId) => `marketing_brand/${brandId}`;

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

// THE live judgement — ONE rule, inside the brand transaction: this offer against one branch's CURRENT live
// set → null | { error: 'too_many_live' } | { error: 'overlap', with: [names] } (names of the clashing offers, no ids). A tombstone is
// never live; this offer's OWN entry is never judged (an edit may overlap itself).
// LIVE = a projection (never a tombstone) whose schedule has not ENDED at server time `t`: nothing flips an offer past its end, so an
// expired entry never holds a branch slot or clashes (portal-ui / advisor 11-14)
const isLive = (e, t) => isObj(e) && e.removed !== true && !(isObj(e.schedule) && Number.isSafeInteger(e.schedule.end) && e.schedule.end <= t);
function liveJudgement(offerId, value, live, t) {
  const others = Object.entries(isObj(live) ? live : {}).filter(([id, r]) => id !== offerId && isLive(r, t));
  if (others.length >= OM.LIMITS.live_max) return { error: 'too_many_live' };
  const mine = new Set(OM.dishesOf(value));
  if (!mine.size) return null;
  const clash = others.filter(([, r]) => OM.dishesOf(r).some((k) => mine.has(k)) && isObj(r.schedule)
    && OM.schedulesOverlap(value.schedule, { start: r.schedule.start ?? null, end: r.schedule.end ?? null, days: r.schedule.days || [], window: r.schedule.window ?? null }));
  return clash.length ? { error: 'overlap', with: clash.map(([, r]) => r.name).filter((n) => typeof n === 'string').sort() } : null;
}
const judgementReply = (v, rid) => reply(409, { error: v.error, rid, ...(v.with ? { with: v.with } : {}), ...(v.offer_id ? { offer_id: v.offer_id } : {}) });
// THE duplicate backstop (advisor 11-14, the portal's single-call Ofertas): another offer of the restaurant already programmed or active with
// the SAME kind, params and branch set and an OVERLAPPING schedule ⇒ { error: 'duplicate', offer_id }. Judged on the WHOLE brand node (the
// branch set is only visible there), inside the brand txn — two racing tabs cannot both pass. → the other offer's id | null
const canon = (v) => (Array.isArray(v) ? `[${(v.every((x) => !isObj(x) && !Array.isArray(x)) ? [...v].sort() : v).map(canon).join(',')}]` :   // set-valued params (items, cats) normalised: order never matters
   isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
// both sides through the STORED params rule (a «sin mínimo» envío is stored params-less: RTDB drops {}) — Codex brand-root r1 P2-1
const paramsKey = (type, p) => canon(OM.paramsOf(type, p, true));
function duplicateOf(all, offerId, proj, branches, schedule, t) {
  const held = {};
  for (const [rid, m] of Object.entries(isObj(all) ? all : {})) {
    for (const [id, e] of Object.entries(isObj(m) ? m : {})) {
      if (id === offerId || !isLive(e, t)) continue;
      (held[id] = held[id] || { rids: new Set(), e }).rids.add(rid);
    }
  }
  const mine = new Set(branches);
  for (const [id, h] of Object.entries(held)) {
    const e = h.e;
    if (e.type !== proj.type || paramsKey(e.type, e.params) !== paramsKey(proj.type, proj.params) || h.rids.size !== mine.size || ![...mine].every((r) => h.rids.has(r)) || !isObj(e.schedule)) continue;
    if (OM.schedulesOverlap(schedule, { start: e.schedule.start ?? null, end: e.schedule.end ?? null, days: e.schedule.days || [], window: e.schedule.window ?? null })) return id;
  }
  return null;
}


// ── the ONE brand transaction ──────────────────────────────────────────────────────────────────────────────────────────────
// `step(node)` is PURE: → { next, result } (commit `next`, answer `result`) | { abort } (write nothing, answer `abort`). The SDK's cold
// first run sees null: an abort there returns null (a no-op that commits only if the server is null too), never `undefined`.
const OP_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OP_TTL_MS = 7 * 86400000;
const isOpId = (v) => typeof v === 'string' && OP_RE.test(v);   // a STRING first
const OP_CONFLICT = () => reply(409, { error: 'op_id_conflict' });
const OPS_MAX = 200;   // live claims per brand — the brand txn stays bounded under a burst (Codex brand-root r1 P2-2)
const TOO_MANY_PENDING = () => reply(429, { error: 'too_many_pending' });
// THE one way a claim is written: expired claims leave first (on EVERY claiming txn, a refusal-only one included); past OPS_MAX live
// claims ⇒ the 429 to abort with (nothing written) | null
function putClaim(next, opId, claim, t) {
  for (const [k, c] of Object.entries(next.ops)) if (!liveClaim(c, t)) delete next.ops[k];
  if (!Object.prototype.hasOwnProperty.call(next.ops, opId) && Object.keys(next.ops).length >= OPS_MAX) return TOO_MANY_PENDING();
  next.ops[opId] = claim;
  return null;
}
async function brandTxn(db, brandId, step) {
  let out = null;
  let tx;
  try {
    tx = await db.ref(brandPath(brandId)).transaction((cur) => {
      out = step(isObj(cur) ? cur : {});
      if (out.abort) return cur === null ? null : undefined;
      return out.next;
    });
  } catch (_) { return UNAVAILABLE(); }
  if (!out) return UNAVAILABLE();
  if (out.abort) return out.abort;
  if (!(tx && tx.committed)) return UNAVAILABLE();
  return out.result;
}
// a copy of the node the step may change (never the transaction's own input)
const draftNode = (node) => ({ ...node, offers: { ...(isObj(node.offers) ? node.offers : {}) }, live: { ...(isObj(node.live) ? node.live : {}) }, ops: { ...(isObj(node.ops) ? node.ops : {}) } });
const liveClaim = (c, t) => isObj(c) && OM.OFFER_ID_RE.test(String(c.offer_id)) && Number.isSafeInteger(c.at) && t - c.at < OP_TTL_MS;
// the claim for `opId` → null (none / expired) | { replay } | { abort } (another kind / source)
function claimCheck(node, opId, kind, sourceId, t) {
  if (opId === undefined) return null;
  const c = isObj(node.ops) ? node.ops[opId] : null;
  if (!liveClaim(c, t)) return null;
  if (c.kind !== kind || (kind === 'repeat' && c.source_id !== sourceId)) return { abort: OP_CONFLICT() };
  if (isObj(c.refused)) return { abort: refusedReply(c.refused) };
  const rec = isObj(node.offers) ? node.offers[c.offer_id] : null;
  if (isObj(rec) && OM.recordOk(rec, opts)) return { abort: reply(200, { ok: true, offer: offerView(c.offer_id, rec, t) }) };
  return null;   // a claim whose record is gone (pruned): a fresh call
}
const refusedReply = (r) => reply(409, { error: r.error, ...(r.rid ? { rid: r.rid } : {}), ...(r.with ? { with: r.with } : {}), ...(r.offer_id ? { offer_id: r.offer_id } : {}) });
// the record `rec` of `offerId` going active — THE judgement on the whole brand's current live set: the DUPLICATE first (it needs the
// branch set, visible only here), then each branch's overlap + MAX_LIVE → null | { verdict, rid }
function judgeActive(node, brandId, offerId, rec, t) {
  const value = OM.authoredOf(rec, opts);
  const proj = OM.liveProjection(rec, brandId);
  const all = isObj(node.live) ? node.live : {};
  const dup = duplicateOf(all, offerId, proj, value.branches, value.schedule, t);
  if (dup) return { verdict: { error: 'duplicate', offer_id: dup }, rid: value.branches[0] };
  for (const rid of value.branches) { const v = liveJudgement(offerId, value, all[rid], t); if (v) return { verdict: v, rid }; }
  return null;
}
// write the record AND its mirror into `next` (one step): active ⇒ the projection on its branches + a tombstone on every other branch it
// held; otherwise a tombstone on every branch it names or held. Expired claims and pruned offers (ended > 180 days, with their entries) leave.
function writeOffer(next, brandId, offerId, rec, t, keep = []) {
  next.offers[offerId] = OM.stripNulls(rec);
  const held = Object.keys(next.live).filter((rid) => isObj(next.live[rid]) && next.live[rid][offerId] != null);
  for (const rid of new Set([...rec.branches, ...held])) {
    const proj = rec.state === 'active' && rec.branches.includes(rid) ? OM.liveProjection(rec, brandId) : null;   // null for a v1-unsupported type
    next.live[rid] = { ...(isObj(next.live[rid]) ? next.live[rid] : {}), [offerId]: proj || { removed: true, rev: rec.rev } };
  }
  for (const id of endedToPrune(next.offers, t).filter((x) => x !== offerId && !keep.includes(x))) {
    delete next.offers[id];
    for (const rid of Object.keys(next.live)) if (isObj(next.live[rid]) && next.live[rid][id] != null) { next.live[rid] = { ...next.live[rid] }; delete next.live[rid][id]; }
  }
  for (const [k, c] of Object.entries(next.ops)) if (!liveClaim(c, t)) delete next.ops[k];
  tidyExpired(next, t);
}
// every committing brand txn tombstones the expired projections it sees (at their own rev; a later genuine edit is a higher rev)
function tidyExpired(next, t) {
  for (const [rid, m] of Object.entries(next.live)) {
    if (!isObj(m)) continue;
    for (const [id, e] of Object.entries(m)) {
      if (isObj(e) && e.removed !== true && !isLive(e, t)) { next.live[rid] = { ...next.live[rid], [id]: { removed: true, rev: e.rev } }; }
    }
  }
}
const endedToPrune = (offers, t) => Object.entries(isObj(offers) ? offers : {})
  .filter(([, r]) => isObj(r) && r.state === 'ended' && Number.isSafeInteger(r.updated_at) && t - r.updated_at > OM.LIMITS.ended_retain_ms).map(([id]) => id);
const bodyOf = (req) => (isObj(req && req.body) ? req.body : {});
const offerView = (id, rec, nowMs) => ({
  id, rev: rec.rev, state: rec.state, status: OM.statusOf(rec, nowMs),
  ...OM.authoredOf(rec, opts),
  created_at: rec.created_at, updated_at: rec.updated_at,
  ...(rec.ended_reason ? { ended_reason: rec.ended_reason } : {}), ...(rec.repeated_from ? { repeated_from: rec.repeated_from } : {}),
  ...(rec.state === 'paused_owner' && Number.isSafeInteger(rec.paused_at) ? { paused_at: rec.paused_at } : {}),
});
// a refusal of a NEW offer under an op_id: only the claim is written, carrying it (its retry answers the same 409); else nothing
function refuse(node, opId, kind, sourceId, offerId, verdict, rid, t) {
  const why = { error: verdict.error, rid, ...(verdict.with ? { with: verdict.with } : {}), ...(verdict.offer_id ? { offer_id: verdict.offer_id } : {}) };
  if (opId === undefined) return { abort: refusedReply(why) };
  const next = draftNode(node);
  const full = putClaim(next, opId, { offer_id: offerId, kind, at: t, ...(kind === 'repeat' ? { source_id: sourceId } : {}), refused: why }, t);
  if (full) return { abort: full };
  tidyExpired(next, t);
  return { next, result: refusedReply(why) };
}

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
  let node, booked;
  try {
    [node, booked] = await Promise.all([switches.offers_enabled ? val(db, brandPath(a.access.brandId)) : null,
      switches.anuncio_enabled ? val(db, `anuncio_bookings/${rid}`) : null]);
  } catch (_) { return UNAVAILABLE(); }
  const t = now();
  // this branch's Anuncio bookings (≤ 12): the derived status, the price agreed, the deadline, the days not shown — no charge field exists
  const bookings = Object.entries(isObj(booked) ? booked : {})
    .filter(([id, b]) => AM.BOOKING_ID_RE.test(id) && isObj(b) && b.void !== true && AM.WEEK_RE.test(String(b.week)))   // a void (a released orphan's marker) is never listed
    .map(([id, b]) => ({ id, week: b.week, status: AM.bookingStatus(b, t), price_cents: b.price_cents, cancel_deadline: b.cancel_deadline, hidden_days: AM.hiddenDays(b) }))
    .sort((x, y) => (x.week < y.week ? 1 : x.week > y.week ? -1 : 0));
  const all = isObj(node) && isObj(node.offers) ? node.offers : {};
  const live = isObj(node) && isObj(node.live) && isObj(node.live[rid]) ? node.live[rid] : {};
  const offers = Object.entries(all)
    .filter(([id, rec]) => OM.OFFER_ID_RE.test(id) && OM.recordOk(rec, opts) && rec.branches.includes(rid))
    .map(([id, rec]) => {
      // a read-only consistency flag (the record and its mirror are written together, so it should never be set): an alert if it is
      const m = live[id];
      const drift = rec.state === 'active' && OM.statusOf(rec, t) !== 'ended' ? !(isObj(m) && m.removed !== true && m.rev === rec.rev) : isLive(m, t);   // ended by schedule: no projection expected
      if (drift) console.warn('marketing_live_drift', JSON.stringify({ offer: id, rev: rec.rev, mirror_rev: isObj(m) ? m.rev : null }));
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
  if (!creating && !(typeof body.offer_id === 'string' && OM.OFFER_ID_RE.test(body.offer_id))) return reply(400, { error: 'bad_request', field: 'offer_id' });
  if (!Number.isSafeInteger(body.expected_rev) || body.expected_rev < 0 || (creating !== (body.expected_rev === 0))) return reply(400, { error: 'bad_request', field: 'expected_rev' });
  if (body.op_id !== undefined && (!creating || !isOpId(body.op_id))) return reply(400, { error: 'bad_request', field: 'op_id' });
  if (body.program !== undefined && body.program !== true) return reply(400, { error: 'bad_request', field: 'program' });
  const program = body.program === true;   // the portal's single-call Ofertas: save AND program in ONE operation (all or nothing)
  const v = OM.validateAuthored(body.offer, opts);
  if (!v.ok) return reply(400, { error: 'bad_request', field: v.field, reason: v.reason });
  const denied = await authorizeBranches(deps, ctx, brandId, v.value.branches);
  if (denied) return denied;
  const dish = await resolveDishes(deps, v.value);
  // a CLAIMED create answers its replay first: a preparation failure (a dish left the menu after a lost reply) waits for the claim
  // check inside the txn (Codex brand-root r1 P2-3)
  if (dish.fail && !(creating && body.op_id !== undefined)) return dish.fail;
  const value = dish.value;
  const t = now();
  const proposed = creating ? newOfferId() : body.offer_id;
  return brandTxn(db, brandId, (node) => {
    if (creating) { const c = claimCheck(node, body.op_id, 'create', null, t); if (c) return c; }   // the replay FIRST (before any validation)
    if (dish.fail) return { abort: dish.fail };   // no replay: the deferred preparation failure
    const cur = isObj(node.offers) ? node.offers[proposed] : null;
    let rec;
    if (creating) {
      if (cur != null) return { abort: reply(409, { error: 'superseded' }) };
      const keep = endedToPrune(node.offers, t);
      if (Object.keys(isObj(node.offers) ? node.offers : {}).length - keep.length >= OM.LIMITS.offers_max) return { abort: reply(409, { error: 'too_many_offers' }) };
      rec = { v: 1, rev: 1, ...value, state: program ? 'active' : 'draft', created_by: ctx.uid, created_at: t, updated_at: t };
    } else {
      if (cur === null || cur === undefined) return { abort: reply(404, { error: 'not_found' }) };
      if (!OM.recordOk(cur, opts)) return { abort: reply(409, { error: 'current_malformed' }) };
      if (cur.rev !== body.expected_rev) return { abort: reply(409, { error: 'superseded', current_rev: cur.rev }) };
      if (cur.state === 'ended') return { abort: reply(409, { error: 'ended' }) };
      if (cur.state !== 'draft') { const p = OM.liveEditProblem(OM.authoredOf(cur, opts), value); if (p) return { abort: reply(409, { error: 'live_edit_not_allowed', field: p }) }; }
      rec = { ...cur, ...value, schedule: value.schedule, rev: cur.rev + 1, updated_at: t };
      delete rec.caps;   // v1: an old record's caps leave on its next save
      if (program && cur.state !== 'active') { rec.state = 'active'; delete rec.paused_at; }   // update AND program in ONE write
    }
    // program: the publish validation applies to a record being PROGRAMMED (a create, a draft, a paused one) — never to a live edit
    if (program && !(isObj(cur) && cur.state === 'active')) { const pub = OM.validatePublishable(value, t); if (!pub.ok) return { abort: reply(400, { error: 'bad_request', field: pub.field, reason: pub.reason }) }; }
    rec = OM.stripNulls(rec);
    if (rec.state === 'active') {
      const j = judgeActive(node, brandId, proposed, rec, t);
      if (j) return creating ? refuse(node, body.op_id, 'create', null, proposed, j.verdict, j.rid, t) : { abort: judgementReply(j.verdict, j.rid) };
    }
    const next = draftNode(node);
    writeOffer(next, brandId, proposed, rec, t);
    if (creating && body.op_id !== undefined) { const full = putClaim(next, body.op_id, { offer_id: proposed, kind: 'create', at: t }, t); if (full) return { abort: full }; }
    return { next, result: reply(200, { ok: true, offer: offerView(proposed, rec, t) }) };
  });
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
  if (!(typeof body.offer_id === 'string' && OM.OFFER_ID_RE.test(body.offer_id))) return reply(400, { error: 'bad_request', field: 'offer_id' });
  if (!['active', 'paused_owner', 'ended'].includes(body.to)) return reply(400, { error: 'bad_request', field: 'to' });
  if (!Number.isSafeInteger(body.expected_rev) || body.expected_rev < 1) return reply(400, { error: 'bad_request', field: 'expected_rev' });
  let pre;   // read for the async work only (authorization, dish resolution); the transaction re-decides on the CURRENT record
  try { pre = await val(db, `${brandPath(brandId)}/offers/${body.offer_id}`); } catch (_) { return UNAVAILABLE(); }
  if (pre === null) return reply(404, { error: 'not_found' });
  if (!OM.recordOk(pre, opts)) return reply(409, { error: 'current_malformed' });
  let value = OM.authoredOf(pre, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  const t = now();
  if (body.to === 'active') {   // a category offer is RE-RESOLVED at publish / resume (frozen from here)
    const dish = await resolveDishes(deps, value);
    if (dish.fail) return dish.fail;
    value = dish.value;
  }
  return brandTxn(db, brandId, (node) => {
    const cur = isObj(node.offers) ? node.offers[body.offer_id] : null;
    if (cur === null || cur === undefined) return { abort: reply(404, { error: 'not_found' }) };
    if (!OM.recordOk(cur, opts)) return { abort: reply(409, { error: 'current_malformed' }) };
    if (cur.rev !== body.expected_rev) return { abort: reply(409, { error: 'superseded', current_rev: cur.rev }) };
    if (cur.rev !== pre.rev) return { abort: reply(409, { error: 'superseded', current_rev: cur.rev }) };
    if (!MOVES[cur.state].includes(body.to)) return { abort: reply(409, { error: 'bad_transition' }) };
    if (body.to === 'active') {   // publish / resume: the schedule is still ahead (a draft), a paused offer not past its end
      if (!OM.typeSupported(cur.type)) return { abort: reply(409, { error: 'type_not_supported' }) };   // an old envío record (owner 11-15)
      if (cur.state === 'draft') { const p = OM.validatePublishable(OM.authoredOf(cur, opts), t); if (!p.ok) return { abort: reply(400, { error: 'bad_request', field: p.field, reason: p.reason }) }; }
      if (cur.state === 'paused_owner' && cur.schedule.end != null && cur.schedule.end <= t) return { abort: reply(409, { error: 'ended' }) };
    }
    const rec = { ...cur, state: body.to, rev: cur.rev + 1, updated_at: t, ...(body.to === 'active' ? { params: value.params } : {}) };
    if (body.to === 'ended') rec.ended_reason = 'owner'; else delete rec.ended_reason;
    if (body.to === 'paused_owner') rec.paused_at = t; else delete rec.paused_at;   // «Pausada por vos el …» (server time); resume / end clear it
    if (rec.state === 'active') { const j = judgeActive(node, brandId, body.offer_id, rec, t); if (j) return { abort: judgementReply(j.verdict, j.rid) }; }
    const next = draftNode(node);
    writeOffer(next, brandId, body.offer_id, rec, t);
    return { next, result: reply(200, { ok: true, offer: offerView(body.offer_id, rec, t) }) };
  });
}

// ── marketingOfferRepeat («Repetir») ────────────────────────────────────────────────────────────────────────────────────────
// A copy of an ended offer (by state, or by schedule): the same set-up. Without program: a draft, the dates cleared (the builder asks
// for new ones). With program + schedule: copied, dated and programmed in ONE operation (all or nothing).
async function marketingOfferRepeatCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  const h = await writeHead(deps, req);
  if (h.fail) return h.fail;
  const { body, ctx } = h;
  const brandId = h.access.brandId;
  if ((body.source_id === undefined) === (body.offer_id === undefined)) return reply(400, { error: 'bad_request', field: 'source_id' });
  const sourceId = body.source_id !== undefined ? body.source_id : body.offer_id;
  if (!(typeof sourceId === 'string' && OM.OFFER_ID_RE.test(sourceId))) return reply(400, { error: 'bad_request', field: 'source_id' });
  if (body.op_id !== undefined && !isOpId(body.op_id)) return reply(400, { error: 'bad_request', field: 'op_id' });
  if (body.program !== undefined && body.program !== true) return reply(400, { error: 'bad_request', field: 'program' });
  const program = body.program === true;
  if (program !== (body.schedule !== undefined)) return reply(400, { error: 'bad_request', field: 'schedule' });
  let src;
  try { src = await val(db, `${brandPath(brandId)}/offers/${sourceId}`); } catch (_) { return UNAVAILABLE(); }
  if (src == null) return reply(404, { error: 'not_found' });
  if (!OM.recordOk(src, opts)) return reply(409, { error: 'current_malformed' });
  const t = now();
  const value = OM.authoredOf(src, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  if (!OM.typeSupported(value.type)) return reply(400, { error: 'bad_request', field: 'type', reason: 'type_not_supported' });   // never repeat an old envío
  // program: the FULL new schedule through the shared model (OM.scheduleOf: bounds, the max timestamp) — before anything is written
  let draft = { ...value, schedule: { ...value.schedule, start: null, end: null } };
  let prepFail = null;
  if (program) {
    const sc = isObj(body.schedule) ? body.schedule : {};
    if (Object.keys(sc).some((k) => k !== 'start' && k !== 'end') || sc.start === undefined || sc.start === null) return reply(400, { error: 'bad_request', field: 'schedule' });
    const programSchedule = OM.scheduleOf({ days: value.schedule.days, start: sc.start, end: sc.end === undefined ? null : sc.end, window: value.schedule.window });
    if (!programSchedule) return reply(400, { error: 'bad_request', field: 'schedule' });
    const dish = await resolveDishes(deps, { ...value, schedule: programSchedule });   // a category offer is re-resolved (frozen from here)
    if (dish.fail && body.op_id === undefined) return dish.fail;
    if (dish.fail) prepFail = dish.fail; else draft = dish.value;   // a CLAIMED repeat: the failure waits for the claim check (P2-3)
  }
  const proposed = newOfferId();
  return brandTxn(db, brandId, (node) => {
    const c = claimCheck(node, body.op_id, 'repeat', sourceId, t);   // the replay FIRST (before any validation or capacity)
    if (c) return c;
    if (prepFail) return { abort: prepFail };   // no replay: the deferred preparation failure
    const s = isObj(node.offers) ? node.offers[sourceId] : null;
    if (!(isObj(s) && OM.recordOk(s, opts))) return { abort: reply(404, { error: 'not_found' }) };
    if (s.rev !== src.rev) return { abort: reply(409, { error: 'superseded', current_rev: s.rev }) };
    if (OM.statusOf(s, t) !== 'ended') return { abort: reply(409, { error: 'not_ended' }) };
    if (program) { const pub = OM.validatePublishable(draft, t); if (!pub.ok) return { abort: reply(400, { error: 'bad_request', field: pub.field, reason: pub.reason }) }; }
    const keep = endedToPrune(node.offers, t).filter((id) => id !== sourceId);   // never the offer being repeated
    if (Object.keys(isObj(node.offers) ? node.offers : {}).length - keep.length >= OM.LIMITS.offers_max) return { abort: reply(409, { error: 'too_many_offers' }) };
    const rec = OM.stripNulls({ v: 1, rev: 1, ...draft, state: program ? 'active' : 'draft', repeated_from: sourceId, created_by: ctx.uid, created_at: t, updated_at: t });
    if (program) { const j = judgeActive(node, brandId, proposed, rec, t); if (j) return refuse(node, body.op_id, 'repeat', sourceId, proposed, j.verdict, j.rid, t); }
    const next = draftNode(node);
    writeOffer(next, brandId, proposed, rec, t, [sourceId]);
    if (body.op_id !== undefined) { const full = putClaim(next, body.op_id, { offer_id: proposed, kind: 'repeat', at: t, source_id: sourceId }, t); if (full) return { abort: full }; }
    return { next, result: reply(200, { ok: true, offer: offerView(proposed, rec, t) }) };
  });
}

module.exports = { getMarketingCore, marketingOfferSaveCore, marketingOfferSetStateCore, marketingOfferRepeatCore, MOVES, newOfferId, admit, brandPath, OPS_MAX };   // admit: the marketing endpoints' ONE token → rid → capability check (anuncio-core)
