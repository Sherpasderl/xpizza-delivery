'use strict';

/**
 * Materialize-time closed-kitchen guard (Scheduled Orders / Codex-on-diff on scheduled-checkout-ux).
 *
 * The intake guard (SCHED.asapWhileClosed in createOrder/chargeOnlineOrder) checks open-hours when an
 * online checkout is OPENED. But an online order is authorized at checkout and materializes LATER at
 * payment confirmation — a customer who opens checkout at 8:40pm (open) and pays at 8:50pm (past an
 * 8:45pm close) would otherwise land a live ASAP order on a dark kitchen.
 *
 * This is the shared re-check at the two materialize chokepoints (confirmAndMaterialize — which the
 * hosted webhook + materializeOnConfirm recovery both delegate to — and confirmAndMaterializeFrom
 * ManualClaim). For an UNSCHEDULED (ASAP) order, it re-reads current hours and, if the kitchen is closed
 * NOW, HOLDS the paid order (payment_status:'manual_review' + scheduled_blocked + dispatcher alert) for a
 * dispatcher to release-when-open / contact / refund — never status:'new'. This reuses the SHIPPED
 * hold+alert policy (mirrors closed-at-release and the scheduled-confirm re-validation); no new policy.
 *
 * Scheduled orders are untouched (they take their own hold path before reaching here). A config outage →
 * materialize (return false): captured money is NEVER stranded over a config blip, mirroring the shipped
 * inactive-restaurant post-capture posture. Returns true iff the order was held (caller must NOT materialize).
 */
const SCHED = require('./scheduled-orders');

async function holdIfClosedAtMaterialize(deps, orderId, order, now) {
  // Scheduled orders hold via their own path; this guard is ASAP-only. (G)
  if (Number.isFinite(Number(order && order.scheduled_for))) return false;
  // No config reader → can't re-check → materialize (never strand paid money). Matches legacy callers.
  if (!deps || !deps.getIdentity) return false;
  // Idempotent re-entry: a prior guard pass already resolved this order (refunded / cancelled / materialized). (E)
  // A materialized order also cannot reach here — confirmAndMaterialize returns at its materialized_at check
  // BEFORE calling this guard — so the refund branch never runs on a materialized (factura-issued) order.
  if (order && (order.payment_status === 'refunded' || order.status === 'cancelled' || order.materialized_at)) return true;

  const rid = (order && order.restaurant_id) || 'x_pizza';
  let hours;
  try { hours = (await deps.getIdentity(deps.db, rid)).hours; }
  catch (_) { return false; }   // (F) config outage → materialize (never strand captured money over a blip)

  const graceMin = deps.getGraceMinutes ? await deps.getGraceMinutes(deps.db) : 15;
  if (SCHED.isWithinGrace(hours, now, graceMin)) return false;   // (A/B) open OR within post-close grace → materialize normally

  // Past the REAL kitchen close → AUTO-REFUND. The order is pre-materialization (a materialized order
  // returns above / at the caller's materialized_at check) → NO factura was issued → no fiscal void.
  // CAS refund claim so two concurrent guard passes can NEVER double-refund/double-message: ONLY the pass
  // that transitions confirmed→refunding_paid_after_close proceeds (didClaim); every other pass no-ops.
  const orderRef = deps.db.ref(`orders/${orderId}`);
  let didClaim = false;
  const claim = await orderRef.transaction((cur) => {
    didClaim = false;
    const o = cur || order;
    if (!o) return o;
    if (o.payment_status === 'refunded' || o.status === 'cancelled' || o.materialized_at) return o; // already resolved (lost the race)
    if (o.payment_status === 'refunding_paid_after_close') return o;                                 // another pass owns the refund
    didClaim = true;
    return { ...o, payment_status: 'refunding_paid_after_close', refunding_at: now };
  });
  if (!claim.committed || !didClaim) return true;   // lost / other-owned / already-resolved → no-op (held; caller must NOT materialize)

  const attemptId = order && order.active_attempt_id;
  // The captured payment's uuid — voidOrRefund needs it to ACTUALLY reverse the capture. A FALSY uuid makes
  // voidOrRefund take the "no payment to void" branch (voided:true) → it would mark the order refunded WITHOUT
  // refunding the customer (money-loss). Every real caller passes the attempt's payment_uuid; mirror that.
  let paymentUuid = null;
  try { paymentUuid = (await deps.db.ref(`payment_attempts/${attemptId}/payment_uuid`).once('value')).val() || null; } catch (_) {}

  try {
    if (!paymentUuid) throw new Error('paid_after_close: missing payment_uuid — cannot confirm a real reversal');
    const rref = await deps.voidOrRefund(deps, {
      orderId, attemptId, pixelpayOrderId: `${orderId}-${attemptId}`, paymentUuid, reason: 'paid_after_close', now,
    });
    // Mark refunded ONLY on a CONFIRMED reversal. voided:false (refund_pending) is NOT a refund — the
    // refundReconciler will retry the attempt; the order must not falsely say "refunded" nor message the
    // customer. Treat any non-confirmed outcome as a failure → manual_review below.
    if (!rref || rref.voided !== true) throw new Error(`paid_after_close: reversal not confirmed (${rref && rref.message})`);
    await orderRef.update({
      payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close',
      refunded_at: now, refund_ref: (rref && rref.ref) || rref.outcome || null,
    });
    // Release any redemption hold — the EXACT cancel-path call (reverseRedemptionForOrder disposition:'refund':
    // reserved/held_paid → released). Best-effort + idempotent; no-op for a non-redeemed order.
    if (deps.releaseRewardHold) { try { await deps.releaseRewardHold(deps.db, { orderId, order, now }); } catch (_) {} }
    try { await deps.db.ref('paid_after_close_audit').push({ order_id: orderId, restaurant_id: rid, actor: 'system:paid_after_close', at: now, outcome: 'refunded' }); } catch (_) {}
    if (deps.sendPaidAfterCloseRefund) { try { await deps.sendPaidAfterCloseRefund(deps.db, { orderId, order }); } catch (_) {} }   // brand-aware customer message (only after a CONFIRMED refund)
  } catch (e) {
    // Missing uuid / refund threw / refund not confirmed → NEVER strand & never falsely refund: fall back to
    // manual_review + a reachable dispatcher action (Task 7, action = Reembolsar) + alert.
    await orderRef.update({ payment_status: 'manual_review', blocked_reason: 'refund_failed_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_failed_paid_after_close', { orderId, restaurant_id: rid, error: e && e.message }); } catch (_) {} }
  }
  return true;   // held / refunded / manual_review — caller must NOT materialize
}

module.exports = { holdIfClosedAtMaterialize };
