'use strict';
// INTL PHONE S-core step 3 (PLAN-intl-phone r2.3; BUILD-ORDER-intl-core, CASE = FLAG) — the test-only index.js INVERSE. Two SAME-LINE
// hunks (no line inserted ⇒ no R3 call-site line shifts): on the createOrder and chargeOnlineOrder `validateOrderPayload(...)` lines,
// the flagged wire contract is appended AFTER the call (validateOrderPayload / sanitizePhone themselves untouched; the pinned seam text
// `validateOrderPayload(body, restaurantId, pricingTables)` intact). unapplyIntlIndex swaps both back, so the result === the base
// index.js byte-for-byte (intl-wiring.guard). It is the NEWEST layer: every index.js chain and fold applies it FIRST (innermost),
// inside formsignal's.
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables); require('./phone/wire').applyWireContract(await require('./phone/flag').phoneWireStrict(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) [create]\n",
  "was": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);\n"
 },
 {
  "file": "index.js",
  "now": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables); require('./phone/wire').applyWireContract(await require('./phone/flag').phoneWireStrict(db), body, errors, fields);   // INTL S-core step 3 — the flagged wire contract (OFF = no-op) [charge]\n",
  "was": "  const { errors, total, lat, lng, fields } = validateOrderPayload(body, restaurantId, pricingTables);\n"
 }
]);
function unapplyIntlIndex(src) {
  let out = src;
  for (const h of HUNKS) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`intl-inverse: index.js: an intl hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
module.exports = { BASE, HUNKS, unapplyIntlIndex };
