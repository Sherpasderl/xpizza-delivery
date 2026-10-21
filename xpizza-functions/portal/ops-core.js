'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5) — the branch-operations cores behind the five portal ops endpoints.
// Every decision lives here, dependency-injected, so the REAL HTTP handlers (portal/ops-functions.js) are thin wrappers
// and the emulator suite drives these exact functions through them.
//
//   E1 getMyBranchesCore         GET   → { brands, branches }        discovery + the read model of the three client scopes
//   E2 updateBranchCore          POST  { rid, expectedVersion, patch: { prep_default_min } }   the ONE identity write of 1a
//   E3 setBranchPauseCore        POST  { rid, op:'pause', dur_min, reason } | { rid, op:'resume' }   via writePause, unmodified
//   E4 getBranchAvailabilityCore GET   ?restaurantId= | ?brandId=   each branch's OWN published menu + its sold-out keys
//   E5 setBranchAvailabilityCore POST  { rids, key, available }     all-or-nothing, ONE root update
//
// AUTHORIZATION: a verified ID token (customer / handheld refused before any read), then resolveAccess PER requested rid,
// then can(access, '<capability>'). Never a role or tier check; member_of is only myLocations' discovery. A throwing
// membership read is 'unavailable' → 503, never a lower role.
const { resolveAccess, myLocations, can } = require('../access/membership');
const { isBrandId } = require('../brands/brand-model');
const { isRoutingValid } = require('../restaurant-config');
const { effectiveState } = require('../order-control-state');
const { isOpenAt } = require('../scheduled-orders');
const { writePause } = require('../merchant/merchant-control');
const { availKey } = require('../avail-key');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { readVersionMenu } = require('../catalog/catalog-menu');
const { hnDateISO } = require('../lib/hn-date');
const { displayName } = require('./location-name');
const { PAUSE_REASONS } = require('./pause-reasons');
const { effectiveResetList } = require('./reset-list');
const { writesEnabled } = require('../access/writes-flag');   // the SAME source of truth as the team writes (PLAN-portal-team-invites §4.1)

const reply = (status, body) => ({ status, body });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const val = async (db, p) => (await db.ref(p).once('value')).val();

const OPS_CAPS = Object.freeze(['location.prep', 'location.pause', 'availability.set']);
const PREP_MIN = 5;
const PREP_MAX = 120;
// A CAS version must be incrementable: an integer, ≥ 0, strictly below VERSION_LIMIT. 10^15, not MAX_SAFE_INTEGER: an RTDB
// transaction on a node holding a larger integer may never verify its commit (emulator probe: 10^15−1 → 10^15 and
// 10^15 → 10^15+1 commit; 2^50−1, 2^52−1 and 2^53−2 fail with maxretry). Production versions are single digits.
const VERSION_LIMIT = 1e15;
const okVersion = (v) => Number.isSafeInteger(v) && v >= 0 && v < VERSION_LIMIT;
const okPrep = (v) => typeof v === 'number' && Number.isInteger(v) && v >= PREP_MIN && v <= PREP_MAX;
const PAUSE_DUR_MS = new Map([[30, 30 * 60000], [60, 60 * 60000], [null, null]]);
const MAX_RIDS = 50;

