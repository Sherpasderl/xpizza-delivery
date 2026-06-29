/**
 * Pure stacking helper for the driver app. No DOM, no Firebase — unit-tested with
 * `node stacking-helpers.test.js` + assert (repo idiom).
 *
 * When a driver accepts their FIRST order, the rest of their assigned stack is
 * auto-accepted (the driver takes them all together). This returns the task ids
 * to flip to 'accepted': the driver's OWN tasks, still 'assigned', belonging to a
 * DIFFERENT order than the one being accepted (the current order keeps its normal
 * flow — its delivery is accepted at pickup, not here). Lone order → []. An order
 * already 'accepted' (e.g. server-stacked) is left alone — so this is a NO-OP
 * against today's auto-assign and only activates for assigned-but-unaccepted stacks.
 */
export function stackedTasksToAccept(allTasks, driverId, currentOrderId) {
  const ids = [];
  for (const [tid, t] of Object.entries(allTasks || {})) {
    if (!t || t.assigned_driver_id !== driverId) continue;
    if (t.order_id === currentOrderId) continue;   // current order: untouched
    if (t.status === 'assigned') ids.push(tid);
  }
  return ids;
}
