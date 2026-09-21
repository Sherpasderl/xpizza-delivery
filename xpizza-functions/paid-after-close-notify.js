'use strict';
/**
 * Pure decision core for the paid-after-close REFUND-message reliability (drives sendPaidAfterCloseRefund + the
 * refundReconciler notification-recovery branch in index.js). No firebase, no I/O.
 *
 * CONTRACT: AT-LEAST-ONCE, not exactly-once. A fire-and-forget WhatsApp send plus a possible crash between the
 * terminal refund write and the send make "exactly one" provably impossible. For a REFUND notice the right
 * failure direction is never-SILENT (a refunded customer must hear about it), so a rare duplicate is accepted
 * (both messages are true, money is safe). `paid_after_close_refund_sent_at` is the source of truth, written
 * ONLY after a confirmed send; every sender/sweep pass skips once it is set.
 */

// The sender's idempotent dedupe gate: skip if the refund message was already CONFIRMED sent.
function alreadyRefundNotified(order) {
  return !!(order && order.paid_after_close_refund_sent_at);
}

// The sweep's notification-recovery selector: a paid-after-close refund that FINALIZED (refunded +
// 'refunded_paid_after_close') but never confirmed its customer message (crash after the terminal write before
// the send, or a null send), old enough that it can't be racing an in-flight finalize's own send.
// staleMs guards against re-driving an order the finalize path is, at this instant, still sending for.
function needsRefundNotifyRecovery(order, now, staleMs) {
  if (!order) return false;
  if (order.payment_status !== 'refunded') return false;              // must be the terminal refunded state
  if (order.blocked_reason !== 'refunded_paid_after_close') return false;  // ...specifically paid-after-close
  if (order.paid_after_close_refund_sent_at) return false;            // already confirmed sent → nothing to recover
  const refundedAt = Number(order.refunded_at);
  const age = now - (Number.isFinite(refundedAt) ? refundedAt : now); // missing refunded_at → age 0 → not yet stale (conservative)
  return age > staleMs;
}

module.exports = { alreadyRefundNotified, needsRefundNotifyRecovery };
