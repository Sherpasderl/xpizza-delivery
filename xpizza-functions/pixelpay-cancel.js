/**
 * X Pizza — PixelPay void/refund helper (Stage 6: cancel/refund).
 *
 * `voidOrRefund` reverses a payment (void an unsettled capture or release an auth
 * hold) and records an IMMUTABLE `/refund_attempts/*` audit entry. Used by:
 *   - cancelPaidOrder (a dispatcher cancels a paid order)
 *   - confirmOnlinePayment's cancel-vs-confirm race guard (a capture that lands after
 *     a cancel → void, never materialize — invariant I8)
 *   - refundReconciler (retry an aged refund_pending)
 *
 * Pure of Firebase specifics: `db` + `client` (pixelpay-client) are injected so it's
 * unit-tested against the in-memory mock. On void failure the attempt is left
 * `refund_pending` (tracked + alerted), never silently lost (I6).
 *
 * PRODUCTION NOTE: the sandbox accepts void with key+hash only; the production void
 * SIGNATURE is still UNVERIFIED (Stage-6 gate). A failed production void → refund_pending
 * → the refundReconciler + dispatcher queue handle it.
 */

async function voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId, paymentUuid, reason, now }) {
  const { db, client } = deps;
  let voided = false;
  let message = null;

  if (paymentUuid) {
    try {
      const vd = await client.voidTransaction({ payment_uuid: paymentUuid, pixelpayOrderId, voidReason: reason || 'xpizza_cancel' });
      voided = !!vd.ok;
      message = vd.message || (vd.errors ? JSON.stringify(vd.errors) : null);
    } catch (e) {
      message = (e && e.message) || 'void_error';
    }
  } else {
    // No payment to reverse (auth never captured / nothing charged) → nothing owed.
    voided = true;
    message = 'no_payment_to_void';
  }

  // Immutable audit record (write-once; never updated).
  try {
    await db.ref(`refund_attempts/${attemptId}-${now}`).set({
      order_id: orderId,
      attempt_id: attemptId,
      payment_uuid: paymentUuid || null,
      pixelpay_order_id: pixelpayOrderId || null,
      reason: reason || null,
      voided,
      message,
      at: now
    });
  } catch (e) {
    // The audit write failing must not strand the void result; log via alert.
    deps.alert && deps.alert('refund_audit_write_failed', { orderId, attemptId, error: e && e.message });
  }

  await db.ref(`payment_attempts/${attemptId}`).update({
    status: voided ? 'refunded' : 'refund_pending',
    refunded_at: voided ? now : null,
    refund_message: message
  });

  if (!voided) {
    deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message });
  }
  return { outcome: voided ? 'refunded' : 'refund_pending', voided, message };
}

module.exports = { voidOrRefund };
