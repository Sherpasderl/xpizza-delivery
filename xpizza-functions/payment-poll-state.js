'use strict';

// Pure map: an order's (status, payment_status, blocked_reason) → the coarse, public-safe poll state
// the online-return page renders. Extracted from the paymentStatus HTTP handler (index.js) so the state
// machine is unit-testable (index.js is not require-safe). Order matters: scheduled + the paid-after-close
// auto-refund are distinct TERMINAL states that must be decided BEFORE the generic paid/cancelled mapping.
function paymentPollState(order) {
  const ps = order && order.payment_status, st = order && order.status;
  if (st === 'scheduled' || st === 'releasing') return 'scheduled_paid';
  if (order && order.blocked_reason === 'refunded_paid_after_close') return 'closed_refunded';   // paid-after-close auto-refund
  if (ps === 'confirmed' || ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed'].includes(st)) return 'paid';
  if (st === 'cancelled' || ps === 'refunded' || ps === 'refund_pending') return 'cancelled';
  if (ps === 'failed') return 'failed';
  if (ps === 'manual_reconciliation') return 'verifying';
  return 'pending';
}

module.exports = { paymentPollState };
