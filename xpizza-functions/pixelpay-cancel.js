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
    // [Fix B / B-r2 / B-r3] Reversal machine — mutual exclusion + PHASE-AWARE recovery so the void is never
    // double-issued and never blind-re-issued after a crash. States: captured → reversing{claimed →
    // side_effect_started} → {refunded | refund_pending}. TERMINAL (refunded/voided) short-circuits; FRESH
    // reversing short-circuits (in-flight void — confirm-vs-cancel protection); a STALE reversing recovers BY PHASE:
    //   • @claimed (crashed BEFORE PixelPay) ......... reclaim → re-drive (safe; the void never happened).
    //   • @side_effect_started (crashed AFTER PixelPay) manual_review + alert — the void MAY have landed; NEVER a
    //                                                   blind second void. (Attempt-level twin of the order-level
    //                                                   SIDE_EFFECT_STARTED discipline; protects all three callers.)
    const attemptRef = db.ref(`payment_attempts/${attemptId}`);
    const REVERSING_STALE_MS = 2 * 60 * 1000;                        // > the 30s void timeout — a fresh reversing is truly in-flight
    const pre = (await attemptRef.once('value')).val();
    const preStale = !!pre && pre.status === 'reversing' && (now - (Number(pre.reversing_at) || 0)) >= REVERSING_STALE_MS;
    if (preStale && pre.reversing_phase === 'side_effect_started') {
      try { await attemptRef.update({ status: 'manual_review', refund_message: 'stale_reversing_post_side_effect' }); } catch (_) {}
      deps.alert && deps.alert('reversing_manual_review', { orderId, attemptId, reversing_at: pre.reversing_at });
      return { outcome: 'manual_review', voided: false, message: 'stale_reversing_post_side_effect' };
    }
    // Reversal CAS — claim into reversing@claimed. Short-circuit terminal / fresh / post-side-effect stale (routed
    // above); reclaim refund_pending / claimed-stale-reversing / captured.
    const rclaim = await attemptRef.transaction((cur) => {
      if (cur === null) return null;                                 // null-first-safe
      if (!cur) return;                                              // no attempt record → abort
      if (['refunded', 'voided'].includes(cur.status)) return;       // TERMINAL → short-circuit
      if (cur.status === 'reversing') {
        if ((now - (Number(cur.reversing_at) || 0)) < REVERSING_STALE_MS) return;     // FRESH → in-flight void → short-circuit
        if (cur.reversing_phase === 'side_effect_started') return;                     // STALE post-side-effect → manual_review (above)
      }
      return { ...cur, status: 'reversing', reversing_phase: 'claimed', reversing_at: now };
    });
    if (!rclaim.committed) {
      const cur = rclaim.snapshot.val() || {};
      const done = ['refunded', 'voided'].includes(cur.status);
      return { outcome: done ? 'refunded' : 'refund_pending', voided: done, message: `reversal_skipped_${cur.status || 'no_attempt'}` };
    }
    if (preStale) deps.alert && deps.alert('stale_reversing_reclaimed', { orderId, attemptId, reversing_at: pre.reversing_at });

    // [B-r3] Attempt-level durable phase marker — CAS reversing_phase claimed → side_effect_started IMMEDIATELY
    // before the PixelPay call (commit-or-abort). A crash after this → recovery sees side_effect_started → manual_review.
    const pmark = await attemptRef.transaction((cur) => {
      if (cur === null) return null;                                 // null-first-safe
      if (!cur || cur.status !== 'reversing' || cur.reversing_phase !== 'claimed') return; // lost the reversal claim
      return { ...cur, reversing_phase: 'side_effect_started' };
    });
    if (!pmark.committed) {
      try { await attemptRef.update({ status: 'refund_pending', refund_message: 'reversing_marker_uncommitted' }); } catch (_) {}
      deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message: 'reversing_marker_uncommitted' });
      return { outcome: 'refund_pending', voided: false, message: 'reversing_marker_uncommitted' };
    }

    // [F4/Fix#2] ORDER-level durable marker (the cancel path injects this hook) — commit-or-abort before the void.
    // Legacy callers (refundReconciler / confirm cancel-guard) inject no hook → unaffected.
    if (deps.markSideEffectStarted) {
      let marked = false;
      try { marked = await deps.markSideEffectStarted(); } catch (_) { marked = false; }
      if (!marked) {
        try { await attemptRef.update({ status: 'refund_pending', refund_message: 'marker_uncommitted_void_skipped' }); } catch (_) {}
        deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message: 'marker_uncommitted' });
        return { outcome: 'refund_pending', voided: false, message: 'marker_uncommitted_void_skipped' };
      }
    }
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
    refund_message: message,
    reversing_phase: null                                            // clear the phase marker on the terminal write
  });

  if (!voided) {
    deps.alert && deps.alert('refund_pending', { orderId, attemptId, payment_uuid: paymentUuid, message });
  }
  return { outcome: voided ? 'refunded' : 'refund_pending', voided, message };
}

module.exports = { voidOrRefund };
