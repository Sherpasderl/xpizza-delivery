'use strict';

/**
 * Materialize-time closed-kitchen guard (Scheduled Orders / Codex-on-diff on scheduled-checkout-ux).
 *
 * The intake guard (SCHED.asapWhileClosed in createOrder/chargeOnlineOrder) checks open-hours when an
 * online checkout is OPENED. But an online order is authorized at checkout and materializes LATER at
 * payment confirmation — a customer who opens checkout at 8:40pm (open) and pays at 8:50pm (past an
 * 8:45pm close) would otherwise land a live ASAP order on a dark kitchen.
 *
 * This is the shared re-check at the two materialize chokepoints (confirmAndMaterialize — which the
 * hosted webhook + materializeOnConfirm recovery both delegate to — and confirmAndMaterializeFrom
 * ManualClaim). For an UNSCHEDULED (ASAP) order, it re-reads current hours and, if the kitchen is closed
 * NOW, HOLDS the paid order (payment_status:'manual_review' + scheduled_blocked + dispatcher alert) for a
 * dispatcher to release-when-open / contact / refund — never status:'new'. This reuses the SHIPPED
 * hold+alert policy (mirrors closed-at-release and the scheduled-confirm re-validation); no new policy.
 *
 * Scheduled orders are untouched (they take their own hold path before reaching here). A config outage →
 * materialize (return false): captured money is NEVER stranded over a config blip, mirroring the shipped
 * inactive-restaurant post-capture posture. Returns true iff the order was held (caller must NOT materialize).
 */
const SCHED = require('./scheduled-orders');

async function holdIfClosedAtMaterialize(deps, orderId, order, now) {
  // Scheduled orders hold via their own path; this guard is ASAP-only.
  if (Number.isFinite(Number(order && order.scheduled_for))) return false;
  // No config reader → can't re-check → materialize (never strand paid money). Matches legacy callers.
  if (!deps || !deps.getIdentity) return false;
  const rid = (order && order.restaurant_id) || 'x_pizza';
  let hours;
  try {
    hours = (await deps.getIdentity(deps.db, rid)).hours;
  } catch (_) {
    return false; // config outage → materialize (never strand captured money over a blip)
  }
  if (!SCHED.asapWhileClosed(hours, null, now)) return false; // open now → materialize normally
  // Closed now: HOLD the paid order for a dispatcher. Reuses the shipped manual_review + block + alert policy.
  await deps.db.ref(`orders/${orderId}`).update({
    payment_status: 'manual_review', scheduled_blocked: true, blocked_reason: 'paid_after_close',
  });
  if (deps.alert) {
    try { await deps.alert('paid_after_close', { orderId, restaurant_id: rid }); } catch (_) { /* order held; a failed alert never un-holds it */ }
  }
  return true;
}

module.exports = { holdIfClosedAtMaterialize };
