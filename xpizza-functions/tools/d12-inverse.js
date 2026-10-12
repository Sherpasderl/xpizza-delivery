'use strict';
// R3-FIX D12 — the slice's INVERSE: the exact hunks D12 adds to modules that older slices PIN byte-for-byte
// (order-control-wiring.guard: materialize / pixelpay-confirm / resolve-manual / restaurant-config vs e1aeb3f;
// identity-record-guards: create-order-build vs 2745be5). Those guards compare unapplyD12(file) with their pin, so ANY
// byte outside these hunks still fails them. d12-wiring.guard.test.js proves this inverse reproduces the D12 base
// (ebc8564) byte-for-byte for every file listed, with each hunk present exactly once. Generated from the D12 diff.
const HUNKS = Object.freeze([
 {
  "file": "restaurant-config.js",
  "now": "'use strict';\nconst { brandText } = require('./pickup-label');   // R3-FIX D12\n\n",
  "was": "'use strict';\n\n"
 },
 {
  "file": "restaurant-config.js",
  "now": "function hubSnapshot(id) {\n  const snap = { hub_lat: id.hub_lat, hub_lng: id.hub_lng, restaurant_name: id.name, restaurant_phone: id.phone };\n  // R3-FIX D12: the brand as customers see it (identity.display_name), ONLY when configured — absent stays absent, so an\n  // order of a restaurant without one is byte-identical to before (and RTDB never receives an undefined)\n  const dn = brandText(id.display_name);\n  if (dn) snap.restaurant_display_name = dn;\n  return snap;\n}\n",
  "was": "function hubSnapshot(id) {\n  return { hub_lat: id.hub_lat, hub_lng: id.hub_lng, restaurant_name: id.name, restaurant_phone: id.phone };\n}\n"
 },
 {
  "file": "create-order-build.js",
  "now": "\nconst { normalizeReorderItems } = require('./reorder-normalize');\nconst { pickupLabel } = require('./pickup-label');   // R3-FIX D12   // P3 — menu-allowlisted reorder recipe\n\n",
  "was": "\nconst { normalizeReorderItems } = require('./reorder-normalize');   // P3 — menu-allowlisted reorder recipe\n\n"
 },
 {
  "file": "create-order-build.js",
  "now": "    restaurant_phone: hubSnap.restaurant_phone,\n    ...(hubSnap.restaurant_display_name ? { restaurant_display_name: hubSnap.restaurant_display_name } : {}),   // R3-FIX D12\n    factura_status: 'not_due',\n",
  "was": "    restaurant_phone: hubSnap.restaurant_phone,\n    factura_status: 'not_due',\n"
 },
 {
  "file": "create-order-build.js",
  "now": "\n  // R3-FIX D12: the pickup line names THIS restaurant, from its own config snapshot — never a brand literal\n  const addressShort = orderType === 'delivery'\n",
  "was": "\n  const addressShort = orderType === 'delivery'\n"
 },
 {
  "file": "create-order-build.js",
  "now": "    ? fields.address_detected.split(',')[0].trim()\n    : pickupLabel(hubSnap.restaurant_display_name, hubSnap.restaurant_name);\n  updates[`order_tracking/${trackingToken}`] = {\n",
  "was": "    ? fields.address_detected.split(',')[0].trim()\n    : 'Recoger en X. Pizza';\n  updates[`order_tracking/${trackingToken}`] = {\n"
 },
 {
  "file": "materialize.js",
  "now": " */\nconst { pickupLabel } = require('./pickup-label');   // R3-FIX D12\n\n",
  "was": " */\n\n"
 },
 {
  "file": "materialize.js",
  "now": "// order's status/payment fields (not overwrite the node) and ADD tasks + tracking.\nfunction buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference = null, paymentMethod = null, liveIdentity = null }) {\n  if (!orderId || !order) throw new Error('buildMaterializeUpdates: orderId and order are required');\n",
  "was": "// order's status/payment fields (not overwrite the node) and ADD tasks + tracking.\nfunction buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference = null, paymentMethod = null }) {\n  if (!orderId || !order) throw new Error('buildMaterializeUpdates: orderId and order are required');\n"
 },
 {
  "file": "materialize.js",
  "now": "  // Public tracking record (safe-to-expose subset only).\n  // R3-FIX D12: the pickup line names THIS restaurant — the order's own config snapshot first, then the caller's LIVE\n  // identity (an order created before the display-name snapshot existed), never the x_pizza-only RESTAURANT fallback\n  const live = liveIdentity && typeof liveIdentity === 'object' ? liveIdentity : {};\n  const addressShort = orderType === 'delivery'\n",
  "was": "  // Public tracking record (safe-to-expose subset only).\n  const addressShort = orderType === 'delivery'\n"
 },
 {
  "file": "materialize.js",
  "now": "    ? String(order.address_detected || '').split(',')[0].trim()\n    : pickupLabel(order.restaurant_display_name, live.display_name, order.restaurant_name, live.name);\n  updates[`order_tracking/${trackingToken}`] = {\n",
  "was": "    ? String(order.address_detected || '').split(',')[0].trim()\n    : 'Recoger en X. Pizza';\n  updates[`order_tracking/${trackingToken}`] = {\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "  let inactiveRid = null;\n  let liveIdentity = null;   // R3-FIX D12: the SAME read names the brand on the pickup line (no extra I/O)\n  if (deps.getIdentity) {\n",
  "was": "  let inactiveRid = null;\n  if (deps.getIdentity) {\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    try {\n      liveIdentity = await deps.getIdentity(db, rid);\n      if (liveIdentity.active === false) inactiveRid = rid;\n    } catch (_) {\n",
  "was": "    try {\n      if ((await deps.getIdentity(db, rid)).active === false) inactiveRid = rid;\n    } catch (_) {\n"
 },
 {
  "file": "pixelpay-confirm.js",
  "now": "    paymentReference: paymentReference || order.payment_reference || null,\n    paymentMethod: 'online',\n    liveIdentity,\n  });\n",
  "was": "    paymentReference: paymentReference || order.payment_reference || null,\n    paymentMethod: 'online'\n  });\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "const MG = require('./materialize-guard');\nconst { readLiveBrand } = require('./pickup-label');   // R3-FIX D12\nconst { holdIfClosedAtMaterialize } = MG;   // paid-after-close re-check (Codex-on-diff)\n",
  "was": "const MG = require('./materialize-guard');\nconst { holdIfClosedAtMaterialize } = MG;   // paid-after-close re-check (Codex-on-diff)\n"
 },
 {
  "file": "resolve-manual.js",
  "now": "  }\n  // R3-FIX D12: an order without a display-name snapshot (created before it existed) names its brand from the LIVE identity\n  const liveIdentity = order.order_type === 'pickup' && !order.restaurant_display_name ? await readLiveBrand(db, order.restaurant_id || 'x_pizza') : null;\n  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference: attemptId, paymentMethod: 'online', liveIdentity });\n  await db.ref().update(updates);\n",
  "was": "  }\n  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference: attemptId, paymentMethod: 'online' });\n  await db.ref().update(updates);\n"
 },
 {
  "file": "scheduled-release-core.js",
  "now": "const { buildMaterializeUpdates } = require('./materialize');\nconst { readLiveBrand } = require('./pickup-label');   // R3-FIX D12\n// R3-FIX D12 (codex r1 note): the sweep releases due orders ONE AT A TIME with ONE deps object per run, so a restaurant's\n// live brand is read ONCE per run (memoized on that deps object) — never a bounded read per order, accumulating.\nconst brandMemo = new WeakMap();\nfunction liveBrandFor(deps, db, rid) {\n  let m = brandMemo.get(deps);\n  if (!m) { m = new Map(); brandMemo.set(deps, m); }\n  if (!m.has(rid)) m.set(rid, readLiveBrand(db, rid));\n  return m.get(rid);\n}\nconst S = require('./scheduled-orders');\n",
  "was": "const { buildMaterializeUpdates } = require('./materialize');\nconst S = require('./scheduled-orders');\n"
 },
 {
  "file": "scheduled-release-core.js",
  "now": "  const restaurant = deps.restaurantFallback || { lat: order.hub_lat, lng: order.hub_lng, name: order.restaurant_name, phone: order.restaurant_phone };\n  // R3-FIX D12: an order without a display-name snapshot (scheduled before it existed) names its brand from the LIVE identity\n  const liveIdentity = order.order_type === 'pickup' && !order.restaurant_display_name ? await liveBrandFor(deps, db, rid) : null;\n  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentMethod: order.payment_method, liveIdentity });\n  delete updates[`orders/${orderId}/charged_at`];\n",
  "was": "  const restaurant = deps.restaurantFallback || { lat: order.hub_lat, lng: order.hub_lng, name: order.restaurant_name, phone: order.restaurant_phone };\n  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentMethod: order.payment_method });\n  delete updates[`orders/${orderId}/charged_at`];\n"
 }
]);

function unapplyD12(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`d12-inverse: ${file}: a D12 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);
module.exports = { HUNKS, FILES, unapplyD12 };
