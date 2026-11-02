/**
 * X Pizza — Hosted Payment callback handler (Stage H3).
 *
 * Verifies + acts on PixelPay's hosted `_callback`. The ONLY authoritative money signal
 * (HOSTED-PAYMENT-PLAN.md §Authority model, I12). Pinned against the real sandbox payload
 * (2026-06-16): Content-Type application/json; our id is in **`order`** (NOT `ref`); `amount`
 * is a JSON number; `payment_hash == MD5(order|key_id|secret)` (verified — == verifyPaymentHash);
 * `uuid` is the payment id to void.
 *
 * Pure of Firebase specifics: `deps` (db + confirmDeps extras) injected so it's unit-tested
 * against an in-memory mock. `deps` = confirmDeps(db) + { genToken }.
 */
const crypto = require('crypto');
const ppCrypto = require('./pixelpay');
const { resolvePixelPayConfig } = require('./pixelpay-config');
const { toCents } = require('./pixelpay-hosted');
const { confirmAndMaterialize } = require('./pixelpay-confirm');
const MR = require('./manual-resolve');   // atomic-claim predicate (rev-5): paid-evidence capture in manual-flow states
const { holdRedemptionForManual, reverseRedemptionForOrder } = require('./rewards-reserve');   // [B] HOLD at a manual entry (alerts on a lost race); [C/#18] reverse the hold when a late paid callback voids a cancelled order

const ATTEMPT_SUFFIX = /-[0-9a-f]{16}$/;             // hosted_order_id = `${orderId}-${attemptId}` (16-hex)
const HOSTED_ORDER_RE = /^[A-Za-z0-9_-]{1,96}$/;

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

