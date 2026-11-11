'use strict';
// DELIVERY PRICING WRITER (PLAN-delivery-pricing-app-only r2 §3 + the advisor's build conditions, 2026-11-10) — the owner-only
// «Envío» callables' decisions. The portal SCREEN is a separate mockup; this is its server contract.
//
// AUTH: a verified ID token (customer / handheld refused before any read) → platform_admins/{uid} === true (owner-granted by CLI;
// RTDB rules closed). A failed admin read is an outage (503), never a lower role.
// REGISTRY: readNow() — a FRESH read or 503. Never the floor / last-good set (known()), which a failure would silently serve.
// WRITE: ONE transaction on platform_config/delivery_pricing (no sibling is read or contended). The node carries its own bounded
// audit: `history`, the last HISTORY_MAX changes newest first, each { actor_uid, prev_version, new_version, new, at,
// prev_malformed?, history_reset? } — `prev` is the next-older entry's `new`, so it is not repeated. The policy and its entry
// are one value: atomic by construction. Success is reported only from the last callback's decision AND the committed snapshot.
// The ORDER PATH's reader (delivery-pricing.js readPricing) is untouched; every node this writer accepts reads back exactly.
const { isDeepStrictEqual } = require('util');
const { verifiedContext, okVersion } = require('../portal/ops-core');

const PATH = 'platform_config/delivery_pricing';
const CAPS = Object.freeze({ max_bands: 20, max_km: 10, max_cents: 15000 });   // owner 2026-11-10: ≤ 20 bands, ≤ 10 km, ≤ L 150 a band
const HISTORY_MAX = 10;
// The order path reads this node on every order: its worst case at the caps (20 bands, 10 history entries, the largest versions),
// UTF-8 bytes of the JSON — pinned by pricing-admin.test.js for 2 and 50 restaurants.
const READ_BYTES_AT_CAPS = Object.freeze({ 2: 9544, 50: 38584 });

const reply = (status, body) => ({ status, body });
const UNAVAILABLE = () => reply(503, { error: 'unavailable', retryable: true });
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const exactKeys = (o, req, opt = []) => isObj(o) && req.every((k) => Object.prototype.hasOwnProperty.call(o, k)) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));
const PATH_SAFE = /^[^.#$[\]/]{1,128}$/;

// bands → null (ok) | 'bands' (shape) | 'band_caps'
function bandsProblem(bands) {
  if (!Array.isArray(bands) || bands.length === 0) return 'bands';
  let prev = 0;
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (!exactKeys(b, ['max_km', 'cents'])) return 'bands';
    if (!(typeof b.max_km === 'number' && Number.isFinite(b.max_km) && b.max_km > prev)) return 'bands';
    if (!(Number.isSafeInteger(b.cents) && b.cents >= 0)) return 'bands';
    prev = b.max_km;
  }
  if (bands.length > CAPS.max_bands || bands.some((b) => b.max_km > CAPS.max_km || b.cents > CAPS.max_cents)) return 'band_caps';
  return null;
}
// restaurants → null | 'restaurants' (a NON-empty map of exact { active, free_delivery } booleans; RTDB drops an empty map)
function restaurantsProblem(rs) {
  if (!isObj(rs) || Object.keys(rs).length === 0) return 'restaurants';
  for (const [rid, v] of Object.entries(rs)) {
    if (!PATH_SAFE.test(rid) || !exactKeys(v, ['active', 'free_delivery']) || typeof v.active !== 'boolean' || typeof v.free_delivery !== 'boolean') return 'restaurants';
  }
  return null;
}
const policyOk = (bands, restaurants) => bandsProblem(bands) === null && restaurantsProblem(restaurants) === null;

// The POST body → { ok: true, value } | { ok: false, reply }. `ids`: the FRESH registry ids.
function validateWrite(body, ids) {
  const bad = (field) => ({ ok: false, reply: reply(400, { error: 'bad_request', field }) });
  if (!isObj(body)) return bad('body');
  if (!okVersion(body.expected_policy_version)) return bad('version');
  const bp = bandsProblem(body.bands); if (bp) return bad(bp);
  const rp = restaurantsProblem(body.restaurants); if (rp) return bad(rp);
  const known = new Set(ids);
  if (Object.keys(body.restaurants).some((rid) => !known.has(rid))) return { ok: false, reply: reply(400, { error: 'unknown_restaurant' }) };
  const bands = body.bands.map((b) => ({ max_km: b.max_km, cents: b.cents }));
  const restaurants = Object.fromEntries(Object.entries(body.restaurants).map(([k, v]) => [k, { active: v.active, free_delivery: v.free_delivery }]));
  return { ok: true, value: { expected: body.expected_policy_version, bands, restaurants } };
}

// One stored history entry, exactly (C1): dense, exact keys, typed.
function entryOk(e) {
  if (!exactKeys(e, ['actor_uid', 'prev_version', 'new_version', 'new', 'at'], ['prev_malformed', 'history_reset'])) return false;
  if (typeof e.actor_uid !== 'string' || !e.actor_uid) return false;
  if (!okVersion(e.prev_version) || !okVersion(e.new_version) || e.new_version < 1) return false;
  if (!(typeof e.at === 'number' && Number.isFinite(e.at))) return false;
  if ('prev_malformed' in e && e.prev_malformed !== true) return false;
  if ('history_reset' in e && e.history_reset !== true) return false;
  return exactKeys(e.new, ['bands', 'restaurants']) && policyOk(e.new.bands, e.new.restaurants);
}
function historyOk(h) {
  if (!Array.isArray(h) || h.length > HISTORY_MAX) return false;
  for (let i = 0; i < h.length; i++) if (!Object.prototype.hasOwnProperty.call(h, i) || !entryOk(h[i])) return false;
  return true;
}

