'use strict';

/**
 * Manual-reconciliation resolve — the money state machine (RECON_ATOMIC_CLAIM_PLAN.md rev-5, Codex-APPROVED).
 * Extracted from index.js with `deps` INJECTED (db, PixelPay client, materialize builder, restaurant fallback,
 * token gen, alert, sanitizeText, serverTimestamp) so it's driven directly by the emulator F-matrix
 * (test/resolve-manual.emulator.test.js) — two concurrent invocations produce REAL RTDB transaction contention,
 * which a pure golden cannot. index.js's onRequest wrapper does auth + input validation, then calls the core.
 *
 * deps = {
 *   db,                    // admin database()
 *   client,               // pixelpay-client (voidTransaction)
 *   buildMaterializeUpdates,
 *   restaurant,           // x_pizza hub fallback for buildMaterializeUpdates
 *   genToken,             // () => tracking token
 *   alert,                // (kind, detail) => paymentAlert
 *   sanitizeText,
 *   serverTimestamp,      // ServerValue.TIMESTAMP (or a number in tests)
 * }
 */
const MR = require('./manual-resolve');
const { holdIfClosedAtMaterialize } = require('./materialize-guard');   // paid-after-close re-check (Codex-on-diff)

// [#7/#8] Materialize a manual-verified order WITHOUT reopening the race: CAS resolving_materialize → confirmed
// on the claim_id (NO transient 'pending', NO materialized_at yet), then materialize atomically. A crash after
// the confirm-flip but before materialize → confirmed + no materialized_at → materializeOnConfirm recovers.
async function confirmAndMaterializeFromManualClaim(deps, { orderId, attemptId, claimId, now, trackingToken }) {
  const { db, buildMaterializeUpdates, restaurant } = deps;
  const orderRef = db.ref(`orders/${orderId}`);
  if (attemptId) await db.ref(`payment_attempts/${attemptId}`).update({ status: 'captured', capture_verified: true, manual_verified: true });
  const tx = await orderRef.transaction((cur) => {
    if (cur === null) return null;                                      // null-first-safe (R1-#1): force server round-trip, don't abort
    if (!cur || cur.resolving_claim_id !== claimId || cur.payment_status !== MR.resolvingStatus('materialize')) return; // claim lost
    if (cur.materialized_at) return;                                    // already materialized (idempotent)
    return { ...cur, payment_status: 'confirmed', charged_at: now, payment_reference: attemptId || null,
             resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null };
  });
  if (!tx.committed) {
    const v = tx.snapshot.val() || {};
    if (v.materialized_at || v.payment_status === 'confirmed') return { outcome: 'already_confirmed' };
    return { outcome: 'confirm_claim_failed', payment_status: v.payment_status };
  }
  const order = tx.snapshot.val();
  // Scheduled Orders (Codex-on-diff #2): manual reconciliation is the THIRD pending→new materialize path —
  // it must be scheduled-safe too. A manually-verified order carrying a scheduled_for is HELD, not
  // materialized: the confirm above persisted the verified payment; here we flip status→scheduled and STOP.
  // It goes live only at release, through the single claim (which re-validates hours). Never buildMaterialize.
  if (Number.isFinite(Number(order.scheduled_for))) {
    if (order.status !== 'scheduled') await orderRef.update({ status: 'scheduled', scheduled_confirmed_at: now });
    return { outcome: 'scheduled_held', scheduled_for: order.scheduled_for };
  }
  // Codex-on-diff (paid-after-close): re-check hours for an UNSCHEDULED order — if the kitchen closed since
  // the money was captured, HOLD it (manual_review + block + alert) instead of materializing onto a dark
  // kitchen. Shared with confirmAndMaterialize (the confirm/webhook chokepoint). Open → materialize as today.
  if (await holdIfClosedAtMaterialize(deps, orderId, order, now)) {
    return { outcome: 'held_closed_at_materialize' };
  }
  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentReference: attemptId, paymentMethod: 'online' });
  await db.ref().update(updates);
  return { outcome: 'materialized' };
}

