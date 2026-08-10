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
 * ManualClaim). For an UNSCHEDULED (ASAP) order it re-reads current hours and: OPEN or within the
 * post-close GRACE (config close + config/order_grace_minutes) → materialize normally; PAST the real
 * kitchen close → AUTO-REFUND the captured payment (pre-materialization → no factura → no fiscal void),
 * never land a live ASAP order on a dark kitchen. Refund-failure is split by cause (refund_pending →
 * reconciler owns it; hard-fail → manual_reconciliation), never a false "refunded". Returns true iff the
 * caller must NOT materialize (held / refunded / refund_pending / manual_reconciliation).
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
    if (o.payment_status !== 'confirmed') return o;                                                  // REVISE-4: only claim a CONFIRMED order (defensive — the guard runs post-confirm)
    didClaim = true;
    return { ...o, payment_status: 'refunding_paid_after_close', refunding_at: now };
  });
  if (!claim.committed || !didClaim) return true;   // lost / not-confirmed / other-owned / already-resolved → no-op

  const attemptId = order && order.active_attempt_id;
  // The captured payment's uuid — voidOrRefund needs it to ACTUALLY reverse the capture. A FALSY uuid makes
  // voidOrRefund take the "no payment to void" branch (voided:true) → it would mark the order refunded WITHOUT
  // refunding the customer (money-loss). Every real caller passes the attempt's payment_uuid; mirror that.
  let paymentUuid = null;
  try { paymentUuid = (await deps.db.ref(`payment_attempts/${attemptId}/payment_uuid`).once('value')).val() || null; } catch (_) {}

  // REVISE-1: missing uuid → NO reversal is/was attempted → route to manual_reconciliation (dispatcher-resolvable
  // in the existing panel; the resolver's no-uuid branch converges honestly). No reversal in flight ⇒ no race
  // with the hourly refundReconciler (which only re-drives refund_pending / stale reversing attempts).
  if (!paymentUuid) {
    await orderRef.update({ payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_failed_paid_after_close', { orderId, restaurant_id: rid, reason: 'no_payment_uuid' }); } catch (_) {} }
    return true;
  }

  let rref = null, threw = null;
  try {
    rref = await deps.voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId: `${orderId}-${attemptId}`, paymentUuid, reason: 'paid_after_close', now });
  } catch (e) { threw = e; }

  // CONFIRMED reversal (voided===true) → refund the customer. (An order-update throw here leaves the order at
  // refunding_paid_after_close; the item-5 stale-recovery sweep re-reads the attempt and finalizes it.)
  if (!threw && rref && rref.voided === true) {
    await orderRef.update({
      payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close',
      refunded_at: now, refund_ref: (rref && rref.ref) || rref.outcome || null,
    });
    if (deps.releaseRewardHold) { try { await deps.releaseRewardHold(deps.db, { orderId, order, now }); } catch (_) {} }   // exact cancel-path reverseRedemptionForOrder('refund'); idempotent, no-op for non-redeemed
    try { await deps.db.ref('paid_after_close_audit').push({ order_id: orderId, restaurant_id: rid, actor: 'system:paid_after_close', at: now, outcome: 'refunded' }); } catch (_) {}
    if (deps.sendPaidAfterCloseRefund) { try { await deps.sendPaidAfterCloseRefund(deps.db, { orderId, order }); } catch (_) {} }   // customer message ONLY after a confirmed refund
    return true;
  }

  // REVERSAL NOT CONFIRMED — split by whether a reversal is IN FLIGHT (owned by the hourly refundReconciler,
  // which re-drives an attempt in refund_pending / stale reversing via voidOrRefund's attempt-CAS). Re-read the
  // attempt: voided===false ⇒ voidOrRefund set it refund_pending; a throw may have left it reversing or untouched.
  let attemptStatus = null;
  try { attemptStatus = (await deps.db.ref(`payment_attempts/${attemptId}/status`).once('value')).val(); } catch (_) {}
  if (attemptStatus === 'refund_pending' || attemptStatus === 'reversing') {
    // REVISE-1: reversal IN FLIGHT → the reconciler finishes it (idempotent). Do NOT expose a manual button —
    // a direct manual void (resolve-manual.js) bypasses the attempt-CAS → double-refund. refund_pending sentinel.
    await orderRef.update({ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_pending_paid_after_close', { orderId, restaurant_id: rid, error: threw && threw.message }); } catch (_) {} }
  } else {
    // No reversal in flight (threw before the reversal CAS) → dispatcher-resolvable. SAFE: the reconciler ignores
    // this attempt (not refund_pending/reversing), so the resolver's direct void is the SOLE reversal — no race.
    await orderRef.update({ payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' });
    if (deps.alert) { try { await deps.alert('refund_failed_paid_after_close', { orderId, restaurant_id: rid, error: threw && threw.message }); } catch (_) {} }
  }
  return true;   // held / refunded / refund_pending / manual_reconciliation — caller must NOT materialize
}

// REVISE-5/-2: stale-recovery decision for a paid-after-close order whose ORDER outcome is hanging — either
//   (a) stuck at 'refunding_paid_after_close' (a crash between voidOrRefund and the order-update), OR
//   (b) parked at payment_status:'refund_pending' + blocked_reason:'refund_pending_paid_after_close' (the
//       reversal was in flight; the hourly reconciler re-drives the ATTEMPT to terminal, but nothing else
//       finalizes the ORDER → refunded-but-silent).
// PURE — the sweep (refundReconciler) re-reads the attempt and applies this. Money is always safe (the
// attempt's own CAS/idempotency); this closes the ORDER/customer outcome. Both states carry refunding_at.
//   attempt refunded/voided → finalize_refunded (complete the order + customer message — fires once);
//   attempt refund_pending/reversing → refund_pending (reconciler still owns it — leave as-is);
//   else (captured / gone) → manual_reconciliation (no reversal in flight → dispatcher-resolvable).
// Fresh (< staleMs since refunding_at) or not a paid-after-close hanging order → none.
function recoverRefundingDecision(order, attempt, now, staleMs) {
  if (!order) return { action: 'none' };
  const isRefunding = order.payment_status === 'refunding_paid_after_close';
  const isRefundPending = order.payment_status === 'refund_pending' && order.blocked_reason === 'refund_pending_paid_after_close';
  if (!isRefunding && !isRefundPending) return { action: 'none' };
  if ((now - (Number(order.refunding_at) || 0)) < staleMs) return { action: 'none' };
  const st = attempt && attempt.status;
  if (st === 'refunded' || st === 'voided') return { action: 'finalize_refunded' };
  if (st === 'refund_pending' || st === 'reversing') return { action: 'refund_pending' };
  return { action: 'manual_reconciliation' };
}

module.exports = { holdIfClosedAtMaterialize, recoverRefundingDecision };
