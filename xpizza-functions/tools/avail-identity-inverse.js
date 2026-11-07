'use strict';
// PLAN-avail-identity r1 — the INVERSE for the availability-identity slice: SAME-LINE hunks only (no line shifts) in menu-pricing.js
// (the one rule as a helper on the itemPricingKey line, the raw line reading through it, the export) and catalog/public-menu.js (the
// helper import, the declared body field, the field set from the normalized rid; NOT the representation marker — PLAN 4 owns the 1d.3
// bump, and avail-identity ships WITH or AFTER PLAN 4: STOP 8 ruling (i), 2026-11-01). Older slices pin menu-pricing.js
// byte-for-byte (extras-wiring.guard: minus the extras hunks == 537bbbc; catalog/identity-record-guards: the sha after every newer
// inverse); those fold sites apply unapplyAvailIdentity INNERMOST (newest first). avail-identity-wiring.guard.test.js proves this
// inverse reproduces 8a31e2a3 for each file byte-for-byte; each `now` occurs exactly once.
const BASE = '8a31e2a3';
const HUNKS = Object.freeze([
 {"file": "menu-pricing.js", "now": "const availIdentityField = (rid) => (rid === 'la_musa' ? 'id' : 'name'); function itemPricingKey(item, restaurantId) {   // PLAN-avail-identity r1: the ONE availability-identity rule, also served in the public menu\n", "was": "function itemPricingKey(item, restaurantId) {\n"},
 {"file": "menu-pricing.js", "now": "  const raw = item && item[availIdentityField(restaurantId)];\n", "was": "  const raw = restaurantId === 'la_musa' ? (item && item.id) : (item && item.name);\n"},
 {"file": "menu-pricing.js", "now": "module.exports = { PRICING_KEY_STAMP, availIdentityField,\n", "was": "module.exports = { PRICING_KEY_STAMP,\n"},
 {"file": "catalog/public-menu.js", "now": "const { photosFor } = require('./public-photos'); const { availIdentityField } = require('../menu-pricing');\n", "was": "const { photosFor } = require('./public-photos');\n"},
 {"file": "catalog/public-menu.js", "now": "  photos: { type: 'object' }, avail_identity: { required: true, type: 'object' },   // PLAN-avail-identity r1: { field } — the restaurant's availability identity, from the server's ONE rule\n", "was": "  photos: { type: 'object' },\n"},
 {"file": "catalog/public-menu.js", "now": "    if (menu.eligibility) body.extras_eligibility = menu.eligibility; body.avail_identity = { field: availIdentityField(restaurantId) };   // the NORMALIZED rid (codex P1)\n", "was": "    if (menu.eligibility) body.extras_eligibility = menu.eligibility;\n"}
]);

function unapplyAvailIdentity(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`avail-identity-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { BASE, HUNKS, FILES, unapplyAvailIdentity };
