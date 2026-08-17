// xpizza-dispatch/dispatch-stalled.js — PURE predicate for a STALLED (offered-but-unaccepted)
// delivery assignment. Display-only; it WRITES NOTHING. Node-testable (no DOM, no Firebase).
//
// A "stalled" order is one the auto-assigner offered to a driver who never accepted: the delivery
// task has an assigned_driver_id but is still in status 'assigned' (accepting flips it past
// 'assigned' → 'accepted'/'in_progress'/'at_restaurant'/'en_route_delivery'), AND the 60s
// acceptance deadline has expired. Such an order is excluded from getPendingOrders() (it HAS a
// driver) yet needs dispatcher rescue via the existing reassignOrder path — the sole reason this
// predicate exists is to FLAG it for a reassign affordance. It never gates or performs a write.
//
// TWO-LEG GUARD (pt = the linked PICKUP task): a delivery task legitimately sits in 'assigned' while
// its pickup leg is being worked — it is DORMANT (depends_on_task_id the pickup) and only activates
// once pickup completes. So if the driver has already ACCEPTED the pickup leg (pt.status past
// 'assigned'), the order is NOT stalled — the driver accepted and is en route to pick up. Without
// this guard, every 2-leg order whose pickup runs longer than the 60s acceptance window (i.e. nearly
// all of them) would false-flag "sin aceptar · expiró" while the driver is actively in 'Recogida'.
export function isStalledAssignment(dt, now, pt) {
  if (pt && pt.status && pt.status !== 'assigned') return false; // driver accepted the entry (pickup) leg
  return !!dt
    && !!dt.assigned_driver_id
    && dt.status === 'assigned'                 // never accepted (accept moves it past 'assigned')
    && Number.isFinite(dt.assignment_deadline)
    && dt.assignment_deadline < now;            // the acceptance window (ACCEPT_TIMEOUT_MS) lapsed
}
