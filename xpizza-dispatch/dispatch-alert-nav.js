// xpizza-dispatch/dispatch-alert-nav.js — PURE, write-free helpers for Torre de Control alert
// navigation + the En Fila needs-attention count. No DOM, no Firebase → node-testable. Mirrors the
// dispatch-stalled.js pattern; index.html imports these and performs the actual navigation/DOM.
import { isStalledAssignment } from './dispatch-stalled.js';

// Alert types whose resolution lives on the ORDER (open its detail modal).
const ORDER_TYPES = new Set(['no_drivers_available', 'no_response_takeover', 'assignment_strand', 'payment_aged_refund_pending']);
// Alert types the dispatcher resolves in Caja → Reconciliación.
const CAJA_TYPES = new Set(['payment_hosted_stale_no_callback', 'payment_reconcile_breaches']);

function orderIdOf(a) { return (a && (a.order_id ?? (a.detail && a.detail.orderId))) || null; }

// Resolve a Torre de Control alert → a navigation target. WRITE-FREE (returns data only):
//   { kind:'order', orderId } · { kind:'caja', orderId|null } · { kind:'driver', driverId } · { kind:'none' }
export function alertNavTarget(a) {
  if (!a || !a.type) return { kind: 'none' };
  if (a.type === 'driver_freshness_stale' && a.driver_id) return { kind: 'driver', driverId: a.driver_id };
  if (CAJA_TYPES.has(a.type)) {
    const br = a.detail && Array.isArray(a.detail.breaches) ? a.detail.breaches : null;
    // A breaches list highlights an order only when it names EXACTLY one; otherwise open Caja unhighlighted.
    const oid = br ? (br.length === 1 ? (br[0].orderId || null) : null) : orderIdOf(a);
    return { kind: 'caja', orderId: oid };
  }
  const oid = orderIdOf(a);
  if (ORDER_TYPES.has(a.type) || oid) return oid ? { kind: 'order', orderId: oid } : { kind: 'none' };
  return { kind: 'none' };
}

// En Fila "needs attention" = count of unique order_ids whose delivery task is UNASSIGNED (mirrors
// getPendingOrders EXACTLY: no assigned_driver_id and status not cancelled/completed) OR STALLED (offered but
// never accepted, acceptance deadline expired). De-duped by order_id. Pure — reads only its args.
export function enFilaAttentionCount(orders, tasks, now) {
  const ids = new Set();
  for (const o of Object.values(orders || {})) {
    const dt = (tasks || {})[`${o.order_id}_delivery`];
    if (!dt) continue;
    const unassigned = !dt.assigned_driver_id && dt.status !== 'cancelled' && dt.status !== 'completed';   // == getPendingOrders predicate
    if (unassigned || isStalledAssignment(dt, now)) ids.add(o.order_id);
  }
  return ids.size;
}