// The resolver core. Returns { status, body } (HTTP status + JSON) so the onRequest wrapper is a thin adapter.
async function resolveManualReconciliationCore(deps, { orderId, action, actor, note, now, claimId }) {
  const { db, client, alert, sanitizeText, serverTimestamp } = deps;
  const orderRef = db.ref(`orders/${orderId}`);
  const audit = async (outcome, extra = {}) => {
    await db.ref('payment_audit').push({ order_id: orderId, action, actor, claim_id: claimId, outcome, at: serverTimestamp, ...extra });
  };

  // 'keep' does NOT mutate payment_status → no claim needed.
  if (action === 'keep') { await audit('kept_queued'); return { status: 200, body: { ok: true, outcome: 'kept_queued' } }; }

  // ── Atomic claim: whole-order-node tx (null-first-safe; only from manual_reconciliation) ──
  const claimTx = await orderRef.transaction((cur) => MR.claimDecision(cur, action, claimId, now));
  if (!claimTx.committed || !MR.claimLanded(claimTx.snapshot.val(), action, claimId)) {
    const cur = claimTx.snapshot.val();                                // #4: a null no-op commits but claims nothing
    if (!cur) return { status: 404, body: { error: 'Order not found' } };
    return { status: 409, body: { error: 'Pedido no resolvable (ya en proceso o resuelto)', payment_status: cur.payment_status } };
  }
  const order = claimTx.snapshot.val();
  const attemptId = order.active_attempt_id;
  const attempt = attemptId ? (await db.ref(`payment_attempts/${attemptId}`).once('value')).val() : null;

  // CAS release — revert to manual_reconciliation ONLY if still OUR claim (never clobber a terminal). Pre-side-effect only.
  const releaseClaim = () => orderRef.transaction((cur) => {
    if (cur === null) return null;                                      // null-first-safe (R1-#1): force server round-trip, don't abort
    if (!cur || cur.resolving_claim_id !== claimId || cur.payment_status !== MR.resolvingStatus(action)) return;
    return { ...cur, payment_status: 'manual_reconciliation', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null };
  });

  try {
    if (action === 'abandon') {
      if (MR.hasPaidEvidence(order, attempt)) {
        await releaseClaim();
        return { status: 409, body: { error: 'Se detectó un pago — usá "Reembolsar", no "Descartar".', payment_uuid_present: true } };
      }
      // Terminal write is a CAS (R3-#1): commit abandoned ONLY if still our claim AND paid_during_resolve !== true.
      const abTx = await orderRef.transaction((cur) => {
        if (cur === null) return null;                                  // null-first-safe (R1-#1): force server round-trip, don't abort
        if (!cur || cur.resolving_claim_id !== claimId || cur.payment_status !== MR.resolvingStatus('abandon') || cur.paid_during_resolve === true) return;
        return { ...cur, payment_status: 'abandoned', status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null };
      });
      if (!abTx.committed) {
        const cur = abTx.snapshot.val() || {};
        if (cur.paid_during_resolve === true) return { status: 409, body: { error: 'Se detectó un pago — usá "Reembolsar".', payment_uuid_present: true } };
        return { status: 409, body: { error: 'No se pudo descartar (el estado cambió)', payment_status: cur.payment_status } };
      }
      if (attemptId) await db.ref(`payment_attempts/${attemptId}`).update({ hosted_state: 'abandoned', status: 'abandoned', abandoned_at: now });
      await audit('abandoned', { note: sanitizeText(note || '', 200) });
      return { status: 200, body: { ok: true, outcome: 'abandoned' } };
    }

    if (action === 'materialize') {
      const r = await confirmAndMaterializeFromManualClaim(deps, { orderId, attemptId, claimId, now, trackingToken: deps.genToken() });
      if (MR.FINAL_SUCCESS_OUTCOMES.has(r.outcome)) {
        await audit(r.outcome, { confirm_outcome: r.outcome });
        return { status: 200, body: { ok: true, outcome: r.outcome } };
      }
      await releaseClaim();                                             // #8: no external money moved → CAS back, 409
      await audit('materialize_failed', { confirm_outcome: r.outcome });
      return { status: 409, body: { ok: false, outcome: r.outcome } };
    }

    // ── action === 'refund' ──
    // Stamp side_effect_started BEFORE the void — after this we NEVER revert (a 2nd resolver could re-void).
    await orderRef.update({ resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, side_effect_started_at: now });
    const uuid = attemptId ? (await db.ref(`payment_attempts/${attemptId}/payment_uuid`).once('value')).val() : null;
    if (!uuid) {
      // No real charge to void → NEVER report refunded (R3-#3). Converge to manual_review (post-side-effect: no revert).
      await orderRef.update({ payment_status: 'manual_review', status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null });
      await audit('manual_review', { reason: 'no_charge' });
      return { status: 409, body: { ok: false, outcome: 'manual_review', detail: 'No se encontró el cargo — revisar en PixelPay' } };
    }
    let voided = false;
    try { const vd = await client.voidTransaction({ payment_uuid: uuid, pixelpayOrderId: `${orderId}-${attemptId}`, voidReason: 'xpizza_manual_refund' }); voided = !!vd.ok; }
    catch (e) { console.warn(`resolveManualReconciliation: void failed for ${orderId} → refund_pending`, e && e.message); }
    const finalStatus = voided ? 'refunded' : 'refund_pending';         // any non-anulada void → refund_pending, never fake refunded
    if (attemptId) await db.ref(`payment_attempts/${attemptId}`).update({ status: finalStatus, refunded_at: now });
    await orderRef.update({ payment_status: finalStatus, status: 'cancelled', resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null });
    await audit(finalStatus, { voided });
    return { status: MR.httpForOutcome(finalStatus), body: { ok: voided, outcome: finalStatus } };
  } catch (e) {
    console.error(`resolveManualReconciliation: ${orderId} ${action} failed`, e.message);
    // Pre-side-effect failure → release (retryable). Post-side-effect → NEVER roll back; alert (R2-#2/#5).
    const cur = (await orderRef.once('value')).val();
    if (cur && cur.resolving_claim_id === claimId && cur.resolving_phase === MR.PHASE.CLAIMED) await releaseClaim();
    else if (cur && cur.resolving_phase === MR.PHASE.SIDE_EFFECT_STARTED) await alert('resolve_crashed_post_side_effect', { orderId, action, claim_id: claimId });
    return { status: 500, body: { error: 'resolve failed', detail: e.message } };
  }
}

