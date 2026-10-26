'use strict';
// ORCHESTRATION O1b T4 / T5 / T7 (PLAN-orch-o1b r3 §2) — the branch-LIFECYCLE cores behind the portal endpoints of slice 1b. Every
// decision lives here, dependency-injected; the HTTP handlers (portal/ops-functions.js) are thin wrappers, as for E1–E5.
//
//   E6  createBranchDraftCore   POST { op_id, brand_id, location_name, phone, hours, prep_default_min }   brand.locations
//   E7  updateBranchProfileCore POST { rid, expectedVersion, patch ⊆ { phone, hours, prep_default_min } }  per field group / drafts
//                                     brand.locations; a location_name → 409 rename_cli_only (plan r3)
//   E8  setBranchActiveCore     POST { rid, expectedVersion, active }                                     brand.locations
//   E10 deleteBranchDraftCore   POST { rid, expectedVersion }                                             brand.locations
//
// ORDER (every write endpoint): method → body shape (incl. the allowlist, rename_cli_only, Q10 phone) → the write gate
// writesEnabled (missing / false / read failure → 503 writes_disabled) → the verified token → authorization → the writer.
// A legacy branch (the member rid of a brand whose activation.state is 'legacy') is refused by E8 in BOTH directions before any
// mutation (409 legacy_branch) — legacy on / off stays the Sherpa CLI until O3.
// After a committed E7 / E8 on a MEMBER branch the brand projection is published best-effort (publishAfterCommit): the mutation's
// reply is already decided; refusal / exception / timeout upserts the ONE projection_stale alert and the reply says `deferred`.
const { resolveAccess, resolveBrandAccess, resolveLocation, can } = require('../access/membership');
const { isBrandId } = require('../brands/brand-model');
const { writesEnabled } = require('../access/writes-flag');
const { verifiedContext } = require('./ops-core');
const { isHnMobile } = require('./branch-phone');
const S = require('../branches/branch-store');
const P = require('../branches/branch-ops');
const { draftBinding } = require('../branches/drafts');
const { portalReaders } = require('../branches/readiness-readers');
const B = require('../brands/brand-store');

const reply = (status, body) => ({ status, body });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const E6_KEYS = Object.freeze(['brand_id', 'hours', 'location_name', 'op_id', 'phone', 'prep_default_min']);
// E7: the field groups and the capability each needs (location_name never reaches this map — rename_cli_only first)
const GROUP_CAP = Object.freeze({ location_name: 'location.profile', phone: 'location.contact', hours: 'location.hours', prep_default_min: 'location.prep' });
const PUBLISH_TIMEOUT_MS = 3000;
const isToken = (v) => (Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && v.length > 0 && v.length <= 200);

const STATUS = {
  forbidden_field: 403, not_authorized: 403,
  stale_branch: 409, name_taken: 409, op_conflict: 409, brand_busy: 409, not_a_draft: 409, not_a_branch: 409, legacy_branch: 409,
  rename_cli_only: 409, not_ready: 409, brand_lists_draft: 409, brand_has_drafts: 409, identity_conflict: 409, rid_conflict: 409,
  rid_exhausted: 409, brand_not_found: 409, interrupted: 409, lease_lost: 409, draft_changed: 409, draft_conflict: 409,
  unavailable: 503, writes_disabled: 503,
};
const statusOf = (code) => STATUS[code] || (/^bad_/.test(String(code)) ? 400 : 409);
const refuse = (code, extra = {}) => reply(statusOf(code), { error: code, ...extra });

