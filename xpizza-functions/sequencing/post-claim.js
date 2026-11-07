'use strict';
// BUILD-stacked-seq-server r5 T5 (iii) — the post-claim checks of a SEQUENCED placement, pure over FRESH reads.
//
// candidateState: has the offered order been touched since the decision? Only an untouched offer is `stillOffered`; anything
// else is `changed`, and the writer rolls its own claim back (it never releases: autoAssign and sweep have no release path, so
// nothing here can reset an accepted or picked-up order).
// confirmIncumbent: is the decision's other member still the driver's ONLY other order, on this driver, before pickup,
// assignable and not held? False → that writer's existing no-taker path.
const TERMINAL = new Set(['completed', 'cancelled']);

function candidateState({ pickup, delivery, order }, { uid, parked, isAssignable, isHeld }) {
  if (!pickup || !delivery || !order) return { changed: 'cancelled' };
  if (pickup.status === 'cancelled' || delivery.status === 'cancelled' || order.status === 'cancelled') return { changed: 'cancelled' };
  if (delivery.assigned_driver_id !== uid) return { changed: 'moved' };
  if (pickup.status === 'completed' || (typeof order.picked_up_at === 'number' && Number.isFinite(order.picked_up_at))) return { changed: 'picked_up' };
  if (pickup.assigned_driver_id || pickup.status === 'accepted' || pickup.status === 'in_progress') return { changed: 'accepted' };
  if (!isAssignable(order) || isHeld(order) || parked) return { changed: 'held' };
  return { stillOffered: true };
}

function confirmIncumbent({ tasks, uid, newOid, decision, incOrder, isAssignable, isHeld }) {
  const others = new Set();
  for (const t of Object.values(tasks || {})) {
    if (t && t.assigned_driver_id === uid && t.order_id && t.order_id !== newOid && !TERMINAL.has(t.status)) others.add(t.order_id);
  }
  if (others.size !== 1) return false;
  const inc = [...others][0];
  if (!decision || inc !== decision.incumbentOid || !decision.pair.includes(inc) || !decision.pair.includes(newOid)) return false;
  const p = tasks[`${inc}_pickup`]; const d = tasks[`${inc}_delivery`];
  if (!p || !d || p.assigned_driver_id !== uid || d.assigned_driver_id !== uid) return false;
  if (TERMINAL.has(p.status) || TERMINAL.has(d.status)) return false;
  return !!incOrder && isAssignable(incOrder) && !isHeld(incOrder);
}

module.exports = { candidateState, confirmIncumbent };
