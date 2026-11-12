'use strict';
// DELIVERY PRICING WRITER (PLAN-delivery-pricing-app-only r2 §3 + the advisor's build conditions + addendum A, 2026-11-10) — the
// owner-only «Envío» callables' decisions. The portal SCREEN is a separate mockup; this is its server contract.
// THE POLICY is ONE platform-wide band table (addendum A): every Sherpa restaurant is priced by it on the app path, with no
// per-restaurant map and no free delivery; bands in 0.5 km steps.
//
// AUTH: a verified ID token (customer / handheld refused before any read) → platform_admins/{uid} === true (owner-granted by CLI;
// RTDB rules closed). A failed admin read is an outage (503), never a lower role.
// WRITE: ONE transaction on platform_config/delivery_pricing (no sibling is read or contended). The node carries its own bounded
// audit: `history`, the last HISTORY_MAX changes newest first, each { actor_uid, prev_version, new_version, new: { bands }, at,
// prev_malformed?, history_reset? } — `prev` is the next-older entry's `new`, so it is not repeated. The policy and its entry
// are one value: atomic by construction. Success is reported only from the last callback's decision AND the committed snapshot.
// The ORDER PATH's reader (delivery-wire.js loadPricing over readPricing) reads every node this writer accepts back exactly.
const { isDeepStrictEqual } = require('util');
const { verifiedContext, okVersion } = require('../portal/ops-core');
const Z = require('./zones');            // envío step 2: drawn no-delivery zones (PLAN-envio-zones-step2-r2)
const ZL = require('./zones-lock');      // envío step 2: zones change only while every restaurant is closed (owner D1)
const DP = require('./delivery-pricing'); // envío restaurant limit (PLAN-envio-restaurant-limit-r5): the ONE per-branch entry reader
const crypto = require('crypto');

const PATH = 'platform_config/delivery_pricing';
const CAPS = Object.freeze({ max_bands: 20, max_km: 10, max_cents: 15000, km_step: 0.5 });   // owner 2026-11-10: ≤ 20 bands, ≤ 10 km in 0.5 km steps, ≤ L 150 a band
const HISTORY_MAX = 10;
// r5 §1/§4: ≤ 200 limits per request; the stored map ≤ the fresh registry's branch count and ≤ 300 entries (checked on the RESULT)
const LIMITS = Object.freeze({ per_request: 200, stored_max: 300 });
// a limit rid is a REGISTRY id: catalog/restaurant-registry.js RID_RE (≤ 40 ASCII) — so a stored key, and the node every order reads, stay bounded
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
// The order path reads this node on every order: its TRUE legal maximum (Codex zones build r1 #4 / r2 #4), MEASURED on the complete node
// the REAL writer commits: one save at the top version (VERSION_LIMIT − 1) by a 128-unit admin uid of 3-byte characters, over the worst
// history the writer RETAINS (9 entries entryOk accepts: 128-unit uids JSON-escaping to 6 bytes each, both flags, top versions, safe-int
// clocks, 20 band caps, an 8-zone summary), with 20 bands at the caps and 8 × 24-point zones at the worst legal encoding within
// |lat| ≤ 60, plus (envío restaurant limit r5 §6) the per-branch map at its cap (300 × the longest registry id with max_km 9.5) after the
// worst LEGAL request (200 mutations: 100 deletions + 100 new entries → 3-digit summary counts), each retained entry's limits summary at its
// bounds — UTF-8 bytes of the JSON; pinned by delivery/zones-writer.test.js.
const READ_BYTES_AT_CAPS = 40898;

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { error: 'unavailable', retryable: true });
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (o, req, opt = []) => isObj(o) && req.every((k) => Object.prototype.hasOwnProperty.call(o, k)) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));
const PATH_SAFE = /^[^.#$[\]/]{1,128}$/;
// Codex build r1 F1 + advisor r2: an actor uid is bounded by LENGTH only — Firebase's own limit, 1..128 UTF-16 code units, any
// characters (custom UIDs need not be alphanumeric: an owner is never locked out). A retained history entry's bytes are then
// bounded by construction (the pinned order-path read size is the true worst case).
const uidOk = (u) => typeof u === 'string' && u.length >= 1 && u.length <= 128;

// bands → null (ok) | 'bands' (shape) | 'band_caps'
function bandsProblem(bands) {
  if (!Array.isArray(bands) || bands.length === 0) return 'bands';
  let prev = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (!exactKeys(b, ['max_km', 'cents'])) return 'bands';
    if (!(typeof b.max_km === 'number' && Number.isFinite(b.max_km) && b.max_km > prev && Number.isInteger(b.max_km / CAPS.km_step))) return 'bands';   // 0.5 km steps: exact in binary
    if (!(Number.isSafeInteger(b.cents) && b.cents >= 0 && b.cents % 100 === 0)) return 'bands';   // whole lempiras, as the owner's screen shows
    prev = b.max_km;
  }
  if (bands.length > CAPS.max_bands || bands.some((b) => b.max_km > CAPS.max_km || b.cents > CAPS.max_cents)) return 'band_caps';
  return null;
}
const bandsOk = (bands) => bandsProblem(bands) === null;

