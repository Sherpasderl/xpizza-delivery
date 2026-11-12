'use strict';
// POST cancelSdkPending { order_id } → { cancelled, safe_to_switch } (PLAN-sdk-d4-r4 S4, §5, A1, W4) — the handler core (the HTTP
// wiring lands in S7). After the usual auth check: an absent order, ANOTHER customer's order and a non-SDK order all answer the
// IDENTICAL 200 no_sdk_order (no existence oracle; nothing written). A placed order is never cancelled here (409 already_placed). An
// owned SDK order — with or without a record — goes through the pending-only cancelSdkOrder, whose create-once cancelled record is
// the fence against a delayed placement; safe_to_switch is read from durable state AFTER it (stable once true). A safe switch
// releases the C6 subject.
const C = require('./coordinator');
const F = require('./flow');
const { authorizeExistingOrder } = require('./order-auth');
const { releaseSubject, subjectKey } = require('./subject');
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_SDK_ORDER = Object.freeze({ cancelled: false, safe_to_switch: true, reason: 'no_sdk_order' });

async function cancelSdkPendingCore(deps, { headers = {}, body = {} } = {}) {
  const orderId = body && body.order_id;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return { status: 400, body: { error: 'bad_request' } };
  const auth = await authorizeExistingOrder(deps, { authorization: headers.authorization, ticket: headers['x-sherpa-order-ticket'] }, orderId);
  if (!auth.ok && auth.status === 404) return { status: 200, body: { ...NO_SDK_ORDER } };   // absent ≡ foreign
  if (!auth.ok) return { status: auth.status, body: { error: auth.error } };
  let order = await C.readOrder(deps.db, orderId);
  if (!F.isSdkOrder(order)) return { status: 200, body: { ...NO_SDK_ORDER } };            // ≡ a non-SDK order
  if (order.payment_placed && !order.payment_cancel) return { status: 409, body: { error: 'already_placed' } };
  if (!order.payment_cancel) {
    const r = await C.cancelSdkOrder(deps, { orderId, kind: 'cancel', pendingOnly: true });
    order = await C.readOrder(deps.db, orderId);
    if (!order.payment_cancel) return order.payment_placed ? { status: 409, body: { error: 'already_placed' } } : { status: 409, body: { error: r.reason || 'not_cancellable' } };
  } else {
    await C.cancelSdkOrder(deps, { orderId, kind: order.payment_cancel.kind });   // resume the idempotent cleanup
  }
  const safe = C.safeToSwitch(await C.readRecord(deps.db, orderId), order);
  if (safe) {
    const subject = subjectKey({ uid: order.customer_uid, phoneHash: order.guest_verified && order.guest_verified.phone_hash });
    if (subject) await releaseSubject(deps, subject, orderId);
  }
  return { status: 200, body: { cancelled: true, safe_to_switch: safe } };
}
module.exports = { cancelSdkPendingCore, NO_SDK_ORDER };
