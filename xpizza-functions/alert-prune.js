'use strict';

// Auto-dismiss stale dispatcher alerts (paid-after-close Task 8). An ORDER-SCOPED payment alert should
// be removed once every order it references is RESOLVED (no longer needs dispatcher attention). Pure +
// unit-tested (index.js is not require-safe); the reconcilePayments sweep composes it.
//
// Only DETAIL-referenced orders are considered (detail.orderId / detail.breaches[].orderId) — keyed
// alerts like factura_<id> / reward_hold_stale_<id> carry the id in the KEY and have their own clearing
// logic, so they're left untouched here.

// The orderIds a dispatcher alert references via its detail (single order or a breaches[] batch).
function alertOrderIds(alert) {
  const out = [];
  const d = alert && alert.detail;
  if (d) {
    if (d.orderId) out.push(d.orderId);
    if (d.order_id) out.push(d.order_id);
    if (Array.isArray(d.breaches)) for (const b of d.breaches) { const id = b && (b.orderId || b.order_id); if (id) out.push(id); }
  }
  return out;
}

// Does an order still warrant a dispatcher alert? RESOLVED (→ dismiss) = gone / cancelled (incl.
// refunded + abandoned, which both set status:'cancelled') / payment refunded|abandoned. Everything
// else — pending_payment / manual_review / manual_reconciliation / refund_pending /
// refunding_paid_after_close, AND a normally-materialized order — is kept: a materialized order can
// still be a live breach (e.g. confirmed_without_verified_payment), so we NEVER auto-nuke on
// materialization (money-integrity alerts must survive) — narrower than the plan's Task-8 wording.
function orderStillFlagged(order) {
  if (!order) return false;
  if (order.status === 'cancelled') return false;
  if (order.payment_status === 'refunded' || order.payment_status === 'abandoned') return false;
  return true;
}

// dispatcher_alerts keys to prune: order-scoped alerts whose referenced orders are ALL resolved.
// Non-order-scoped alerts (no detail orderId/breaches) are never auto-dismissed here.
function alertsToPrune(alerts, orders) {
  const prune = [];
  for (const [key, alert] of Object.entries(alerts || {})) {
    const ids = alertOrderIds(alert);
    if (ids.length === 0) continue;
    if (ids.every((id) => !orderStillFlagged((orders || {})[id]))) prune.push(key);
  }
  return prune;
}

module.exports = { alertOrderIds, orderStillFlagged, alertsToPrune };