// ── auth ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The same verification sequence as getMyRestaurantsCore: Bearer header only, the real verifier, and the customer /
// handheld refusal BEFORE any read.
async function verifiedContext({ verifyIdToken }, req) {
  const header = (req && typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { fail: reply(401, { error: 'missing_bearer_token' }) };
  let decoded;
  try { decoded = await verifyIdToken(token); } catch (_) { return { fail: reply(401, { error: 'invalid_credentials' }) }; }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return { fail: reply(401, { error: 'invalid_credentials' }) };
  if (decoded.customer === true || decoded.handheld === true) return { fail: reply(403, { error: 'not_authorized' }) };
  return { ctx: { uid: decoded.uid, token: decoded } };
}

// resolveAccess → the access result, or the reply to send. 'unavailable' is an outage (503); every other refusal is 403.
async function accessFor(db, ctx, rid) {
  const a = await resolveAccess({ db }, ctx, rid);
  if (a && a.ok === true) return { access: a };
  if (a && a.code === 'unavailable') return { fail: reply(503, { error: 'unavailable', retryable: true }) };
  return { fail: reply(403, { error: 'not_authorized' }) };
}

// ── E1 read model ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const nullControl = (state) => ({ state, paused_until: null, pause_reason: null, pause_since: null });

// precedence: inactive > paused > closed > open. ABSENT order_control = open (effectiveState). `unknown` only for a missing /
// malformed identity, a malformed control node, or a failed read.
function controlOf(identity, current, nowMs) {
  if (!isObj(identity) || !isRoutingValid(identity)) return nullControl('unknown');
  if (identity.active === false) return nullControl('inactive');
  const e = effectiveState(current, nowMs);
  if (e.state === 'unknown') return nullControl('unknown');
  if (e.state === 'paused') {
    return {
      state: 'paused',
      paused_until: e.until,
      pause_reason: isObj(current) && typeof current.reason === 'string' ? current.reason : null,
      pause_since: isObj(current) && Number.isFinite(current.since) ? current.since : null,
    };
  }
  return nullControl(isOpenAt(identity.hours, nowMs) ? 'open' : 'closed');
}

function editableOf(identity) {
  return { prep_default_min: isObj(identity) && okPrep(identity.prep_default_min) ? identity.prep_default_min : null };
}
const versionOf = (identity) => (isObj(identity) && okVersion(identity.version) ? identity.version : null);

async function operationalOf(db, rid, nowMs) {
  const [identity, current, handhelds, last] = await Promise.all([
    val(db, `restaurants/${rid}/identity`),
    val(db, `order_control/${rid}/current`),
    val(db, `restaurants/${rid}/handhelds`),
    val(db, `counters/order_display_seq/${rid}/${hnDateISO(nowMs)}/last`),
  ]);
  const id = isObj(identity) ? identity : null;
  return {
    identity_version: versionOf(id),
    editable: editableOf(id),
    readonly: {
      active: id && typeof id.active === 'boolean' ? id.active : null,
      radius_km: id && Number.isFinite(id.delivery_radius_km) ? id.delivery_radius_km : null,
      hours: id && isObj(id.hours) ? id.hours : null,
      phone: id && typeof id.phone === 'string' ? id.phone : null,
    },
    control: controlOf(id, current, nowMs),
    devices: isObj(handhelds) ? Object.keys(handhelds).length : 0,
    last_order_today: Number.isInteger(last) ? last : null,
  };
}

async function getMyBranchesCore({ db, verifyIdToken, now = () => Date.now(), log = console }, req) {
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const v = await verifiedContext({ verifyIdToken }, req);
  if (v.fail) return v.fail;
  let locs;
  try {
    locs = await myLocations({ db, onStale: (x) => log.warn('member_of_stale', JSON.stringify({ fn: 'getMyBranches', kind: x.kind })) }, v.ctx);
  } catch (e) {
    log.warn('portal_ops_unavailable', JSON.stringify({ fn: 'getMyBranches', error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'read_unavailable', retryable: true });
  }
  const nowMs = now();
  // the membership write freeze, for the shell's nav visibility only (the team endpoints enforce it themselves). Read in
  // parallel; writesEnabled never throws (missing / non-true / read error → false).
  const writesFlag = writesEnabled(db);
  // An AUTHORIZATION outage (resolveAccess 'unavailable' or a throw) is the whole reply's 503 — never a 200 that silently
  // drops a branch the caller may hold (codex 1a r1 P2-4). Only a failed read of an ALREADY-authorized branch's operational
  // fields degrades that one row.
  const AUTH_OUTAGE = Symbol('auth_outage');
  const rows = await Promise.all(locs.map(async (l) => {
    let a;
    try { a = await resolveAccess({ db }, v.ctx, l.rid); } catch (e) { a = { ok: false, code: 'unavailable' }; }
    if (!a || a.ok !== true) return a && a.code === 'unavailable' ? AUTH_OUTAGE : null;
    if (!a.caps.length) return null;
    try {
      const row = { rid: l.rid, brand_id: a.brandId, role: l.role, state: a.state, caps: a.caps, name: await displayName(db, l.rid) };
      // operational fields ONLY under a capability that justifies them (a stats-only / retired branch gets none)
      if (OPS_CAPS.some((c) => can(a, c))) Object.assign(row, await operationalOf(db, l.rid, nowMs));
      return row;
    } catch (e) {
      log.warn('portal_ops_branch_degraded', JSON.stringify({ fn: 'getMyBranches', rid: l.rid, error: String((e && e.message) || e).slice(0, 160) }));
      return { rid: l.rid, brand_id: a.brandId, degraded: true };
    }
  }));
  if (rows.includes(AUTH_OUTAGE)) {
    log.warn('portal_ops_unavailable', JSON.stringify({ fn: 'getMyBranches', error: 'access_unavailable' }));
    return reply(503, { error: 'unavailable', retryable: true });
  }
  const branches = rows.filter(Boolean);
  const brandIds = [...new Set(branches.map((b) => b.brand_id))].sort();
  let brands;
  try {
    brands = await Promise.all(brandIds.map(async (b) => {
      const n = await val(db, `brands/${b}/name`);
      return { brand_id: b, name: typeof n === 'string' && n.trim() ? n : b };
    }));
  } catch (e) {
    return reply(503, { error: 'read_unavailable', retryable: true });
  }
  return reply(200, { brands, branches, membership_writes_enabled: (await writesFlag) === true });
}

// ── E2 updateBranch (prep_default_min only) ───────────────────────────────────────────────────────────────────────────────
async function updateBranchCore({ db, verifyIdToken, log = console }, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  const { rid, expectedVersion, patch } = body;
  if (!isBrandId(rid)) return reply(400, { error: 'bad_rid' });
  if (!isObj(patch) || Object.keys(patch).length !== 1 || !Object.prototype.hasOwnProperty.call(patch, 'prep_default_min')) return reply(400, { error: 'bad_patch' });
  if (!okPrep(patch.prep_default_min)) return reply(400, { error: 'bad_prep' });
  if (!okVersion(expectedVersion)) return reply(400, { error: 'bad_version' });
  const v = await verifiedContext({ verifyIdToken }, req);
  if (v.fail) return v.fail;
  const r = await accessFor(db, v.ctx, rid);
  if (r.fail) return r.fail;
  if (!can(r.access, 'location.prep')) return reply(403, { error: 'not_authorized' });

  const next = patch.prep_default_min;
  let why = null;
  let from = null;
  let tx;
  try {
    tx = await db.ref(`restaurants/${rid}/identity`).transaction((cur) => {
      why = null;
      if (cur === null) { why = 'missing'; return null; }   // null-first safe: an existing node makes the server re-run us
      if (!isObj(cur) || !isRoutingValid(cur)) { why = 'malformed'; return undefined; }
      if (!okVersion(cur.version)) { why = 'version_overflow'; return undefined; }   // before stale: an admissible request reaches it
      if (cur.version !== expectedVersion) { why = 'stale'; return undefined; }
      if (cur.prep_default_min === next) { why = 'noop'; return undefined; }
      why = 'write';
      from = cur.prep_default_min === undefined ? null : cur.prep_default_min;
      // the node-level CAS: every other child — incl. server-owned flags and anything written concurrently (the
      // transaction re-runs on a changed node) — is carried through from `cur` exactly as read INSIDE the transaction.
      return { ...cur, prep_default_min: next, version: cur.version + 1 };
    }, undefined, false);
  } catch (e) {
    log.warn('portal_ops_unavailable', JSON.stringify({ fn: 'updateBranch', rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'unavailable', retryable: true });
  }
  const snap = tx && tx.snapshot;
  if (!snap || !snap.exists()) return reply(404, { error: 'identity_missing' });   // incl. an absent→absent COMMITTED transaction
  const s = snap.val();
  const current = { identity_version: versionOf(s), editable: editableOf(s) };
  if (tx.committed && why === 'write' && isObj(s) && s.version === expectedVersion + 1 && s.prep_default_min === next) {
    log.log(JSON.stringify({ evt: 'branch_update', rid, uid: v.ctx.uid, field: 'prep_default_min', from, to: next, version: s.version }));
    return reply(200, current);
  }
  if (!tx.committed && why === 'noop') return reply(200, { noop: true, ...current });
  if (why === 'stale') return reply(409, { error: 'stale_branch', ...current });
  if (why === 'malformed') return reply(409, { error: 'identity_malformed' });
  if (why === 'version_overflow') return reply(409, { error: 'version_overflow' });
  log.warn('portal_ops_update_unverified', JSON.stringify({ rid, committed: !!tx.committed, why }));
  return reply(500, { error: 'update_unverified' });
}

// ── E3 setBranchPause (writePause, unmodified) ────────────────────────────────────────────────────────────────────────────
// The handheld adapter's translation (merchant-location.js setPause), replicated exactly; the guard pins it.
function pauseSpecOf(body) {
  if (body.op === 'resume') return { op: 'resume', forMs: null, reason: 'reanudar' };
  if (body.op === 'pause') {
    const dur = body.dur_min === undefined ? undefined : body.dur_min;
    if (PAUSE_DUR_MS.has(dur) && PAUSE_REASONS.has(body.reason)) return { op: 'pause', forMs: PAUSE_DUR_MS.get(dur), reason: body.reason };
  }
  return null;
}

async function setBranchPauseCore(deps, req) {
  const { db, verifyIdToken, now = () => Date.now() } = deps;
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  if (!isBrandId(body.rid)) return reply(400, { error: 'bad_rid' });
  const spec = pauseSpecOf(body);
  if (!spec) return reply(400, { error: 'bad_pause' });
  const v = await verifiedContext({ verifyIdToken }, req);
  if (v.fail) return v.fail;
  const r = await accessFor(db, v.ctx, body.rid);
  if (r.fail) return r.fail;
  if (!can(r.access, 'location.pause')) return reply(403, { error: 'not_authorized' });
  let out;
  try {
    out = await writePause({ db, now, timestamp: deps.timestamp, newOpId: deps.newOpId }, body.rid,
      { ...spec, actor: `portal:${v.ctx.uid}`, principal: v.ctx.uid });
  } catch (e) {
    return reply(503, { error: 'unavailable', retryable: true });
  }
  if (!out || out.ok !== true) return reply(409, { error: out && out.code === 'superseded' ? 'superseded' : 'refused' });
  let control;
  try {
    const [identity, current] = await Promise.all([val(db, `restaurants/${body.rid}/identity`), val(db, `order_control/${body.rid}/current`)]);
    control = controlOf(identity, current, now());
  } catch (_) { control = nullControl('unknown'); }
  return reply(200, { ok: true, noop: out.noop === true, control });
}

// ── E4 / E5 published menus ───────────────────────────────────────────────────────────────────────────────────────────────
function categoryNames(structure) {
  const names = new Map();
  const walk = (list) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!isObj(c)) continue;
      if (typeof c.id === 'string' && typeof c.name === 'string') names.set(c.id, c.name);
      walk(c.subcats);
    }
  };
  walk(isObj(structure) ? structure.categories : null);
  return names;
}

