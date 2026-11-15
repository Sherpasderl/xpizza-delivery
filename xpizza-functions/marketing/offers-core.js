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
//   marketing_live_b/{brandId}/{rid}/{offerId} — the price path's compact record (offer-model liveProjection) while the offer is
//                                           active, else a tombstone { removed, rev }. EVERY mirror mutation of an offer is ONE transaction
//                                           on marketing_live_b/{brandId} (applyMirror: the overlap rule + MAX_LIVE judged inside — the
//                                           authority; all branches or nothing; rev-guarded). A refused activation puts the record back. A
//                                           record ahead of its mirror (an outage after the retries) is reported as live_drift and healed
//                                           by the next write.
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
// THE live mirror (PLAN-3a-live-mirror-rekey r2): marketing_live_b/{brandId}/{rid}/{offerId} — ONE parent per restaurant, so every mirror
// mutation of an offer is ONE transaction across all its branches (a NEW root: a legacy brand id can equal a rid)
const liveBrandPath = (brandId) => `marketing_live_b/${brandId}`;
const livePath = (brandId, rid) => `${liveBrandPath(brandId)}/${rid}`;

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

// THE live judgement — ONE rule, used by the cheap pre-check AND inside the brand transaction: this offer against one branch's CURRENT live
// set → null | { error: 'too_many_live' } | { error: 'overlap', with: [names] } (names of the clashing offers, no ids). A tombstone is
// never live; this offer's OWN entry is never judged (an edit may overlap itself).
function liveJudgement(offerId, value, live) {
  const others = Object.entries(isObj(live) ? live : {}).filter(([id, r]) => id !== offerId && isObj(r) && r.removed !== true);
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
function duplicateOf(all, offerId, proj, branches, schedule) {
  const held = {};
  for (const [rid, m] of Object.entries(isObj(all) ? all : {})) {
    for (const [id, e] of Object.entries(isObj(m) ? m : {})) {
      if (id === offerId || !isObj(e) || e.removed === true) continue;
      (held[id] = held[id] || { rids: new Set(), e }).rids.add(rid);
    }
  }
  const mine = new Set(branches);
  for (const [id, h] of Object.entries(held)) {
    const e = h.e;
    if (e.type !== proj.type || canon(e.params) !== canon(proj.params) || h.rids.size !== mine.size || ![...mine].every((r) => h.rids.has(r)) || !isObj(e.schedule)) continue;
    if (OM.schedulesOverlap(schedule, { start: e.schedule.start ?? null, end: e.schedule.end ?? null, days: e.schedule.days || [], window: e.schedule.window ?? null })) return id;
  }
  return null;
}

// the PRE-check (no write): refuse early, before the record moves, when a branch's live set already says no. Not the authority —
// applyMirror re-judges inside the brand transaction.
async function liveProblem(deps, brandId, offerId, value) {
  let all;
  try { all = await val(deps.db, liveBrandPath(brandId)); } catch (_) { return UNAVAILABLE(); }
  const dup = duplicateOf(all, offerId, { type: value.type, params: OM.liveProjection({ ...value, rev: 0, state: 'active' }, brandId).params }, value.branches, value.schedule);
  if (dup) return judgementReply({ error: 'duplicate', offer_id: dup }, value.branches[0]);   // the duplicate FIRST, on every path (P2-4)
  for (const rid of value.branches) {
    const v = liveJudgement(offerId, value, isObj(all) ? all[rid] : null);
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

// A CREATE that programmed in the same call and was REFUSED (Codex program r1 P1-2): the record becomes a TERMINAL `refused` record at a
// NEW rev (monotonic — never deleted, so no rev is ever reused under a newer tombstone), carrying the refusal; its mirror is applied for
// that rev (tombstones only — nothing priced). A same-op retry answers the SAME refusal. → the 409 | 503
const refusedReply = (rec) => reply(409, { error: rec.refused.error, ...(rec.refused.rid ? { rid: rec.refused.rid } : {}), ...(rec.refused.with ? { with: rec.refused.with } : {}), ...(rec.refused.offer_id ? { offer_id: rec.refused.offer_id } : {}) });
async function refuseProgram(db, brandId, path, offerId, rec, verdict, rid, t) {
  const why = { error: verdict.error, rid, ...(verdict.with ? { with: verdict.with } : {}), ...(verdict.offer_id ? { offer_id: verdict.offer_id } : {}) };
  let w;
  try { w = await casWrite(db, path, rec.rev, (cur, d) => { d.why = 'write'; return { ...cur, state: 'refused', refused: why, rev: cur.rev + 1, updated_at: t }; }); } catch (_) { return UNAVAILABLE(); }
  if (w.fail) return UNAVAILABLE();
  const m = await applyFromRecord(db, brandId, path, offerId, w.rec);
  if (m.fail) return UNAVAILABLE();
  return refusedReply(w.rec);
}

// THE mirror writer (PLAN-3a-live-mirror-rekey r2; Codex 2-phase r2 → advisor ruling): EVERY mirror mutation of an offer — publish, edit,
// pause / end, undo, every tombstone — is ONE transaction on marketing_live_b/{brandId}: it judges every branch (MAX_LIVE + the overlap
// rule — THE AUTHORITY) and writes ALL of the offer's branch entries or NOTHING. For the record `rec` at its rev: active ⇒ the projection on
// its branches and a TOMBSTONE { removed: true, rev } on every other branch the offer holds an entry on (or `alsoRids`); not active ⇒ a
// tombstone on every such branch. With `tombRev` (a pause / end's PRE-CAS fence) every branch is tombstoned at that rev. REV-GUARDED: an
// entry of this offer at a HIGHER rev on any branch means a newer write owns it ⇒ a no-op (strict `>`: the same rev re-applies).
// → { ok } | { stale } | { verdict, rid } ; throws on an outage
async function applyMirror(db, brandId, offerId, rec, { alsoRids = [], tombRev = null } = {}) {
  const active = tombRev === null && rec.state === 'active';
  const rev = tombRev === null ? rec.rev : tombRev;
  const value = active ? OM.authoredOf(rec, opts) : null;
  const proj = active ? OM.liveProjection(rec, brandId) : null;
  let last = null;
  const tx = await db.ref(liveBrandPath(brandId)).transaction((cur) => {
    const d = { verdict: null, rid: null, stale: false };
    last = d;
    const all = isObj(cur) ? cur : {};
    const held = Object.keys(all).filter((rid) => isObj(all[rid]) && all[rid][offerId] != null);
    const rids = [...new Set([...(Array.isArray(rec.branches) ? rec.branches : []), ...alsoRids, ...held])];
    const higher = rids.some((rid) => { const e = isObj(all[rid]) ? all[rid][offerId] : null; return isObj(e) && Number.isSafeInteger(e.rev) && e.rev > rev; });
    if (higher) { d.stale = true; return undefined; }
    if (active) {
      const dup = duplicateOf(all, offerId, proj, rec.branches, value.schedule);
      if (dup) { d.verdict = { error: 'duplicate', offer_id: dup }; d.rid = rec.branches[0]; return undefined; }
      for (const rid of rec.branches) { const v = liveJudgement(offerId, value, all[rid]); if (v) { d.verdict = v; d.rid = rid; return undefined; } }
    }
    const next = { ...all };
    for (const rid of rids) next[rid] = { ...(isObj(all[rid]) ? all[rid] : {}), [offerId]: active && rec.branches.includes(rid) ? proj : { removed: true, rev } };
    return next;
  });
  if (last && last.stale) return { stale: true };
  if (last && last.verdict) return { verdict: last.verdict, rid: last.rid };
  if (!(tx && tx.committed)) throw new Error('mirror_not_committed');
  return { ok: true };
}
// applyMirror for the record as it is NOW: an outage RETRIES from the current record (never a half state — each attempt is one atomic
// txn); the last failure ⇒ { fail } (the record ahead of the mirror: never mispriced, reported as live_drift, healed by the next write)
const MIRROR_TRIES = 3;
async function applyFromRecord(db, brandId, path, offerId, rec, opts2 = {}) {
  let current = rec;
  for (let i = 0; i < MIRROR_TRIES; i++) {
    try { return await applyMirror(db, brandId, offerId, current, opts2); } catch (_) {
      try { const fresh = await val(db, path); if (isObj(fresh) && OM.recordOk(fresh, opts)) current = fresh; } catch (__) { /* retry with what we have */ }
    }
  }
  return { fail: true };
}
// after the record CAS: ONE brand txn applies THIS record's rev. A refused activation / edit wrote NOTHING; the record is put BACK (a second
// CAS on the new rev) and that undo's KNOWN rev is applied in ONE more brand txn (an active «before» re-stamps its untouched projection,
// an inactive one tombstones every branch). → null | the 409 judgement (with current_rev) | 503
async function settleMirrors(db, brandId, path, offerId, rec, before, t) {
  const prevBranches = isObj(before) && Array.isArray(before.branches) ? before.branches : [];
  const r = await applyFromRecord(db, brandId, path, offerId, rec, { alsoRids: prevBranches });
  if (r.fail) return UNAVAILABLE();
  if (!r.verdict) return null;
  if (!isObj(before)) return refuseProgram(db, brandId, path, offerId, rec, r.verdict, r.rid, t);   // a CREATE that programmed in the same call
  const undo = await casWrite(db, path, rec.rev, (cur, d) => { d.why = 'write'; return { ...before, rev: cur.rev + 1, updated_at: t }; });
  if (undo.fail) return UNAVAILABLE();
  const u = await applyFromRecord(db, brandId, path, offerId, undo.rec, { alsoRids: rec.branches });
  if (u.fail || u.verdict) return UNAVAILABLE();
  return reply(409, { ...judgementReply(r.verdict, r.rid).body, current_rev: undo.rec.rev });
}

// Q4: the brand's ended offers older than 180 days (by their last write) — removed by the next create, in ONE update of the brand node
// a refused attempt never counts toward offers_max (a terminal record of a failed call, pruned like an ended one)
const isRefused = (r) => isObj(r) && r.state === 'refused';
const counted = (all) => Object.values(isObj(all) ? all : {}).filter((r) => !isRefused(r)).length;
const endedToPrune = (all, t) => Object.entries(isObj(all) ? all : {})
  .filter(([, r]) => isObj(r) && (r.state === 'ended' || r.state === 'refused') && Number.isSafeInteger(r.updated_at) && t - r.updated_at > OM.LIMITS.ended_retain_ms).map(([id]) => id);
async function pruneEnded(db, brandId, ids) {
  if (!ids.length) return;
  try { await db.ref(offersPath(brandId)).update(Object.fromEntries(ids.map((id) => [id, null]))); } catch (_) { /* retried by the next create */ }
}

const bodyOf = (req) => (isObj(req && req.body) ? req.body : {});

// IDEMPOTENT create / repeat per (restaurant, client op_id) (advisor 11-14; portal-ui retries a lost reply): ONE create-only transaction
// claims marketing_offer_ops/{brandId}/{op_id} = { offer_id, kind, at } BEFORE the record is created under that id (the record create is
// create-only too). A repeat call finds the claim and answers THAT offer (its current rev and state); while the first call is still in
// flight (claimed, record not yet written) the repeat creates under the SAME claimed id — create-only, so exactly one record ever exists
// and the loser answers the winner's. An op_id older than OP_TTL_MS no longer matches (the claim is replaced; expired claims are pruned).
const OP_RE = /^[A-Za-z0-9_-]{16,64}$/;
const OP_TTL_MS = 7 * 86400000;
const opsPath = (brandId) => `marketing_offer_ops/${brandId}`;
const isOpId = (v) => typeof v === 'string' && OP_RE.test(v);   // a STRING first (Codex op_id r2 P2-5)
const liveClaim = (c, t) => isObj(c) && OM.OFFER_ID_RE.test(String(c.offer_id)) && Number.isSafeInteger(c.at) && t - c.at < OP_TTL_MS;
// → { offerId, fresh } (fresh = this call made the claim) | { conflict: true } (an unexpired claim of ANOTHER kind or, for a repeat, another
// SOURCE — never overwritten: Codex op_id r2 P2-2 / P2-3) | null (an outage)
async function claimOp(db, brandId, opId, kind, t, sourceId = null) {
  const proposed = newOfferId();
  let out = null;
  const tx = await db.ref(`${opsPath(brandId)}/${opId}`).transaction((cur) => {
    if (liveClaim(cur, t)) {
      out = cur.kind === kind && (kind !== 'repeat' || cur.source_id === sourceId) ? { offerId: cur.offer_id, fresh: false } : { conflict: true };
      return undefined;
    }
    out = { offerId: proposed, fresh: true };
    return { offer_id: proposed, kind, at: t, ...(kind === 'repeat' ? { source_id: sourceId } : {}) };
  });
  if (out && out.fresh && !(tx && tx.committed)) return null;
  if (out && out.fresh) {   // the brand's EXPIRED claims leave with a fresh one — each in its OWN txn that re-checks it is still that expired claim
    try {
      const all = (await val(db, opsPath(brandId))) || {};
      for (const [k, c] of Object.entries(isObj(all) ? all : {})) {
        if (liveClaim(c, t)) continue;
        await db.ref(`${opsPath(brandId)}/${k}`).transaction((cur) => {
          if (cur === null) return null;
          return !liveClaim(cur, t) && isObj(cur) && isObj(c) && cur.offer_id === c.offer_id && cur.at === c.at ? null : undefined;   // renewed meanwhile ⇒ kept (P2-1)
        });
      }
    } catch (_) { /* retried by the next fresh claim */ }
  }
  return out;
}
const OP_CONFLICT = () => reply(409, { error: 'op_id_conflict' });
// an op_id retry that lost the create-only race (or found the claim): the claimed offer as it is NOW — success means the record AND its
// mirror agree at the record's rev (Codex program r1 P1-1): an ACTIVE record whose mirror is not there re-runs the idempotent, rev-guarded
// brand txn (repair-on-replay) and answers 200 only after it; a refusal there turns its own first write (rev 1) into the terminal refusal.
// → the 200 / 409 reply | null (no record yet: the caller creates under the claimed id)
async function replayOf(db, brandId, offerId, t) {
  const path = `${offersPath(brandId)}/${offerId}`;
  const rec = await val(db, path);
  if (!(isObj(rec) && OM.recordOk(rec, opts))) return null;
  if (rec.state === 'refused' && isObj(rec.refused)) return refusedReply(rec);
  if (rec.state === 'active') {
    const all = (await val(db, liveBrandPath(brandId))) || {};
    const at = rec.branches.every((rid) => { const e = isObj(all[rid]) ? all[rid][offerId] : null; return isObj(e) && e.removed !== true && e.rev === rec.rev; });
    if (!at) {
      const m = await applyFromRecord(db, brandId, path, offerId, rec);
      if (m.fail) return UNAVAILABLE();
      if (m.verdict) return rec.rev === 1 ? refuseProgram(db, brandId, path, offerId, rec, m.verdict, m.rid, t) : UNAVAILABLE();
      if (m.stale) { const now2 = await val(db, path); if (isObj(now2) && OM.recordOk(now2, opts)) return reply(200, { ok: true, offer: offerView(offerId, now2, t) }); }
    }
  }
  return reply(200, { ok: true, offer: offerView(offerId, rec, t) });
}
const offerView = (id, rec, nowMs) => ({
  id, rev: rec.rev, state: rec.state, status: OM.statusOf(rec, nowMs),
  ...OM.authoredOf(rec, opts),
  created_at: rec.created_at, updated_at: rec.updated_at,
  ...(rec.ended_reason ? { ended_reason: rec.ended_reason } : {}), ...(rec.repeated_from ? { repeated_from: rec.repeated_from } : {}),
  ...(rec.state === 'paused_owner' && Number.isSafeInteger(rec.paused_at) ? { paused_at: rec.paused_at } : {}),
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
      switches.offers_enabled ? val(db, offersPath(a.access.brandId)) : null, switches.offers_enabled ? val(db, livePath(a.access.brandId, rid)) : null,
      switches.anuncio_enabled ? val(db, `anuncio_bookings/${rid}`) : null]);
  } catch (_) { return UNAVAILABLE(); }
  const t = now();
  // this branch's Anuncio bookings (≤ 12): the derived status, the price agreed, the deadline, the days not shown — no charge field exists
  const bookings = Object.entries(isObj(booked) ? booked : {})
    .filter(([id, b]) => AM.BOOKING_ID_RE.test(id) && isObj(b) && b.void !== true && AM.WEEK_RE.test(String(b.week)))   // a void (a released orphan's marker) is never listed
    .map(([id, b]) => ({ id, week: b.week, status: AM.bookingStatus(b, t), price_cents: b.price_cents, cancel_deadline: b.cancel_deadline, hidden_days: AM.hiddenDays(b) }))
    .sort((x, y) => (x.week < y.week ? 1 : x.week > y.week ? -1 : 0));
  const offers = Object.entries(isObj(all) ? all : {})
    .filter(([id, rec]) => OM.OFFER_ID_RE.test(id) && OM.recordOk(rec, opts) && rec.state !== 'refused' && rec.branches.includes(rid))   // a refused attempt is never listed
    .map(([id, rec]) => {
      const m = isObj(live) ? live[id] : undefined;
      const drift = rec.state === 'active' ? !(isObj(m) && m.removed !== true && m.rev === rec.rev) : isObj(m) && m.removed !== true;   // a tombstone is «not live»
      if (drift) console.warn('marketing_live_drift', JSON.stringify({ offer: id, rev: rec.rev, mirror_rev: isObj(m) ? m.rev : null }));   // the backstop ALERT: a record ≠ its mirror (Codex program r1)
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
  if (!creating && !(typeof body.offer_id === 'string' && OM.OFFER_ID_RE.test(body.offer_id))) return reply(400, { error: 'bad_request', field: 'offer_id' });   // a STRING first (Codex op_id r3)
  if (!Number.isSafeInteger(body.expected_rev) || body.expected_rev < 0 || (creating !== (body.expected_rev === 0))) return reply(400, { error: 'bad_request', field: 'expected_rev' });
  if (body.op_id !== undefined && (!creating || !isOpId(body.op_id))) return reply(400, { error: 'bad_request', field: 'op_id' });
  if (body.program !== undefined && body.program !== true) return reply(400, { error: 'bad_request', field: 'program' });
  const program = body.program === true;   // the portal's single-call Ofertas: save AND program in ONE operation (all or nothing)
  const v = OM.validateAuthored(body.offer, opts);
  if (!v.ok) return reply(400, { error: 'bad_request', field: v.field, reason: v.reason });
  const denied = await authorizeBranches(deps, ctx, brandId, v.value.branches);
  if (denied) return denied;
  const dish = await resolveDishes(deps, v.value);
  if (dish.fail) return dish.fail;
  const value = dish.value;
  const t = now();
  let offerId = creating ? newOfferId() : body.offer_id;
  if (creating && body.op_id !== undefined) {   // idempotent create: the claimed id; a repeat answers the offer it already made
    let c;
    try { c = await claimOp(db, brandId, body.op_id, 'create', t); } catch (_) { return UNAVAILABLE(); }
    if (!c) return UNAVAILABLE();
    if (c.conflict) return OP_CONFLICT();
    offerId = c.offerId;
    if (!c.fresh) { let r; try { r = await replayOf(db, brandId, offerId, t); } catch (_) { return UNAVAILABLE(); } if (r) return r; }
  }
  let prune = [];
  if (creating) {   // the brand's bound (every state counts) + Q4: ended offers older than 180 days leave with this write
    let all;
    try { all = (await val(db, offersPath(brandId))) || {}; } catch (_) { return UNAVAILABLE(); }
    prune = endedToPrune(all, t);
    if (counted(all) - prune.filter((id) => !isRefused(all[id])).length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  }
  let prevRec = null;
  if (!creating) { try { prevRec = await val(db, `${offersPath(brandId)}/${offerId}`); } catch (_) { return UNAVAILABLE(); } }
  // program: the publish validation (a future start) applies to a record being PROGRAMMED (a create, a draft, a paused one) — never to an
  // already live offer's edit (caps / end) — and only AFTER any op_id replay above (Codex program r1 P2-3)
  if (program && !(isObj(prevRec) && prevRec.state === 'active')) { const pub = OM.validatePublishable(value, t); if (!pub.ok) return reply(400, { error: 'bad_request', field: pub.field, reason: pub.reason }); }
  if (!creating) {   // an active / paused offer: the live-edit allowlist is checked against the record the CAS will see
    if (isObj(prevRec) && (program || prevRec.state === 'active' || prevRec.state === 'paused_owner')) {
      const live = await liveProblem(deps, brandId, offerId, value);   // a later end CAN create an overlap: the same judgement as a publish
      if (live) return live;
    }
  }
  const w = await casWrite(db, `${offersPath(brandId)}/${offerId}`, body.expected_rev, (cur, d) => {
    if (cur === null) {
      d.why = 'write';
      return OM.stripNulls({ v: 1, rev: 1, ...value, state: program ? 'active' : 'draft', created_by: ctx.uid, created_at: t, updated_at: t });
    }
    if (!OM.recordOk(cur, opts)) { d.why = 'current_malformed'; return undefined; }
    if (cur.state === 'ended' || cur.state === 'refused') { d.why = cur.state; return undefined; }
    if (cur.state !== 'draft') {
      const p = OM.liveEditProblem(OM.authoredOf(cur, opts), value);
      if (p) { d.why = 'live_edit_not_allowed'; d.field = p; return undefined; }
    }
    d.why = 'write';
    const next = { ...cur, ...value, schedule: value.schedule, caps: value.caps, rev: cur.rev + 1, updated_at: t };
    if (program && cur.state !== 'active') { next.state = 'active'; delete next.paused_at; }   // update AND program in ONE CAS
    return OM.stripNulls(next);
  });
  if (w.fail) {
    if (creating && body.op_id !== undefined) { let r = null; try { r = await replayOf(db, brandId, offerId, t); } catch (_) { /* the 503 below */ } if (r) return r; }   // the concurrent twin won the create-only write
    return w.fail;
  }
  if (w.rec.state === 'active') { const m = await settleMirrors(db, brandId, `${offersPath(brandId)}/${offerId}`, offerId, w.rec, prevRec, t); if (m) return m; }
  await pruneEnded(db, brandId, prune);
  return reply(200, { ok: true, offer: offerView(offerId, w.rec, t) });
}

// ── marketingOfferSetState ─────────────────────────────────────────────────────────────────────────────────────────────────
// to: 'active' (publish a draft, or resume a paused offer) | 'paused_owner' | 'ended'
const MOVES = Object.freeze({ draft: ['active', 'ended'], active: ['paused_owner', 'ended'], paused_owner: ['active', 'ended'], ended: [], refused: [] });
async function marketingOfferSetStateCore(deps, req) {
  const { db, now = () => Date.now() } = deps;
  const h = await writeHead(deps, req);
  if (h.fail) return h.fail;
  const { body, ctx } = h;
  const brandId = h.access.brandId;
  if (!(typeof body.offer_id === 'string' && OM.OFFER_ID_RE.test(body.offer_id))) return reply(400, { error: 'bad_request', field: 'offer_id' });
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
    const live = await liveProblem(deps, brandId, body.offer_id, value);
    if (live) return live;
  }
  // PAUSE / END (advisor 11-14, 5f's price-plan review): the price path loses the offer BEFORE its record says so. A failed removal is
  // a 503 with the record unchanged (still active, still applied — consistent); never a paused / ended record whose mirror still prices.
  // A lost CAS after the removal leaves an active record with no mirror: never applied, reported as live_drift, healed by the next write.
  if (body.to !== 'active' && MOVES[pre.state].includes(body.to)) {   // the PRE-CAS fence: ONE brand txn tombstones every branch at the rev this CAS will write
    const f = await applyFromRecord(db, brandId, path, body.offer_id, pre, { tombRev: pre.rev + 1, alsoRids: value.branches });
    if (f.fail) return UNAVAILABLE();
  }
  const w = await casWrite(db, path, body.expected_rev, (cur, d) => {
    if (cur === null) { d.why = 'not_found'; return undefined; }
    if (!OM.recordOk(cur, opts)) { d.why = 'current_malformed'; return undefined; }
    if (!MOVES[cur.state].includes(body.to)) { d.why = 'bad_transition'; return undefined; }
    d.why = 'write';
    const next = { ...cur, state: body.to, rev: cur.rev + 1, updated_at: t, ...(body.to === 'active' ? { params: value.params } : {}) };
    if (body.to === 'ended') next.ended_reason = 'owner'; else delete next.ended_reason;
    if (body.to === 'paused_owner') next.paused_at = t; else delete next.paused_at;   // «Pausada por vos el …» (server time); resume / end clear it
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
  // the source: `source_id` (the single-call contract) or `offer_id` (today's) — exactly one
  if ((body.source_id === undefined) === (body.offer_id === undefined)) return reply(400, { error: 'bad_request', field: 'source_id' });
  const sourceId = body.source_id !== undefined ? body.source_id : body.offer_id;
  if (!(typeof sourceId === 'string' && OM.OFFER_ID_RE.test(sourceId))) return reply(400, { error: 'bad_request', field: 'source_id' });   // a STRING first: never an array persisted as source_id (Codex op_id r3)
  if (body.op_id !== undefined && !isOpId(body.op_id)) return reply(400, { error: 'bad_request', field: 'op_id' });
  if (body.program !== undefined && body.program !== true) return reply(400, { error: 'bad_request', field: 'program' });
  const program = body.program === true;   // copy + dates + program in ONE operation (all or nothing)
  if (program !== (body.schedule !== undefined)) return reply(400, { error: 'bad_request', field: 'schedule' });
  let all;
  try { all = (await val(db, offersPath(brandId))) || {}; } catch (_) { return UNAVAILABLE(); }
  const src = isObj(all) ? all[sourceId] : null;
  if (src == null) return reply(404, { error: 'not_found' });
  if (!OM.recordOk(src, opts)) return reply(409, { error: 'current_malformed' });
  const t = now();
  if (OM.statusOf(src, t) !== 'ended') return reply(409, { error: 'not_ended' });
  const value = OM.authoredOf(src, opts);
  const denied = await authorizeBranches(deps, ctx, brandId, value.branches);
  if (denied) return denied;
  // program: the FULL new schedule through the shared model (OM.scheduleOf: bounds, max timestamp) — BEFORE any claim or write (P2-5)
  let programSchedule = null;
  if (program) {
    const sc = isObj(body.schedule) ? body.schedule : {};
    if (Object.keys(sc).some((k) => k !== 'start' && k !== 'end') || sc.start === undefined || sc.start === null) return reply(400, { error: 'bad_request', field: 'schedule' });
    programSchedule = OM.scheduleOf({ days: value.schedule.days, start: sc.start, end: sc.end === undefined ? null : sc.end, window: value.schedule.window });
    if (!programSchedule) return reply(400, { error: 'bad_request', field: 'schedule' });
  }
  let offerId = newOfferId();
  if (body.op_id !== undefined) {   // idempotent repeat (see claimOp), bound to its SOURCE — a replay comes BEFORE the capacity check (P2-4)
    let c;
    try { c = await claimOp(db, brandId, body.op_id, 'repeat', t, sourceId); } catch (_) { return UNAVAILABLE(); }
    if (!c) return UNAVAILABLE();
    if (c.conflict) return OP_CONFLICT();
    offerId = c.offerId;
    if (!c.fresh) { let r; try { r = await replayOf(db, brandId, offerId, t); } catch (_) { return UNAVAILABLE(); } if (r) return r; }
  }
  const prune = endedToPrune(all, t).filter((id) => id !== sourceId);   // never the offer being repeated
  if (counted(all) - prune.filter((id) => !isRefused(all[id])).length >= OM.LIMITS.offers_max) return reply(409, { error: 'too_many_offers' });
  let draft = { ...value, schedule: { ...value.schedule, start: null, end: null } };
  if (program) {   // the new dates (validated above), checked as a publish; a category offer is re-resolved (frozen from here)
    draft = { ...value, schedule: programSchedule };
    const pub = OM.validatePublishable(draft, t);
    if (!pub.ok) return reply(400, { error: 'bad_request', field: pub.field, reason: pub.reason });
    const dish = await resolveDishes(deps, draft);
    if (dish.fail) return dish.fail;
    draft = dish.value;
  }
  const w = await casWrite(db, `${offersPath(brandId)}/${offerId}`, 0, (cur, d) => {
    d.why = 'write';
    return OM.stripNulls({ v: 1, rev: 1, ...draft, state: program ? 'active' : 'draft', repeated_from: sourceId, created_by: ctx.uid, created_at: t, updated_at: t });
  });
  if (w.fail) {
    if (body.op_id !== undefined) { let r = null; try { r = await replayOf(db, brandId, offerId, t); } catch (_) { /* the 503 below */ } if (r) return r; }
    return w.fail;
  }
  if (program) { const m = await settleMirrors(db, brandId, `${offersPath(brandId)}/${offerId}`, offerId, w.rec, null, t); if (m) return m; }
  await pruneEnded(db, brandId, prune);
  return reply(200, { ok: true, offer: offerView(offerId, w.rec, t) });
}

module.exports = { getMarketingCore, marketingOfferSaveCore, marketingOfferSetStateCore, marketingOfferRepeatCore, MOVES, newOfferId, admit };   // admit: the marketing endpoints' ONE token → rid → capability check (anuncio-core)