// the gate + token, shared: → { ctx } or { fail }
async function gateAndToken(deps, req) {
  let on = false;
  try { on = (await writesEnabled(deps.db)) === true; } catch (_) { on = false; }
  if (!on) return { fail: refuse('writes_disabled') };
  const v = await verifiedContext({ verifyIdToken: deps.verifyIdToken }, req);
  return v.fail ? { fail: v.fail } : { ctx: v.ctx };
}
async function brandOwner(db, ctx, brandId) {
  const a = await resolveBrandAccess({ db }, ctx, brandId);
  if (a && a.ok === true && can(a, 'brand.locations')) return { access: a };
  if (a && a.code === 'unavailable') return { fail: refuse('unavailable', { retryable: true }) };
  return { fail: refuse('not_authorized') };
}
// a branch's legacy status: the member rid of a brand whose activation.state is 'legacy' (R-LEGACY)
function isLegacyBranch(brand, rid) {
  return isObj(brand) && isObj(brand.activation) && brand.activation.state === 'legacy' && isObj(brand.locations) && brand.locations[rid] === 'member';
}

// best-effort fenced publish after a committed mutation of a MEMBER branch → 'published' | 'superseded' | 'deferred'
async function publishAfterCommit(deps, brandId, rid) {
  const { db, now = () => Date.now(), publishTimeoutMs = PUBLISH_TIMEOUT_MS, log = console } = deps;
  let outcome; let reason = null;
  try {
    let timer;
    const expiry = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), publishTimeoutMs); });
    const r = await Promise.race([B.publishBrandProjection(db, brandId, { now: now() }), expiry]).finally(() => clearTimeout(timer));
    if (r && r.timedOut) { outcome = 'deferred'; reason = 'timeout'; } else if (r && r.ok === true) outcome = r.superseded ? 'superseded' : 'published';
    else { outcome = 'deferred'; reason = (r && r.error) || 'refused'; }
  } catch (e) {
    outcome = 'deferred'; reason = 'exception';
  }
  if (outcome === 'deferred') {
    // the alert is best-effort and BOUNDED too (Codex build r1 #3): a stalled alert transaction never holds the reply
    try {
      let t2;
      const capped = new Promise((resolve) => { t2 = setTimeout(() => resolve('alert_timeout'), publishTimeoutMs); });
      const a = await Promise.race([B.raiseProjectionStale(db, brandId, { rid, reason, at: now() }), capped]).finally(() => clearTimeout(t2));
      if (a === 'alert_timeout') log.warn('projection_stale_alert_failed', JSON.stringify({ brandId, rid, reason, why: 'timeout' }));
    } catch (e) { log.warn('projection_stale_alert_failed', JSON.stringify({ brandId, rid, reason })); }
    log.warn('projection_deferred', JSON.stringify({ brandId, rid, reason }));
  }
  return outcome;
}

// ── E6 createBranchDraft ────────────────────────────────────────────────────────────────────────────────────────────────────
async function createBranchDraftCore(deps, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  if (Object.keys(body).sort().join(',') !== E6_KEYS.join(',')) {   // the WHOLE request: exactly the six keys (Codex r1 #9)
    return Object.keys(body).some((k) => !E6_KEYS.includes(k)) ? refuse('forbidden_field') : refuse('bad_request');
  }
  if (!isBrandId(body.brand_id)) return refuse('bad_brand');
  if (!isHnMobile(body.phone)) return refuse('bad_phone');
  const g = await gateAndToken(deps, req);
  if (g.fail) return g.fail;
  const o = await brandOwner(deps.db, g.ctx, body.brand_id);
  if (o.fail) return o.fail;
  let r;
  try {
    r = await S.createDraft(deps.db, { input: { brand_id: body.brand_id, location_name: body.location_name, phone: body.phone, hours: body.hours, prep_default_min: body.prep_default_min },
      opId: body.op_id, callerUid: g.ctx.uid, now: (deps.now || Date.now)(), clock: deps.clock });
  } catch (e) { return refuse('unavailable', { retryable: true }); }
  if (!r || r.ok !== true) {   // createDraft's validation refusal is { error:'bad_draft', errors:[bad_name | bad_phone | bad_prep | bad_hours…] }
    const code = r && r.error === 'bad_draft' && Array.isArray(r.errors) && r.errors.length ? r.errors[0] : (r && r.error) || 'unavailable';
    return refuse(code, r && Array.isArray(r.errors) ? { errors: r.errors } : {});
  }
  const d = await val(deps.db, `restaurants/${r.rid}/draft`);
  if (isObj(d)) return reply(200, { rid: r.rid, state: 'draft', version: P.draftToken(d) });
  // a replay of a create whose allocation was MATERIALIZED since (T3a recognises it complete): its CURRENT lifecycle + identity token
  // (Codex build r1 #4) — never 'draft' with a token E7 / E10 cannot use
  const id = await val(deps.db, `restaurants/${r.rid}/identity`);
  const st = await val(deps.db, `brands/${body.brand_id}/locations/${r.rid}`);
  if (!isObj(id) || !Number.isSafeInteger(id.version)) return refuse('unavailable', { retryable: true });
  return reply(200, { rid: r.rid, state: st === 'staged' ? 'staged' : (id.active === true ? 'active' : 'inactive'), version: id.version });
}

