/**
 * X Pizza — online-payment CONFIRM state machine (Stage 4, sub-stage 2).
 *
 * Turns a `pending_payment` online order into a live `new` order by CAPTURING the
 * browser's 3DS auth hold server-side and verifying the capture response. This is the
 * authoritative confirmer (PAYMENT-PLAN §B/§C, invariants I1-I8). `getStatus` is
 * liveness-only; `doCapture`'s response is the source of truth (amount + binding hash).
 *
 * Money-safety guarantees:
 *   - ONE capture per attempt: a `capturing` claim (CAS on the attempt, with
 *     `capturing_started_at` + `payment_uuid`) gates the money-moving call; a second
 *     caller within the stale window backs off.
 *   - Lost-capture-response (capture landed at PixelPay but our response was lost) →
 *     `manual_reconciliation` (NEVER auto-materialize) — re-capture returns 412 and
 *     getStatus is too thin to reverify (sandbox-proven).
 *   - Mismatched capture (wrong order's uuid / amount / approval) → VOID + fail (I8).
 *   - Crash-after-confirm-before-materialize → re-materialize idempotently.
 *
 * Pure of Firebase specifics: `db` (RTDB-shaped) and `client` (pixelpay-client) are
 * injected so the whole machine is unit-tested against an in-memory mock.
 */

const TERMINAL_ATTEMPT = ['declined', 'voided', 'abandoned', 'converted', 'refunded'];

async function confirmOnlinePayment(deps, { orderId, paymentUuid, now, trackingToken }) {
  const { db, staleMs = 90000 } = deps;
  const orderRef = db.ref(`orders/${orderId}`);

  const order = (await orderRef.once('value')).val();
  if (!order) return { outcome: 'no_order' };
  if (order.payment_method !== 'online') return { outcome: 'not_online' };
  if (order.status === 'cancelled') return { outcome: 'cancelled' };
  if (order.payment_status === 'manual_reconciliation') return { outcome: 'manual_reconciliation' };
  if (order.payment_status === 'failed') return { outcome: 'failed' };

  // Already confirmed → ensure materialized (recover crash-after-confirm), then done.
  if (order.payment_status === 'confirmed') {
    return confirmAndMaterialize(deps, { orderId, attemptId: order.active_attempt_id, now, trackingToken });
  }

  const attemptId = order.active_attempt_id;
  if (!attemptId) return { outcome: 'no_active_attempt' };
  const attemptRef = db.ref(`payment_attempts/${attemptId}`);
  const pixelpayOrderId = `${orderId}-${attemptId}`;
  const amountLempiras = Number((Number(order.total_cents) / 100).toFixed(2));

  // ---- 1. Capturing claim (CAS on the attempt) ----
  const claim = await attemptRef.transaction((cur) => {
    if (!cur) return; // no attempt record → abort
    if (cur.status === 'active') {
      cur.status = 'capturing';
      cur.capturing_started_at = now;
      cur.payment_uuid = cur.payment_uuid || paymentUuid || null;
      return cur;
    }
    if (cur.status === 'capturing') {
      const started = typeof cur.capturing_started_at === 'number' ? cur.capturing_started_at : 0;
      if (now - started < staleMs) return; // another worker is actively capturing → abort
      cur.capturing_started_at = now;       // stale → take over
      cur.payment_uuid = cur.payment_uuid || paymentUuid || null;
      return cur;
    }
    return cur; // captured / capture_unverified / terminal → no change; handled below
  });

  const attempt = (await attemptRef.once('value')).val();
  if (!attempt) return { outcome: 'no_attempt_record' };

  // Non-capturing terminal/recovery states (claim made no change).
  if (attempt.status === 'captured') {
    return confirmAndMaterialize(deps, { orderId, attemptId, now, trackingToken });
  }
  if (attempt.status === 'capture_unverified') return { outcome: 'manual_reconciliation' };
  if (TERMINAL_ATTEMPT.includes(attempt.status)) return { outcome: 'failed', attemptStatus: attempt.status };
  if (attempt.status !== 'capturing') return { outcome: 'unexpected_state', attemptStatus: attempt.status };
  if (!claim.committed) return { outcome: 'in_progress' }; // capturing held by another (not stale)

  const uuid = attempt.payment_uuid || paymentUuid;
  if (!uuid) return { outcome: 'no_payment_uuid' }; // can't capture/look up; sweep handles

  // ---- 2. getStatus pre-check (recovery-aware) ----
  const status = deps.client.interpretStatus(await deps.client.getStatus({ payment_uuid: uuid }));
  if (status.paid) {
    // A capture already settled. Recover ONLY if a verified result is persisted.
    if (attempt.capture_verified && attempt.amount_cents != null) {
      return confirmAndMaterialize(deps, { orderId, attemptId, now, trackingToken });
    }
    await routeManualReconciliation(deps, { orderId, attemptId, uuid, now });
    return { outcome: 'manual_reconciliation' };
  }
  if (status.reversed || status.declined) {
    await attemptRef.update({ status: 'declined', failed_at: now, decline_reason: status.status });
    await orderRef.update({ payment_status: 'failed' });
    return { outcome: 'failed', reason: status.status };
  }

  // ---- 3. CAPTURE (server sets the amount) ----
  let cap;
  try {
    cap = await deps.client.capture({ payment_uuid: uuid, amountLempiras });
  } catch (e) {
    // Network/timeout: the capture MAY have landed. Leave the capturing claim; the
    // sweep recovers after the stale window (→ capture/manual_reconciliation). Never retry blindly.
    return { outcome: 'capture_error_retryable', error: e && e.message };
  }

  if (cap.httpStatus === 412) {
    // Settled already but we hold no verified result → cannot reverify → manual reconcile.
    await routeManualReconciliation(deps, { orderId, attemptId, uuid, now });
    return { outcome: 'manual_reconciliation' };
  }
  if (!cap.ok) {
    // Declined / amount>auth / etc. — no money moved. Open for COD fallback.
    await attemptRef.update({ status: 'declined', failed_at: now, decline_message: cap.message || null });
    await orderRef.update({ payment_status: 'failed' });
    return { outcome: 'capture_failed', message: cap.message };
  }

  // ---- 4. Verify the capture response (authoritative, server-obtained binding) ----
  const v = deps.client.verifyCaptureResult(cap.data, { pixelpayOrderId, expectedAmountLempiras: amountLempiras });
  if (!v.ok) {
    // Captured a mismatched payment (wrong order's uuid, or amount/approval off) → VOID (I8).
    let voided = false;
    try {
      const vd = await deps.client.voidTransaction({ payment_uuid: uuid, pixelpayOrderId, voidReason: 'xpizza_mismatch_void' });
      voided = !!vd.ok;
    } catch (_) { /* void failed → refund_pending below */ }
    await attemptRef.update({ status: voided ? 'voided' : 'refund_pending', mismatch_reason: v.reason, failed_at: now });
    await orderRef.update({ payment_status: voided ? 'failed' : 'refund_pending' });
    deps.alert && deps.alert('capture_mismatch', { orderId, attemptId, uuid, reason: v.reason, voided });
    return { outcome: 'mismatch_voided', voided, reason: v.reason };
  }

  // ---- 5. Persist the verified capture result FIRST (recovery reads this) ----
  await attemptRef.update({
    status: 'captured',
    capture_verified: true,
    payment_uuid: uuid,
    payment_reference: (cap.data && cap.data.transaction_reference) || null,
    amount_cents: order.total_cents,
    captured_at: now
  });

  // ---- 6. Confirm + materialize ----
  return confirmAndMaterialize(deps, {
    orderId, attemptId, now, trackingToken,
    paymentReference: (cap.data && cap.data.transaction_reference) || null
  });
}