function projectMenu(menu) {
  const cats = categoryNames(menu.structure);
  return menu.items.map((it) => {
    const d = isObj(it.display) ? it.display : {};
    const cat = typeof d.cat === 'string' ? d.cat : null;
    return {
      key: it.key,
      name: typeof d.name === 'string' ? d.name : it.key,
      category_id: cat,
      category_name: cat && cats.has(cat) ? cats.get(cat) : null,
      price: it.price,
      description: typeof d.desc === 'string' ? d.desc : '',
    };
  });
}

// The WHOLE per-rid pointer + menu read in one try: ANY throw → that rid alone is menu_unavailable (code logged, never sent).
async function publishedMenuOf(fs, rid, log) {
  try {
    const versionId = await getActiveVersionId(fs, rid);
    if (versionId == null) return { rid, published: false, items: [] };
    const menu = await readVersionMenu(fs, rid, versionId);
    return { rid, published: true, items: projectMenu(menu) };
  } catch (e) {
    log.warn(JSON.stringify({ evt: 'branch_menu_unavailable', rid, code: (e && (e.code || e.cause_code)) || 'error' }));
    return { rid, published: null, error: 'menu_unavailable', items: [] };
  }
}

async function soldOutOf(db, rid, items) {
  const node = await val(db, `restaurants/${rid}/item_availability`);
  if (!isObj(node)) return [];
  return items.filter((it) => isObj(node[availKey(it.key)]) && node[availKey(it.key)].available === false).map((it) => it.key);
}