// auth + fresh registry → { uid, ids } | { fail }
async function admit(deps, req) {
  const v = await verifiedContext({ verifyIdToken: deps.verifyIdToken }, req);
  if (v.fail) return { fail: v.fail };
  const uid = v.ctx.uid;
  if (!PATH_SAFE.test(uid)) return { fail: reply(403, { error: 'not_authorized' }) };
  let admin;
  try { admin = (await deps.db.ref(`platform_admins/${uid}`).once('value')).val(); } catch (_) { return { fail: UNAVAILABLE() }; }
  if (admin !== true) return { fail: reply(403, { error: 'not_authorized' }) };
  let reg;
  try { reg = await deps.readRegistry(); } catch (_) { return { fail: UNAVAILABLE() }; }
  if (!reg || reg.ok !== true || reg.fresh !== true || !Array.isArray(reg.ids)) return { fail: UNAVAILABLE() };
  return { uid, ids: reg.ids };
}

async function getDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  let cur;
  try { cur = (await deps.db.ref(PATH).once('value')).val(); } catch (_) { return UNAVAILABLE(); }
  const common = { caps: { ...CAPS }, known_restaurants: [...a.ids] };
  if (cur === null || cur === undefined) return reply(200, { policy_version: 0, bands: [], restaurants: {}, history: [], ...common });
  const pv = isObj(cur) ? cur.policy_version : undefined;
  if (!isObj(cur) || !(okVersion(pv) && pv >= 1) || !policyOk(cur.bands, cur.restaurants)) {
    return reply(200, { current_malformed: true, policy_version_raw: typeof pv === 'number' || typeof pv === 'string' ? pv : null, ...common });
  }
  return reply(200, { policy_version: pv, bands: cur.bands, restaurants: cur.restaurants, history: historyOk(cur.history) ? cur.history : [], ...common });
}

async function setDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  const v = validateWrite(req && req.body, a.ids);
  if (!v.ok) return v.reply;
  const { expected, bands, restaurants } = v.value;
  const at = deps.timestamp();
  let last = null;   // the LAST callback's decision (reset on every invocation — the SDK re-runs the callback)
  let tx;
  try {
    tx = await deps.db.ref(PATH).transaction((cur) => {
      const d = { why: null, current: null };
      last = d;
      if (cur === null) {
        if (expected !== 0) { d.why = 'stale_null'; return null; }   // null-first safe: an existing node makes the server re-run us
        d.why = 'write';
        return nodeOf({ prevVersion: 0, prevMalformed: false, kept: [], reset: false });
      }
      const pv = isObj(cur) ? cur.policy_version : undefined;
      if (!isObj(cur) || !(okVersion(pv) && pv >= 1)) { d.why = 'current_malformed'; return undefined; }
      if (pv !== expected) { d.why = 'superseded'; d.current = pv; return undefined; }
      const keep = historyOk(cur.history);
      d.why = 'write';
      return nodeOf({ prevVersion: pv, prevMalformed: !policyOk(cur.bands, cur.restaurants), kept: keep ? cur.history : [], reset: !keep && cur.history !== undefined });
    }, undefined, false);
  } catch (_) {
    return UNAVAILABLE();
  }
  function nodeOf({ prevVersion, prevMalformed, kept, reset }) {
    const entry = { actor_uid: a.uid, prev_version: prevVersion, new_version: prevVersion + 1, new: { bands, restaurants }, at,
      ...(prevMalformed ? { prev_malformed: true } : {}), ...(reset ? { history_reset: true } : {}) };
    return { policy_version: prevVersion + 1, bands, restaurants, history: [entry, ...kept].slice(0, HISTORY_MAX), updated_at: at, updated_by: a.uid };
  }
  const why = last && last.why;
  if (why === 'superseded') return reply(409, { error: 'superseded', current_version: last.current });
  if (why === 'current_malformed') return reply(409, { error: 'current_malformed' });
  const snap = tx && tx.snapshot;
  const s = snap && snap.exists() ? snap.val() : null;
  if (why === 'stale_null') return s === null ? reply(409, { error: 'superseded', current_version: 0 }) : UNAVAILABLE();
  if (why !== 'write' || !tx.committed || !isObj(s)) return UNAVAILABLE();
  const want = expected + 1;
  const h0 = Array.isArray(s.history) ? s.history[0] : null;
  if (s.policy_version !== want || !isDeepStrictEqual(s.bands, bands) || !isDeepStrictEqual(s.restaurants, restaurants)
    || !isObj(h0) || h0.new_version !== want || !isDeepStrictEqual(h0.new, { bands, restaurants })) return UNAVAILABLE();
  return reply(200, { ok: true, policy_version: want });
}

module.exports = { PATH, CAPS, HISTORY_MAX, READ_BYTES_AT_CAPS, validateWrite, historyOk, getDeliveryPricingCore, setDeliveryPricingCore };
