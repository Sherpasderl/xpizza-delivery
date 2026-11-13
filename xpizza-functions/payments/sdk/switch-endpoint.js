'use strict';
// POST cancelSdkPending { order_id } → { cancelled, safe_to_switch } (PLAN-sdk-d4-r4 S4, §5, A1, W4) — the handler core (the HTTP
// wiring lands in S7). After the usual auth check: an absent order, ANOTHER customer's order and a non-SDK order all answer the
// IDENTICAL 200 no_sdk_order (no existence oracle; nothing written). A placed order is never cancelled here (409 already_placed). An
// owned SDK order — with or without a record — goes through the pending-only cancelSdkOrder, whose create-once cancelled record is
// the fence against a delayed placement; safe_to_switch is read from durable state AFTER it (stable once true). A safe switch
// releases the C6 subject.
// THE FENCE (PLAN-sdk-fence-r1): the caller's order ABSENT (≡ foreign) ⇒ sdk_fence for (id, the caller) is stored FIRST, THEN the order is
// re-read — a late create that landed meanwhile goes through the owned path below; otherwise the byte-identical NO_SDK_ORDER. A guest's
// absent order is fenced only with a checkout ticket bound to THIS id (every other guest case keeps its 401). A failed fence write ⇒ 503
// (never safe_to_switch:true unfenced).
const C = require('./coordinator');
const F = require('./flow');
const { authorizeExistingOrder, authorizeExistingOrderAs } = require('./order-auth');
const { releaseSubject, subjectKey } = require('./subject');
const FN = require('./fence');
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NO_SDK_ORDER = Object.freeze({ cancelled: false, safe_to_switch: true, reason: 'no_sdk_order' });
const FENCE_UNAVAILABLE = Object.freeze({ status: 503, body: Object.freeze({ error: 'unavailable', retryable: true }) });

async function cancelSdkPendingCore(deps, { headers = {}, body = {} } = {}) {
  const orderId = body && body.order_id;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return { status: 400, body: { error: 'bad_request' } };
  const creds = { authorization: headers.authorization, ticket: headers['x-sherpa-order-ticket'] };
  const first = await authorizeExistingOrderAs(deps, creds, orderId);
  let auth = first.auth;
  if (!auth.ok) {
    // the fence's owner: a verified member whose order is absent ≡ foreign (404), or a guest whose order is ABSENT and whose ticket is bound to it
    const owner = auth.status === 404 ? FN.ownerOf({ uid: first.uid })
      : auth.error === 'guest_auth_required' && (await C.readOrder(deps.db, orderId)) == null ? await FN.guestOwnerForAbsent(deps, creds.ticket, orderId) : null;
    if (!owner) return auth.status === 404 ? { status: 200, body: { ...NO_SDK_ORDER } } : { status: auth.status, body: { error: auth.error } };
    try { await FN.writeFence(deps, orderId, owner); } catch (e) { console.error('cancelSdkPending: fence write failed', e && e.name); return { status: FENCE_UNAVAILABLE.status, body: { ...FENCE_UNAVAILABLE.body } }; }
    auth = await authorizeExistingOrder(deps, creds, orderId);   // THEN the re-read: a create that landed before the fence is cancelled below
    if (!auth.ok) return { status: 200, body: { ...NO_SDK_ORDER } };   // absent ≡ foreign (fenced for this caller)
  }
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
