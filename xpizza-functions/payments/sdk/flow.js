'use strict';
// THE discriminator for SDK card orders (BRIEF r5 §2): every legacy money path refuses an order for which this is true,
// and routes its money to the SDK coordinator instead. payment_flow is written once by the server and is rules-immutable.
const SDK_FLOW = 'sdk_auth_v1';
const isSdkOrder = (order) => !!order && typeof order === 'object' && order.payment_flow === SDK_FLOW;

// The decision markers on orders/{id} and their EXACT shapes (Codex r1 #1). A present marker of any other shape — a scalar,
// a missing or extra field, a wrong type — is never acted on: the coordinator locks for a person instead.
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRev = (v, min) => Number.isInteger(v) && v >= min;
const isId = (v) => typeof v === 'string' && v.length > 0;
const exact = (v, keys) => isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const MARKER_SHAPES = Object.freeze({
  payment_placed: (v) => exact(v, ['leg_id', 'at']) && isId(v.leg_id) && isTime(v.at),
  payment_commit: (v) => exact(v, ['revision', 'pid']) && isRev(v.revision, 1) && isId(v.pid),
  payment_terminal: (v) => exact(v, ['revision', 'at']) && isRev(v.revision, 0) && isTime(v.at),
  payment_cancel: (v) => exact(v, ['kind', 'at']) && (v.kind === 'cancel' || v.kind === 'expire') && isTime(v.at),
});
// The first present-but-malformed marker's name, or null when every present marker is well-formed.
function markerFault(order) {
  if (!isObj(order)) return null;
  for (const [f, ok] of Object.entries(MARKER_SHAPES)) if (order[f] !== undefined && order[f] !== null && !ok(order[f])) return f;
  return null;
}
// The SDK go-live admission (ruling #9 A): placed, not cancelled, not terminal (marker AND status), every marker well-formed, not scheduled
// (scheduled SDK orders are refused at placement in this slice).
const CLOSED_STATUSES = Object.freeze(['delivered', 'completed', 'cancelled']);
const sdkGoLiveAdmits = (order) => isSdkOrder(order) && !markerFault(order) && !!order.payment_placed && !order.payment_cancel && !order.payment_terminal && order.scheduled_for == null
  && !CLOSED_STATUSES.includes(order.status);
// The shared go-live claim has committed and its materialization has not run, or its create-only paths are still pending:
// a cancel waits for it (or for its park).
const goLiveInFlight = (order) => isSdkOrder(order) && !!order.payment_placed && ((order.payment_status === 'confirmed' && !order.materialized_at) || order.sdk_live_pending != null);
// Placed, not live, not parked for a person: the go-live may be (re-)driven.
const goLiveRedrivable = (order) => isSdkOrder(order) && !!order.payment_placed && order.status === 'pending_payment' && !order.materialized_at && (order.payment_status === 'pending' || order.payment_status === 'confirmed');
// Live (claimed + materialized) with a redemption on the order: the shared go-live's already-confirmed branch is the
// idempotent consume backstop for a redemption still reserved (ruling A on the redemption gap).
const consumeBackstopDue = (order) => sdkGoLiveAdmits(order) && order.payment_status === 'confirmed' && !!order.materialized_at && !!order.redemption
  && typeof order.customer_uid === 'string' && order.customer_uid.length > 0 && typeof order.restaurant_id === 'string' && order.restaurant_id.length > 0;
// Fulfilled (delivered / completed), never cancelled, with a redemption on the order: a redemption still reserved is consumed.
const FULFILLED = Object.freeze(['delivered', 'completed']);
const terminalConsumeDue = (order) => isSdkOrder(order) && !markerFault(order) && FULFILLED.includes(order.status) && !order.payment_cancel && !!order.redemption
  && typeof order.customer_uid === 'string' && order.customer_uid.length > 0 && typeof order.restaurant_id === 'string' && order.restaurant_id.length > 0;
module.exports = { SDK_FLOW, isSdkOrder, MARKER_SHAPES, markerFault, sdkGoLiveAdmits, goLiveInFlight, goLiveRedrivable, consumeBackstopDue, terminalConsumeDue };