async function getBranchAvailabilityCore({ db, fs, verifyIdToken, env = process.env, log = console }, req) {
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const q = (req && req.query) || {};
  const one = q.restaurantId, brand = q.brandId;
  if ((one === undefined) === (brand === undefined)) return reply(400, { error: 'bad_query' });
  if (!isBrandId(one === undefined ? brand : one)) return reply(400, { error: 'bad_query' });
  const v = await verifiedContext({ verifyIdToken }, req);
  if (v.fail) return v.fail;

  let rids;
  if (one !== undefined) {
    const r = await accessFor(db, v.ctx, one);
    if (r.fail) return r.fail;
    if (!can(r.access, 'availability.set')) return reply(403, { error: 'not_authorized' });
    rids = [one];
  } else {
    let locs;
    try { locs = await myLocations({ db }, v.ctx); } catch (_) { return reply(503, { error: 'read_unavailable', retryable: true }); }
    rids = [];
    for (const l of locs) {
      if (l.brand_id !== brand) continue;
      const a = await resolveAccess({ db }, v.ctx, l.rid);
      if (a && a.ok === false && a.code === 'unavailable') return reply(503, { error: 'unavailable', retryable: true });
      if (can(a, 'availability.set') && a.brandId === brand) rids.push(l.rid);
    }
    if (!rids.length) return reply(403, { error: 'not_authorized' });
  }

  const resets = effectiveResetList(env);
  const out = await Promise.all(rids.map(async (rid) => {
    const m = await publishedMenuOf(fs, rid, log);
    const row = { rid: m.rid, published: m.published, items: m.items, unavailable: [], resets_daily: resets.includes(rid) };
    if (m.error) row.error = m.error;
    else if (m.published) {
      try { row.unavailable = await soldOutOf(db, rid, m.items); } catch (_) { row.error = 'availability_unavailable'; }
    }
    return row;
  }));
  if (out.every((r) => r.error)) return reply(503, { error: 'unavailable', retryable: true });
  return reply(200, { branches: out });
}