// r5 §4: `limits: [{ rid, km }]` → null | the 400 reason. km ∈ [0.5, the NEW top] on a .5 step; km null DELETES (server-only); a rid that
// is not a registry id (RID_RE) is unknown_rid (a client bug). Registration and identity are checked against FRESH reads in the save (directory_changed).
function limitsProblem(limits, top) {
  if (!Array.isArray(limits) || limits.length === 0) return 'shape';
  if (limits.length > LIMITS.per_request) return 'too_many';
  const seen = new Set();
  for (const e of limits) {
    if (!exactKeys(e, ['rid', 'km']) || typeof e.rid !== 'string' || !(e.km === null || (typeof e.km === 'number' && Number.isFinite(e.km)))) return 'shape';
    if (!RID_RE.test(e.rid)) return 'unknown_rid';
    if (seen.has(e.rid)) return 'duplicate_rid';
    seen.add(e.rid);
    if (e.km === null) continue;
    if (!Number.isInteger(e.km / CAPS.km_step)) return 'step';
    if (e.km < CAPS.km_step || e.km > top) return 'range';
  }
  return null;
}
// the canonical (sorted-key) JSON of a stored map, and its sha256 — the history records the RESULT by count + fingerprint (r5 P2-7)
const canonJson = (v) => (isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonJson(v[k])}`).join(',')}}` : JSON.stringify(v));
const mapSha = (m) => crypto.createHash('sha256').update(canonJson(m)).digest('hex');

// The POST body (exactly { expected_policy_version, bands }) → { ok: true, value } | { ok: false, reply }.
function validateWrite(body) {
  const bad = (field) => ({ ok: false, reply: reply(400, { error: 'bad_request', field }) });
  if (!exactKeys(body, ['expected_policy_version', 'bands'], ['no_delivery_zones', 'limits'])) return bad('body');
  if (!okVersion(body.expected_policy_version)) return bad('version');
  const bp = bandsProblem(body.bands); if (bp) return bad(bp);
  // step 2: present → the full list REPLACES the stored one (normalized, every rule after rounding); absent → the stored list is kept
  let zones;
  if ('no_delivery_zones' in body) {
    const zr = Z.normalizeInput(body.no_delivery_zones);
    if (!zr.ok) return { ok: false, reply: reply(400, { error: 'bad_request', field: zr.problem, ...(zr.zone_id ? { zone_id: zr.zone_id } : {}), part: zr.field }) };
    zones = zr.zones;
  }
  let limits;
  if ('limits' in body) { const lp = limitsProblem(body.limits, body.bands[body.bands.length - 1].max_km); if (lp) return { ok: false, reply: reply(400, { error: 'bad_request', field: 'limits', reason: lp }) }; limits = body.limits.map((e) => ({ rid: e.rid, km: e.km })); }
  return { ok: true, value: { expected: body.expected_policy_version, bands: body.bands.map((b) => ({ max_km: b.max_km, cents: b.cents })), zones, limits } };
}

// One stored history entry, exactly (C1): dense, exact keys, typed.
function entryOk(e) {
  if (!exactKeys(e, ['actor_uid', 'prev_version', 'new_version', 'new', 'at'], ['prev_malformed', 'history_reset'])) return false;
  if (!uidOk(e.actor_uid)) return false;
  if (!okVersion(e.prev_version) || !okVersion(e.new_version) || e.new_version < 1) return false;
  if (!(Number.isSafeInteger(e.at) && e.at >= 0)) return false;
  if ('prev_malformed' in e && e.prev_malformed !== true) return false;
  if ('history_reset' in e && e.history_reset !== true) return false;
  if (!exactKeys(e.new, ['bands'], ['zones', 'limits']) || !bandsOk(e.new.bands)) return false;
  if ('limits' in e.new && !(exactKeys(e.new.limits, ['set', 'deleted', 'sha256']) && [e.new.limits.set, e.new.limits.deleted].every((c) => Number.isSafeInteger(c) && c >= 0 && c <= LIMITS.stored_max) && typeof e.new.limits.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.new.limits.sha256))) return false;   // r5: the limits summary
  // step 2: the zones are recorded by count + fingerprint only (owner D4: never the shapes — the order path reads this node)
  return !('zones' in e.new) || (exactKeys(e.new.zones, ['count', 'sha256']) && Number.isSafeInteger(e.new.zones.count) && e.new.zones.count >= 0 && e.new.zones.count <= Z.CAPS.zones_max && typeof e.new.zones.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.new.zones.sha256));
}
function historyOk(h) {
  if (!Array.isArray(h) || h.length > HISTORY_MAX) return false;
  for (let i = 0; i < h.length; i++) if (!Object.prototype.hasOwnProperty.call(h, i) || !entryOk(h[i])) return false;
  return true;
}

