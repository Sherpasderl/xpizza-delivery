'use strict';

/**
 * Pure predicate for the S3 pending-order re-offer sweeper. No db / I/O — unit-tested with
 * `node sweep-pending.test.js` (repo idiom). The `sweepPendingOrders` scheduled function composes this
 * to decide which orders to re-offer; keeping the decision pure makes the "too-loose predicate"
 * failure mode (the main way this sweeper misbehaves) directly testable.
 *
 * An order is sweepable iff it is genuinely stuck and safe to auto-retry:
 *   - order status is auto-assignable (new/preparing/ready) — excludes cancelled/completed/pending_payment
 *   - NOT dispatcher-parked (the explicit opt-out / "behaves like today" escape hatch)
 *   - both pickup AND delivery tasks exist, are unassigned, and not cancelled
 *   - neither task has a live assignment_deadline (i.e. it is not mid-assignment)
 *   - retry_count (on the delivery task) is below the throttle
 *   - old enough that it can't collide with autoAssignOnOrderCreate, which still reads/picks/writes
 *     AFTER its 30s grace sleep: created_at <= now - (graceMs + sweepIntervalMs)
 */

// Mirrors index.js AUTO_ASSIGNABLE_STATUSES (new/preparing/ready). Small + stable; kept local so the
// pure predicate has no index.js dependency.
const AUTO_ASSIGNABLE_STATUSES = new Set(['new', 'preparing', 'ready']);

// Order statuses the HEAL must NEVER touch (terminal / non-live). The heal unassigns a stranded
// pickup≠delivery half-claim back to SIN ASIGNAR — but a terminal order's tasks are legitimately
// FINAL, so a historical mismatch on a delivered/cancelled order must not be "healed" (fix #4: the
// heal previously fresh-skipped only 'cancelled'). 'completed' is a task status, included defensively.
const HEAL_TERMINAL_STATUSES = new Set(['cancelled', 'delivered', 'completed']);

function sweepDecision(order, tasks, now, opts = {}) {
  const { graceMs = 30_000, sweepIntervalMs = 60_000, retryMax = 2 } = opts;
  const all = tasks || {};
  if (!order) return { sweep: false, reason: 'no_order' };
  if (order.dispatch_parked) return { sweep: false, reason: 'parked' };
  if (!AUTO_ASSIGNABLE_STATUSES.has(order.status)) return { sweep: false, reason: `status_${order.status}` };

  const pickup = all[`${order.order_id}_pickup`];
  const delivery = all[`${order.order_id}_delivery`];
  if (!pickup || !delivery) return { sweep: false, reason: 'no_tasks' };
  for (const t of [pickup, delivery]) {
    if (t.status === 'cancelled') return { sweep: false, reason: 'cancelled' };
    if (t.assigned_driver_id) return { sweep: false, reason: 'assigned' };
    if (t.assignment_deadline) return { sweep: false, reason: 'live_deadline' };   // mid-assignment
  }

  if ((delivery.retry_count || 0) >= retryMax) return { sweep: false, reason: 'retry_exhausted' };
  if (typeof order.created_at !== 'number' || order.created_at > now - (graceMs + sweepIntervalMs)) {
    return { sweep: false, reason: 'too_young' };
  }
  return { sweep: true };
}

/**
 * Count a driver's DISTINCT active (not completed/cancelled) order_ids, optionally EXCLUDING one order.
 * `reassertAssignable` uses this with the order being placed excluded — because the sweeper CAS-claims
 * the delivery task before the recheck, so the just-claimed order would otherwise inflate the count and
 * wrongly reject a valid stackable driver. (In the S2 auto-assign call the order isn't claimed yet, so
 * excluding it is a harmless no-op there.)
 */
function activeOrderCount(tasks, driverId, excludeOrderId = null) {
  const orderIds = new Set();
  for (const t of Object.values(tasks || {})) {
    if (!t || t.assigned_driver_id !== driverId) continue;
    if (t.status === 'completed' || t.status === 'cancelled') continue;
    if (!t.order_id || t.order_id === excludeOrderId) continue;
    orderIds.add(t.order_id);
  }
  return orderIds.size;
}

/**
 * Classify a STRANDED / inconsistent assignment (finding 4, generalized in S3i to cover both strand shapes).
 *
 * A consistent order ALWAYS has its pickup and delivery tasks on the SAME driver — they are assigned and
 * moved together in a single atomic finalize update(). A MISMATCH between the two arises ONLY in the
 * transient window between a delivery CAS-claim and its finalize:
 *   - delivery claimed, pickup still null   (autoAssign / sweeper / manual grab)          — a "half-claim"
 *   - delivery moved to the new driver, pickup still on the old  (timeout-reassign / reassignOrder) — a "split"
 * A process death in that window leaves the mismatch stranded: the order is hidden from SIN ASIGNAR
 * (getPendingOrders keys off the delivery assignment) and never self-recovers — for the split, the two
 * halves are even owned by different drivers. Every legitimate claim→finalize window is bounded well below
 * staleMs (server functions die at their 90s timeout; the client aborts its finalize at 90s via the stall
 * guard), and staleMs defaults to 2×SWEEP_INTERVAL = 120s — so a mismatch that PERSISTS past staleMs is a
 * genuine strand, never a live in-flight claim.
 *
 * Two-pass via a `half_claim_since` marker on the delivery task so a live window (milliseconds) is never
 * healed:
 *   - 'none'  → consistent (both on the same driver, or both unassigned). Caller clears any stale marker.
 *   - 'mark'  → mismatch, no marker yet. Caller stamps half_claim_since = now (does NOT heal).
 *   - 'wait'  → mismatch, marker younger than staleMs. Caller does nothing (protects a live claim).
 *   - 'heal'  → mismatch persisted past staleMs. Caller unassigns BOTH tasks back to SIN ASIGNAR.
 */
function assignmentStrandState(pickup, delivery, now, opts = {}) {
  const { staleMs = 120_000 } = opts;
  if (!pickup || !delivery) return 'none';
  const dDriver = delivery.assigned_driver_id == null ? null : delivery.assigned_driver_id;
  const pDriver = pickup.assigned_driver_id == null ? null : pickup.assigned_driver_id;
  if (dDriver === pDriver) return 'none';   // consistent — both the same driver, or both unassigned
  if (typeof delivery.half_claim_since !== 'number') return 'mark';
  if (now - delivery.half_claim_since < staleMs) return 'wait';
  return 'heal';
}

module.exports = { sweepDecision, AUTO_ASSIGNABLE_STATUSES, HEAL_TERMINAL_STATUSES, activeOrderCount, assignmentStrandState };
