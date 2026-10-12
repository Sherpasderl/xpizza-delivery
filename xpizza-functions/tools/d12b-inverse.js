'use strict';
// D12b (brand display name) — the slice's INVERSE: its exact hunks in modules older slices PIN byte-for-byte
// (order-control-wiring: materialize vs e1aeb3f; identity-record-guards: create-order-build by sha; d12-wiring: both, via
// the D12 inverse). Those guards apply unapplyD12b FIRST (newest first), then D12's, so any byte outside the hunks still
// fails them. d12b-wiring.guard.test.js proves this inverse reproduces the D12b base (acd606e) byte-for-byte.
const HUNKS = Object.freeze([
 {
  "file": "create-order-build.js",
  "now": "const { normalizeReorderItems } = require('./reorder-normalize');\nconst { pickupLabel, brandOf } = require('./pickup-label');   // R3-FIX D12 (+ D12b brandOf)   // P3 — menu-allowlisted reorder recipe\n\n",
  "was": "const { normalizeReorderItems } = require('./reorder-normalize');\nconst { pickupLabel } = require('./pickup-label');   // R3-FIX D12   // P3 — menu-allowlisted reorder recipe\n\n"
 },
 {
  "file": "create-order-build.js",
  "now": "    : pickupLabel(hubSnap.restaurant_display_name, hubSnap.restaurant_name);\n  // D12b: the brand as customers see it, on the PUBLIC tracking record (the tracker cannot read identity) — the SAME\n  // resolution as the pickup line; absent when nothing names the restaurant (the tracker then uses neutral copy)\n  const trackBrand = brandOf(hubSnap.restaurant_display_name, hubSnap.restaurant_name);\n  updates[`order_tracking/${trackingToken}`] = {\n",
  "was": "    : pickupLabel(hubSnap.restaurant_display_name, hubSnap.restaurant_name);\n  updates[`order_tracking/${trackingToken}`] = {\n"
 },
 {
  "file": "create-order-build.js",
  "now": "    restaurant_id: restaurantId,   // D2: only order_tracking is public-readable — lets the tracker brand per restaurant\n    ...(trackBrand ? { restaurant_display_name: trackBrand } : {}),   // D12b\n    customer_name: fields.customer_name,\n",
  "was": "    restaurant_id: restaurantId,   // D2: only order_tracking is public-readable — lets the tracker brand per restaurant\n    customer_name: fields.customer_name,\n"
 },
 {
  "file": "materialize.js",
  "now": " */\nconst { pickupLabel, brandOf } = require('./pickup-label');   // R3-FIX D12 (+ D12b brandOf)\n\n",
  "was": " */\nconst { pickupLabel } = require('./pickup-label');   // R3-FIX D12\n\n"
 },
 {
  "file": "materialize.js",
  "now": "    : pickupLabel(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name);\n  // D12b: the same brand on the PUBLIC tracking record (absent when nothing names it — the tracker then uses neutral copy)\n  const trackBrand = brandOf(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name);\n  updates[`order_tracking/${trackingToken}`] = {\n",
  "was": "    : pickupLabel(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name);\n  updates[`order_tracking/${trackingToken}`] = {\n"
 },
 {
  "file": "materialize.js",
  "now": "    restaurant_id: order.restaurant_id || 'x_pizza',   // D2: per-restaurant tracker branding (legacy-normalized)\n    ...(trackBrand ? { restaurant_display_name: trackBrand } : {}),   // D12b\n    customer_name: order.customer_name,\n",
  "was": "    restaurant_id: order.restaurant_id || 'x_pizza',   // D2: per-restaurant tracker branding (legacy-normalized)\n    customer_name: order.customer_name,\n"
 }
]);

function unapplyD12b(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`d12b-inverse: ${file}: a D12b hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyD12b };