// [D/R2-#2] Single-order phase-aware recovery (the sweep's core). Pre-side-effect stale → revert to
// manual_reconciliation; post-side-effect stale → manual_review + alert, NEVER re-resolvable. CAS on claim_id.
async function recoverStaleResolve(deps, orderId, order, now, staleMs) {
  const { db, alert } = deps;
  const rec = MR.recoveryDecision(order, now, staleMs);
  if (!rec.act) return null;
  const claimId = order.resolving_claim_id;
  const cas = await db.ref(`orders/${orderId}`).transaction((cur) => {
    if (cur === null) return null;                                      // null-first-safe (R1-#1): force server round-trip, don't abort
    if (!cur || cur.resolving_claim_id !== claimId || !MR.isResolving(cur.payment_status)) return; // only OUR still-stale claim
    return { ...cur, payment_status: rec.to, resolving_action: null, resolving_claim_id: null, resolving_claimed_at: null, resolving_phase: null,
             ...(rec.to === 'manual_review' ? { status: 'cancelled' } : {}) };
  });
  if (cas.committed && rec.alert) await alert('resolve_stale_recovered', { orderId, to: rec.to, claim_id: claimId });
  return cas.committed ? { recovered: true, to: rec.to } : null;
}

module.exports = { resolveManualReconciliationCore, confirmAndMaterializeFromManualClaim, recoverStaleResolve };
