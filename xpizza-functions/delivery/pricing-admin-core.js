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

const PATH = 'platform_config/delivery_pricing';
const CAPS = Object.freeze({ max_bands: 20, max_km: 10, max_cents: 15000, km_step: 0.5 });   // owner 2026-11-10: ≤ 20 bands, ≤ 10 km in 0.5 km steps, ≤ L 150 a band
const HISTORY_MAX = 10;
// The order path reads this node on every order: its worst case at the caps (20 bands, 10 history entries, 128-char uids, the
// largest versions), UTF-8 bytes of the JSON — pinned by pricing-admin.test.js; independent of the restaurant count.
const READ_BYTES_AT_CAPS = 9258;

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
    if (!(typeof b.max_km === 'number' && Number.isFinite(b.max_km) && b.max_km > prev && Number.isInteger(b.max_km / CAPS.km_step))) return 'bands';   // 0.5 km steps: exact in binary
    if (!(Number.isSafeInteger(b.cents) && b.cents >= 0)) return 'bands';
    prev = b.max_km;
  }
  if (bands.length > CAPS.max_bands || bands.some((b) => b.max_km > CAPS.max_km || b.cents > CAPS.max_cents)) return 'band_caps';
  return null;
}
const bandsOk = (bands) => bandsProblem(bands) === null;

// The POST body (exactly { expected_policy_version, bands }) → { ok: true, value } | { ok: false, reply }.
function validateWrite(body) {
  const bad = (field) => ({ ok: false, reply: reply(400, { error: 'bad_request', field }) });
  if (!exactKeys(body, ['expected_policy_version', 'bands'])) return bad('body');
  if (!okVersion(body.expected_policy_version)) return bad('version');
  const bp = bandsProblem(body.bands); if (bp) return bad(bp);
  return { ok: true, value: { expected: body.expected_policy_version, bands: body.bands.map((b) => ({ max_km: b.max_km, cents: b.cents })) } };
}

// One stored history entry, exactly (C1): dense, exact keys, typed.
function entryOk(e) {
  if (!exactKeys(e, ['actor_uid', 'prev_version', 'new_version', 'new', 'at'], ['prev_malformed', 'history_reset'])) return false;
  if (typeof e.actor_uid !== 'string' || !e.actor_uid) return false;
  if (!okVersion(e.prev_version) || !okVersion(e.new_version) || e.new_version < 1) return false;
  if (!(typeof e.at === 'number' && Number.isFinite(e.at))) return false;
  if ('prev_malformed' in e && e.prev_malformed !== true) return false;
  if ('history_reset' in e && e.history_reset !== true) return false;
  return exactKeys(e.new, ['bands']) && bandsOk(e.new.bands);
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
  if (!PATH_SAFE.test(uid)) return { fail: reply(403, { error: 'not_authorized' }) };
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
      return { rid, brand_id, name: str(o.name), location_name: str(o.location_name), hub: coord(o.hub_lat) && coord(o.hub_lng) ? { lat: o.hub_lat, lng: o.hub_lng } : null };
    }));
    const out = [];
    for (const r of rows) {
      const b = r.brand_id ? await brandName.get(r.brand_id) : { ok: true, name: null };
      if (!b.ok) return null;
      out.push({ rid: r.rid, brand_id: r.brand_id, brand_name: b.name || r.name, location_name: r.location_name, hub: r.hub });
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function getDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  let cur;
  const branchesP = branchesOf(deps);   // in parallel with the policy read; never rejects
  try { cur = (await deps.db.ref(PATH).once('value')).val(); } catch (_) { return UNAVAILABLE(); }
  const list = await branchesP;
  const caps = { ...CAPS };
  const dir = list ? { branches: list } : { branches_unavailable: true };
  if (cur === null || cur === undefined) return reply(200, { policy_version: 0, bands: [], history: [], caps, ...dir });
  const pv = isObj(cur) ? cur.policy_version : undefined;
  if (!isObj(cur) || !(okVersion(pv) && pv >= 1) || !bandsOk(cur.bands)) {
    return reply(200, { current_malformed: true, policy_version_raw: typeof pv === 'number' || typeof pv === 'string' ? pv : null, caps, ...dir });
  }
  return reply(200, { policy_version: pv, bands: cur.bands, history: historyOk(cur.history) ? cur.history : [], caps, ...dir });
}

async function setDeliveryPricingCore(deps, req) {
  const a = await admit(deps, req);
  if (a.fail) return a.fail;
  const v = validateWrite(req && req.body);
  if (!v.ok) return v.reply;
  const { expected, bands } = v.value;
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
      return nodeOf({ prevVersion: pv, prevMalformed: !bandsOk(cur.bands), kept: keep ? cur.history : [], reset: !keep && cur.history !== undefined });
    }, undefined, false);
  } catch (_) {
    return UNAVAILABLE();
  }
  function nodeOf({ prevVersion, prevMalformed, kept, reset }) {
    const entry = { actor_uid: a.uid, prev_version: prevVersion, new_version: prevVersion + 1, new: { bands }, at,
      ...(prevMalformed ? { prev_malformed: true } : {}), ...(reset ? { history_reset: true } : {}) };
    return { policy_version: prevVersion + 1, bands, history: [entry, ...kept].slice(0, HISTORY_MAX), updated_at: at, updated_by: a.uid };
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
  if (s.policy_version !== want || !isDeepStrictEqual(s.bands, bands) || 'restaurants' in s
    || !isObj(h0) || h0.new_version !== want || !isDeepStrictEqual(h0.new, { bands })) return UNAVAILABLE();
  return reply(200, { ok: true, policy_version: want });
}

module.exports = { PATH, CAPS, HISTORY_MAX, READ_BYTES_AT_CAPS, validateWrite, historyOk, getDeliveryPricingCore, setDeliveryPricingCore };
