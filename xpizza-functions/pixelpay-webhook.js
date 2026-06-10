/**
 * X Pizza — PixelPay webhook + sweep pure helpers (Stage 4, sub-stage 3).
 *
 * Kept pure (no I/O) so they're unit-tested in isolation; the HTTPS webhook and
 * the scheduled sweep in index.js wrap these with RTDB + the confirm machine.
 *
 * The webhook is a NUDGE ONLY — confirmOnlinePayment re-verifies via a server
 * doCapture, so nothing extracted here is trusted for the money decision; we only
 * need enough to find the internal order and (best-effort) a payment_uuid.
 */

// attempt_id is 16 lowercase-hex chars (crypto.randomBytes(8).toString('hex')), and
// pixelpay_order_id = `${order_id}-${attempt_id}`. Strip the suffix to get the order id.
const ATTEMPT_SUFFIX = /-[0-9a-f]{16}$/;

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

// Tolerantly pull the nudge fields out of an unknown PixelPay webhook payload
// shape. Returns { pixelpayOrderId, orderId, paymentUuid, eventId }.
// (PixelPay's exact webhook body is a build-time sandbox-pin; this accepts the
// common field names and nestings and logs-unknown upstream.)
function extractWebhookNudge(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const d = (b.data && typeof b.data === 'object') ? b.data : {};
  const t = (b.transaction && typeof b.transaction === 'object') ? b.transaction : {};
  const o = (b.order && typeof b.order === 'object') ? b.order : (d.order && typeof d.order === 'object' ? d.order : {});

  // PixelPay's REAL order_callback (captured from the live sandbox 2026-06-10) puts the order
  // id (= the pixelpay_order_id we sent as order.id) in **`ref`**, and the payment id in `uuid`
  // (a `P-…` scope that DIFFERS from our auth/capture `S-…` uuid). We therefore key off the
  // ORDER ID and let confirm use OUR attempt's stored uuid — never the callback's. `order`/
  // `order_id` are kept as fallbacks (the subscription webhook uses `order`). Nudge-only: this
  // is never trusted for the money decision (confirm re-verifies via doCapture).
  const pixelpayOrderId = firstString(b.ref, b.order, b.order_id, d.ref, d.order, d.order_id, t.order_id, o.id, b.pixelpay_order_id, d.pixelpay_order_id);
  const paymentUuid = firstString(b.uuid, b.payment_uuid, d.uuid, d.payment_uuid, t.payment_uuid);
  const eventId = firstString(b.transaction_id, b.uuid, b.id, b.event_id, d.transaction_id, d.id) || pixelpayOrderId;

  let orderId = null;
  if (pixelpayOrderId) {
    orderId = ATTEMPT_SUFFIX.test(pixelpayOrderId)
      ? pixelpayOrderId.replace(ATTEMPT_SUFFIX, '')
      : pixelpayOrderId; // already a bare order id, or unparseable → pass through
  }

  return { pixelpayOrderId, orderId, paymentUuid, eventId };
}

// Decide what the sweep should do with a stale pending_payment order.
//   'confirm'  — an attempt with a payment_uuid (or a stuck capturing claim) past the
//                confirm TTL → run confirmOnlinePayment (capture / recover / manual).
//   'abandon'  — no usable payment_uuid past the abandon TTL → the auth has expired at
//                PixelPay (no money moved); mark failed + alert (missed order).
//   'leave'    — too recent; the live flow may still complete.
//   'skip'     — not a sweepable state (already confirmed / manual / failed / cancelled).
function classifySweepCandidate(order, attempt, now, { confirmTtlMs = 120000, abandonTtlMs = 1800000 } = {}) {
  if (!order) return 'skip';
  if (order.status !== 'pending_payment') return 'skip';
  if (['confirmed', 'manual_reconciliation', 'failed', 'refund_pending'].includes(order.payment_status)) return 'skip';

  const created = Number(order.created_at) || 0;
  const age = now - created;
  const hasUuid = !!(attempt && attempt.payment_uuid);
  const capturing = !!(attempt && attempt.status === 'capturing');

  if ((hasUuid || capturing) && age > confirmTtlMs) return 'confirm';
  if (!hasUuid && !capturing && age > abandonTtlMs) return 'abandon';
  return 'leave';
}

module.exports = { extractWebhookNudge, classifySweepCandidate, ATTEMPT_SUFFIX };
