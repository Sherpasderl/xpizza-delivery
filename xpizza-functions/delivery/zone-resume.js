'use strict';
// ENVÍO STEP 2 (PLAN-envio-zones-step2-r2 §4.4, Codex r1 F1) + the RESTAURANT LIMIT (PLAN-envio-restaurant-limit-r5 §2.3) — the read-only
// guard for RESUMING a live issued checkout, at EVERY actual reuse: chargeContext's grandfathered reuse (delivery-wire.js), the
// reward-BOUND reuse (index.js), the hosted acquire's reuseGuard and chargeOnlineOrder's pre-bookkeeping check. App deliveries only (a
// stored delivery_snapshot with mode 'delivery'; forms carry none), on the STORED order: its pin to its IMMUTABLE hub snapshot
// (hub_lat / hub_lng, written at issuance), recomputed with haversine — never the rounded snapshot km, never the identity (zero reads
// beyond the request's ONE pricing read). It reads; it never releases, retires, captures or reverses — the caller answers first.
// Order: no table / invalid table → null (step 1) · branch-invalid limit → delivery_pricing_invalid · beyond the effective limit →
// outside_delivery_bands · malformed zones → delivery_zones_invalid · in a zone → no_delivery_zone (the fresh routes' order).
//   → null (resume as today) | { refusal, httpStatus }
const Z = require('./zones');
const P = require('./delivery-pricing');

const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);
const isLat = (x) => Number.isFinite(x) && x >= -90 && x <= 90;
const isLng = (x) => Number.isFinite(x) && x >= -180 && x <= 180;

async function deliveryResumeRefusal(db, order, pricingP) {
  const s = order && order.delivery_snapshot;
  if (!s || typeof s !== 'object' || s.mode !== 'delivery') return null;
  const lp = await (pricingP || require('./delivery-wire').loadPricing(db));   // the request's ONE pricing read when the caller has it (Codex build r1 #2)   // the ONE pricing reader (lazy: delivery-wire requires this module)
  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };
  const pr = lp.pricing;
  if (!pr || pr.invalid) return null;   // no table / invalid bands: step 1's grandfathering, unchanged
  const hub = { lat: num(order.hub_lat), lng: num(order.hub_lng) }, pin = { lat: num(order.lat), lng: num(order.lng) };
  if (!isLat(hub.lat) || !isLng(hub.lng) || !isLat(pin.lat) || !isLng(pin.lng)) return { refusal: 'order_context_changed', httpStatus: 409 };   // r5 P1-2: never reused
  const max = P.effectiveMaxKm(pr, order.restaurant_id);
  if (max === P.LIMIT_INVALID) return { refusal: 'delivery_pricing_invalid', httpStatus: 409 };
  if (P.haversineKm(hub.lat, hub.lng, pin.lat, pin.lng) > max) return { refusal: 'outside_delivery_bands', httpStatus: 409 };
  if (pr.zonesInvalid) return { refusal: 'delivery_zones_invalid', httpStatus: 503 };
  return pr.zones && Z.inZone(pr.zones, pin) ? { refusal: 'no_delivery_zone', httpStatus: 409 } : null;
}

/* r5 §2.4 — chargeOnlineOrder's PRE-BOOKKEEPING check, immediately before the content stamp / prune / rate limits (and so before the
   reserve, the A8 stamp and the acquire): no order, reservation, content-stamp, rate or payment write precedes a limit refusal.
   · dq route: chargeContext already read the stored order and its guarded grandfathered return answered (`resume`) — nothing re-read
   · null-dq route (a non-app-classified retry: entry_mode omitted / direct): ONE read of orders/{id}; a first attempt reads null → null */
async function preBookkeepingRefusal(db, orderId, dq, pricingP) {
  if (dq) return dq.resume ? dq : null;
  return deliveryResumeRefusal(db, (await db.ref(`orders/${orderId}`).get()).val(), pricingP);
}
/* r5 §2.4 — the acquire BACKSTOP's compensation: the content stamps (the bookkeeping stamp and the A8 stamp share the
   recent_order_content/{phone} family) that still name THIS order_id are removed, each in its own transaction, so a newer stamp is
   never touched and the customer's next legitimate order is neither a re-tap nor a materialize-side duplicate. Best-effort. */
async function dropOwnStamps(db, phoneKey, orderId) {
  if (!phoneKey || !orderId) return;
  try {
    const all = (await db.ref(`recent_order_content/${phoneKey}`).once('value')).val() || {};
    await Promise.all(Object.keys(all).filter((k) => all[k] && all[k].order_id === orderId).map((k) =>
      db.ref(`recent_order_content/${phoneKey}/${k}`).transaction((cur) => (cur && cur.order_id === orderId ? null : cur))));
  } catch (_) { /* best-effort: a stale stamp only costs one phone token on the next order */ }
}

module.exports = { deliveryResumeRefusal, preBookkeepingRefusal, dropOwnStamps };