// ── E7 updateBranchProfile ──────────────────────────────────────────────────────────────────────────────────────────────────
async function updateBranchProfileCore(deps, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  const { rid, expectedVersion, patch } = body;
  if (!isBrandId(rid)) return refuse('bad_rid');
  if (!isObj(patch) || !Object.keys(patch).length) return refuse('bad_patch');
  if (has(patch, 'location_name')) return refuse('rename_cli_only');   // plan r3: names change only through the Sherpa CLI
  if (Object.keys(patch).some((k) => !has(GROUP_CAP, k))) return refuse('forbidden_field');
  if (has(patch, 'phone') && !isHnMobile(patch.phone)) return refuse('bad_phone');
  if (!isToken(expectedVersion)) return refuse('bad_version');
  const g = await gateAndToken(deps, req);
  if (g.fail) return g.fail;
  const { db } = deps;
  const isDraft = typeof expectedVersion === 'string';
  let brandId = null; let member = false;
  if (isDraft) {   // drafts: OWNER-only, by brand.locations on the draft's own brand (R-DRAFT)
    const d = await val(db, `restaurants/${rid}/draft`);
    brandId = isObj(d) && isBrandId(d.brand_id) ? d.brand_id : null;
    if (!brandId) return refuse((await val(db, `restaurants/${rid}/identity`)) != null ? 'stale_branch' : 'not_a_draft');
    const o = await brandOwner(db, g.ctx, brandId);
    if (o.fail) return o.fail;
  } else {         // an identity: EVERY field group authorized before any write (mixed patches)
    if ((await val(db, `restaurants/${rid}/identity`)) == null) {   // an integer token, but the rid is a draft → stale (its owner only)
      const d = await val(db, `restaurants/${rid}/draft`);
      if (!isObj(d) || !isBrandId(d.brand_id)) return refuse('not_a_branch');
      const o = await brandOwner(db, g.ctx, d.brand_id);
      return o.fail || refuse('stale_branch');
    }
    const a = await resolveAccess({ db }, g.ctx, rid);
    if (!a || a.ok !== true) return a && a.code === 'unavailable' ? refuse('unavailable', { retryable: true }) : refuse('not_authorized');
    if (!Object.values(GROUP_CAP).some((c) => can(a, c))) return refuse('not_authorized');   // no profile capability here at all
    if (Object.keys(patch).some((k) => !can(a, GROUP_CAP[k]))) return refuse('forbidden_field');   // a group this caller may not edit
    brandId = a.brandId; member = a.state === 'member';
  }
  let r;
  try { r = await S.updateBranchProfile(db, { rid, patch, expected: expectedVersion, now: (deps.now || Date.now)(), clock: deps.clock }); } catch (e) { return refuse('unavailable', { retryable: true }); }
  if (r && r.ok === true) {
    const out = { version: r.version, lifecycle: r.lifecycle };
    if (!isDraft && member) out.projection = await publishAfterCommit(deps, brandId, rid);
    return reply(200, out);
  }
  if (r && r.error === 'noop') return reply(200, { noop: true });
  return refuse((r && r.error) || 'unavailable');
}

