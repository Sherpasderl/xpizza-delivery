'use strict';
// S-A1 — the durable rating FULFILMENT stamp (PLAN §S-A (b)): ratings_v2/{orderId}.fulfilled_at, set ONCE at the terminal transition
// to delivered OR completed, for members AND guests (set-if-absent; the node is created if absent; a deleted node is never touched).
// Driven by index.js's stampRatingFulfilment trigger on /orders/{orderId}/status. The v2 edit window runs from this stamp; an order
// without it (historical, or never fulfilled) is closed to v2 ratings. Reads orders/{orderId}/restaurant_id once, only when terminal.
const V2 = require('./rating-v2');

async function stampRatingFulfilment(db, { orderId, status, now }) {
  if (typeof orderId !== 'string' || !V2.ORDER_ID_RE.test(orderId) || !V2.FULFILLED.has(status)) return 'skip';
  const rid = (await db.ref(`orders/${orderId}/restaurant_id`).once('value')).val();
  const out = {};
  await V2.ratingRef(db, orderId).transaction(V2.fulfilmentUpdater({ restaurantId: rid, now }, out));
  return out.outcome;
}

module.exports = { stampRatingFulfilment };
