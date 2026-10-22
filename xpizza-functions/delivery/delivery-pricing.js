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
  return { policy_version: pv, bands: bands.map((b) => ({ max_km: b.max_km, cents: b.cents })), free_delivery: r.free_delivery === true };
}

/* The envío for one request on an ACTIVE restaurant → { ctx } or { refusal }.
   ctx = { mode, delivery_cents, promo_discount_cents, policy_version, km?, band?, promo? } — what the quote signs, the
   gate charges and the order records. */
function quoteDelivery({ pricing, hub, mode, pin, customerUid }) {
  if (!pricing || pricing.invalid) return { refusal: 'delivery_pricing_invalid' };
  if (mode === 'pickup') return { ctx: mint({ mode: 'pickup', delivery_cents: 0, promo_discount_cents: 0, policy_version: pricing.policy_version }) };
  if (mode !== 'delivery') return { refusal: 'mode_required' };
  if (!pin || pin.confirmed !== true || !isLat(pin.lat) || !isLng(pin.lng)) return { refusal: 'pin_required' };
  if (!hub || !isLat(hub.lat) || !isLng(hub.lng)) return { refusal: 'delivery_pricing_invalid' };
  const km = haversineKm(hub.lat, hub.lng, pin.lat, pin.lng);
  const band = pricing.bands.findIndex((b) => km <= b.max_km);
  if (band < 0) return { refusal: 'outside_delivery_bands' };
  const delivery_cents = pricing.bands[band].cents;
  const promo = pricing.free_delivery && typeof customerUid === 'string' && customerUid ? 'free_delivery' : null;
  return { ctx: mint({ mode: 'delivery', delivery_cents, promo_discount_cents: promo ? delivery_cents : 0, policy_version: pricing.policy_version,
    km: Math.round(km * 1000) / 1000, band, promo }) };
}

// The net envío the customer pays: max(0, delivery − promo).
const netDeliveryCents = (ctx) => (ctx ? Math.max(0, ctx.delivery_cents - ctx.promo_discount_cents) : 0);

// Only a ctx MADE HERE is money (computeServerNet ignores any other object — a request body can never mint one).
const SERVER_CTX = new WeakSet();
const isServerDeliveryCtx = (c) => !!c && typeof c === 'object' && SERVER_CTX.has(c);
const mint = (ctx) => { SERVER_CTX.add(ctx); return ctx; };

module.exports = { haversineKm, readPricing, quoteDelivery, netDeliveryCents, isServerDeliveryCtx };
