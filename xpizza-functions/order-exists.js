'use strict';
// order-exists.js — D4-c5 phase 1 (PLAN-D4c5 rev 6 §1/§2): the response for a request that names an EXISTING order id
// the server will not serve.
//
// The order forms automatically mint a fresh order id and resubmit ONCE when they see the legacy literals
// `order_conflict` (cash) or `Order conflict` / `Order closed` (online). Returned for an order that is still live or
// unresolved, that creates a SECOND purchase while the first stays live. So every existing-order refusal now answers
// with the typed, non-self-healing `409 order_exists`, which no form page mints on. The single exception is the cash
// classifier's `closed` reason for a snapshot PROVABLY terminal and money-free (isTerminalSafe), which keeps today's
// literal — and its self-heal.
//
// The body carries NO order data (advisor clarification within plan §1/§2): exactly { error, reason, detail, order_id },
// where order_id is the client's own echoed id and `reason` is drawn from a closed enum. A cross-restaurant id answers
// the neutral 'conflict' (no disclosure that the id belongs to another restaurant), and an order's own status never
// reaches the body — the call sites keep the specific value in their log line.

const ORDER_EXISTS = 'order_exists';
const ORDER_EXISTS_DETAIL = 'Ya hay un pedido en curso con este número. Revisá tu pedido o pago anterior antes de volver a intentar.';
const ORDER_EXISTS_REASONS = Object.freeze(new Set(['method', 'closed', 'cart', 'cart_unverifiable', 'binding_format_invalid', 'client_update_race', 'conflict']));

// §1 table — every row must hold, else the snapshot is not provably safe to self-heal.
const TERMINAL_SAFE_METHODS = Object.freeze(new Set(['cash', 'card_delivery']));
const TERMINAL_SAFE_STATUSES = Object.freeze(new Set(['delivered', 'completed', 'cancelled']));
// ABSENT means undefined: a present value of ANY type refuses (RTDB never stores null, so null cannot arise from a
// real snapshot; it refuses too, the conservative reading of "any value").
const MUST_BE_UNDEFINED = Object.freeze(['payment_status', 'redemption']);
// ABSENT means undefined or null; a present value of any type (incl. false, '', 0) refuses.
const MUST_BE_ABSENT = Object.freeze(['paid_during_resolve', 'active_attempt_id', 'payment_reference', 'cancel_claim_id',
  'resolving_claim_id', 'payment_uuid', 'capture_verified', 'hosted_callback_verified']);

// PURE. Uses ONLY the order snapshot the caller already read — no reads.
function isTerminalSafe(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return false;
  if (!TERMINAL_SAFE_METHODS.has(order.payment_method)) return false;
  if (!TERMINAL_SAFE_STATUSES.has(order.status)) return false;
  for (const k of MUST_BE_UNDEFINED) if (order[k] !== undefined) return false;
  for (const k of MUST_BE_ABSENT) if (order[k] !== undefined && order[k] !== null) return false;
  return true;
}

// PURE. createOrder's existing-order refusal (the classifier said 409). `restaurant` and `method` ALWAYS refuse typed
// (precedence, plan §1 B2); only `closed` is tested for the terminal exception. `legacy: true` = keep today's literal.
function decideCashExistingRefusal(clsReason, order) {
  if (clsReason === 'closed' && isTerminalSafe(order)) return { legacy: true };
  return { legacy: false, reason: clsReason === 'restaurant' ? 'conflict' : clsReason };
}

// The one body. A reason outside the closed enum (a value no call site produces today) answers the neutral 'conflict'
// rather than reaching the client.
function orderExistsBody(reason, orderId) {
  return { error: ORDER_EXISTS, reason: ORDER_EXISTS_REASONS.has(reason) ? reason : 'conflict', detail: ORDER_EXISTS_DETAIL, order_id: orderId };
}

module.exports = { ORDER_EXISTS, ORDER_EXISTS_DETAIL, ORDER_EXISTS_REASONS, MUST_BE_UNDEFINED, MUST_BE_ABSENT,
  isTerminalSafe, decideCashExistingRefusal, orderExistsBody };
