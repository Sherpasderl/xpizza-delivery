'use strict';
// S3a envío (Customer App) — the test-only INVERSE of the S3a slice's index.js hunks (hot-file invariant, see memory
// index-js-inverse-fold-invariant). Every hunk is SAME-LINE (no line inserted, so no R3 region line shifts): the DW require
// on the restaurant-config line; quoteOrder / quoteRedemption envío + optional auth; createOrder / chargeOnlineOrder
// deliveryFor → withDelivery on the breakdown, the refusal step before the gate, and the envío argument to the gate;
// the hosted pending record's envío fields; the order / held / pending `total` (lempiras) = food + net envío; the envío config read started in parallel with each handler's first reads; the card path priced against the STORED order (codex P1-1/P1-2); quote 503s; member history = the order total. Put back to their fa6551ab text, so every *-wiring.guard fold chain
// reconstructs its frozen base. Proof (i): unapplyS3aIndex(index.js) === fa6551ab:index.js byte-for-byte
// (s3a-wiring.guard). Each hunk must occur EXACTLY once, else this throws. GENERATED from `git diff fa6551ab -- index.js`
// (context grown until unique); JSON-quoted strings.

const HUNKS = [
  [
    "const { getIdentity: getRestaurantIdentity, hubSnapshot } = require('./restaurant-config'); const DW = require('./delivery/delivery-wire');   // S3a envío (delivery/; tools/s3a-inverse.js)\n",
    "const { getIdentity: getRestaurantIdentity, hubSnapshot } = require('./restaurant-config');\n"
  ],
  [
    "  if (!ridDefaulted) console.log(`createOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId);   // 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n",
    "  if (!ridDefaulted) console.log(`createOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase();                                            // 1b-1: hoisted above validation (the RTDB alarm sink)\n"
  ],
  [
    "  const dq = await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP }); const priceBreakdown = DW.withDelivery(dq, redemptionPriced\n",
    "  const priceBreakdown = redemptionPriced\n"
  ],
  [
    "    : orderBreakdownCents(total, restaurantId));  // platform → ISV 15% incl.; non-platform → no split\n",
    "    : orderBreakdownCents(total, restaurantId);  // platform → ISV 15% incl.; non-platform → no split\n"
  ],
  [
    "    const applied = (await DW.refusalGate(dq, async () => { if (redemptionReserved) await releaseRedemption(db, { ...redemptionReserved, now: Date.now() }).catch(() => {}); }, orderId)) || await applyConfirmedNetGate({\n",
    "    const applied = await applyConfirmedNetGate({\n"
  ],
  [
    "      },\n      orderId, ...DW.gateExtra(dq),\n",
    "      },\n      orderId,\n"
  ],
  [
    "      orderId, orderType, now, trackingToken, total: DW.totalLempiras(dq, effectiveTotal), lat, lng, fields, hubSnap,\n",
    "      orderId, orderType, now, trackingToken, total: effectiveTotal, lat, lng, fields, hubSnap,\n"
  ],
  [
    "    attachCustomerAttribution(heldUpdates, orderId, customer_uid, { now, total: DW.totalLempiras(dq, effectiveTotal), orderType, items_text: fields.items_text, restaurantId, items: body.items, tables: pricingTables });   // 2a: the recipe allowlist follows the catalog\n",
    "    attachCustomerAttribution(heldUpdates, orderId, customer_uid, { now, total: effectiveTotal, orderType, items_text: fields.items_text, restaurantId, items: body.items, tables: pricingTables });   // 2a: the recipe allowlist follows the catalog\n"
  ],
  [
    "  Object.assign(updates, buildCreateOrderUpdates({\n    orderId, orderType, now, trackingToken, total: DW.totalLempiras(dq, effectiveTotal), lat, lng, fields, hubSnap,\n",
    "  Object.assign(updates, buildCreateOrderUpdates({\n    orderId, orderType, now, trackingToken, total: effectiveTotal, lat, lng, fields, hubSnap,\n"
  ],
  [
    "  attachCustomerAttribution(updates, orderId, customer_uid, { now, total: DW.totalLempiras(dq, effectiveTotal), orderType, items_text: fields.items_text, restaurantId, items: body.items, tables: pricingTables });   // 2a: the recipe allowlist follows the catalog\n",
    "  attachCustomerAttribution(updates, orderId, customer_uid, { now, total: effectiveTotal, orderType, items_text: fields.items_text, restaurantId, items: body.items, tables: pricingTables });   // 2a: the recipe allowlist follows the catalog\n"
  ],
  [
    "  if (!ridDefaulted) console.log(`chargeOnlineOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId);   // 1b-1: hoisted above validation (the RTDB alarm sink); S3a: the envío config read starts NOW, in parallel with the first reads\n",
    "  if (!ridDefaulted) console.log(`chargeOnlineOrder: restaurant_id=${restaurantId}`);\n  const db = getDatabase();                                            // 1b-1: hoisted above validation (the RTDB alarm sink)\n"
  ],
  [
    "  const dq = await DW.chargeContext(db, orderId, await DW.deliveryFor(db, { rid: restaurantId, mode: orderType, pin: DW.orderPin(body), customerUid: customer_uid, getIdentity: getRestaurantIdentity, pricingP: dpP }), body, Date.now(), { releaseStaleHold: customer_uid ? () => releaseRedemption(db, { uid: customer_uid, rid: restaurantId, orderId, now: Date.now() }) : null }); if (dq && dq.refusal) return res.status(dq.httpStatus).json({ error: dq.refusal, ...(dq.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId }); const effBreakdown = DW.withDelivery(dq, redemptionPriced\n",
    "  const effBreakdown = redemptionPriced\n"
  ],
  [
    "    : orderBreakdownCents(total, restaurantId));\n",
    "    : orderBreakdownCents(total, restaurantId);\n"
  ],
  [
    "    total: DW.totalLempiras(dq, effTotal),    // discounted total (== total when no redeem); + net envío when active (S3a)\n",
    "    total: effTotal,                          // discounted total (== total when no redeem)\n"
  ],
  [
    "    ...(effBreakdown.desc_rebaja_cents ? { desc_rebaja_cents: effBreakdown.desc_rebaja_cents } : {}), ...DW.orderFields(effBreakdown),   // A-F: factura comp rebaja (x_pizza only)\n",
    "    ...(effBreakdown.desc_rebaja_cents ? { desc_rebaja_cents: effBreakdown.desc_rebaja_cents } : {}),   // A-F: factura comp rebaja (x_pizza only)\n"
  ],
  [
    "    runGate: async (recordedTotalCents) => (await DW.refusalGate(dq, releaseHoldIfOwned, orderId)) || applyConfirmedNetGate({\n",
    "    runGate: (recordedTotalCents) => applyConfirmedNetGate({\n"
  ],
  [
    "      releaseHold: releaseHoldIfOwned,\n      orderId, ...DW.gateExtra(dq),\n",
    "      releaseHold: releaseHoldIfOwned,\n      orderId,\n"
  ],
  [
    "      const dpP = DW.loadPricing(db, restaurantId); const { allowed, retryAfterSec } = await checkRateLimit(db, 'quote_ip', clientIp, RATE_LIMIT_BUCKETS.quote_ip);   // S3a: envío config read in parallel\n",
    "      const { allowed, retryAfterSec } = await checkRateLimit(db, 'quote_ip', clientIp, RATE_LIMIT_BUCKETS.quote_ip);\n"
  ],
  [
    "      const dq = await DW.quoteDeliveryFor(req, db, restaurantId, body, { getIdentity: getRestaurantIdentity, getAuth, attributionUid, pricingP: dpP }); if (dq.refuse) return res.status(dq.httpStatus || 200).json(dq.refuse); const issued = issueQuote({ items: body.items, reward: null, rid: restaurantId, tables, deliveryContext: dq.ctx,\n        customerId: dq.uid, nowMs: Date.now() });\n",
    "      const issued = issueQuote({ items: body.items, reward: null, rid: restaurantId, tables,\n        customerId: null, nowMs: Date.now() });\n"
  ],
  [
    "        ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}), ...DW.quoteFields(dq.ctx),\n",
    "        ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}),\n"
  ],
  [
    "      if (ridError) return res.status(400).json({ ok: false, error: 'bad_request', detail: ridError });\n      const db = getDatabase(); const dpP = DW.loadPricing(db, restaurantId);   // S3a: envío config read in parallel with the auth reads\n",
    "      if (ridError) return res.status(400).json({ ok: false, error: 'bad_request', detail: ridError });\n      const db = getDatabase();\n"
  ],
  [
    "      const dq = await DW.quoteDeliveryFor(req, db, restaurantId, body, { getIdentity: getRestaurantIdentity, knownUid: customerUid, pricingP: dpP }); if (dq.refuse) return res.status(dq.httpStatus || 200).json(dq.refuse);  const quoteTables = await resolvePricingTables(restaurantId);\n",
    "      const quoteTables = await resolvePricingTables(restaurantId);\n"
  ],
  [
    "      const q = await quoteRedemptionCore(db, { redeem: body.redeem, items: body.items, restaurantId, customerUid, tables: quoteTables, eligible: quoteEligible, deliveryContext: dq.ctx });\n",
    "      const q = await quoteRedemptionCore(db, { redeem: body.redeem, items: body.items, restaurantId, customerUid, tables: quoteTables, eligible: quoteEligible });\n"
  ]
];

function unapplyS3aIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`s3a-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyS3aIndex, HUNKS };
