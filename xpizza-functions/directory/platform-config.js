'use strict';
// S7a directory (BRIEF-5f-capp-directory §D) — the ONE platform constants node for the customer app,
// platform_config/customer_app (admin-only, Sherpa-owned). Read once per directory build; built field by field from an
// explicit allowlist. Absent node → null (confirmed absent); a read failure THROWS (the directory answers 503).
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const isStr = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && v.trim() === v;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;

function pickPlatform(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  if (isStr(raw.city_label, 60)) out.city_label = raw.city_label;
  if (Array.isArray(raw.cuisines)) {
    const c = raw.cuisines.filter((x) => isObj(x) && typeof x.id === 'string' && ID.test(x.id) && isStr(x.label, 40)).map((x) => ({ id: x.id, label: x.label }));
    out.cuisines = c.filter((x, i) => c.findIndex((y) => y.id === x.id) === i);
  }
  if (isObj(raw.meals)) {
    const m = {};
    for (const [k, v] of Object.entries(raw.meals)) if (ID.test(k) && isStr(v, 40)) m[k] = v;
    out.meals = m;
  }
  if (isObj(raw.social) && nonNegInt(raw.social.min_reorders) && nonNegInt(raw.social.min_ratings)) out.social = { min_reorders: raw.social.min_reorders, min_ratings: raw.social.min_ratings };
  if (isObj(raw.value) && nonNegInt(raw.value.median_up_to_cents)) out.value = { median_up_to_cents: raw.value.median_up_to_cents };
  return out;
}

async function readCustomerAppPlatform(db) {
  const raw = (await db.ref('platform_config/customer_app').once('value')).val();   // throws on a read failure
  return raw == null ? null : pickPlatform(raw);
}

module.exports = { readCustomerAppPlatform, pickPlatform };
