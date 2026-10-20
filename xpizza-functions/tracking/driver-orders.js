'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 3) — a BYTE COPY of the driver app's getDriverOrders (xpizza-driver/xpizza-delivery.js)
// and the enums it uses (xpizza-driver/driver-complete.js), so the server can compute EXACTLY which order the driver app shows as
// its active card (element 0). driver-orders.guard.test.js extracts both from the SDK and asserts byte equality — edit the SDK, not
// this file, then re-copy.
// ── BEGIN COPY: enums (driver-complete.js) ──
const TASK_STATUS = {
  PENDING: 'pending',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled'
};

const TASK_TYPE = {
  PICKUP: 'pickup',
  DELIVERY: 'delivery'
};
// ── END COPY: enums ──

// ── BEGIN COPY: getDriverOrders (xpizza-delivery.js) ──
function getDriverOrders(driverId, allTasks, allOrders, includeCompleted = false) {
  const grouped = {};
  Object.entries(allTasks).forEach(([taskId, t]) => {
    if (t.assigned_driver_id !== driverId) return;
    if (!grouped[t.order_id]) grouped[t.order_id] = {};
    if (t.type === TASK_TYPE.PICKUP) grouped[t.order_id].pickup = { ...t, id: taskId };
    if (t.type === TASK_TYPE.DELIVERY) grouped[t.order_id].delivery = { ...t, id: taskId };
  });

  const result = [];
  for (const [orderId, pair] of Object.entries(grouped)) {
    const { pickup, delivery } = pair;
    if (!pickup || !delivery) continue; // skip malformed pairs

    // Skip cancelled orders — driver should never see them
    if (pickup.status === TASK_STATUS.CANCELLED || delivery.status === TASK_STATUS.CANCELLED) continue;

    let phase;
    if (delivery.status === TASK_STATUS.COMPLETED) phase = 'completed';
    else if (pickup.status === TASK_STATUS.COMPLETED) phase = 'delivery';
    else if (pickup.status === TASK_STATUS.ACCEPTED || pickup.status === TASK_STATUS.IN_PROGRESS) phase = 'pickup';
    else phase = 'awaiting_acceptance';

    if (phase === 'completed' && !includeCompleted) continue;

    result.push({
      orderId,
      phase,
      pickupTask: pickup,
      deliveryTask: delivery,
      order: allOrders[orderId] || null
    });
  }

  // Sort: in-progress orders first, then by created_at
  const phaseRank = { delivery: 0, pickup: 1, awaiting_acceptance: 2, completed: 3 };
  result.sort((a, b) => {
    const r = phaseRank[a.phase] - phaseRank[b.phase];
    if (r !== 0) return r;
    return (a.deliveryTask.created_at || 0) - (b.deliveryTask.created_at || 0);
  });

  return result;
}
// ── END COPY: getDriverOrders ──

module.exports = { getDriverOrders, TASK_STATUS, TASK_TYPE };
