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
const ppCrypto = require('./pixelpay');
const { resolvePixelPayConfig } = require('./pixelpay-config');
const { toCents } = require('./pixelpay-hosted');
const { confirmAndMaterialize } = require('./pixelpay-confirm');
const MR = require('./manual-resolve');   // atomic-claim predicate (rev-5): paid-evidence capture in manual-flow states

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
    await db.ref(`orders/${orderId}`).update({ payment_status: 'manual_reconciliation' });
    deps.alert && deps.alert('hosted_verify_fail', { orderId, attemptId, bindingOk, hashOk, amountOk });
    return { code: 200, outcome: 'manual_reconciliation' };
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
      [`payment_attempts/${attemptId}/payment_reference`]: txnRef || uuid,
      [`payment_attempts/${attemptId}/paid_at`]: now,
      [`orders/${orderId}/paid_during_resolve`]: true,
    });
    deps.alert && deps.alert('paid_during_manual_resolve', { orderId, attemptId, payment_status: order.payment_status });
    return { code: 200, outcome: 'paid_evidence_recorded' };
  }

  // Verified paid → persist the verified payment data FIRST (recovery reads it), then
  // confirm + materialize idempotently (reuses the tested confirmAndMaterialize claim).
  await db.ref(`payment_attempts/${attemptId}`).update({
    hosted_state: 'paid', payment_uuid: uuid, paid_amount_cents: toCents(amount),
    hosted_callback_verified: true, payment_hash_verified: true,
    payment_reference: txnRef || uuid, paid_at: now
  });

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

// Auto-void a paid hosted charge for a cancelled order; never leaves money on a cancelled order.
async function voidPaid(deps, { orderId, attemptId, hostedOrderId, uuid, amount, now, reason }) {
  const { db } = deps;
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
  deps.alert && deps.alert('hosted_cancel_void', { orderId, attemptId, voided, reason });
  return { code: 200, outcome: voided ? 'cancelled_voided' : 'cancelled_refund_pending' };
}

module.exports = { handleHostedCallback };
