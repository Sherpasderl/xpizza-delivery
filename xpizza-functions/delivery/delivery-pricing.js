'use strict';
// S3a — ENVÍO, PURE CORE (PLAN-shared-order-form.FINAL §5 S3; advisor rulings 2026-10-22 A–H).
//
// Envío = Sherpa-set straight-line distance bands, branch hub → customer pin, computed by the SERVER at quote AND at
// order time from config + the request. Nothing incremental is stored: every quote/order derives it again, and the
// order keeps its own snapshot in the same atomic order write.
//
//   platform_config/delivery_pricing = {
//     policy_version: int ≥ 1,
//     bands: [{ max_km, cents }, …]          ascending max_km; a distance ≤ max_km takes that band; beyond the last → refused
//     restaurants: { [rid]: { active: bool, free_delivery: bool } }
//   }
// Sherpa-only (platform_config is .read/.write false; admin SDK only). Absent / invalid / restaurant not active → DARK:
// the order path is byte-identical to before S3 (delivery 0, no new field, no refusal).
//
// ACTIVE restaurant (ruling B, plan §5 S3 "no client-controlled downgrade"):
//   · mode must be 'delivery' or 'pickup' (omitted context is never legacy-free)
//   · delivery needs pin { lat, lng, confirmed: true } — confirmed is the client's word (a UX fact the server cannot
//     verify); the server requires it and valid coordinates, nothing more
//   · pickup → envío 0
//   · free_delivery ON + an authenticated customer → promo_discount_cents = delivery_cents (Sherpa-funded); guests pay
// Driver pay is unaffected (flat L 70, S8).

const crypto = require('crypto'); const Z = require('./zones');   // envío step 2: drawn no-delivery zones (PLAN-envio-zones-step2-r2)

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

const isLat = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -90 && x <= 90;
const isLng = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -180 && x <= 180;

// The config for ONE restaurant, or null (= dark). Invalid bands make the whole config dark-invalid: refused, never free.
function readPricing(raw, rid) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw.restaurants && typeof raw.restaurants === 'object' ? raw.restaurants[rid] : null;
  if (!r || r.active !== true) return null;
  const pv = raw.policy_version;
  const bands = Array.isArray(raw.bands) ? raw.bands : raw.bands && typeof raw.bands === 'object' ? Object.values(raw.bands) : [];
  let ok = Number.isInteger(pv) && pv >= 1 && bands.length > 0;
  let prev = 0;
  for (const b of bands) {
    if (!b || !(typeof b.max_km === 'number' && Number.isFinite(b.max_km) && b.max_km > prev) || !(Number.isSafeInteger(b.cents) && b.cents >= 0)) { ok = false; break; }
    prev = b.max_km;
  }
  if (!ok) return { invalid: true };
  const zp = Z.storedProblem(raw.no_delivery_zones), zl = Z.logical(raw.no_delivery_zones); return { policy_version: pv, bands: bands.map((b) => ({ max_km: b.max_km, cents: b.cents })), free_delivery: r.free_delivery === true, ...(zp ? { zonesInvalid: true } : zl.length ? { zones: zl } : {}) };   // step 2: malformed zones stay distinct from invalid bands (F5); absent → step 1's exact object
}

/* The envío for one request on an ACTIVE restaurant → { ctx } or { refusal }.
   ctx = { mode, delivery_cents, promo_discount_cents, policy_version, km?, band?, promo? } — what the quote signs, the
   gate charges and the order records. */
/* S2 §3.6: `maxKm` (the APP's effective coverage, min(last band, identity.delivery_radius_km) — delivery-wire quoteDeliveryFor)
   refuses a pin beyond it as outside_delivery_bands, so an app quote never prices a pin the order's radius check refuses.
   Absent (every legacy caller) → unchanged. */
function quoteDelivery({ pricing, hub, mode, pin, customerUid, maxKm = null }) {
  if (!pricing || pricing.invalid) return { refusal: 'delivery_pricing_invalid' };
  if (mode === 'pickup') return { ctx: mint({ mode: 'pickup', delivery_cents: 0, promo_discount_cents: 0, policy_version: pricing.policy_version, place: placeOf('pickup', hub, null), customer: uidOrNull(customerUid) }) };
  if (mode !== 'delivery') return { refusal: 'mode_required' };
  if (!pin || pin.confirmed !== true || !isLat(pin.lat) || !isLng(pin.lng)) return { refusal: 'pin_required' };
  if (!hub || !isLat(hub.lat) || !isLng(hub.lng)) return { refusal: 'delivery_pricing_invalid' };
  const km = haversineKm(hub.lat, hub.lng, pin.lat, pin.lng);
  const band = pricing.bands.findIndex((b) => km <= b.max_km);
  if (band < 0 || (typeof maxKm === 'number' && km > maxKm)) return { refusal: 'outside_delivery_bands' }; if (pricing.zonesInvalid) return { refusal: 'delivery_zones_invalid' }; if (pricing.zones && Z.inZone(pricing.zones, pin)) return { refusal: 'no_delivery_zone' };   // step 2: after the limit; pickup returned above
  const delivery_cents = pricing.bands[band].cents;
  const promo = pricing.free_delivery && typeof customerUid === 'string' && customerUid ? 'free_delivery' : null;
  return { ctx: mint({ mode: 'delivery', delivery_cents, promo_discount_cents: promo ? delivery_cents : 0, policy_version: pricing.policy_version,
    km: Math.round(km * 1000) / 1000, band, promo, place: placeOf('delivery', hub, pin), customer: uidOrNull(customerUid) }) };
}

