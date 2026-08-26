'use strict';

// createorder-classify.js — hardens createOrder's idempotency branch so a re-submit of an EXISTING order_id
// returns idempotent-200 ONLY when it is genuinely the SAME LIVE cash order; every other existing-order state
// → 409 (never a false "order placed"). Mirrors the online path (acquireHostedAttempt/classifyHostedAttempt).
//
// Root incident (F1 / Miguel Vargas): a customer abandoned an online payment, came back, switched to cash and
// re-submitted the SAME order_id; createOrder blindly returned 200 idempotent on the stale online order →
// "order placed" with NOTHING on the KDS. Cases 2 (method) + 3 (terminal) kill that; case 4 (content) is the
// codex-required money-safety net so the server never relies on the client to bind content.
//
// classifyExistingOrder is PURE. computeIncomingFingerprint is async ONLY for the redemption branch, and even
// then uses prepareRedemption which is READ-ONLY (the reserve/debit lives in the SEPARATE
// resolveRedemptionForOrder). Both are computed AT the existence check (:500) with NO side effects, so a legit
// idempotent retry short-circuits to 200 without ever touching rate-limit / reserve / availability — preserving
// (never regressing) today's no-429-on-retry behavior.

// Statuses that mean "this order_id is NOT a live cash order a retry may idempotent-return":
//   cancelled/pending_payment/delivered/completed. (pending_payment is an ONLINE state — a cash re-submit of it
//   is Miguel; it is also caught by the method check, but listed here as defense-in-depth.)
const LIVE_TERMINAL_STATUSES = new Set(['cancelled', 'pending_payment', 'delivered', 'completed']);

// PURE. `existing` = the stored orders/{id}. `incoming` = { paymentMethod, restaurantMatches } for THIS request
// (always cash/card_delivery — online is rejected upstream). `incomingFp` may be null (legacy order with no
// payment_fingerprint, OR a fail-open recompute) → the content check (case 4) is skipped, method+terminal still
// apply. `isPaymentStatusClosed(paymentStatus)` is injected (= manual-resolve.isStatusChangeClosedToAutomation).
function classifyExistingOrder(existing, { paymentMethod, restaurantMatches }, incomingFp, { isPaymentStatusClosed } = {}) {
  if (!existing) return { action: '200' };                                             // caller only enters this on exists()
  if (!restaurantMatches) return { action: '409', reason: 'restaurant' };              // case 1 — order_id owned by another brand
  if (existing.payment_method !== paymentMethod) return { action: '409', reason: 'method' }; // case 2 — Miguel (online → cash)
  const closedByStatus = LIVE_TERMINAL_STATUSES.has(existing.status);
  const closedByPayment = !!existing.payment_status
    && typeof isPaymentStatusClosed === 'function'
    && isPaymentStatusClosed(existing.payment_status);
  if (closedByStatus || closedByPayment) return { action: '409', reason: 'closed' };   // case 3 — dead/paid/awaiting order
  if (existing.payment_fingerprint && incomingFp && existing.payment_fingerprint !== incomingFp) {
    return { action: '409', reason: 'cart' };                                          // case 4 — same id, different cart
  }
  return { action: '200' };                                                            // case 5 — genuine live same-order retry
}

// Compute the incoming content fingerprint AT the existence check, with NO side effects. Non-redemption → pure
// (orderBreakdownCents). Redemption → prepareRedemption ONLY (read-only). Mirrors the online path's
// orderFingerprint(orderId, total_cents, items_text, [schedExtra, rf:<redeemedSet>].join('|')) exactly, so the
// stored payment_fingerprint (computed from this SAME call) and a later retry's recompute are byte-identical.
// Returns the hex fingerprint, or null on ANY failure (FAIL-OPEN: a recompute failure must never 409/500 a
// legit retry — the caller skips case 4 and returns 200).
async function computeIncomingFingerprint(ctx, deps) {
  const { orderId, restaurantId, total, itemsText, items, redeem, customerUid, scheduledForRaw, orderType } = ctx;
  const { orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra, db } = deps;
  try {
    const isScheduled = Number.isFinite(scheduledForRaw);
    const schedExtra = isScheduled ? schedFingerprintExtra({ scheduled_for: scheduledForRaw, order_type: orderType }) : '';
    if (redeem == null) {
      const totalCents = orderBreakdownCents(total, restaurantId).total_cents;
      return orderFingerprint(orderId, totalCents, itemsText, [schedExtra].filter(Boolean).join('|'));
    }
    // Redemption cash order — read-only prepare (NEVER resolveRedemptionForOrder, which reserves/debits).
    const prep = await prepareRedemption(db, { redeem, items, restaurantId, itemsText, totalLempiras: total, customerUid });
    if (!prep || !prep.ok) return null;   // e.g. reward_unavailable (free item 86'd after the original) → fail-open
    const extra = [schedExtra, prep.redemptionFp ? `rf:${prep.redemptionFp}` : ''].filter(Boolean).join('|');
    return orderFingerprint(orderId, prep.priced.total_cents, prep.itemsText, extra);
  } catch (_) {
    return null;   // FAIL-OPEN — a fingerprint recompute failure never blocks a legit idempotent retry
  }
}

module.exports = { classifyExistingOrder, computeIncomingFingerprint, LIVE_TERMINAL_STATUSES };
