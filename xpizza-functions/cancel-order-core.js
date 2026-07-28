'use strict';

/**
 * Dispatcher cancellation — deps-injected wiring (CANCEL_PAID_ORDER_FIX_PLAN.md rev-5, Codex-APPROVED).
 * Orchestrates the PURE decisions in cancel-order.js against injected db / voidOrRefund / alert. Extracted
 * (like resolve-manual.js) so the emulator F-matrix drives REAL concurrent transactions; index.js's
 * generalized `cancelPaidOrder` is a thin auth→core→HTTP adapter.
 *
 * EVERY transaction() callback here is null-first-safe (`if (cur === null) return null`) — the exact
 * liveness bug the atomic-claim F-matrix caught. `cancel_pending` is set on the attempt immediately after
 * the order claim (before any void) so a paid callback in that window is auto-voided by the hosted webhook,
 * never materialized.
 *
 * deps = { db, voidOrRefund, alert, serverTimestamp }
 */
const MR = require('./manual-resolve');
const C = require('./cancel-order');
const { reverseEarnForOrder } = require('./rewards-earn');   // Rewards Phase A — earn clawback on cancel (idempotent, fail-open)

// Idempotent, best-effort task-cancel + driver release (NON-money). onOrderCancelled is the durable backstop.
async function cleanupTasksAndDriver(deps, orderId, order, now) {
  const { db } = deps;
  const updates = {};
  if (order && order.order_type === 'delivery') {
    const pickupTaskId = `${orderId}_pickup`, deliveryTaskId = `${orderId}_delivery`;
    const pickup = (await db.ref(`tasks/${pickupTaskId}`).once('value')).val();
    if (pickup && pickup.status !== 'cancelled') updates[`tasks/${pickupTaskId}/status`] = 'cancelled';
    const delivery = (await db.ref(`tasks/${deliveryTaskId}`).once('value')).val();
    if (delivery && delivery.status !== 'cancelled') updates[`tasks/${deliveryTaskId}/status`] = 'cancelled';
    const driverId = pickup && pickup.assigned_driver_id;
    if (driverId) {
      const driver = (await db.ref(`drivers/${driverId}`).once('value')).val();
      if (driver && (driver.current_task_id === pickupTaskId || driver.current_task_id === deliveryTaskId)) {
        updates[`drivers/${driverId}/current_task_id`] = null;
        if (['assigned', 'at_restaurant', 'en_route_delivery'].includes(driver.status)) updates[`drivers/${driverId}/status`] = 'available';
      }
    }
  }
  if (Object.keys(updates).length) await db.ref().update(updates);
}

// Money-critical finalize: ORDER-node tx re-verifying OUR claim, writes status+payment, CLEARS claim metadata.
async function finalize(orderRef, { claimId, now, actor, reason, paymentStatus }) {
  const tx = await orderRef.transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur || cur.cancel_claim_id !== claimId) return;               // lost the claim → abort
    const next = { ...cur, status: 'cancelled', cancelled_at: now, cancelled_by: actor, cancel_reason: reason,
      cancel_claim_id: null, resolving_action: null, resolving_phase: null, resolving_claimed_at: null, side_effect_started_at: null };
    if (paymentStatus) next.payment_status = paymentStatus;
    return next;
  });
  const v = tx.snapshot.val();
  // LOOSE == null: the tx sets cancel_claim_id:null, and RTDB DELETES null-valued keys, so on the committed
  // snapshot the key is ABSENT (undefined), not null. `=== null` here reports claim_lost on a cancel that
  // actually committed (emulator-caught; goldens can't model null-key deletion). The four `=== null` above are
  // null-first `cur` guards (RTDB's speculative null) and are correct — do NOT loosen those.
  return tx.committed && v && v.cancel_claim_id == null && v.status === 'cancelled';
}

// Release the claim WITHOUT cancelling (the captured-but-no-uuid case: never strand money on a cancelled order).
async function releaseCancelClaim(orderRef, claimId) {
  await orderRef.transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur || cur.cancel_claim_id !== claimId) return;
    return { ...cur, cancel_claim_id: null, resolving_action: null, resolving_phase: null, resolving_claimed_at: null };
  });
}

