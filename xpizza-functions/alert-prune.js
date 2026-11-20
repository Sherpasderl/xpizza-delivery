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
// Codex #211 P1-2 (cancel-park): an UNRESOLVED MONEY state (manual_review / manual_reconciliation / refund_pending / resolving_*) still
// needs a person WHATEVER the order's fulfilment status — kept, never pruned. (It subsumes H1a A-R1's handheld-reject refund_pending keep.)
const UNRESOLVED_MONEY = new Set(['manual_review', 'manual_reconciliation', 'refund_pending']);
const unresolvedMoney = (order) => !!order && (UNRESOLVED_MONEY.has(order.payment_status) || (typeof order.payment_status === 'string' && order.payment_status.startsWith('resolving_')));
function orderStillFlagged(order, alert) {   // `alert` is kept in the signature: callers pass it
  if (!order) return false;
  if (unresolvedMoney(order)) return true;
  if (order.status === 'cancelled') return false;
  if (order.payment_status === 'refunded' || order.payment_status === 'abandoned') return false;
  return true;
}

// dispatcher_alerts keys to prune: order-scoped alerts whose referenced orders are ALL resolved.
// Non-order-scoped alerts (no detail orderId/breaches) are never auto-dismissed here.
// An extra-payment alert is a MONEY obligation, not an order flag: it stays until the person who reviews / returns the second
// payment dismisses it, whatever the order's state (on a cancelled order by design).
// A «refund confirmed — release points» escalation is a points OBLIGATION, not an order flag: it stays until the staff
// member who releases the points dismisses it, whatever the order's state (the order is cancelled/refunded by design).
// (assembly composition: both lanes' never-auto-prune alert types — extra-pay's money obligations (received + quarantined) + P5a's points obligation)
const NEVER_AUTO_PRUNE = new Set(['payment_extra_payment_received', 'payment_extra_payment_quarantined', 'payment_refund_confirmed_release_points']);
function alertsToPrune(alerts, orders) {
  const prune = [];
  for (const [key, alert] of Object.entries(alerts || {})) {
    if (alert && NEVER_AUTO_PRUNE.has(alert.type)) continue;
    const ids = alertOrderIds(alert);
    if (ids.length === 0) continue; if (alert && String(alert.type || '').startsWith('payment_sdk_')) continue;
    if (ids.every((id) => !orderStillFlagged((orders || {})[id], alert))) prune.push(key);
  }
  return prune;
}

module.exports = { alertOrderIds, orderStillFlagged, alertsToPrune, unresolvedMoney };
