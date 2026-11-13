'use strict';
// D4 post-merge (asm7 HIGH gate P1 + P2, advisor 2026-11-12) — an SDK request that REUSES an existing order authorises a NEW attempt
// on it, so the order's STORED delivery facts (its pin to its immutable hub snapshot, against today's effective limit / zones) are
// admitted by Envío's ONE resume guard (delivery/zone-resume.js deliveryResumeRefusal) — never by the request's fresh context alone
// (chargeContext measures from the CURRENT hub; a moved hub can pass it while the stored pin is beyond the limit).
// Two call sites, the same rule: chargeOnlineApp in SDK mode BEFORE the content stamp / prune / rate-limit writes (P2), and finishSdk
// BEFORE enrol / the subject claim / any dispatch (P1, the race backstop). Envío's refusal contract, unchanged: { error, retryable?, order_id }.
// `deliveryResume(order)` is injected by the caller with the request's ONE pricing read (dpP); a fresh (absent) order ⇒ null.
const refusalOf = (lr, orderId) => ({ status: lr.httpStatus, body: { error: lr.refusal, ...(lr.httpStatus === 503 ? { retryable: true } : {}), order_id: orderId } });

// the stored order of this id, read once ⇒ { order, refusal } — refusal null ⇒ admitted (or no order yet)
async function storedAdmission(db, orderId, deliveryResume) {
  if (typeof deliveryResume !== 'function') throw new Error('storedAdmission: deliveryResume is required');   // never silently unguarded
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (order == null) return { order: null, refusal: null };
  const lr = await deliveryResume(order);
  return { order, refusal: lr ? refusalOf(lr, orderId) : null };
}
// the same rule on an order already in hand (finishSdk's create-once reuse of an order its first read did not see)
async function admitOrder(order, orderId, deliveryResume) {
  if (typeof deliveryResume !== 'function') throw new Error('admitOrder: deliveryResume is required');
  const lr = order == null ? null : await deliveryResume(order);
  return lr ? refusalOf(lr, orderId) : null;
}
module.exports = { storedAdmission, admitOrder, refusalOf };
