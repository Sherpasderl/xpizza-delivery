'use strict';
// S3a envío (Customer App) — the slice's INVERSE for the order-path MODULES older slices pin byte-for-byte
// (catalog/identity-record-guards: compute-server-net / quote-issue / rewards-redeem-intake / token-gate by sha256;
// a1-wiring.guard: rewards-redeem-intake.js vs 341d1b1a). Those guards apply unapplyS3aModule FIRST (newest first), so any
// byte outside these exact hunks still fails them. s3a-wiring.guard.test.js proves this inverse reproduces fa6551ab for each
// file byte-for-byte. GENERATED from `git diff fa6551ab` (context grown until unique); each `now` occurs exactly once.
const HUNKS = Object.freeze([
 {
  "file": "compute-server-net.js",
  "now": "const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');\nconst { isServerDeliveryCtx, netDeliveryCents } = require('./delivery/delivery-pricing');   // S3a envío\n",
  "was": "const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "/* The delivery slot, computed HERE from server-side context. The client never supplies a fee: S3a's\n   `deliveryContext` is the SERVER's envío (delivery/delivery-pricing.js quoteDelivery, from Sherpa config + hub +\n   pin), recognised by identity (isServerDeliveryCtx — a JSON object from a request can never be one), and a caller\n   that passes anything else, amount or not, is ignored, which is the point. The slot is the NET envío the customer\n   pays: max(0, delivery − free-delivery promo). No context (a restaurant not activated for envío) → 0, as before S3. */\n",
  "was": "/* The delivery slot. Zero today — delivery is free — but it is computed HERE, from server-side\n   context, so the 2-tier distance pricing lands with no rework and no call-site change. The client\n   never supplies a fee: `deliveryContext` describes the delivery (what it will eventually carry is\n   distance/zone), and a caller that passes an amount would be ignored, which is the point. */\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "  return isServerDeliveryCtx(deliveryContext) ? netDeliveryCents(deliveryContext) : 0;\n",
  "was": "  return 0;\n"
 },
 {
  "file": "quote-issue.js",
  "now": "function issueQuoteInner({ items, reward = null, redemptionRef = null, rid, tables = null, customerId = null, deliveryContext = null, nowMs = Date.now() }) {\n  const net = computeServerNet({ items, reward, deliveryContext, rid, tables });\n",
  "was": "function issueQuoteInner({ items, reward = null, redemptionRef = null, rid, tables = null, customerId = null, nowMs = Date.now() }) {\n  const net = computeServerNet({ items, reward, rid, tables });\n"
 },
 {
  "file": "quote-issue.js",
  "now": "      redemption_ref: redemptionRef || null,\n      // S3a: the envío facts this net includes (mode, policy_version, delivery/promo) — absent when the restaurant is\n      // not activated for envío, so every pre-S3 token payload is byte-identical.\n      ...(deliveryContext ? { delivery: { mode: deliveryContext.mode, policy_version: deliveryContext.policy_version, delivery_cents: deliveryContext.delivery_cents, promo_discount_cents: deliveryContext.promo_discount_cents } } : {}),\n",
  "was": "      redemption_ref: redemptionRef || null,\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "async function quoteRedemptionCore(db, { redeem, items, restaurantId, customerUid, tables, eligible = null, deliveryContext = null }) {\n",
  "was": "async function quoteRedemptionCore(db, { redeem, items, restaurantId, customerUid, tables, eligible = null }) {\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "    rid: restaurantId, tables, customerId: customerUid, deliveryContext, nowMs: Date.now() });   // S3a: envío (null = not activated)\n",
  "was": "    rid: restaurantId, tables, customerId: customerUid, nowMs: Date.now() });\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "    ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}),\n    ...(deliveryContext ? { delivery: { delivery_cents: deliveryContext.delivery_cents, promo_discount_cents: deliveryContext.promo_discount_cents, policy_version: deliveryContext.policy_version, mode: deliveryContext.mode } } : {}) };\n",
  "was": "    ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}) };\n"
 },
 {
  "file": "token-gate.js",
  "now": "async function applyConfirmedNetGate({ gateInput, recordedTotalCents, releaseHold, orderId, log = console, deliveryContext = null }) {\n  // S3a: the SERVER's envío for this order (delivery/delivery-wire.js gateExtra) joins the recompute; absent → as before S3.\n  const result = gateConfirmedNet(deliveryContext ? { ...gateInput, deliveryContext } : gateInput);\n",
  "was": "async function applyConfirmedNetGate({ gateInput, recordedTotalCents, releaseHold, orderId, log = console }) {\n  const result = gateConfirmedNet(gateInput);\n"
 }
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);

function unapplyS3aModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const i = out.indexOf(h.now);
    if (i < 0 || out.indexOf(h.now, i + 1) !== -1) throw new Error(`s3a-module-inverse: ${file} hunk not found exactly once: ${h.now.slice(0, 80)}`);
    out = out.slice(0, i) + h.was + out.slice(i + h.now.length);
  }
  return out;
}

module.exports = { unapplyS3aModule, FILES, HUNKS };