async function cancelOrderCore(deps, { orderId, actor, reason, now, claimId }) {
  const { db, voidOrRefund, alert, serverTimestamp } = deps;
  const orderRef = db.ref(`orders/${orderId}`);
  const audit = async (outcome, extra = {}) => {
    await db.ref('payment_audit').push({ order_id: orderId, action: 'cancel', actor, claim_id: claimId, outcome, at: serverTimestamp, ...extra });
  };

  const order = (await orderRef.once('value')).val();
  if (!order) return { status: 404, body: { error: 'Order not found' } };

  // B.2 allowed-state gate
  const g = C.gate(order);
  if (g.reject) {
    if (g.reject.alert) await alert('cancel_manual_review', { orderId, payment_status: order.payment_status });
    return { status: g.reject.code, body: { ok: false, outcome: g.reject.outcome, error: g.reject.error, order_id: orderId } };
  }

  const attemptId = order.active_attempt_id || null;
  let attempt = attemptId ? (await db.ref(`payment_attempts/${attemptId}`).once('value')).val() : null;

  // B.4 idempotency — ONLY for an order already status==='cancelled'.
  if (order.status === 'cancelled') {
    const d = C.cancelledDecision(order, attempt);
    if (!d.heal) {
      if (d.alert) await alert('cancel_manual_review', { orderId, payment_status: order.payment_status });
      return { status: d.code, body: { ok: d.code === 200, outcome: d.outcome, order_id: orderId } };
    }
    // heal → proceed to claim + void
  }

  // B.5 claim — null-first-safe unique cancel_claim_id; verify OUR claim landed.
  const claimTx = await orderRef.transaction((cur) => C.claimDecision(cur, claimId, now));
  if (!claimTx.committed || !C.claimLanded(claimTx.snapshot.val(), claimId)) {
    return { status: 409, body: { ok: false, outcome: 'claim_lost', error: 'Cancelación en proceso por otro', order_id: orderId } };
  }
  const claimed = claimTx.snapshot.val();

  // B.6 close BOTH capture-in-flight paths — attempt gets cancelling:true (confirmOnlinePayment) AND
  // cancel_pending:true (pixelpay-hosted-webhook.js:77) so a paid callback in this window is auto-voided.
  if (attemptId) {
    const atx = await db.ref(`payment_attempts/${attemptId}`).transaction((cur) => {
      if (cur === null) return null;                                   // null-first-safe
      if (!cur) return;
      return { ...cur, cancelling: true, cancel_pending: true, cancel_reason: reason, cancel_claimed_at: now };
    });
    attempt = atx.snapshot.val() || attempt;
  }

  // B.7 void — only the claim owner, only captured money not already reversed. Durable marker BEFORE the call.
  const wantVoid = C.shouldVoid(claimed, attempt);
  let voided = false;
  if (wantVoid) {
    const uuid = attempt && attempt.payment_uuid;
    if (!uuid) {
      // Captured money but NO resolvable uuid (F8-r1) → never cancel-and-strand: release the claim + alert.
      await releaseCancelClaim(orderRef, claimId);
      await audit('manual_review', { reason: 'captured_no_uuid' });
      await alert('cancel_manual_review', { orderId, reason: 'captured_no_uuid' });
      return { status: 409, body: { ok: false, outcome: 'manual_review', order_id: orderId } };
    }
    // [Fix#2] Durable marker = a CLAIM-CHECKED CAS (not a blind update). Returns whether it committed;
    // voidOrRefund ABORTS the void if it didn't (never an unmarked void → no unrecoverable double-void window).
    const markSideEffectStarted = async () => {
      const mtx = await orderRef.transaction((cur) => {
        if (cur === null) return null;                                 // null-first-safe
        if (!cur || cur.cancel_claim_id !== claimId) return;           // lost the claim → abort (skip the void)
        return { ...cur, resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, side_effect_started_at: now };
      });
      const v = mtx.snapshot.val();
      return mtx.committed && !!v && v.resolving_phase === MR.PHASE.SIDE_EFFECT_STARTED;
    };
    const vr = await voidOrRefund({ ...deps, markSideEffectStarted }, { orderId, attemptId, pixelpayOrderId: `${orderId}-${attemptId}`, paymentUuid: uuid, reason, now });
    voided = !!vr.voided;
  } else if (!C.isAlreadyReversed(claimed, attempt) && MR.hasPaidEvidence(claimed, attempt)) {
    // [B.3/F7] AMBIGUOUS: a UUID exists but NO captured-money evidence (a declined auth carries a UUID; or an
    // unconfirmed capture) AND the money isn't already reversed. Never auto-void (might not be a real charge),
    // never clean-cancel-and-strand (might be). Release the claim + manual_review + alert → dispatcher verifies.
    await releaseCancelClaim(orderRef, claimId);
    await audit('manual_review', { reason: 'ambiguous_paid_evidence' });
    await alert('cancel_manual_review', { orderId, reason: 'ambiguous_paid_evidence' });
    return { status: 409, body: { ok: false, outcome: 'manual_review', order_id: orderId } };
  }

  // B.8 finalize (order-node tx, clears claim) + B.11 honest outcome. Three cases for payment_status:
  //  - wantVoid → refunded / refund_pending (from the void result);
  //  - [Fix A] already-reversed (money handled, no void) → SYNC to the truthful reversed status — never leave a
  //    cancelled order reading `confirmed`;
  //  - else (cash / no charge) → unchanged.
  let fin;
  if (wantVoid) fin = C.finalizeOutcome({ hadEvidence: true, voided });
  else if (C.isAlreadyReversed(claimed, attempt)) {
    const ps = C.reversedPaymentStatus(claimed, attempt);
    fin = { code: ps === 'refund_pending' ? 409 : 200, outcome: ps === 'refund_pending' ? 'refund_pending' : 'cancelled', payment_status: ps };
  } else fin = C.finalizeOutcome({ hadEvidence: false, voided: false });
  const done = await finalize(orderRef, { claimId, now, actor, reason, paymentStatus: fin.payment_status });
  if (!done) return { status: 409, body: { ok: false, outcome: 'claim_lost', order_id: orderId } };

  // B.9 non-money cleanup — separate idempotent best-effort (onOrderCancelled is the durable backstop).
  try { await cleanupTasksAndDriver(deps, orderId, order, now); } catch (e) { console.warn(`cancelOrder cleanup failed for ${orderId}`, e && e.message); }

  // Rewards Phase A — clawback the loyalty earn when a cancel commits. reverseEarnForOrder is idempotent
  // (its own reverse_${orderId} ledger key), self-guarded (no-op unless the order actually earned), and fail-open,
  // so reconciliation retries / refund_pending re-entry / recoverStaleCancel can't double-reverse. Normally a
  // no-op (the gate blocks delivered/completed, the only states that earn); this covers the earn↔cancel async
  // race. EARN only — redemption reversal is Phase B. Never blocks the cancel.
  try { await reverseEarnForOrder(db, { orderId, order, now }); } catch (e) { console.warn(`cancelOrder reverse-earn failed for ${orderId}`, e && e.message); }

  const refund = wantVoid ? (voided ? 'refunded' : 'refund_pending') : (fin.payment_status || 'no_payment');
  await audit(fin.outcome, { refund });
  return { status: fin.code, body: { ok: fin.code === 200, outcome: fin.outcome, refund, order_id: orderId } };
}

