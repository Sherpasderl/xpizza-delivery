'use strict';

// RTDB egress Stage 1 — /tasks retention decisions (PURE; index.js is not require-safe). /tasks had no
// retention → 438 terminal-record keys that every 1–2min sweep re-read for zero live value (~950 MB/day idle
// egress). Shrink it to the live set. The safety-critical invariant: a LIVE order NEVER loses its tasks.

// Real-time trigger (deleteTasksOnOrderTerminal) deletes tasks the instant an order enters one of these states.
// ⚠️ EXCLUDES 'cancelled' — executor gate-check-3 finding: on the status→cancelled edge, notifyDriverOnCancellation
// (index.js) reads tasks/{id}_pickup for the assigned_driver_id to notify the driver of the cancellation ("the
// task survives intact for us to read"). A real-time delete on that same edge would RACE it (~50% → driver not
// notified). delivered/completed edges have NO task reader (verified exhaustively), so real-time deletion there
// is race-free. Cancelled tasks are drained by the periodic retention sweep below — which runs long after that
// notify has fired — so the driver is always notified AND cancelled tasks are still reclaimed.
const REALTIME_TERMINAL_STATUSES = new Set(['delivered', 'completed']);

// PURE. The ENTERING-terminal edge: true iff `after` is in the set and `before` is NOT (fire once). A
// terminal→terminal or live→live (or live→non-set-terminal, e.g. →cancelled for the realtime set) write is false.
function entersTerminalEdge(before, after, terminalSet) {
  return !!terminalSet && terminalSet.has(after) && !terminalSet.has(before);
}

const strip = (taskId) => String(taskId).replace(/_(pickup|delivery)$/, '');

// PURE. The periodic backstop / one-time drain: given the FULL /orders + /tasks snapshots, return the task ids to
// delete = tasks whose order is TERMINAL (terminalStatuses, injected = HEAL_TERMINAL_STATUSES incl. cancelled) OR
// whose order no longer exists (orphan). NEVER a task whose order is live/non-terminal (the impossible regression).
// REQUIRES a COMPLETE /orders snapshot — a partial read would misclassify a present-but-unread live order as an
// orphan; the caller reads all of /orders in one shot, so a live order is always present here.
function tasksToDelete(orders, tasks, terminalStatuses) {
  const o = orders || {}, t = tasks || {};
  const out = [];
  for (const taskId of Object.keys(t)) {
    const rec = t[taskId] || {};
    const orderId = rec.order_id || strip(taskId);
    const order = o[orderId];
    if (!order) { out.push(taskId); continue; }                                  // orphan → delete
    if (terminalStatuses && terminalStatuses.has(order.status)) { out.push(taskId); continue; }  // terminal order → delete
    // live / non-terminal order → KEEP its task (never delete a live order's task)
  }
  return out;
}

// PURE. The batch /orders + /tasks reads are NOT a consistent cross-node snapshot — an order + its tasks are
// written atomically (one multi-path update), but the two `once('value')` reads can straddle that write, so a
// brand-new LIVE order's task can appear as an orphan (its order absent from the earlier /orders read). Before
// deleting a CANDIDATE, the sweep re-reads its order FRESH and passes it here: absent → genuine orphan (delete);
// present + terminal → delete; present + NON-terminal → a live/just-created order (the race) → KEEP. Mirrors
// sweep-pending.js's fresh-status guard before a destructive write.
function confirmTaskDelete(freshOrder, terminalStatuses) {
  if (!freshOrder) return true;                                              // absent on the fresh re-read → true orphan
  return !!(terminalStatuses && terminalStatuses.has(freshOrder.status));    // terminal → delete; live/non-terminal → KEEP
}

module.exports = { REALTIME_TERMINAL_STATUSES, tasksToDelete, entersTerminalEdge, confirmTaskDelete };
