'use strict';
// ENVÍO STEP 2 (PLAN-envio-zones-step2-r2 §4.4, Codex r1 F1) — the read-only zone guard for RESUMING a live issued checkout, at both
// resume returns: chargeContext's grandfathered reuse (delivery-wire.js) and the reward-BOUND reuse (index.js, before chargeContext).
// App deliveries only (a stored delivery_snapshot with mode 'delivery'; forms carry none), on the STORED pin. It reads; it never
// releases, retires, captures or reverses — the caller answers the refusal before the reuse.
//   → null (resume as today) | { refusal: 'no_delivery_zone', httpStatus: 409 } | { refusal: 'delivery_zones_invalid' | 'delivery_pricing_unavailable', httpStatus: 503 }
const Z = require('./zones');

const num = (x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);

async function zoneResumeRefusal(db, order) {
  const s = order && order.delivery_snapshot;
  if (!s || typeof s !== 'object' || s.mode !== 'delivery') return null;
  const lp = await require('./delivery-wire').loadPricing(db);   // the ONE pricing reader (lazy: delivery-wire requires this module)
  if (lp.failed) return { refusal: 'delivery_pricing_unavailable', httpStatus: 503 };
  const pr = lp.pricing;
  if (!pr || pr.invalid) return null;   // no table / invalid bands: step 1's grandfathering, unchanged
  if (pr.zonesInvalid) return { refusal: 'delivery_zones_invalid', httpStatus: 503 };
  return pr.zones && Z.inZone(pr.zones, { lat: num(order.lat), lng: num(order.lng) }) ? { refusal: 'no_delivery_zone', httpStatus: 409 } : null;
}

// by order id — the reward-bound resume has no order in hand (one read of orders/{id}; absent → null)
async function zoneResumeRefusalFor(db, orderId) {
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  return order ? zoneResumeRefusal(db, order) : null;
}

module.exports = { zoneResumeRefusal, zoneResumeRefusalFor };
