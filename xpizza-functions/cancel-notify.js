'use strict';
/**
 * Pure decision core for the CUSTOMER cancellation WhatsApp (fired by sendOrderStatusNotifications on the
 * transition into status:'cancelled'). That message is otherwise unconditional, which mis-sends for an
 * ABANDONED CART: a customer who opens online checkout but never completes leaves a hidden pending skeleton
 * order (index.js pendingOrderRecord — carries customer_phone, no tracking_token). When the dispatcher
 * "Descartar"s it from reconciliation the order goes status:'cancelled' with payment_status:'abandoned'
 * (resolve-manual.js). The customer never knowingly placed THAT order, so "tu pedido fue cancelado" is
 * confusing — and if they later placed a real order, they think the real one was cancelled.
 *
 * Descartar is, by construction, the NEVER-PAID branch (refused when any payment evidence exists), so
 * payment_status:'abandoned' is a trustworthy "never actually placed" signal → send nothing. There is NO
 * replacement message to worry about: a never-placed order needs no notification at all.
 *
 * It also suppresses the generic message for a PAID-AFTER-CLOSE AUTO-REFUND (payment_status:'refunded',
 * status:'cancelled', blocked_reason:'refunded_paid_after_close', set by materialize-guard.js / the recovery
 * sweep). Those orders get a DEDICATED refund message from the finalize path (sendPaidAfterCloseRefund) — the
 * customer needs to hear about the REFUND, not a bare "cancelado" — so the generic one here would be a confusing
 * DOUBLE send. It is safe to suppress it: the dedicated send runs at the finalize path (right after the confirmed
 * reversal, not on a fragile status edge) with an at-most-once claim and a durable unresolved-marker on failure,
 * so it is the single, reliable, recoverable channel for that message — suppressing the generic never leaves the
 * customer silently un-notified.
 *
 * This is a read-only predicate over markers the writers already set — no new fields. Money-inert: it gates only
 * a NOTIFICATION. Every real cancellation (a dispatcher cancel, a manual Reembolsar) has neither marker and still
 * notifies. Fail-safe: an unknown/missing shape → notify (never silently drop a real cancellation).
 */
function suppressCancelledNotification(order) {
  if (!order || typeof order !== 'object') return false;   // fail-safe: unknown shape → notify (never silently drop a real cancel)
  return order.payment_status === 'abandoned'                 // never-placed cart (Descartar) → no message
      || order.blocked_reason === 'refunded_paid_after_close';  // paid-after-close auto-refund → dedicated refund message instead
}

module.exports = { suppressCancelledNotification };
