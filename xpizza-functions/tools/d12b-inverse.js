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

// ── index.js: ONE delimited block (requestOtp's message — codex D12b r1 P2-2) ──────────────────────────────────────────────
// The block's EXACT bytes are pinned (an edit inside it is detected); unapplyD12bIndex swaps it back for the ORIGINAL two lines,
// so unapplyD12bIndex(index.js) === acd606e:index.js byte-for-byte (d12b-wiring.guard). Every index.js fold guard applies it
// FIRST (D12b is the newest index.js slice), before D4-c2b's block.
const crypto = require('crypto');
const INDEX_BEGIN = '/* d12b:begin */';
const INDEX_END = '/* d12b:end */';
const INDEX_BLOCK = /[ \t]*\/\* d12b:begin \*\/\n[\s\S]*?\/\* d12b:end \*\/\n/g;
const INDEX_BLOCK_SHA256 = '288d8eafd9fecdc2157676d2529ab6e7a113d2e15e23db19f289509ec4b92ca8';
const INDEX_ORIGINAL = "      const brand = restaurantId === 'la_musa' ? 'La Musa' : 'X. Pizza';\n      await whatsapp.sendMessage(phone, `Tu código de ${brand} es ${code}. Vence en 5 minutos. No lo compartas.`, restaurantId);\n";
function unapplyD12bIndex(src) {
  const begins = src.split(INDEX_BEGIN).length - 1; const ends = src.split(INDEX_END).length - 1;
  const blocks = src.match(INDEX_BLOCK) || [];
  if (begins !== 1 || ends !== 1 || blocks.length !== 1) throw new Error(`d12b-inverse: expected exactly one d12b index.js block (begin ${begins}, end ${ends}, blocks ${blocks.length})`);
  if (crypto.createHash('sha256').update(blocks[0]).digest('hex') !== INDEX_BLOCK_SHA256) throw new Error('d12b-inverse: the d12b index.js block differs from its pinned bytes');
  return src.replace(INDEX_BLOCK, () => INDEX_ORIGINAL);
}

module.exports = { HUNKS, FILES, unapplyD12b, unapplyD12bIndex, INDEX_BEGIN, INDEX_END, INDEX_BLOCK_SHA256 };