// Returns { code, outcome }. code is the HTTP status the endpoint should return:
//   2xx after a DURABLE decision (paid+materialized, permanent-fail recorded, cancel-voided);
//   5xx only on a TRANSIENT error so PixelPay retries (R2-3 / I5).
async function handleHostedCallback(deps, body, now) {
  const { db } = deps;
  const cfg = resolvePixelPayConfig();
  const b = (body && typeof body === 'object') ? body : {};

  // Our id is in `order` (pinned). `ref` is a PixelPay-internal value — only a defensive fallback.
  const hostedOrderId = firstString(b.order, b.ref);
  const status = b.status;
  const uuid = firstString(b.uuid, b.payment_uuid);
  const paymentHash = b.payment_hash;
  const amount = b.amount;
  const txnRef = firstString(b.transaction_id);

  if (!hostedOrderId || !HOSTED_ORDER_RE.test(hostedOrderId)) return { code: 200, outcome: 'ignored_no_order' };

  // Non-paid callbacks (failed-status, etc.) are TELEMETRY ONLY — never act (I12).
  if (status !== 'paid') return { code: 200, outcome: `ignored_status_${status || 'none'}` };

  if (!ATTEMPT_SUFFIX.test(hostedOrderId)) return { code: 200, outcome: 'ignored_unparseable' };
  const orderId = hostedOrderId.replace(ATTEMPT_SUFFIX, '');
  const attemptId = hostedOrderId.slice(orderId.length + 1);

  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  const attempt = (await db.ref(`payment_attempts/${attemptId}`).once('value')).val();
  if (!order || !attempt) return { code: 200, outcome: 'ignored_unknown' };   // nothing to bind to

  // Verify ALL: binding (order == this attempt's hosted_order_id, rejects superseded — I3),
  // payment_hash == MD5(order|key|secret), amount (integer centavos) == order.total_cents.
  const bindingOk = attempt.hosted_order_id === hostedOrderId;
  const hashOk = typeof paymentHash === 'string' && ppCrypto.verifyPaymentHash(paymentHash, hostedOrderId, cfg.app_key, cfg.secret);
  const amountOk = toCents(amount) === Number(order.total_cents);

  if (!bindingOk || !hashOk || !amountOk) {
    // PERMANENT verification failure → manual_reconciliation + alert, then 2xx (won't change on retry, I8/R2-3).
    await db.ref(`payment_attempts/${attemptId}`).update({
      hosted_state: 'manual_reconciliation',
      manual_reason: `verify_fail binding=${bindingOk} hash=${hashOk} amount=${amountOk}`,
      payment_uuid: uuid, paid_amount_cents: toCents(amount), flagged_at: now
    });
    await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // [B] a 'paid' callback that failed verify → POSSIBLY paid → secure held_paid BEFORE advertising manual_reconciliation (alerts if a release-sweep race already freed it → possible mint)
    await db.ref(`orders/${orderId}`).update({ payment_status: 'manual_reconciliation' });
    deps.alert && deps.alert('hosted_verify_fail', { orderId, attemptId, bindingOk, hashOk, amountOk });
    return { code: 200, outcome: 'manual_reconciliation' };
  }

  // ONE payment per attempt, bound ATOMICALLY (absent → this payment id). A re-delivery of the bound payment passes on; any
  // OTHER payment id — including the loser of two concurrent first callbacks — is an extra payment with its own state
  // machine (handleExtraPayment) and never touches this attempt's payment or reversal fields.
  if (uuid) {
    const bind = await db.ref(`payment_attempts/${attemptId}/payment_uuid`).transaction((cur) => (cur == null ? uuid : undefined));
    const bound = bind.committed ? uuid : (bind.snapshot && bind.snapshot.val());
    if (bound !== uuid) return handleExtraPayment(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now });
  }

  // CANCEL race (I9): cancelled before this paid callback → auto-void, NEVER materialize.
  // NOTE: an `abandoned` manual-resolve order has status:'cancelled', so a LATE paid callback on an
  // abandoned order lands HERE → auto-void + refund_pending + alert (rev-5 R3-#2 backstop).
  // [Fix#3] Also honor an ORDER-level cancel claim (resolving_action='cancel' + cancel_claim_id) — set
  // ATOMICALLY by cancelOrderCore's claim BEFORE the attempt's cancel_pending flag. A paid callback in the
  // ~1ms gap between the order-claim and the attempt-flag would otherwise see neither → materialize. This
  // closes that window completely (the order claim always lands first).
  if (attempt.cancel_pending || order.status === 'cancelled' || (order.resolving_action === 'cancel' && order.cancel_claim_id)) {
    return voidPaid(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now, reason: 'cancelled_before_payment' });
  }

  // [rev-5 R2-#1 / R4 / R3-#4] Paid callback while the order is in the manual-reconciliation flow — QUEUED
  // (manual_reconciliation) or MID-RESOLVE (resolving_*), both still status:'pending_payment'. This is money
  // EVIDENCE, not noise: record it ATOMICALLY (attempt UUID + verified flags + orders/{id}/paid_during_resolve)
  // in ONE multi-location update so no partial strand, and do NOT materialize — the dispatcher owns the
  // resolution. The order flag makes the resolver's abandon-CAS fail and its refund use this UUID.
  if (order.payment_status === 'manual_reconciliation' || MR.isResolving(order.payment_status)) {
    await db.ref().update({
      [`payment_attempts/${attemptId}/hosted_state`]: 'paid',
      [`payment_attempts/${attemptId}/payment_uuid`]: uuid,
      [`payment_attempts/${attemptId}/paid_amount_cents`]: toCents(amount),
      [`payment_attempts/${attemptId}/hosted_callback_verified`]: true,
      [`payment_attempts/${attemptId}/payment_hash_verified`]: true,
      [`orders/${orderId}/paid_during_resolve`]: true,
    });
    await setPaidOnce(db, attemptId, { paidAt: now, reference: txnRef || uuid });
    await holdRedemptionForManual(db, { orderId, order, now, alert: deps.alert });   // paid evidence in manual-flow → HOLD the points (alerts if a race already freed the hold → possible mint)
    deps.alert && deps.alert('paid_during_manual_resolve', { orderId, attemptId, payment_status: order.payment_status });
    return { code: 200, outcome: 'paid_evidence_recorded' };
  }

  // Verified paid → persist the verified payment data FIRST (recovery reads it), then
  // confirm + materialize idempotently (reuses the tested confirmAndMaterialize claim).
  await db.ref(`payment_attempts/${attemptId}`).update({
    hosted_state: 'paid', payment_uuid: uuid, paid_amount_cents: toCents(amount),
    hosted_callback_verified: true, payment_hash_verified: true
  });
  await setPaidOnce(db, attemptId, { paidAt: now, reference: txnRef || uuid });   // immutable once written: a re-delivery never moves them

  let r;
  try {
    r = await confirmAndMaterialize(deps, { orderId, attemptId, now, trackingToken: deps.genToken(), paymentReference: txnRef || uuid });
  } catch (e) {
    return { code: 500, outcome: 'materialize_error', error: e && e.message };   // TRANSIENT → PixelPay retries
  }

  // Tight cancel-vs-confirm race: order got cancelled between our check and the claim → void.
  if (r.outcome === 'cancelled_during_confirm' || r.outcome === 'cancelled') {
    return voidPaid(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now, reason: 'cancelled_during_confirm' });
  }
  return { code: 200, outcome: r.outcome };
}