// [B.10] Phase-aware recovery for a stale resolving_action='cancel' claim (reconcilePayments full-order scan
// home). Pre-side-effect → clear the claim (safe); post-side-effect → manual_review + alert, never blind re-void.
// null-first-safe CAS on cancel_claim_id.
async function recoverStaleCancel(deps, orderId, order, now, staleMs) {
  const { db, alert } = deps;
  const rec = C.cancelRecoveryDecision(order, now, staleMs);
  if (!rec.act) return null;
  const claimId = order.cancel_claim_id;
  const cas = await db.ref(`orders/${orderId}`).transaction((cur) => {
    if (cur === null) return null;                                     // null-first-safe
    if (!cur || cur.cancel_claim_id !== claimId || cur.resolving_action !== 'cancel') return;
    const cleared = { ...cur, cancel_claim_id: null, resolving_action: null, resolving_phase: null, resolving_claimed_at: null, side_effect_started_at: null };
    if (rec.to === 'manual_review') cleared.payment_status = 'manual_review';
    return cleared;
  });
  if (cas.committed && rec.alert) await alert('cancel_stale_recovered', { orderId, to: rec.to || 'cleared', claim_id: claimId });
  return cas.committed ? { recovered: true, to: rec.to || 'cleared' } : null;
}

module.exports = { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, isReconcilerRetryable: C.isReconcilerRetryable };
