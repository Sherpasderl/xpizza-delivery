'use strict';
// S2-srv-tip (Customer App S2, PLAN-capp-S2-r4 §3/§4.1) — the test-only exact INVERSE of the slice's hunks in the pinned
// order-path MODULES (see memory pinned-module-inverse): reversed FIRST (newest first) by every module fold chain
// (catalog/identity-record-guards, a1-wiring.guard, s3a-wiring.guard, order-control-wiring.guard, form-source-inventory.guard).
// Proof: unapplyS2tipModule(f, f) === 276ed944:f byte-for-byte for every file (s2tip-wiring.guard). Each hunk must occur
// EXACTLY once, else this throws. GENERATED from `git diff 276ed944` per file (context grown until unique).

const HUNKS = [
 {
  "file": "catalog/charge-inputs.js",
  "now": "  'pin_confirmed',   // S3a envío: the client's pin confirmation decides whether a delivery is priced or refused (codex P1-2)\n  'tip_cents',       // S2: the tip joins the charged total (PLAN-capp-S2-r4 §3.1) — 0 is normalized OUT of the projection below\n",
  "was": "  'pin_confirmed',   // S3a envío: the client's pin confirmation decides whether a delivery is priced or refused (codex P1-2)\n"
 },
 {
  "file": "catalog/charge-inputs.js",
  "now": "  const picked = {};\n  // S2: `tip_cents: 0` is the no-tip case, so it is skipped like `undefined` — absent / undefined / 0 hash identically (= pre-S2)\n  for (const k of CHARGE_INPUT_FIELDS) if (own(body, k) && body[k] !== undefined && !(k === 'tip_cents' && body[k] === 0)) picked[k] = body[k];\n",
  "was": "  const picked = {};\n  for (const k of CHARGE_INPUT_FIELDS) if (own(body, k) && body[k] !== undefined) picked[k] = body[k];\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');\nconst { isServerDeliveryCtx, netDeliveryCents, tipCentsOf } = require('./delivery/delivery-pricing');   // S3a envío; S2 tip\n",
  "was": "const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');\nconst { isServerDeliveryCtx, netDeliveryCents } = require('./delivery/delivery-pricing');   // S3a envío\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "  return isServerDeliveryCtx(deliveryContext) ? netDeliveryCents(deliveryContext) : 0;\n}\n\n/* S2 (PLAN-capp-S2-r4 §3.1): the tip rides the SAME server ctx (delivery-pricing withTip — a request body can never mint one)\n   and joins the net EXACTLY ONCE, after the envío. No tip → 0 → the net and the components are byte-identical. */\nfunction tipCentsFor(deliveryContext) {\n  return isServerDeliveryCtx(deliveryContext) ? tipCentsOf(deliveryContext) : 0;\n",
  "was": "  return isServerDeliveryCtx(deliveryContext) ? netDeliveryCents(deliveryContext) : 0;\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "  const delivery_cents = deliveryCentsFor(deliveryContext, rid);\n  const tip_cents = tipCentsFor(deliveryContext);\n  const net_total_cents = netAfterReward + delivery_cents + tip_cents;\n",
  "was": "  const delivery_cents = deliveryCentsFor(deliveryContext, rid);\n  const net_total_cents = netAfterReward + delivery_cents;\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "     a fact nobody can later verify. */\n  const out = { net_total_cents, base_cents, reward_discount_cents, delivery_cents, fiscal_cents, tip_cents };\n",
  "was": "     a fact nobody can later verify. */\n  const out = { net_total_cents, base_cents, reward_discount_cents, delivery_cents, fiscal_cents };\n"
 },
 {
  "file": "compute-server-net.js",
  "now": "    net_total_cents,\n    components: { base_cents, reward_discount_cents, delivery_cents, fiscal_cents, ...(tip_cents > 0 ? { tip_cents } : {}) },   // S2: tip_cents only when > 0\n",
  "was": "    net_total_cents,\n    components: { base_cents, reward_discount_cents, delivery_cents, fiscal_cents },\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "/* a1:end text-version-require */\nconst TIP = require('./tip');   // S2-srv-tip: the direct stored-tip compare + the fingerprint component (PLAN-capp-S2-r4 §3.2)\n",
  "was": "/* a1:end text-version-require */\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "   binding_format_invalid. A null candidate keeps today's fail-open (case 4 skipped). */\nfunction classifyExistingOrder(existing, { paymentMethod, restaurantMatches, incomingTip = 0 }, incomingFp, { isPaymentStatusClosed, canonicalIncoming = null, a8Incoming = null } = {}) {\n",
  "was": "   binding_format_invalid. A null candidate keeps today's fail-open (case 4 skipped). */\nfunction classifyExistingOrder(existing, { paymentMethod, restaurantMatches }, incomingFp, { isPaymentStatusClosed, canonicalIncoming = null, a8Incoming = null } = {}) {\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "  if (closedByStatus || closedByPayment) return { action: '409', reason: 'closed' };   // case 3 — dead/paid/awaiting order\n  // S2 §3.2: a changed tip is a different order — compared DIRECTLY, before every fingerprint (a null recompute skips case 4),\n  // and after `closed` on purpose so the terminal-safe self-heal (order-exists.js) is unchanged. No tip vs no tip never refuses.\n  if (TIP.tipBindingConflict(existing, incomingTip)) return { action: '409', reason: 'tip' };\n",
  "was": "  if (closedByStatus || closedByPayment) return { action: '409', reason: 'closed' };   // case 3 — dead/paid/awaiting order\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "async function computeIncomingFingerprint(ctx, deps) {\n  const { orderId, restaurantId, total, itemsText, items, redeem, customerUid, scheduledForRaw, orderType, tipCents = 0 } = ctx;\n",
  "was": "async function computeIncomingFingerprint(ctx, deps) {\n  const { orderId, restaurantId, total, itemsText, items, redeem, customerUid, scheduledForRaw, orderType } = ctx;\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "  const { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra, db, tables, eligible = null } = deps;\n  const tipX = TIP.tipExtra(tipCents);   // S2: '' with no tip → filtered → byte-identical\n",
  "was": "  const { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra, db, tables, eligible = null } = deps;\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "      const totalCents = orderBreakdownCents(total, restaurantId).total_cents;\n      return orderFingerprint(orderId, totalCents, itemsText, [schedExtra, tipX].filter(Boolean).join('|'));\n",
  "was": "      const totalCents = orderBreakdownCents(total, restaurantId).total_cents;\n      return orderFingerprint(orderId, totalCents, itemsText, [schedExtra].filter(Boolean).join('|'));\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "    if (!prep || !prep.ok) return null;   // e.g. reward_unavailable (free item 86'd after the original) → fail-open\n    const extra = [schedExtra, prep.redemptionFp ? `rf:${prep.redemptionFp}` : '', tipX].filter(Boolean).join('|');\n",
  "was": "    if (!prep || !prep.ok) return null;   // e.g. reward_unavailable (free item 86'd after the original) → fail-open\n    const extra = [schedExtra, prep.redemptionFp ? `rf:${prep.redemptionFp}` : ''].filter(Boolean).join('|');\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "async function computeCanonicalIncomingFingerprint(ctx, deps) {\n  const { orderId, restaurantId, total, items, redeem, customerUid, scheduledForRaw, orderType, itemsText, tipCents = 0 } = ctx;\n",
  "was": "async function computeCanonicalIncomingFingerprint(ctx, deps) {\n  const { orderId, restaurantId, total, items, redeem, customerUid, scheduledForRaw, orderType, itemsText } = ctx;\n"
 },
 {
  "file": "createorder-classify.js",
  "now": "    const isScheduled = Number.isFinite(scheduledForRaw);\n    const schedExtra = [isScheduled ? schedFingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '', TIP.tipExtra(tipCents)].filter(Boolean).join('|');   // S2: + the tip component ('' → unchanged)\n",
  "was": "    const isScheduled = Number.isFinite(scheduledForRaw);\n    const schedExtra = isScheduled ? schedFingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '';\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "   gate charges and the order records. */\n/* S2 §3.6: `maxKm` (the APP's effective coverage, min(last band, identity.delivery_radius_km) — delivery-wire quoteDeliveryFor)\n   refuses a pin beyond it as outside_delivery_bands, so an app quote never prices a pin the order's radius check refuses.\n   Absent (every legacy caller) → unchanged. */\nfunction quoteDelivery({ pricing, hub, mode, pin, customerUid, maxKm = null }) {\n",
  "was": "   gate charges and the order records. */\nfunction quoteDelivery({ pricing, hub, mode, pin, customerUid }) {\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "  const band = pricing.bands.findIndex((b) => km <= b.max_km);\n  if (band < 0 || (typeof maxKm === 'number' && km > maxKm)) return { refusal: 'outside_delivery_bands' };\n",
  "was": "  const band = pricing.bands.findIndex((b) => km <= b.max_km);\n  if (band < 0) return { refusal: 'outside_delivery_bands' };\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "  if (signed.customer && signed.customer !== ctx.customer) return 'delivery_customer_mismatch';\n  if (tipCentsOf(signed) !== tipCentsOf(ctx)) return 'tip_mismatch';   // S2: the signed tip is the charged tip (absent on both = 0)\n",
  "was": "  if (signed.customer && signed.customer !== ctx.customer) return 'delivery_customer_mismatch';\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "  return mint({ mode: s.mode, delivery_cents: order.delivery_cents, promo_discount_cents: order.promo_discount_cents, policy_version: s.policy_version,\n    ...(s.mode === 'delivery' ? { km: s.km, band: s.band, promo: s.promo || null } : {}), place: null, customer: null,\n    ...(Number.isSafeInteger(order.tip_cents) && order.tip_cents > 0 ? { tip_cents: order.tip_cents } : {}) });   // S2: the tip the checkout was issued with\n",
  "was": "  return mint({ mode: s.mode, delivery_cents: order.delivery_cents, promo_discount_cents: order.promo_discount_cents, policy_version: s.policy_version,\n    ...(s.mode === 'delivery' ? { km: s.km, band: s.band, promo: s.promo || null } : {}), place: null, customer: null });\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "const netDeliveryCents = (ctx) => (ctx ? Math.max(0, ctx.delivery_cents - ctx.promo_discount_cents) : 0);\n// S2 (PLAN-capp-S2-r4 §3.1): the tip on a server ctx (or a signed payload's delivery block) — 0 when absent. It is NOT part of\n// the envío (netDeliveryCents stays envío-only); computeServerNet and the order breakdown add it once, separately.\nconst tipCentsOf = (c) => (c && Number.isSafeInteger(c.tip_cents) && c.tip_cents > 0 ? c.tip_cents : 0);\n// A server ctx carrying this request's tip — a NEW minted object (the original stays untouched). tip 0 → the same ctx.\nconst withTip = (ctx, tip) => (ctx && tip > 0 ? mint({ ...ctx, tip_cents: tip }) : ctx);\n",
  "was": "const netDeliveryCents = (ctx) => (ctx ? Math.max(0, ctx.delivery_cents - ctx.promo_discount_cents) : 0);\n"
 },
 {
  "file": "delivery/delivery-pricing.js",
  "now": "\nmodule.exports = { haversineKm, readPricing, quoteDelivery, netDeliveryCents, isServerDeliveryCtx, deliveryBindingMismatch, storedCtx, placeOf, tipCentsOf, withTip };\n",
  "was": "\nmodule.exports = { haversineKm, readPricing, quoteDelivery, netDeliveryCents, isServerDeliveryCtx, deliveryBindingMismatch, storedCtx, placeOf };\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "const P = require('./delivery-pricing');\nconst TIP = require('../tip');   // S2-srv-tip (PLAN-capp-S2-r4 §3)\n",
  "was": "const P = require('./delivery-pricing');\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// identity (the same cached reader the order path uses; unreadable → a 503 refusal, never free).\n/* S2 (§3.1): `tip` is the request's raw tip_cents (already validated by the handler's early TIP.orderRefusal). A tip needs an\n   ACTIVE restaurant (dark + tip → 409 tip_not_enabled) and a delivery (pickup + tip → 400 tip_pickup); otherwise it rides the\n   server ctx (P.withTip), so the breakdown, the gate's recompute and the record all carry it. No tip → byte-identical. */\nasync function deliveryFor(db, { rid, mode, pin, customerUid, getIdentity, pricingP, tip }) {\n  const t = TIP.normTip(tip);\n  if (Number.isNaN(t)) return { refusal: 'tip_invalid', httpStatus: 400 };\n",
  "was": "// identity (the same cached reader the order path uses; unreadable → a 503 refusal, never free).\nasync function deliveryFor(db, { rid, mode, pin, customerUid, getIdentity, pricingP }) {\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };\n  if (!lp.pricing) return t > 0 ? { refusal: 'tip_not_enabled', httpStatus: 409 } : null;\n",
  "was": "  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };\n  if (!lp.pricing) return null;\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "  const q = P.quoteDelivery({ pricing: lp.pricing, hub, mode, pin, customerUid });\n  if (q.refusal) return { refusal: q.refusal, httpStatus: REFUSAL_STATUS[q.refusal] || 409 };\n  if (t > 0 && q.ctx.mode === 'pickup') return { refusal: 'tip_pickup', httpStatus: 400 };\n  return t > 0 ? { ctx: P.withTip(q.ctx, t) } : q;\n",
  "was": "  const q = P.quoteDelivery({ pricing: lp.pricing, hub, mode, pin, customerUid });\n  return q.refusal ? { refusal: q.refusal, httpStatus: REFUSAL_STATUS[q.refusal] || 409 } : q;\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// subtotal/tax stay the FOOD split (envío is pass-through to Sherpa, outside the restaurant's revenue and factura).\n// S2: + the tip (once) on total_cents, and `tip_cents` on the record only when > 0 (subtotal/tax stay the FOOD split — the tip,\n// like envío, is pass-through: never restaurant revenue, never on the factura).\n",
  "was": "// subtotal/tax stay the FOOD split (envío is pass-through to Sherpa, outside the restaurant's revenue and factura).\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "  if (!c) return breakdown;\n  const tip = P.tipCentsOf(c);\n",
  "was": "  if (!c) return breakdown;\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "    ...breakdown,\n    total_cents: breakdown.total_cents + P.netDeliveryCents(c) + tip,\n",
  "was": "    ...breakdown,\n    total_cents: breakdown.total_cents + P.netDeliveryCents(c),\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "    delivery_snapshot: { mode: c.mode, policy_version: c.policy_version, ...(c.mode === 'delivery' ? { km: c.km, band: c.band, promo: c.promo || null } : {}) },\n    ...(tip > 0 ? { tip_cents: tip } : {}),\n",
  "was": "    delivery_snapshot: { mode: c.mode, policy_version: c.policy_version, ...(c.mode === 'delivery' ? { km: c.km, band: c.band, promo: c.promo || null } : {}) },\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// `total` and `total_cents` stay one number. The reward earn base keeps the FOOD total (callers pass it unchanged there).\nconst totalLempiras = (dq, foodLempiras) => (ctxOf(dq) ? foodLempiras + (P.netDeliveryCents(ctxOf(dq)) + P.tipCentsOf(ctxOf(dq))) / 100 : foodLempiras);   // S2: + the tip\n",
  "was": "// `total` and `total_cents` stay one number. The reward earn base keeps the FOOD total (callers pass it unchanged there).\nconst totalLempiras = (dq, foodLempiras) => (ctxOf(dq) ? foodLempiras + P.netDeliveryCents(ctxOf(dq)) / 100 : foodLempiras);\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// S3c: the WhatsApp «Envío» argument from a breakdown / an order record (delivery_cents > 0 only — absent → nothing).\nconst waEnvio = (o) => ({ ...(o && Number.isSafeInteger(o.delivery_cents) && o.delivery_cents > 0 ? { envio: { cents: o.delivery_cents, promo_cents: Number.isSafeInteger(o.promo_discount_cents) ? o.promo_discount_cents : 0 } } : {}),\n  ...(o && Number.isSafeInteger(o.tip_cents) && o.tip_cents > 0 ? { propina: { cents: o.tip_cents } } : {}) });   // S2: + the «Propina» line\n",
  "was": "// S3c: the WhatsApp «Envío» argument from a breakdown / an order record (delivery_cents > 0 only — absent → nothing).\nconst waEnvio = (o) => (o && Number.isSafeInteger(o.delivery_cents) && o.delivery_cents > 0 ? { envio: { cents: o.delivery_cents, promo_cents: Number.isSafeInteger(o.promo_discount_cents) ? o.promo_discount_cents : 0 } } : {});\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// The fields the hosted path copies onto the pending order (the cash path spreads the whole breakdown).\nconst orderFields = (b) => (b && b.delivery_snapshot ? { delivery_cents: b.delivery_cents, promo_discount_cents: b.promo_discount_cents, delivery_snapshot: b.delivery_snapshot, ...(b.tip_cents > 0 ? { tip_cents: b.tip_cents } : {}) } : {});   // S2: + tip_cents (> 0 only)\n",
  "was": "// The fields the hosted path copies onto the pending order (the cash path spreads the whole breakdown).\nconst orderFields = (b) => (b && b.delivery_snapshot ? { delivery_cents: b.delivery_cents, promo_discount_cents: b.promo_discount_cents, delivery_snapshot: b.delivery_snapshot } : {});\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "   `knownUid` (quoteRedemption already verified one) skips the second verify. */\n/* S2 (§3.1/§3.5/§3.6): the tip is validated here for BOTH quote endpoints (they pass the raw body) — malformed → 400\n   tip_invalid; a tip with a reward (`redeem`) → 409 tip_reward_unsupported; dark + tip → 409 tip_not_enabled; pickup + tip →\n   400 tip_pickup. An APP quote (`entry_mode:'app'`) is refused beyond min(last band, identity.delivery_radius_km), so it never\n   prices a pin the order's radius check refuses. Active quotes carry the public { from_cents, max_km } (quoteFields). */\n",
  "was": "   `knownUid` (quoteRedemption already verified one) skips the second verify. */\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "async function quoteDeliveryFor(req, db, rid, body, { getIdentity, getAuth, attributionUid, knownUid, pricingP }) {\n  const t = TIP.normTip(body && typeof body === 'object' ? body.tip_cents : undefined);\n  if (Number.isNaN(t)) return { refuse: { ok: false, error: 'tip_invalid' }, httpStatus: 400 };\n  if (t > 0 && body.redeem != null) return { refuse: { ok: false, error: 'tip_reward_unsupported' }, httpStatus: 409 };\n",
  "was": "async function quoteDeliveryFor(req, db, rid, body, { getIdentity, getAuth, attributionUid, knownUid, pricingP }) {\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "  if (lp.failed) return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 };\n  if (!lp.pricing) return t > 0 ? { refuse: { ok: false, error: 'tip_not_enabled' }, httpStatus: 409 } : { ctx: null, uid: knownUid === undefined ? null : knownUid };\n",
  "was": "  if (lp.failed) return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 };\n  if (!lp.pricing) return { ctx: null, uid: knownUid === undefined ? null : knownUid };\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "  try { identity = await getIdentity(db, rid); } catch (_) { return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 }; }\n  const maxKm = lp.pricing.invalid ? null : coverageKm(lp.pricing, identity, body);   // an invalid config has no bands: quoteDelivery refuses it (delivery_pricing_invalid) exactly as before S2 — coverage is never read for it (codex S2-srv-tip r1 P2)\n  const q = P.quoteDelivery({ pricing: lp.pricing, hub: identity && { lat: identity.hub_lat, lng: identity.hub_lng }, mode: body && body.mode, pin: quotePin(body), customerUid: uid, ...(isApp(body) ? { maxKm } : {}) });\n  if (q.refusal) return { refuse: { ok: false, error: q.refusal }, httpStatus: REFUSAL_STATUS[q.refusal] === 503 ? 503 : 200 };   // a config outage is a 503; a request refusal stays a fail-soft 200 body\n  if (t > 0 && q.ctx.mode === 'pickup') return { refuse: { ok: false, error: 'tip_pickup' }, httpStatus: 400 };\n  const ctx = P.withTip(q.ctx, t);\n  PUBLIC.set(ctx, { from_cents: lp.pricing.bands[0].cents, max_km: maxKm });\n  return { ctx, uid };\n",
  "was": "  try { identity = await getIdentity(db, rid); } catch (_) { return { refuse: { ok: false, error: 'delivery_pricing_unavailable', retryable: true }, httpStatus: 503 }; }\n  const q = P.quoteDelivery({ pricing: lp.pricing, hub: identity && { lat: identity.hub_lat, lng: identity.hub_lng }, mode: body && body.mode, pin: quotePin(body), customerUid: uid });\n  return q.refusal ? { refuse: { ok: false, error: q.refusal }, httpStatus: REFUSAL_STATUS[q.refusal] === 503 ? 503 : 200 } : { ctx: q.ctx, uid };   // a config outage is a 503; a request refusal stays a fail-soft 200 body\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "}\n\n// S2 §3.6: an APP request (the only entry_mode value besides 'direct' — never priced, charge-inputs.js NON_CHARGE_FIELDS).\nconst isApp = (body) => !!body && body.entry_mode === 'app';\n// The coverage a quote reports and (for the app) enforces: the last band's max_km; for the app, also no further than the\n// restaurant's own delivery radius (the identity read just above — no new read). A missing/invalid radius → the bands.\nfunction coverageKm(pricing, identity, body) {\n  const last = pricing.bands[pricing.bands.length - 1].max_km;\n  const r = identity && identity.delivery_radius_km;\n  return isApp(body) && typeof r === 'number' && Number.isFinite(r) && r > 0 ? Math.min(last, r) : last;\n}\n// The public delivery facts of an ACTIVE quote ctx (WeakMap: never a field on the money ctx, never signed or recorded).\nconst PUBLIC = new WeakMap();\n",
  "was": "}\n"
 },
 {
  "file": "delivery/delivery-wire.js",
  "now": "// The additive quote response fields (absent when dark → byte-identical response).\nconst quoteFields = (ctx) => (ctx ? { delivery: { delivery_cents: ctx.delivery_cents, promo_discount_cents: ctx.promo_discount_cents, policy_version: ctx.policy_version, mode: ctx.mode, ...(PUBLIC.get(ctx) || {}) } } : {});   // S2 §3.6: + { from_cents, max_km }\n",
  "was": "// The additive quote response fields (absent when dark → byte-identical response).\nconst quoteFields = (ctx) => (ctx ? { delivery: { delivery_cents: ctx.delivery_cents, promo_discount_cents: ctx.promo_discount_cents, policy_version: ctx.policy_version, mode: ctx.mode } } : {});\n"
 },
 {
  "file": "driver-ledger/ledger-core.js",
  "now": "//\n// REFUNDS (plan §5 S8): the L 70 base is retained on any refund (the delivery happened).\n// TIPS (S2, PLAN-capp-S2-r4 §3.4 — OWNER-CONFIRMED 2026-10-25): the order's tip accrues to the driver ONLY at delivered, in\n// the SAME accrual as the base (current week → base_cents, late → adjustments_cents). A cancellation before delivery never\n// accrues it. A refund AFTER delivery does NOT claw the tip back (a manual adjustment is a backlog item): no refund hook.\n",
  "was": "//\n// REFUNDS (plan §5 S8): the L 70 base is retained on any refund (the delivery happened); only a tip-inclusive refund\n// reverses the tip. Tips do not exist until S2, so no refund can move a payable today — the refund-adjustment hook is\n// DEFERRED to S2 (advisor ruling 2026-10-22). Hook point: cancel-order-core.js, where the refund outcome is final\n// (`const refund = …` near :208), which S2 wires to a current-week adjustment referencing the original week.\n"
 },
 {
  "file": "driver-ledger/ledger-core.js",
  "now": "  const entry = (uid) => (drivers[uid] = drivers[uid] || { deliveries: [], adjustments: [] });\n  const tipsNow = new Map(), tipsLate = new Map();   // S2: driver uid → the tips of this week's / late deliveries (accrued with the delivery that pays them)\n",
  "was": "  const entry = (uid) => (drivers[uid] = drivers[uid] || { deliveries: [], adjustments: [] });\n"
 },
 {
  "file": "driver-ledger/ledger-core.js",
  "now": "    if (!stamp) { if (!listedUnres.has(oid)) unresolved.push(oid); continue; }\n    const tip = Number.isSafeInteger(o.tip_cents) && o.tip_cents > 0 ? o.tip_cents : 0;\n    const accrue = (acc) => acc.set(stamp, (acc.get(stamp) || 0) + tip);   // S2: the tip rides the delivery that pays it\n    if (o.delivered_at >= start) { entry(stamp).deliveries.push(oid); accrue(tipsNow); }\n    else { entry(stamp).adjustments.push({ order_id: oid, original_week: weekOf(o.delivered_at) }); accrue(tipsLate); }\n",
  "was": "    if (!stamp) { if (!listedUnres.has(oid)) unresolved.push(oid); continue; }\n    if (o.delivered_at >= start) entry(stamp).deliveries.push(oid);\n    else entry(stamp).adjustments.push({ order_id: oid, original_week: weekOf(o.delivered_at) });\n"
 },
 {
  "file": "driver-ledger/ledger-core.js",
  "now": "    const carry_in_cents = p && !p.paid && Number.isInteger(p.net_cents) && p.net_cents < 0 ? p.net_cents : 0;\n    const base_cents = d.deliveries.length * cfg.base_cents + (tipsNow.get(uid) || 0);         // S2: + the tips of this week's deliveries\n    const adjustments_cents = d.adjustments.length * cfg.base_cents + (tipsLate.get(uid) || 0);   // S2: + the late deliveries' tips\n",
  "was": "    const carry_in_cents = p && !p.paid && Number.isInteger(p.net_cents) && p.net_cents < 0 ? p.net_cents : 0;\n    const base_cents = d.deliveries.length * cfg.base_cents;\n    const adjustments_cents = d.adjustments.length * cfg.base_cents;    // tips join both in S2\n"
 },
 {
  "file": "factura/build-record.js",
  "now": "  return Math.max(0, d - p);\n}\n// S2 (PLAN-capp-S2-r4 §3.3): the tip is the driver's pass-through too — never on the fiscal total. Absent / 0 → 0 → byte-identical.\nfunction tipCents(order) {\n  const t = order.tip_cents;\n  return Number.isSafeInteger(t) && t > 0 ? t : 0;\n",
  "was": "  return Math.max(0, d - p);\n"
 },
 {
  "file": "factura/build-record.js",
  "now": "    isv_total_cents: order.tax_cents,\n    total_cents: order.total_cents - envioNetCents(order) - tipCents(order),   // the FOOD total (envío and the S2 tip excluded); the cash change below stays on the CHARGED total\n",
  "was": "    isv_total_cents: order.tax_cents,\n    total_cents: order.total_cents - envioNetCents(order),   // the FOOD total (envío excluded); the cash change below stays on the CHARGED total\n"
 },
 {
  "file": "order-exists.js",
  "now": "const ORDER_EXISTS_DETAIL = 'Ya hay un pedido en curso con este número. Revisá tu pedido o pago anterior antes de volver a intentar.';\nconst ORDER_EXISTS_REASONS = Object.freeze(new Set(['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'conflict', 'tip']));   // S2: + 'tip' (a changed tip on an existing order id — tip.js tipBindingConflict)\n",
  "was": "const ORDER_EXISTS_DETAIL = 'Ya hay un pedido en curso con este número. Revisá tu pedido o pago anterior antes de volver a intentar.';\nconst ORDER_EXISTS_REASONS = Object.freeze(new Set(['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'conflict']));\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "const { paymentBindingConflict, conflictOutcome, once, formatOf, FORMAT_CANONICAL, installFingerprint } = require('./catalog/canonical-binding');   // 1D D4-b §A.3\nconst { tipBindingConflict } = require('./tip');   // S2-srv-tip §3.2: the direct stored-tip compare, BEFORE the binding check at every site\n",
  "was": "const { paymentBindingConflict, conflictOutcome, once, formatOf, FORMAT_CANONICAL, installFingerprint } = require('./catalog/canonical-binding');   // 1D D4-b §A.3\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "   create CAS writes the a8 fingerprint (pendingOrderRecord already carries the a8 text + marker). */\nasync function acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, now, cartBlocked = [], genId = genAttemptId, genTok = genPollToken, canonicalFp = null, refuseFresh = false, controlRefuseFresh = false, menuRefuseFresh = false, choiceRefuseFresh = false, extrasRefuseFresh = null, textBinding = null, incomingTip = 0, payerRefuseFresh = false) {\n",
  "was": "   create CAS writes the a8 fingerprint (pendingOrderRecord already carries the a8 text + marker). */\nasync function acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, now, cartBlocked = [], genId = genAttemptId, genTok = genPollToken, canonicalFp = null, refuseFresh = false, controlRefuseFresh = false, menuRefuseFresh = false, choiceRefuseFresh = false, extrasRefuseFresh = null, textBinding = null) {\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "      if (order.payment_status === 'confirmed') return { outcome: 'already_paid' };\n      { const t = tipBindingConflict(order, incomingTip); if (t) return conflictOutcome(t); }   // S2: a changed tip → 'tip' (precedes the fingerprint, which also binds it)\n",
  "was": "      if (order.payment_status === 'confirmed') return { outcome: 'already_paid' };\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "    if (refuseFresh === true) return { outcome: 'conflict', reason: 'client_update_race' };\n    // S2 P-C (§4.1): no payer email for a FRESH checkout (the pre-reserve check passed on a reuse that raced to fresh, or the\n    // classify failed) → refused here, BEFORE the CAS: no attempt is created or retired; the caller releases only its own hold.\n    if (payerRefuseFresh === true) return { outcome: 'conflict', reason: 'payer_email_unconfigured' };\n",
  "was": "    if (refuseFresh === true) return { outcome: 'conflict', reason: 'client_update_race' };\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "      if (c.payment_status === 'confirmed') return c;\n      if (tipBindingConflict(c, incomingTip) || paymentBindingConflict(c, fingerprint, canon, a8)) return c;     // the CAS: (tip, format, fingerprint) on the record held\n",
  "was": "      if (c.payment_status === 'confirmed') return c;\n      if (paymentBindingConflict(c, fingerprint, canon, a8)) return c;     // the CAS: (format, fingerprint) on the record held\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "    if (committed.payment_status === 'confirmed') return { outcome: 'already_paid' };\n    { const t = tipBindingConflict(committed, incomingTip); if (t) return conflictOutcome(t); }   // S2: post-txn tip\n",
  "was": "    if (committed.payment_status === 'confirmed') return { outcome: 'already_paid' };\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "// OPEN (treats as \"do not gate\") — a DB hiccup must never block a sale.\nasync function classifyHostedAttempt(db, orderId, fingerprint, now, canonicalFp = null, a8Fp = null, incomingTip = 0) {\n",
  "was": "// OPEN (treats as \"do not gate\") — a DB hiccup must never block a sale.\nasync function classifyHostedAttempt(db, orderId, fingerprint, now, canonicalFp = null, a8Fp = null) {\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "  const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n  const r = await classifyFromOrder(db, order, fingerprint, now, canonicalFp, a8Fp, incomingTip);\n",
  "was": "  const order = (await db.ref(`orders/${orderId}`).once('value')).val();\n  const r = await classifyFromOrder(db, order, fingerprint, now, canonicalFp, a8Fp);\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "}\nasync function classifyFromOrder(db, order, fingerprint, now, canonicalFp, a8Fp = null, incomingTip = 0) {\n",
  "was": "}\nasync function classifyFromOrder(db, order, fingerprint, now, canonicalFp, a8Fp = null) {\n"
 },
 {
  "file": "pixelpay-hosted-charge.js",
  "now": "    if (order.payment_status === 'confirmed') return { willIssueFreshUrl: false, outcome: 'already_paid' };\n    { const t = tipBindingConflict(order, incomingTip); if (t) return conflictOutcome(t, { willIssueFreshUrl: false }); }   // S2: parity with acquire\n",
  "was": "    if (order.payment_status === 'confirmed') return { willIssueFreshUrl: false, outcome: 'already_paid' };\n"
 },
 {
  "file": "quote-issue.js",
  "now": "const { computeServerNet } = require('./compute-server-net');\nconst { tipCentsOf } = require('./delivery/delivery-pricing');   // S2-srv-tip\n",
  "was": "const { computeServerNet } = require('./compute-server-net');\n"
 },
 {
  "file": "quote-issue.js",
  "now": "      // not activated for envío, so every pre-S3 token payload is byte-identical.\n      ...(deliveryContext ? { delivery: { mode: deliveryContext.mode, policy_version: deliveryContext.policy_version, delivery_cents: deliveryContext.delivery_cents, promo_discount_cents: deliveryContext.promo_discount_cents, place: deliveryContext.place || null, customer: deliveryContext.customer || null,\n        ...(tipCentsOf(deliveryContext) > 0 ? { tip_cents: tipCentsOf(deliveryContext) } : {}) } } : {}),   // S2: the SIGNED tip (> 0 only — every no-tip payload and pre-S2 token is byte-identical); the gate binds it (deliveryBindingMismatch)\n",
  "was": "      // not activated for envío, so every pre-S3 token payload is byte-identical.\n      ...(deliveryContext ? { delivery: { mode: deliveryContext.mode, policy_version: deliveryContext.policy_version, delivery_cents: deliveryContext.delivery_cents, promo_discount_cents: deliveryContext.promo_discount_cents, place: deliveryContext.place || null, customer: deliveryContext.customer || null } } : {}),\n"
 },
 {
  "file": "rewards-redeem-intake.js",
  "now": "    ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}),\n    ...require('./delivery/delivery-wire').quoteFields(deliveryContext) };   // S3a envío block (absent when not activated); S2 §3.6: + the public { from_cents, max_km }, ONE builder with quoteOrder\n",
  "was": "    ...(issued.ok && issued.quote_token ? { quote_token: issued.quote_token } : {}),\n    ...(deliveryContext ? { delivery: { delivery_cents: deliveryContext.delivery_cents, promo_discount_cents: deliveryContext.promo_discount_cents, policy_version: deliveryContext.policy_version, mode: deliveryContext.mode } } : {}) };\n"
 },
 {
  "file": "stats/stats-api.js",
  "now": "  return [T.dateOf(ms), `${hh}:${mm}`, o.display_number == null ? '' : o.display_number, o.order_type || '', o.payment_method || '',\n    classifyOrder(o), L(Number(o.total_cents) - B.envioNetCents(o) - B.tipCents(o)), L(Number(o.subtotal_cents)), L(Number(o.tax_cents)), items];\n",
  "was": "  return [T.dateOf(ms), `${hh}:${mm}`, o.display_number == null ? '' : o.display_number, o.order_type || '', o.payment_method || '',\n    classifyOrder(o), L(Number(o.total_cents) - B.envioNetCents(o)), L(Number(o.subtotal_cents)), L(Number(o.tax_cents)), items];\n"
 },
 {
  "file": "stats/stats-build.js",
  "now": "}\n// S2 (PLAN-capp-S2-r4 §3.3): the tip is the driver's pass-through — never the restaurant's revenue. Absent / 0 → 0 → byte-identical.\nfunction tipCents(order) {\n  const t = order && order.tip_cents;\n  return Number.isSafeInteger(t) && t > 0 ? t : 0;\n}\n",
  "was": "}\n"
 },
 {
  "file": "stats/stats-build.js",
  "now": "function addSale(s, order, rid, keyer) {\n  const cents = int(order.total_cents) - envioNetCents(order) - tipCents(order);\n",
  "was": "function addSale(s, order, rid, keyer) {\n  const cents = int(order.total_cents) - envioNetCents(order);\n"
 },
 {
  "file": "stats/stats-build.js",
  "now": "  const cls = classifyOrder(order);\n  const cents = int(order.total_cents) - envioNetCents(order) - tipCents(order);   // S3c: the food total (refunds of the restaurant's sale exclude envío too); S2: and the tip\n",
  "was": "  const cls = classifyOrder(order);\n  const cents = int(order.total_cents) - envioNetCents(order);   // S3c: the food total (refunds of the restaurant's sale exclude envío too)\n"
 },
 {
  "file": "stats/stats-build.js",
  "now": "\nmodule.exports = { envioNetCents, tipCents,\n",
  "was": "\nmodule.exports = { envioNetCents,\n"
 },
 {
  "file": "whatsapp.js",
  "now": "\n// S2: the «Propina» line beside «Envío» — only when the order carries a tip (> 0); absent → no line, byte-identical.\nfunction propinaLines(propina) {\n  if (!propina || !Number.isSafeInteger(propina.cents) || propina.cents <= 0) return [];\n  return [`🤝 Propina: L${propina.cents / 100}`];\n}\n\nfunction renderOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId, brand, envio, propina }) {\n",
  "was": "\nfunction renderOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId, brand, envio }) {\n"
 },
 {
  "file": "whatsapp.js",
  "now": "    ...envioLines(envio),\n    ...propinaLines(propina),\n",
  "was": "    ...envioLines(envio),\n"
 }
];

const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);

function unapplyS2tipModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const i = out.indexOf(h.now);
    if (i < 0 || out.indexOf(h.now, i + 1) !== -1) throw new Error(`s2tip-module-inverse: ${file} hunk not found exactly once: ${h.now.slice(0, 80)}`);
    out = out.slice(0, i) + h.was + out.slice(i + h.now.length);
  }
  return out;
}

module.exports = { unapplyS2tipModule, FILES, HUNKS, BASE: '276ed944' };
