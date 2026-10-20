'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 3) — the derived tracker state for ONE order from current truth. Pure.
// Input: { orderId, order:{status}, pickup, delivery (task objects or null), owner:{uid, active, current_shift_id,
// current_task_id} | null, ownerTasks:{taskId: task} (the owner's task set) }.
// Output: { mode: 'terminal'|'pre'|'live'|'waiting'|'neutral', owner: uid|null, shift_id }.
const { getDriverOrders } = require('./driver-orders');

const TERMINAL = new Set(['delivered', 'completed', 'cancelled']);

function legsOwner(pickup, delivery) {
  if (!pickup || !delivery) return null;
  const a = pickup.assigned_driver_id, b = delivery.assigned_driver_id;
  return a && a === b ? a : null;
}

function deriveOrderTracker({ orderId, order, pickup, delivery, owner, ownerTasks }) {
  const status = order && order.status;
  if (TERMINAL.has(status)) return { mode: 'terminal', owner: null, shift_id: null };
  if (status !== 'out_for_delivery') return { mode: 'pre', owner: null, shift_id: null };
  const O = legsOwner(pickup, delivery);
  if (!O || !owner || owner.uid !== O) return { mode: 'neutral', owner: null, shift_id: null };
  const shift = owner.current_shift_id || null;
  if (owner.active !== true) return { mode: 'neutral', owner: O, shift_id: shift };

  // the driver app's own choice: element 0 of getDriverOrders, if it is a delivery-phase order (driver index.html:2195)
  const list = getDriverOrders(O, ownerTasks || {}, {});
  const D = list.filter((x) => x.phase === 'delivery');
  const first = list.length && list[0].phase === 'delivery' ? list[0] : null;
  const tie = first && D.some((x) => x !== first && (x.deliveryTask.created_at || 0) === (first.deliveryTask.created_at || 0));
  const pointer = owner.current_task_id || null;
  const pointsAtFirst = !!(first && pointer === first.deliveryTask.id);
  const inD = D.some((x) => x.orderId === orderId);
  if (!tie && pointsAtFirst && first.orderId === orderId) return { mode: 'live', owner: O, shift_id: shift };
  if (!tie && pointsAtFirst && inD && first.orderId !== orderId) return { mode: 'waiting', owner: O, shift_id: shift };
  return { mode: 'neutral', owner: O, shift_id: shift };
}

module.exports = { deriveOrderTracker, legsOwner, TERMINAL };