// ── E8 setBranchActive ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function setBranchActiveCore(deps, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  const { rid, expectedVersion, active } = body;
  if (!isBrandId(rid)) return refuse('bad_rid');
  if (typeof active !== 'boolean') return refuse('bad_active');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return refuse('bad_version');
  const g = await gateAndToken(deps, req);
  if (g.fail) return g.fail;
  const { db } = deps;
  // the brand by the VALIDATED resolver (Codex build r1 #5): F1 brandIdOf over the identity + the legacy singleton record, then the
  // roster — so an UNENRICHED legacy singleton (no identity.brand_id, resolved via brands/{rid}) is recognised too
  let loc;
  try { loc = await resolveLocation(db, rid); } catch (e) { return refuse('unavailable', { retryable: true }); }
  if (!loc || loc.state === 'unknown' || !isBrandId(loc.brandId)) return refuse('not_a_branch');
  const brandId = loc.brandId;
  const o = await brandOwner(db, g.ctx, brandId);
  if (o.fail) return o.fail;
  if (isLegacyBranch(loc.rec, rid)) return refuse('legacy_branch');   // R-LEGACY: before ANY mutation, both directions
  let r;
  try {
    r = await S.setBranchActive(db, { rid, active, expectedVersion, now: (deps.now || Date.now)(), clock: deps.clock, readers: portalReaders(db, brandId) });
  } catch (e) { return refuse('unavailable', { retryable: true }); }
  if (r && r.ok === true) {
    const out = { ok: true, state: r.state };
    if ('consequences' in r) out.consequences = r.consequences;   // null = committed, but the counts could not be read
    out.projection = await publishAfterCommit(deps, brandId, rid);   // after either direction the branch is a MEMBER (activate moved staged → member)
    return reply(200, out);
  }
  if (r && r.error === 'noop') return reply(200, { noop: true });
  if (r && r.error === 'not_ready') return refuse('not_ready', { unmet: r.unmet, ...(r.identity_gaps ? { identity_gaps: r.identity_gaps } : {}) });
  return refuse((r && r.error) || 'unavailable');
}

// ── E10 deleteBranchDraft ───────────────────────────────────────────────────────────────────────────────────────────────────
async function deleteBranchDraftCore(deps, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  const { rid, expectedVersion } = body;
  if (!isBrandId(rid)) return refuse('bad_rid');
  if (typeof expectedVersion !== 'string' || !expectedVersion) return refuse('bad_version');
  const g = await gateAndToken(deps, req);
  if (g.fail) return g.fail;
  const { db } = deps;
  const d = await val(db, `restaurants/${rid}/draft`);
  const brandId = isObj(d) && isBrandId(d.brand_id) ? d.brand_id : null;
  if (!brandId) return refuse('not_a_draft');
  const o = await brandOwner(db, g.ctx, brandId);
  if (o.fail) return o.fail;
  if (!(await draftBinding(db, brandId, rid)).ok) return refuse('not_a_draft');
  let r;
  try { r = await S.deleteBranchDraft(db, { rid, brandId, now: (deps.now || Date.now)(), clock: deps.clock, bind: true, token: expectedVersion }); } catch (e) { return refuse('unavailable', { retryable: true }); }
  return r && r.ok === true ? reply(200, { ok: true }) : refuse((r && r.error) || 'unavailable');
}

module.exports = { createBranchDraftCore, updateBranchProfileCore, setBranchActiveCore, deleteBranchDraftCore, publishAfterCommit, isLegacyBranch, E6_KEYS, GROUP_CAP, PUBLISH_TIMEOUT_MS };
