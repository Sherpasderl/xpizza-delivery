// xpizza-dispatch/dispatch-stalled.js — PURE predicate for a STALLED (offered-but-unaccepted)
// delivery assignment. Display-only; it WRITES NOTHING. Node-testable (no DOM, no Firebase).
//
// A "stalled" order is one the auto-assigner offered to a driver who never accepted: the delivery
// task has an assigned_driver_id but is still in status 'assigned' (accepting flips it past
// 'assigned' → 'accepted'/'in_progress'/'at_restaurant'/'en_route_delivery'), AND the 60s
// acceptance deadline has expired. Such an order is excluded from getPendingOrders() (it HAS a
// driver) yet needs dispatcher rescue via the existing reassignOrder path — the sole reason this
// predicate exists is to FLAG it for a reassign affordance. It never gates or performs a write.
export function isStalledAssignment(dt, now) {
  return !!dt
    && !!dt.assigned_driver_id
    && dt.status === 'assigned'                 // never accepted (accept moves it past 'assigned')
    && Number.isFinite(dt.assignment_deadline)
    && dt.assignment_deadline < now;            // the acceptance window (ACCEPT_TIMEOUT_MS) lapsed
}
