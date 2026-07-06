'use strict';

/**
 * Scheduled Orders — deps-injected release core (SCHEDULED_ORDERS_PLAN.md rev-3 §C/§D).
 *
 * The money-safe spine: a scheduled/held order becomes LIVE exactly once, by exactly one claim owner, via
 * the SAME buildMaterializeUpdates shape as an ASAP order — so autoAssign/factura/tracking/notifications
 * fire at release as if placed then. Mirrors the shipped atomic-claim/null-first discipline
 * (cancel-order-core.js / resolve-manual.js); the emulator F-matrix drives real concurrent transactions.
 *
 * Closed/invalid at release ⇒ HOLD + block + dispatcher alert (owner ruling) — never dumped on a dark kitchen.
 *
 * deps = { db, alert(kind, detail), genToken(), now?, restaurantFallback? }
 */
const { buildMaterializeUpdates } = require('./materialize');
const S = require('./scheduled-orders');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// Atomic claim scheduled → releasing (null-first-safe). Aborts (no write) unless still a due, unblocked,
// non-cancelling scheduled order. Returns { claimed, order }.
async function claimForRelease(deps, orderId, now, claimId) {
  const res = await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
    if (cur === null) return null;                                   // null-first: don't fabricate an order
    if (cur.status !== S.SCHEDULED) return;                          // abort — not claimable
    if (cur.scheduled_blocked === true) return;
    if (cur.resolving_action === 'cancel') return;                   // cancel/confirm race — let cancel win
    if (!(isNum(cur.release_at) && cur.release_at <= now)) return;   // not due yet
    return { ...cur, status: S.RELEASING, release_claim_id: claimId, releasing_since: now };
  });
  const order = res.snapshot ? res.snapshot.val() : null;
  const claimed = res.committed && order && order.status === S.RELEASING && order.release_claim_id === claimId;
  return { claimed, order };
}

// Re-validate at release then MATERIALIZE (releasing→new) OR HOLD-block. Shared by fresh claim + recovery.
async function finalizeRelease(deps, orderId, order, now) {
  const { db, alert } = deps;
  const rid = order.restaurant_id || 'x_pizza';
  const hours = (await db.ref(`restaurants/${rid}/identity/hours`).once('value')).val() || null;
  const check = S.releaseTimeValid(hours, order, now);

  if (!check.valid) {
    // Owner ruling: HOLD + alert, never auto-refund, never dump on a closed kitchen. Revert the claim,
    // set scheduled_blocked so future sweeps skip it (R2-#1) until a dispatcher clears it (releaseScheduledOrder).
    await db.ref(`orders/${orderId}`).update({
      status: S.SCHEDULED, scheduled_blocked: true, blocked_reason: check.reason,
      release_claim_id: null, releasing_since: null,
    });
    if (alert) await alert('scheduled_blocked', { orderId, reason: check.reason, scheduled_for: order.scheduled_for });
    return { released: false, blocked: true, reason: check.reason };
  }

  // Materialize via the single live-shape source (status:new + tasks + tracking + fresh token). Pass the
  // order's real payment_method so the delivery task carries it, but DELETE the release-time charged_at
  // overwrite — an online order was captured at HOLD time and that timestamp must be preserved (payment_status
  // 'confirmed' re-set is idempotent; cash has no online block so this is a no-op).
  const trackingToken = deps.genToken();
  const restaurant = deps.restaurantFallback || { lat: order.hub_lat, lng: order.hub_lng, name: order.restaurant_name, phone: order.restaurant_phone };
  const updates = buildMaterializeUpdates({ orderId, order, trackingToken, now, restaurant, paymentMethod: order.payment_method });
  delete updates[`orders/${orderId}/charged_at`];
  updates[`orders/${orderId}/release_claim_id`] = null;
  updates[`orders/${orderId}/releasing_since`] = null;
  updates[`orders/${orderId}/released_at`] = now;
  await db.ref().update(updates);
  return { released: true, blocked: false, trackingToken };
}

// releaseOne — claim + finalize. The normal release path (sweep) and the dispatcher override both use this.
async function releaseOne(deps, { orderId, now, claimId }) {
  const { claimed, order } = await claimForRelease(deps, orderId, now, claimId);
  if (!claimed) return { released: false, claimed: false, reason: 'not_claimable' };
  return finalizeRelease(deps, orderId, order, now);
}

// recoverStaleReleasing — a releasing claim whose owner died mid-finalize. Re-claim (only if still releasing
// AND stale) then finalize — the re-claim guards two overlapping sweeps from double-materializing.
async function recoverStaleReleasing(deps, { orderId, now, claimId, cfg }) {
  const c = S.resolveCfg(cfg);
  const res = await deps.db.ref(`orders/${orderId}`).transaction((cur) => {
    if (cur === null) return null;
    if (cur.status !== S.RELEASING) return;                                          // already finished/changed
    if (!(isNum(cur.releasing_since) && now - cur.releasing_since > c.staleReleasingMs)) return; // not stale
    return { ...cur, release_claim_id: claimId, releasing_since: now };              // re-claim the stale one
  });
  const order = res.snapshot ? res.snapshot.val() : null;
  if (!(res.committed && order && order.release_claim_id === claimId)) return { recovered: false };
  const r = await finalizeRelease(deps, orderId, order, now);
  return { recovered: true, ...r };
}

module.exports = { claimForRelease, finalizeRelease, releaseOne, recoverStaleReleasing };
