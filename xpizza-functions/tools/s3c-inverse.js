'use strict';
// S3c envío activation prerequisites (Customer App) — the test-only INVERSE of the S3c slice's index.js hunks (hot-file
// invariant, see memory index-js-inverse-fold-invariant). Every hunk is SAME-LINE: the WhatsApp order-received calls carry the
// CHARGED total and the «Envío» argument (createOrder cash/pickup, and the online order-received trigger). Put back to their
// 50ab2b56 text, so every *-wiring.guard fold chain reconstructs its frozen base. Proof (i): unapplyS3cIndex(index.js) ===
// 50ab2b56:index.js byte-for-byte (s3c-wiring.guard). Each hunk must occur EXACTLY once. GENERATED from
// `git diff 50ab2b56 -- index.js` (context grown until unique); JSON-quoted strings.

const HUNKS = [
  [
    "            itemsText: String(updates[`orders/${orderId}`].items_text || ''),\n            total: DW.totalLempiras(dq, effectiveTotal), ...DW.waEnvio(priceBreakdown),   // S3c: the charged total + the «Envío» line\n            pickupTime: String(updates[`orders/${orderId}`].pickup_time || 'standard'),\n",
    "            itemsText: String(updates[`orders/${orderId}`].items_text || ''),\n            total: effectiveTotal,\n            pickupTime: String(updates[`orders/${orderId}`].pickup_time || 'standard'),\n"
  ],
  [
    "            itemsText: String(updates[`orders/${orderId}`].items_text || ''),\n            total: DW.totalLempiras(dq, effectiveTotal), ...DW.waEnvio(priceBreakdown),   // S3c: the charged total + the «Envío» line\n            trackingToken,\n",
    "            itemsText: String(updates[`orders/${orderId}`].items_text || ''),\n            total: effectiveTotal,\n            trackingToken,\n"
  ],
  [
    "        ? whatsapp.tplPickupReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, ...DW.waEnvio(order), pickupTime: order.pickup_time || 'standard', trackingToken, restaurantId })\n        : whatsapp.tplOrderReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, ...DW.waEnvio(order), trackingToken, restaurantId });\n",
    "        ? whatsapp.tplPickupReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, pickupTime: order.pickup_time || 'standard', trackingToken, restaurantId })\n        : whatsapp.tplOrderReceived({ customerName: order.customer_name, orderId, itemsText: order.items_text, total: order.total, trackingToken, restaurantId });\n"
  ]
];

function unapplyS3cIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s3c-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS3cIndex, HUNKS };
