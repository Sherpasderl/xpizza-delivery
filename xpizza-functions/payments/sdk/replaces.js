'use strict';
// D4 S4 / S7 (c) (PLAN §S4, CONTRACT §2.2, A2) — THE replaces rule, shared by the SDK finish (B4) and createOrder (cash after a
// switch). A replaces_order_id naming the CALLER's own SDK order requires it placed or safe_to_switch (§5, from durable state),
// else 409 previous_payment_unresolved. Anything else — absent, foreign, non-SDK, the request's own id, no caller identity — is
// IGNORED: nothing about the named order is revealed or changed. Reads only.
const HC = require('../../pixelpay-hosted-charge');
const F = require('./flow');
const C = require('./coordinator');
const UNRESOLVED = Object.freeze({ status: 409, body: Object.freeze({ error: 'previous_payment_unresolved' }) });

// an order of THIS caller: the verified member, or a guest whose verified phone is the order's (never a member's / claimed order)
const ownedBy = ({ uid = null, pendingOrderRecord = null } = {}, o) => (uid ? !!o && o.customer_uid === uid
  : !!o && !o.customer_uid && !!(pendingOrderRecord && pendingOrderRecord.guest_verified) && !HC.guestForeign(o, pendingOrderRecord));
// placed, or safe_to_switch from durable state (§5)
async function resolvedOrder(deps, orderId, order) {
  const o = order || await C.readOrder(deps.db, orderId);
  if (!o) return true;
  if (o.payment_placed) return true;
  return C.safeToSwitch(await C.readRecord(deps.db, orderId), o);
}
async function replacesRefusal(deps, { orderId, replacesOrderId, uid = null, pendingOrderRecord = null } = {}) {
  if (typeof replacesOrderId !== 'string' || !replacesOrderId || replacesOrderId === orderId) return null;
  if (!uid && !(pendingOrderRecord && pendingOrderRecord.guest_verified)) return null;
  const prev = await C.readOrder(deps.db, replacesOrderId);
  if (!F.isSdkOrder(prev) || !ownedBy({ uid, pendingOrderRecord }, prev)) return null;
  return (await resolvedOrder(deps, replacesOrderId, prev)) ? null : { status: UNRESOLVED.status, body: { ...UNRESOLVED.body } };
}
module.exports = { replacesRefusal, ownedBy, resolvedOrder, UNRESOLVED };