// The bound payment's paid_at / payment_reference are written ONCE (absent → value); a re-delivery leaves them as they were.
async function setPaidOnce(db, attemptId, { paidAt, reference }) {
  await db.ref(`payment_attempts/${attemptId}/paid_at`).transaction((cur) => (cur == null ? paidAt : undefined));
  await db.ref(`payment_attempts/${attemptId}/payment_reference`).transaction((cur) => (cur == null ? reference : undefined));
}

// ── AN EXTRA PAYMENT: a second distinct verified payment on an attempt that already has one (two payable checkouts paid) ──
// Its OWN record under payment_attempts/{aaid}/extra_payments/{sha256(uuid)} (server-only; the exact uuid is stored inside and
// checked on every read), its OWN phases, and its OWN reversal, scoped to its payment id — the attempt-level payment fields and
// reversal state (status / refund_*) are never read or written for it, so the first payment's refund machinery is untouched.
//   recorded → (durable alert + order flag) → held_for_review         live order: a person reviews it; never voided here
//                                         → reversal_claimed → side_effect_started → voided | manual     cancelled order
// Re-delivery resumes: an unwritten alert/flag is written; a held extra whose order is now cancelled is reversed; a claimed
// but never-started reversal is started; a STARTED but unrecorded one is uncertain → manual, never re-sent. An unconfirmed void
// is manual-only (no automatic retry). A failed alert / flag write answers 5xx so PixelPay re-delivers. No provider text is
// ever copied into a record or an alert.
const extraKey = (uuid) => crypto.createHash('sha256').update(String(uuid)).digest('hex');
const orderCancelled = (o, att) => !!((att && att.cancel_pending) || (o && (o.status === 'cancelled' || (o.resolving_action === 'cancel' && o.cancel_claim_id))));
async function handleExtraPayment(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now }) {
  const { db } = deps;
  const key = extraKey(uuid);
  const ref = db.ref(`payment_attempts/${attemptId}/extra_payments/${key}`);
  const done = { code: 200, outcome: 'extra_payment_recorded' };
  await ref.transaction((cur) => (cur == null ? { uuid, amount_cents: toCents(amount), at: now, phase: 'recorded' } : undefined));
  const rec = (await ref.once('value')).val();
  if (!rec || rec.uuid !== uuid) return { code: 500, outcome: 'extra_payment_key_mismatch' };   // never act on another payment's record
  try {
    await db.ref(`dispatcher_alerts/extra_payment_${key}`).set({ type: 'payment_extra_payment_received', detail: { orderId, attemptId }, created_at: rec.at });
    await db.ref(`orders/${orderId}`).update({ extra_payment_review: true });
  } catch (_) { return { code: 500, outcome: 'extra_payment_alert_failed' }; }   // surfaced: PixelPay re-delivers and this resumes

  if (rec.phase === 'voided' || rec.phase === 'manual') return done;
  if (rec.phase === 'side_effect_started') {   // a crash after the provider call may have started → uncertain → a person decides
    await ref.update({ phase: 'manual', outcome: 'void_uncertain_manual' });
    return done;
  }
  const [order, att] = (await Promise.all([db.ref(`orders/${orderId}`).once('value'), db.ref(`payment_attempts/${attemptId}`).once('value')])).map((x) => x.val());
  if (!orderCancelled(order, att)) {
    if (rec.phase !== 'held_for_review' && rec.phase !== 'reversal_claimed') await ref.update({ phase: 'held_for_review' });
    if (rec.phase !== 'reversal_claimed') return done;
  }
  // Cancelled (or a claimed reversal to finish): CAS into side_effect_started IMMEDIATELY before the provider call, so exactly
  // one delivery ever sends it; the claim step is separate so a crash before the call is provably "not started".
  const claim = await ref.transaction((cur) => {
    if (cur === null) return null;                                       // null-first-safe
    if (!cur || cur.uuid !== uuid || !['recorded', 'held_for_review', 'reversal_claimed'].includes(cur.phase)) return;
    return { ...cur, phase: 'reversal_claimed', claimed_at: cur.claimed_at || now };
  });
  if (!claim.committed) return done;
  const start = await ref.transaction((cur) => {
    if (cur === null) return null;
    if (!cur || cur.uuid !== uuid || cur.phase !== 'reversal_claimed') return;
    return { ...cur, phase: 'side_effect_started', started_at: now };
  });
  if (!start.committed) return done;
  let voided = false;
  try {
    const vd = await deps.client.voidTransaction({ payment_uuid: uuid, pixelpayOrderId: hostedOrderId, voidReason: 'cancelled_before_payment' });
    voided = !!(vd && vd.ok);
  } catch (_) { voided = false; }
  await ref.update(voided ? { phase: 'voided', outcome: 'auto_voided', finished_at: now } : { phase: 'manual', outcome: 'void_unconfirmed_manual', finished_at: now });
  return done;
}

// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.
async function voidPaid(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now, reason }) {
  const { db } = deps;
  // PLAN-H0 §4 — a verified paid callback with NO payment uuid can never be reversed automatically, and must never read
  // as 'refunded'. Park it durably for staff: the H0 sweep (superseded-capture.js) alerts it as reversal_uncertain.
  if (!uuid) {
    await db.ref().update({
      [`payment_attempts/${attemptId}/status`]: 'manual_review',
      [`payment_attempts/${attemptId}/hosted_callback_verified`]: true,
      [`payment_attempts/${attemptId}/no_uuid_paid_callback`]: { at: now, hosted_order_id: hostedOrderId },
      [`payment_attempts/${attemptId}/uncertain_at`]: now,
      [`orders/${orderId}/status`]: 'cancelled',
      [`orders/${orderId}/payment_status`]: 'manual_review',
    });
    return { code: 200, outcome: 'cancelled_no_uuid_manual_review' };
  }
  let voided = false;
  try {
    const vr = await deps.voidOrRefund(deps, { orderId, attemptId, pixelpayOrderId: hostedOrderId, paymentUuid: uuid, reason, now });
    voided = !!vr.voided;
  } catch (_) { /* void failed → refund_pending (refundReconciler retries) */ }
  await db.ref(`payment_attempts/${attemptId}`).update({
    hosted_state: voided ? 'voided' : 'refund_pending', payment_uuid: uuid,
    paid_amount_cents: toCents(amount), voided_at: now
  });
  await db.ref(`orders/${orderId}`).update({ status: 'cancelled', payment_status: voided ? 'refunded' : 'refund_pending' });
  // [C/#18] a late paid callback on a cancelled/abandoned order → the money is voided/refunded, so reverse the
  // redemption hold too (reserved/held_paid→released, consumed→credit debit_applied). Idempotent (order_id-keyed)
  // → a no-op if the cancel path already reversed it; closes the gap where voidPaid moved money but not the hold.
  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  await reverseRedemptionForOrder(db, { orderId, order, disposition: 'refund', now });
  deps.alert && deps.alert('hosted_cancel_void', { orderId, attemptId, voided, reason });
  return { code: 200, outcome: voided ? 'cancelled_voided' : 'cancelled_refund_pending' };
}

module.exports = { handleHostedCallback };