const uidOrNull = (u) => (typeof u === 'string' && u ? u : null);
// The PLACE a quote priced (mode + hub + pin, 6 decimals ≈ 0.1 m) — signed into the quote token and compared at the charge,
// so a token for one fulfilment / pin / branch never authorises another whose total happens to be no higher (codex S3a P2-3).
const r6 = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(6) : 'x');
function placeOf(mode, hub, pin) {
  const s = [mode, r6(hub && hub.lat), r6(hub && hub.lng), r6(pin && pin.lat), r6(pin && pin.lng)].join('|');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
}

/* The quote's signed envío facts vs the server's envío for THIS charge → null (bound) or the mismatch reason. Not activated
   (no server ctx) → nothing to bind (dark / legacy, unchanged). A member-bound quote never authorises another account or a
   guest (re-quote — ruling C); a GUEST quote may be charged to a member (the promo can only lower the price, which the gate
   already charges). */
function deliveryBindingMismatch(signed, ctx) {
  if (!ctx) return null;
  if (!signed || typeof signed !== 'object') return 'delivery_unbound';
  if (signed.mode !== ctx.mode) return 'delivery_mode_mismatch';
  if (signed.place !== ctx.place) return 'delivery_place_mismatch';
  if (signed.customer && signed.customer !== ctx.customer) return 'delivery_customer_mismatch';
  if (tipCentsOf(signed) !== tipCentsOf(ctx)) return 'tip_mismatch';   // S2: the signed tip is the charged tip (absent on both = 0)
  return null;
}

/* A STORED order's envío as a server ctx — for a LIVE issued checkout, whose economics are locked at issuance (§3.3): the
   charge path prices it from what the order recorded, never from today's config (codex S3a P1-2). No snapshot (issued
   while dark) → null = food only, exactly what that checkout charges. */
function storedCtx(order) {
  const s = order && order.delivery_snapshot;
  if (!s || typeof s !== 'object' || !Number.isSafeInteger(order.delivery_cents) || !Number.isSafeInteger(order.promo_discount_cents)) return null;
  return mint({ mode: s.mode, delivery_cents: order.delivery_cents, promo_discount_cents: order.promo_discount_cents, policy_version: s.policy_version,
    ...(s.mode === 'delivery' ? { km: s.km, band: s.band, promo: s.promo || null } : {}), place: null, customer: null,
    ...(Number.isSafeInteger(order.tip_cents) && order.tip_cents > 0 ? { tip_cents: order.tip_cents } : {}) });   // S2: the tip the checkout was issued with
}

// The net envío the customer pays: max(0, delivery − promo).
const netDeliveryCents = (ctx) => (ctx ? Math.max(0, ctx.delivery_cents - ctx.promo_discount_cents) : 0);
// S2 (PLAN-capp-S2-r4 §3.1): the tip on a server ctx (or a signed payload's delivery block) — 0 when absent. It is NOT part of
// the envío (netDeliveryCents stays envío-only); computeServerNet and the order breakdown add it once, separately.
const tipCentsOf = (c) => (c && Number.isSafeInteger(c.tip_cents) && c.tip_cents > 0 ? c.tip_cents : 0);
// A server ctx carrying this request's tip — a NEW minted object (the original stays untouched). tip 0 → the same ctx.
const withTip = (ctx, tip) => (ctx && tip > 0 ? mint({ ...ctx, tip_cents: tip }) : ctx);

// Only a ctx MADE HERE is money (computeServerNet ignores any other object — a request body can never mint one).
const SERVER_CTX = new WeakSet();
const isServerDeliveryCtx = (c) => !!c && typeof c === 'object' && SERVER_CTX.has(c);
const mint = (ctx) => { SERVER_CTX.add(ctx); return ctx; };

module.exports = { haversineKm, readPricing, quoteDelivery, netDeliveryCents, isServerDeliveryCtx, deliveryBindingMismatch, storedCtx, placeOf, tipCentsOf, withTip };
