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
const { reverseRedemptionForOrder } = require('./rewards-reserve');   // Phase B1 — redemption hold reversal on cancel (single helper, idempotent)

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

  // Rewards clawback + redemption reversal when a cancel commits. Both idempotent (reverse_${orderId} /
  // order_id-keyed) and self-guarded (no-op unless the order earned/redeemed), so refund_pending re-entry /
  // recoverStaleCancel / reconciler retries can't double-reverse. Normally a no-op; covers the earn↔cancel race.
  //
  // [A — ledger atomicity] The order is ALREADY cancelled + its factura voided by this point. We must NOT block
  // or undo the cancel (the customer's refund is committed) — but we also must NOT silently swallow a ledger fix
  // that failed (that's the money-loss: refunded order keeps consumed punches / earned rewards). So on a REAL
  // failure (not a legit no-op) we journal a durable `reward_ledger_repair/${orderId}` record + alert; the
  // sweepStalePending retry (retryRewardLedgerRepair) re-runs both — idempotent, so it heals without double-reversing.
  let earnRes = { ok: false }, redRes = { ok: false };
  try { earnRes = await reverseEarnForOrder(db, { orderId, order, now }); } catch (e) { earnRes = { ok: false }; console.warn(`cancelOrder reverse-earn failed for ${orderId}`, e && e.message); }
  try { redRes = await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now }); } catch (e) { redRes = { ok: false }; console.warn(`cancelOrder reverse-redemption failed for ${orderId}`, e && e.message); }
  const earnFailed = !earnRes || earnRes.ok === false;
  const redFailed = !!redRes && redRes.ok === false && redRes.skipped !== true;   // skipped = non-redeemed order (legit no-op), NOT a failure
  if (earnFailed || redFailed) {
    await db.ref(`reward_ledger_repair/${orderId}`).update({ order_id: orderId, disposition: 'refund',
      earn_failed: earnFailed, redemption_failed: redFailed, reason: reason || 'cancel', first_failed_at: now, updated_at: now, attempts: 0 })
      .catch((e) => console.error(`cancelOrder repair-journal write failed for ${orderId}`, e && e.message));
    await alert('reward_reversal_failed', { orderId, earn_failed: earnFailed, redemption_failed: redFailed });
  }

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

// [A — ledger atomicity] Retry the durable ledger-repair records cancelOrderCore journaled when a reversal
// failed. Idempotent: reverseEarnForOrder / reverseRedemptionForOrder are order_id-keyed, so re-running both is
// safe even if one already succeeded — no double-reverse. Clears the record once the ledger is consistent
// (earn clawed back AND redemption reversed); otherwise bumps attempts + escalates an alert on a persistent
// divergence. Runs on the 5-min sweepStalePending so a refunded-but-diverged ledger heals promptly.
async function retryRewardLedgerRepair(deps, { now }) {
  const { db, alert } = deps;
  const repairs = (await db.ref('reward_ledger_repair').once('value')).val() || {};
  let healed = 0, pending = 0;
  for (const orderId of Object.keys(repairs)) {
    const rec = repairs[orderId] || {};
    const order = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!order) { await db.ref(`reward_ledger_repair/${orderId}`).remove(); continue; }   // order purged → nothing to heal
    let earn = { ok: false }, red = { ok: false };
    try { earn = await reverseEarnForOrder(db, { orderId, order, now }); } catch (_) { earn = { ok: false }; }
    try { red = await reverseRedemptionForOrder(db, { orderId, order, disposition: rec.disposition || 'refund', now }); } catch (_) { red = { ok: false }; }
    const earnOk = !!earn && earn.ok !== false;
    const redOk = !!red && (red.ok !== false || red.skipped === true);
    if (earnOk && redOk) { await db.ref(`reward_ledger_repair/${orderId}`).remove(); healed++; continue; }
    pending++;
    const attempts = (Number(rec.attempts) || 0) + 1;
    await db.ref(`reward_ledger_repair/${orderId}`).update({ attempts, updated_at: now, earn_failed: !earnOk, redemption_failed: !redOk });
    if (attempts === 3 || attempts % 12 === 0) await alert('reward_reversal_stuck', { orderId, attempts });   // persistent divergence → escalate to a human
  }
  return { healed, pending };
}

module.exports = { cancelOrderCore, cleanupTasksAndDriver, recoverStaleCancel, retryRewardLedgerRepair, isReconcilerRetryable: C.isReconcilerRetryable };
