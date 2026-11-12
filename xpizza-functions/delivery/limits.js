'use strict';
// ENVÍO restaurant limit (PLAN-envio-restaurant-limit-r5 §1): `restaurants[branch rid] = { max_km }` in the SAME policy node. An entry
// is VALID only as exactly { max_km: finite > 0 }; the S3a legacy shape (a non-empty subset of {active, free_delivery}, all booleans)
// reads as ABSENT; anything else is MALFORMED and fails closed for THAT branch only (LIMIT_INVALID), never the whole policy.
const LIMIT_INVALID = Object.freeze({ limit_invalid: true });
const isObjL = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function limitEntry(e) {
  if (isObjL(e)) {
    const ks = Object.keys(e);
    if (ks.length === 1 && ks[0] === 'max_km' && typeof e.max_km === 'number' && Number.isFinite(e.max_km) && e.max_km > 0) return e.max_km;
    if (ks.length > 0 && ks.every((k) => (k === 'active' || k === 'free_delivery') && typeof e[k] === 'boolean')) return undefined;   // legacy → absent
  }
  return LIMIT_INVALID;
}
// the stored map → { [rid]: max_km | LIMIT_INVALID } (legacy entries omitted); not an object → {}
function readLimits(raw) {
  const out = {};
  if (!isObjL(raw)) return out;
  for (const [rid, e] of Object.entries(raw)) { const v = limitEntry(e); if (v !== undefined) out[rid] = v; }
  return out;
}
// the app's effective coverage for one branch: min(top, max_km) | top (absent) | LIMIT_INVALID (malformed)
function effectiveMaxKm(pricing, rid) {
  const top = pricing.bands[pricing.bands.length - 1].max_km;
  const e = pricing.limits && Object.prototype.hasOwnProperty.call(pricing.limits, rid) ? pricing.limits[rid] : undefined;
  if (e === LIMIT_INVALID) return LIMIT_INVALID;
  return typeof e === 'number' ? Math.min(top, e) : top;
}

module.exports = { LIMIT_INVALID, limitEntry, readLimits, effectiveMaxKm };