// Claim payment_status pending→confirmed (CAS on the order) then materialize atomically.
// Idempotent: safe to re-enter for an already-confirmed-but-unmaterialized order.
async function confirmAndMaterialize(deps, { orderId, attemptId, now, trackingToken, paymentReference = null }) {
  const { db, restaurant, buildMaterializeUpdates } = deps;
  const orderRef = db.ref(`orders/${orderId}`);

  const claim = await orderRef.transaction((cur) => {
    if (!cur) return;
    if (cur.status === 'cancelled') return cur;
    if (attemptId && cur.active_attempt_id !== attemptId) return cur; // attempt no longer active
    if (cur.payment_status === 'confirmed') return cur;               // already (idempotent)
    if (cur.payment_status !== 'pending') return cur;
    cur.payment_status = 'confirmed';
    cur.charged_at = now;
    if (paymentReference != null) cur.payment_reference = paymentReference;
    return cur;
  });

  const order = claim.snapshot.val();
  if (!order || order.status === 'cancelled') return { outcome: 'cancelled_during_confirm' };
  if (attemptId && order.active_attempt_id !== attemptId) return { outcome: 'attempt_superseded' };
  if (order.payment_status !== 'confirmed') return { outcome: 'confirm_claim_failed' };
  if (order.materialized_at) return { outcome: 'already_confirmed', tracking_token: order.tracking_token };

  const token = order.tracking_token || trackingToken;
  const updates = buildMaterializeUpdates({
    orderId,
    order,
    trackingToken: token,
    now,
    restaurant,
    paymentReference: paymentReference || order.payment_reference || null,
    paymentMethod: 'online'
  });
  await db.ref().update(updates);
  return { outcome: 'confirmed', tracking_token: token };
}

// Route a paid-but-unverifiable capture to the audited manual-reconciliation queue.
async function routeManualReconciliation(deps, { orderId, attemptId, uuid, now }) {
  await deps.db.ref(`payment_attempts/${attemptId}`).update({
    status: 'capture_unverified',
    payment_uuid: uuid,
    manual_reason: 'paid_lost_capture_response',
    flagged_at: now
  });
  await deps.db.ref(`orders/${orderId}`).update({ payment_status: 'manual_reconciliation' });
  deps.alert && deps.alert('manual_reconciliation', { orderId, attemptId, uuid });
}

module.exports = { confirmOnlinePayment, confirmAndMaterialize, routeManualReconciliation };