// auth → { uid } | { fail }
async function admit(deps, req) {
  const v = await verifiedContext({ verifyIdToken: deps.verifyIdToken }, req);
  if (v.fail) return { fail: v.fail };
  const uid = v.ctx.uid;
  if (!uidOk(uid)) return { fail: reply(403, { error: 'not_authorized' }) };
  let admin;
  try { admin = (await deps.db.ref(`platform_admins/${uid}`).once('value')).val(); } catch (_) { return { fail: UNAVAILABLE() }; }
  if (admin !== true) return { fail: reply(403, { error: 'not_authorized' }) };
  return { uid };
}

// G2 (advisor 2026-11-10): EVERY registry branch for the admin picker — { rid, brand_id, brand_name, location_name, hub } and nothing
// else (no phone, no address). The registry must be FRESH (readNow) and every read must succeed; otherwise null (the caller says
// branches_unavailable) — never a partial list. A registered branch without an identity yet is listed with nulls.
const str = (x) => (typeof x === 'string' && x.trim() ? x : null);
const coord = (x) => typeof x === 'number' && Number.isFinite(x);
async function branchesOf(deps) {
  try {
    const reg = await deps.readRegistry();
    if (!reg || reg.ok !== true || reg.fresh !== true || !Array.isArray(reg.ids)) return null;
    const ids = [...new Set(reg.ids)].filter((rid) => PATH_SAFE.test(rid)).sort();
    const brandName = new Map();
    const rows = await Promise.all(ids.map(async (rid) => {
      const id = (await deps.db.ref(`restaurants/${rid}/identity`).once('value')).val();
      const o = isObj(id) ? id : {};
      const brand_id = str(o.brand_id) && PATH_SAFE.test(o.brand_id) ? o.brand_id : null;
      if (brand_id && !brandName.has(brand_id)) brandName.set(brand_id, deps.db.ref(`brands/${brand_id}/name`).once('value').then((sn) => ({ ok: true, name: str(sn.val()) }), () => ({ ok: false })));
      return { rid, brand_id, name: str(o.name), location_name: str(o.location_name), hub: coord(o.hub_lat) && coord(o.hub_lng) ? { lat: o.hub_lat, lng: o.hub_lng } : null, editable: isObj(id) };
    }));
    const out = [];
    for (const r of rows) {
      const b = r.brand_id ? await brandName.get(r.brand_id) : { ok: true, name: null };
      if (!b.ok) return null;
      out.push({ rid: r.rid, brand_id: r.brand_id, brand_name: b.name || r.name, location_name: r.location_name, hub: r.hub, limit_editable: r.editable });
    }
    return out;
  } catch (_) {
    return null;
  }
}

// r5 §3: one branch's limit fields, from the policy node this GET already read (JSON-safe: a malformed entry is limit_invalid, never the top)
function limitRow(cur, rid) {
  const top = isObj(cur) && bandsOk(cur.bands) ? cur.bands[cur.bands.length - 1].max_km : null;
  const m = isObj(cur) && isObj(cur.restaurants) && Object.prototype.hasOwnProperty.call(cur.restaurants, rid) ? DP.limitEntry(cur.restaurants[rid]) : undefined;
  if (m === DP.LIMIT_INVALID) return { max_km: null, effective_km: null, above_top: false, limit_invalid: true };
  const max = typeof m === 'number' ? m : null;
  return { max_km: max, effective_km: top === null ? null : max === null ? top : Math.min(top, max), above_top: top !== null && max !== null && max > top, limit_invalid: false };
}