async function setBranchAvailabilityCore({ db, fs, verifyIdToken, timestamp, log = console }, req) {
  if (!req || req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const body = isObj(req.body) ? req.body : {};
  const { rids, key, available } = body;
  if (!Array.isArray(rids) || !rids.length || rids.length > MAX_RIDS || new Set(rids).size !== rids.length || !rids.every(isBrandId)) return reply(400, { error: 'bad_rids' });
  if (typeof key !== 'string' || key.length < 1 || key.length > 120) return reply(400, { error: 'bad_key' });
  if (typeof available !== 'boolean') return reply(400, { error: 'bad_available' });
  const v = await verifiedContext({ verifyIdToken }, req);
  if (v.fail) return v.fail;
  // EVERY target authorized before anything is read or written
  for (const rid of rids) {
    const r = await accessFor(db, v.ctx, rid);
    if (r.fail) return r.fail;
    if (!can(r.access, 'availability.set')) return reply(403, { error: 'not_authorized' });
  }
  // EVERY target must publish the key
  const menus = await Promise.all(rids.map((rid) => publishedMenuOf(fs, rid, log)));
  if (menus.some((m) => m.error)) return reply(503, { error: 'unavailable', retryable: true });
  if (menus.some((m) => !m.published || !m.items.some((it) => it.key === key))) return reply(400, { error: 'unknown_item' });
  const k = availKey(key);
  const ts = timestamp();
  const updates = {};
  for (const rid of rids) {
    updates[`restaurants/${rid}/item_availability/${k}`] = { available, updated_at: ts };
    updates[`restaurants/${rid}/availability_audit/${k}`] = { available, updated_at: ts, updated_by: `portal:${v.ctx.uid}` };
  }
  try { await db.ref().update(updates); } catch (e) { return reply(503, { error: 'unavailable', retryable: true }); }
  return reply(200, { ok: true, results: rids.map((rid) => ({ rid, key, available })) });
}

module.exports = {
  getMyBranchesCore, updateBranchCore, setBranchPauseCore, getBranchAvailabilityCore, setBranchAvailabilityCore,
  controlOf, pauseSpecOf, projectMenu, verifiedContext, OPS_CAPS, okVersion, VERSION_LIMIT,
};
