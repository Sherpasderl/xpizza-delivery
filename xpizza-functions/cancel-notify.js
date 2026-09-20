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
 * This is a read-only predicate over a marker the writer already sets — no new fields. Money-inert: it gates
 * only a NOTIFICATION, and Descartar issues no refund, so suppressing the message can never skip a refund.
 * Every real cancellation (a dispatcher cancel, a manual Reembolsar) has no such marker and still notifies.
 *
 * NOTE — the paid-after-close DOUBLE message (a refunded order getting both the dedicated refund message AND
 * this generic one) is a separate, pre-existing bug. It is NOT suppressed here: the marker
 * blocked_reason:'refunded_paid_after_close' proves the refund happened, NOT that the customer was successfully
 * notified (the dedicated send is best-effort and its result is unchecked), so suppressing on it could drop the
 * customer's only message. That fix consolidates the two senders into one and is handled on its own slice.
 */
function suppressCancelledNotification(order) {
  if (!order || typeof order !== 'object') return false;   // fail-safe: unknown shape → notify (never silently drop a real cancel)
  return order.payment_status === 'abandoned';               // never-placed cart (Descartar) → the ONLY suppression
}

module.exports = { suppressCancelledNotification };