async function getDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  let cur;
  const branchesP = branchesOf(deps);   // in parallel with the policy read; never rejects
  try { cur = (await deps.db.ref(PATH).once('value')).val(); } catch (_) { return UNAVAILABLE(); }
  const list = await branchesP;
  const caps = { ...CAPS, ...Z.CAPS };
  const dir = list ? { branches: list.map((r) => ({ ...r, ...limitRow(cur, r.rid) })) } : { branches_unavailable: true };
  const zones_editable = (await ZL.zonesLock(deps)).ok === true;   // advisory for the portal: the save re-runs the same check
  if (cur === null || cur === undefined) return reply(200, { policy_version: 0, bands: [], history: [], no_delivery_zones: [], zones_editable, caps, ...dir });
  const pv = isObj(cur) ? cur.policy_version : undefined;
  if (!isObj(cur) || !(okVersion(pv) && pv >= 1) || !bandsOk(cur.bands) || Z.storedProblem(cur.no_delivery_zones)) {
    return reply(200, { current_malformed: true, policy_version_raw: typeof pv === 'number' || typeof pv === 'string' ? pv : null, caps, ...dir });
  }
  return reply(200, { policy_version: pv, bands: cur.bands, history: historyOk(cur.history) ? cur.history : [], no_delivery_zones: Z.toPortal(cur.no_delivery_zones), zones_editable, caps, ...dir });
}

