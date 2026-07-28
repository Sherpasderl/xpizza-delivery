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

const TERMINAL_ATTEMPT = ['declined', 'voided', 'abandoned', 'converted', 'refunded', 'voided_inactive'];
const SCHED = require('./scheduled-orders');   // Scheduled Orders — confirm-time slot re-validation (§F)
const { holdIfClosedAtMaterialize } = require('./materialize-guard');   // paid-after-close re-check (Codex-on-diff)
const { settleRedemptionAtConfirm } = require('./rewards-reserve');     // Phase B1 — consume/hold the redemption at materialize (no-op for a non-redeemed order)

async function confirmOnlinePayment(deps, { orderId, paymentUuid, now, trackingToken }) {
  const { db, staleMs = 90000 } = deps;
  const orderRef = db.ref(`orders/${orderId}`);

  const order = (await orderRef.once('value')).val();
  if (!order) return { outcome: 'no_order' };
  if (order.payment_method !== 'online') return { outcome: 'not_online' };
  if (order.status === 'cancelled') return { outcome: 'cancelled' };
  if (order.payment_status === 'manual_reconciliation') return { outcome: 'manual_reconciliation' };
  if (require('./manual-resolve').isResolving(order.payment_status)) return { outcome: 'resolving_in_progress' }; // dispatcher mid-resolve — don't auto-transition
  if (order.payment_status === 'failed') return { outcome: 'failed' };

  // Already confirmed → ensure materialized (recover crash-after-confirm), then done.
  if (order.payment_status === 'confirmed') {
    return confirmAndMaterialize(deps, { orderId, attemptId: order.active_attempt_id, now, trackingToken });
  }

  const attemptId = order.active_attempt_id;
  if (!attemptId) return { outcome: 'no_active_attempt' };
  const attemptRef = db.ref(`payment_attempts/${attemptId}`);
  const pixelpayOrderId = `${orderId}-${attemptId}`;
  // Amount we CAPTURE through PixelPay. deps.chargeAmountLempiras lets the prod path map
  // sandbox orders to a 1-14 test amount (the sandbox rejects real totals); default = real total.
  const amountLempiras = deps.chargeAmountLempiras
    ? deps.chargeAmountLempiras(order.total_cents)
    : Number((Number(order.total_cents) / 100).toFixed(2));

  // ---- 1. Capturing claim (CAS on the attempt) ----
  // Pre-read so the transaction never spuriously aborts on the Admin SDK's first
  // (uncached → null) invocation: fall back to the pre-read value, and the SDK
  // re-runs against the real value on any genuine write conflict. Returning a value
  // (not undefined) on the null call is what triggers that conflict re-check.
  const preAttempt = (await attemptRef.once('value')).val();
  if (!preAttempt) return { outcome: 'no_attempt_record' };

  // 3c (plan 10b): pre-capture active-recheck. An auth opened before an active=false flip must not
  // be captured into a deactivated Restaurant. Runs BEFORE the capturing CAS so no claim is planted
  // on the void path. Only `active` is rechecked (hub stays the immutable snapshot). X. Pizza is
  // always active -> no-op. Optional-by-presence so legacy callers/tests without getIdentity skip.
  if (deps.getIdentity) {
    const rid = order.restaurant_id || 'x_pizza';
    let activeNow;
    try {
      activeNow = (await deps.getIdentity(db, rid)).active;
    } catch (e) {
      return { outcome: 'config_unavailable_retryable', error: e && e.message }; // never capture when activeness unprovable
    }
    if (activeNow === false) {
      const uuid0 = paymentUuid || preAttempt.payment_uuid;
      try {
        if (uuid0) await deps.client.voidTransaction({ payment_uuid: uuid0, pixelpayOrderId, voidReason: 'xpizza_inactive_void' });
      } catch (_) { /* best-effort auth void; terminalize + alert regardless */ }
      await attemptRef.update({ status: 'voided_inactive', voided_at: now, void_reason: 'restaurant_inactive' });
      await orderRef.update({ payment_status: 'failed' });
      deps.alert && deps.alert('confirm_voided_inactive', { orderId, attemptId, restaurant_id: rid });
      return { outcome: 'voided_inactive' };
    }
  }

  const claim = await attemptRef.transaction((cur) => {
    const a = cur || preAttempt;
    if (a.status === 'active') {
      return { ...a, status: 'capturing', capturing_started_at: now, payment_uuid: a.payment_uuid || paymentUuid || null };
    }
    if (a.status === 'capturing') {
      const started = typeof a.capturing_started_at === 'number' ? a.capturing_started_at : 0;
      if (now - started < staleMs) return;  // another worker is actively capturing → abort
      return { ...a, capturing_started_at: now, payment_uuid: a.payment_uuid || paymentUuid || null }; // stale → take over
    }
    return a; // captured / capture_unverified / terminal → unchanged; handled below
  });

  const attempt = claim.snapshot.val() || preAttempt;

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
    // 412 "Error al encontrar el cobro" is AMBIGUOUS: it means either (a) the charge
    // settled already and we lost the capture response, OR (b) the payment_uuid was
    // never a capturable auth (a DECLINED auth still returns a uuid; capturing it 412s).
    // Disambiguate via getStatus: manual_reconciliation ONLY if PixelPay shows it paid;
    // otherwise it's a plain failure (no money moved).
    const recheck = deps.client.interpretStatus(await deps.client.getStatus({ payment_uuid: uuid }));
    if (recheck.paid) {
      await routeManualReconciliation(deps, { orderId, attemptId, uuid, now });
      return { outcome: 'manual_reconciliation' };
    }
    await attemptRef.update({ status: 'declined', failed_at: now, decline_message: cap.message || 'capture_not_found' });
    await orderRef.update({ payment_status: 'failed' });
    return { outcome: 'capture_failed', message: cap.message || 'capture not found' };
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

  // ---- 5b. CANCEL-vs-CONFIRM race (I8): if a cancel landed on this attempt/order while
  // we were capturing, VOID the capture instead of materializing — money must never
  // materialize onto a cancelled order. (cancelPaidOrder sets attempt.cancelling +
  // order.status='cancelled'; this is the converge point.) ----
  if (deps.voidOrRefund) {
    const freshAttempt = (await attemptRef.once('value')).val();
    const freshOrder = (await orderRef.once('value')).val();
    // [Fix#3] also honor an atomic ORDER-level cancel claim (set before the attempt's cancelling flag).
    if ((freshAttempt && freshAttempt.cancelling) || (freshOrder && freshOrder.status === 'cancelled') || (freshOrder && freshOrder.resolving_action === 'cancel' && freshOrder.cancel_claim_id)) {
      const vr = await deps.voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId, paymentUuid: uuid, reason: 'cancelled_during_capture', now });
      await orderRef.update({ status: 'cancelled', payment_status: vr.voided ? 'refunded' : 'refund_pending' });
      return { outcome: 'cancelled_voided', voided: vr.voided };
    }
  }

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

  // Pre-read to avoid the Admin SDK first-call-null transaction abort (see §1).
  const preOrder = (await orderRef.once('value')).val();
  if (!preOrder) return { outcome: 'no_order' };

  const claim = await orderRef.transaction((cur) => {
    const o = cur || preOrder;
    if (o.status === 'cancelled') return o;
    if (attemptId && o.active_attempt_id !== attemptId) return o; // attempt no longer active
    if (o.payment_status === 'confirmed') return o;               // already (idempotent)
    if (o.payment_status !== 'pending') return o;
    return { ...o, payment_status: 'confirmed', charged_at: now, ...(paymentReference != null ? { payment_reference: paymentReference } : {}) };
  });

  const order = claim.snapshot.val() || preOrder;
  if (!order || order.status === 'cancelled') return { outcome: 'cancelled_during_confirm' };
  if (attemptId && order.active_attempt_id !== attemptId) return { outcome: 'attempt_superseded' };
  if (order.payment_status !== 'confirmed') return { outcome: 'confirm_claim_failed' };
  if (order.materialized_at) {
    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'consume', now });   // idempotent backstop (crash-after-consume recovery)
    return { outcome: 'already_confirmed', tracking_token: order.tracking_token };
  }

  // ---- Scheduled Orders (§B.1): a confirmed order carrying a scheduled_for is HELD, not materialized —
  // it goes live ONLY at release (scheduled→releasing→new, scheduled-release-core). This is the sole
  // pending_payment→new chokepoint, so this one guard makes EVERY confirm entrypoint (confirmOnlinePayment,
  // sweepStalePending, the materializeOnConfirm recovery) scheduled-safe. The claim above already set
  // payment_status:confirmed + charged_at; here we just flip status→scheduled and stop (no tasks/tracking).
  if (Number.isFinite(Number(order.scheduled_for))) {
    // Re-validate the slot at CONFIRM (design §F: create+confirm+release; Codex-on-diff #3). Use
    // releaseTimeValid (slot still within open hours + not a missed window) — NOT the full create-time
    // validateScheduledFor, whose MIN_LEAD would false-block a legit earliest-slot order that simply took a
    // while to pay (payment latency must never invalidate a PAID order). A slot that CLOSED between checkout
    // and the paid callback ⇒ don't accept it as a clean hold: money is captured, so route to manual_review
    // + block for a dispatcher (refund via cancelPaidOrder or reschedule) — never auto-refund.
    let hours = null;
    if (deps.getIdentity) { try { hours = (await deps.getIdentity(db, order.restaurant_id || 'x_pizza')).hours; } catch (_) { hours = null; } }
    const sv = SCHED.releaseTimeValid(hours, order, now);
    if (!sv.valid) {
      await orderRef.update({ payment_status: 'manual_review', scheduled_blocked: true, blocked_reason: 'confirm_' + sv.reason });
      await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'hold', now });   // paid but slot closed → HOLD the points (dispatcher resolves)
      if (deps.alert) { try { await deps.alert('scheduled_confirm_invalid', { orderId, reason: sv.reason, scheduled_for: order.scheduled_for }); } catch (_) {} }
      return { outcome: 'scheduled_confirm_invalid', reason: sv.reason };
    }
    if (order.status !== 'scheduled') await orderRef.update({ status: 'scheduled', scheduled_confirmed_at: now });
    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'consume', now });   // paid + held-for-schedule → realize the debit (cancel-before-release refunds it)
    return { outcome: 'scheduled_held', scheduled_for: order.scheduled_for };
  }

  // Codex-on-diff (paid-after-close): an UNSCHEDULED online order authorized while OPEN can confirm AFTER
  // close. Re-check hours at materialize — closed now → HOLD (manual_review + block + alert), never land a
  // live ASAP order on a dark kitchen. This is the shared chokepoint for confirmOnlinePayment, the hosted
  // webhook, and the materializeOnConfirm recovery (all delegate here). Open → materialize as today.
  if (await holdIfClosedAtMaterialize(deps, orderId, order, now)) {
    await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'hold', now });   // paid but kitchen closed → HOLD the points (dispatcher resolves)
    return { outcome: 'held_closed_at_materialize' };
  }

  // 3c (plan 10b): post-capture active-recheck. Money is captured — NEVER strand a paid order;
  // always materialize. If the Restaurant was deactivated mid-flight, alert dispatcher (we owe
  // fulfillment). Idempotent: already-materialized returned above, and the marker is written in the
  // same atomic update, so re-entry can't re-alert. X. Pizza always active -> no alert.
  let inactiveRid = null;
  if (deps.getIdentity) {
    const rid = order.restaurant_id || 'x_pizza';
    try {
      if ((await deps.getIdentity(db, rid)).active === false) inactiveRid = rid;
    } catch (_) {
      inactiveRid = rid; // config unavailable post-capture: still materialize, flag for review
    }
  }

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
  if (inactiveRid) updates[`orders/${orderId}/inactive_materialize_alerted_at`] = now;
  await db.ref().update(updates);
  // AWAIT the alert (it's an async DB write): a fire-and-forget alert can be dropped if the
  // instance freezes after the update, and the committed marker would then suppress it on
  // re-entry — losing it permanently. On alert failure, LOG only: the order is already
  // materialized (never stranded); we don't undo a paid, fulfilled order over a failed alert.
  if (inactiveRid && deps.alert) {
    try {
      await deps.alert('materialized_into_inactive_restaurant', { orderId, restaurant_id: inactiveRid });
    } catch (e) {
      console.error(`confirmAndMaterialize: inactive-materialize alert failed for ${orderId} (order materialized, not stranded): ${e && e.message}`);
    }
  }
  await settleRedemptionAtConfirm(db, { orderId, order, disposition: 'consume', now });   // fresh materialize (paid + live) → realize the debit (online primary consume)
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
