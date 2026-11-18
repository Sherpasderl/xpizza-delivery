'use strict';
// S-A1 — the durable rating FULFILMENT stamp (PLAN §S-A (b)): ratings_v2/{orderId}.fulfilled_at, set ONCE at the terminal transition
// to delivered OR completed, for members AND guests (set-if-absent; the node is created if absent; a deleted node is never touched).
// Driven by index.js's stampRatingFulfilment trigger on /orders/{orderId}/status. The v2 edit window runs from this stamp; an order
// without it (historical, or never fulfilled) is closed to v2 ratings. Reads orders/{orderId}/restaurant_id once, only when terminal.
// THE TIME (Calificaciones v2, PLAN-3a-merchant-reviews-v2 r3 §4): fulfilled_at = the ORDER's own terminal timestamp — delivered_at for
// delivered (the transition writer's field, set in the same update), completed_at for completed — clamped ≤ the event time; absent or
// malformed ⇒ the event time. `eventTime` is the CloudEvent's time (identical across retries), never the trigger's wall clock; without a
// usable one the trigger throws and retries. Census of the writers (D4c-grill NOTE-reviews-v2-s3-fulfilment-census.md): delivered_at is
// set with the delivered status by the driver app (driver-complete.js) and dispatch; no writer sets completed_at (pickups use the event).
const V2 = require('./rating-v2');

const TERMINAL_AT = Object.freeze({ delivered: 'delivered_at', completed: 'completed_at' });

async function stampRatingFulfilment(db, { orderId, status, eventTime }) {
  if (typeof orderId !== 'string' || !V2.ORDER_ID_RE.test(orderId) || !V2.FULFILLED.has(status)) return 'skip';
  if (!Number.isSafeInteger(eventTime) || eventTime <= 0) throw new Error('stampRatingFulfilment: no event time');
  const [rid, at] = await Promise.all([db.ref(`orders/${orderId}/restaurant_id`).once('value'), db.ref(`orders/${orderId}/${TERMINAL_AT[status]}`).once('value')]).then((s) => s.map((x) => x.val()));
  const fulfilledAt = Number.isSafeInteger(at) && at > 0 ? Math.min(at, eventTime) : eventTime;
  const out = {};
  const tx = await V2.ratingRef(db, orderId).transaction(V2.fulfilmentUpdater({ restaurantId: rid, fulfilledAt }, out));
  // S-A(d): the merchant index entry — on 'stamped' AND 'kept' (a retry / a crash after the stamp heals), from the COMMITTED node
  if (out.outcome === 'stamped' || out.outcome === 'kept') await V2.indexNode(db, orderId, tx && tx.snapshot ? tx.snapshot.val() : null);
  return out.outcome;
}

module.exports = { stampRatingFulfilment };