async function setDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  const v = validateWrite(req && req.body);
  if (!v.ok) return v.reply;
  const { expected, bands, zones, limits } = v.value;
  // r5 §1/§4: the per-branch map is carried by EVERY save. When there is a map (stored, or requested) the save reads the registry FRESH
  // (dead branches are pruned, requested rids must be registered with an identity → else directory_changed); an outage → 503, nothing written.
  let pre;
  try { pre = (await deps.db.ref(PATH).once('value')).val(); } catch (_) { return UNAVAILABLE(); }
  let reg = null;
  if (limits !== undefined || (isObj(pre) && pre.restaurants !== undefined)) {
    try { reg = await deps.readRegistry(); } catch (_) { return UNAVAILABLE(); }
    if (!reg || reg.ok !== true || reg.fresh !== true || !Array.isArray(reg.ids)) return UNAVAILABLE();
    reg = new Set(reg.ids.filter((rid) => typeof rid === 'string' && RID_RE.test(rid)));
    if (limits !== undefined) {
      let ids;
      try { ids = await Promise.all(limits.map((e) => (reg.has(e.rid) ? deps.db.ref(`restaurants/${e.rid}/identity`).once('value').then((sn) => isObj(sn.val())) : false))); } catch (_) { return UNAVAILABLE(); }
      if (ids.some((ok) => !ok)) return reply(400, { error: 'bad_request', field: 'limits', reason: 'directory_changed' });
    }
  }
  // step 2 (owner D1): a save that CHANGES the zones needs every restaurant closed — checked once, before the transaction (a
  // point-in-time owner rule; Codex r1 F3: the seconds until the commit are an accepted residual). Bands-only saves never read hours.
  let zonesCleared = false;
  if (zones !== undefined) {
    if (!Z.sameLogical(zones, isObj(pre) ? pre.no_delivery_zones : undefined)) {
      const lock = await ZL.zonesLock(deps);
      if (!lock.ok) return reply(lock.status, lock.body);
      zonesCleared = true;
    }
  }
  const at = deps.timestamp();
  const zonesSummary = (z) => ({ count: Z.logical(z).length, sha256: Z.sha(z) });   // the history's record of the zones (D4)
  let last = null;   // the LAST callback's decision (reset on every invocation — the SDK re-runs the callback)
  let tx;
  try {
    tx = await deps.db.ref(PATH).transaction((cur) => {
      const d = { why: null, current: null, zones: undefined, map: {}, summary: null };
      last = d;
      const curZ = isObj(cur) ? cur.no_delivery_zones : undefined;
      // step 2: an omitted field keeps the CURRENT stored list and its presence exactly (F6); a zones change not cleared by the lock
      // (the stored list moved after the pre-read) is superseded
      const newZ = zones === undefined ? curZ : zones;
      d.zones = newZ;
      if (cur === null) {   // the speculative null-first pass: a stale `expected` re-runs; expected 0 + an empty pre-read means any zones were cleared
        if (expected !== 0) { d.why = 'stale_null'; return null; }   // null-first safe: an existing node makes the server re-run us
        if (!mapOf(d, undefined)) return undefined;
        d.why = 'write';
        return nodeOf({ prevVersion: 0, prevMalformed: false, kept: [], reset: false, zonesNow: newZ });
      }
      const pv = isObj(cur) ? cur.policy_version : undefined;
      if (!isObj(cur) || !(okVersion(pv) && pv >= 1) || Z.storedProblem(curZ)) { d.why = 'current_malformed'; return undefined; }
      if (pv !== expected) { d.why = 'superseded'; d.current = pv; return undefined; }
      if (zones !== undefined && !zonesCleared && !Z.sameLogical(zones, curZ)) { d.why = 'superseded'; d.current = pv; return undefined; }   // the zones moved after the pre-read
      if (reg === null && cur.restaurants !== undefined) { d.why = 'superseded'; d.current = pv; return undefined; }   // a map appeared after the pre-read (no registry read)
      if (!mapOf(d, cur.restaurants)) return undefined;
      const keep = historyOk(cur.history);
      d.why = 'write';
      return nodeOf({ prevVersion: pv, prevMalformed: !bandsOk(cur.bands), kept: keep ? cur.history : [], reset: !keep && cur.history !== undefined, zonesNow: newZ });
    }, undefined, false);
  } catch (_) {
    return UNAVAILABLE();
  }
  // r5 §4: the new map, derived INSIDE the callback from the CURRENT stored one — legacy entries dropped, entries of unregistered rids
  // pruned, then `limits` applied (km null deletes); the RESULT is capped. → false (d.why set) | true (d.map, d.summary set)
  function mapOf(d, curMap) {
    const m = {};
    let set = 0, deleted = 0;
    // a stored limit (valid or malformed) of a branch no longer in the fresh registry is PRUNED — a deletion the history records
    // (Codex build r1 P2-4); a legacy {active, free_delivery} entry is not a limit and leaves without a trace
    if (isObj(curMap)) for (const [rid, e] of Object.entries(curMap)) if (DP.limitEntry(e) !== undefined) { if (reg && reg.has(rid)) m[rid] = e; else deleted++; }
    for (const { rid, km } of limits || []) {
      if (km === null) { if (rid in m) { delete m[rid]; deleted++; } continue; }
      if (!(isObj(m[rid]) && m[rid].max_km === km && Object.keys(m[rid]).length === 1)) set++;
      m[rid] = { max_km: km };
    }
    if (Object.keys(m).length > Math.min(reg ? reg.size : 0, LIMITS.stored_max)) { d.why = 'too_many'; return false; }
    d.map = m; d.summary = set + deleted > 0 ? { set, deleted, sha256: mapSha(m) } : null;
    return true;
  }
  function nodeOf({ prevVersion, prevMalformed, kept, reset, zonesNow }) {
    const entry = { actor_uid: a.uid, prev_version: prevVersion, new_version: prevVersion + 1, new: { bands, zones: zonesSummary(zonesNow), ...(last.summary ? { limits: last.summary } : {}) }, at,
      ...(prevMalformed ? { prev_malformed: true } : {}), ...(reset ? { history_reset: true } : {}) };
    // an empty zone list is the field ABSENT (RTDB prunes empty arrays; F6)
    return { policy_version: prevVersion + 1, bands, ...(Z.logical(zonesNow).length ? { no_delivery_zones: zonesNow } : {}), ...(Object.keys(last.map).length ? { restaurants: last.map } : {}), history: [entry, ...kept].slice(0, HISTORY_MAX), updated_at: at, updated_by: a.uid };   // r5: an empty map is the key ABSENT
  }
  const why = last && last.why;
  if (why === 'superseded') return reply(409, { error: 'superseded', current_version: last.current });
  if (why === 'current_malformed') return reply(409, { error: 'current_malformed' });
  if (why === 'too_many') return reply(400, { error: 'bad_request', field: 'limits', reason: 'too_many' });
  const snap = tx && tx.snapshot;
  const s = snap && snap.exists() ? snap.val() : null;
  if (why === 'stale_null') return s === null ? reply(409, { error: 'superseded', current_version: 0 }) : UNAVAILABLE();
  if (why !== 'write' || !tx.committed || !isObj(s)) return UNAVAILABLE();
  const want = expected + 1;
  const h0 = Array.isArray(s.history) ? s.history[0] : null;
  if (s.policy_version !== want || !isDeepStrictEqual(s.bands, bands) || !(Object.keys(last.map).length ? isDeepStrictEqual(s.restaurants, last.map) : !('restaurants' in s)) || !Z.sameLogical(s.no_delivery_zones, last.zones)
    || !isObj(h0) || h0.new_version !== want || !isDeepStrictEqual(h0.new, { bands, zones: zonesSummary(last.zones), ...(last.summary ? { limits: last.summary } : {}) })) return UNAVAILABLE();   // r5: presence-aware read-back of the map
  return reply(200, { ok: true, policy_version: want });
}

module.exports = { PATH, CAPS, LIMITS, HISTORY_MAX, READ_BYTES_AT_CAPS, validateWrite, historyOk, getDeliveryPricingCore, setDeliveryPricingCore };
