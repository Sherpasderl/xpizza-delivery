'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1 Step 3) — a BYTE COPY of the driver app's getDriverOrders (xpizza-driver/xpizza-delivery.js)
// and the enums it uses (xpizza-driver/driver-complete.js), so the server can compute EXACTLY which order the driver app shows as
// its active card (element 0). driver-orders.guard.test.js extracts both from the SDK and asserts byte equality — edit the SDK, not
// this file, then re-copy.
// the copied sort calls validPair — the server rule (sequencing/validity.js) the driver's stack-validity.js is byte-pinned to
const { validPair } = require('../sequencing/validity');
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

  // Sort: in-progress orders first, then by the server's stop_seq (a coherent sequenced stack), else by created_at.
  const phaseRank = { delivery: 0, pickup: 1, awaiting_acceptance: 2, completed: 3 };
  // Sequence ONLY a coherent 2-stop DELIVERY stack: the whole delivery-phase set is EXACTLY one valid pair (server
  // validPair provenance — same stack_id/driver, ranks 1+2, no reassignment after the stack write). This is a
  // SET-LEVEL decision computed once, so the comparator is consistent/transitive (never a pairwise mix with a 3rd
  // order). Non-delivery phases, a non-coherent delivery set (3+ orders, partial/mismatched/stale metadata) → legacy
  // created_at. The server (sequencing/plan-stack) is the only writer of stop_seq/stack_id on tasks/{oid}_delivery;
  // flag-OFF writes none. (This whole block is mirrored verbatim into tracking/driver-orders.js by platform-core,
  // which imports validPair from the same byte-pinned rule.)
  const deliveryPhase = result.filter((o) => o.phase === 'delivery');
  const seqMode = deliveryPhase.length === 2 && validPair(deliveryPhase[0].deliveryTask, deliveryPhase[1].deliveryTask);
  result.sort((a, b) => {
    const r = phaseRank[a.phase] - phaseRank[b.phase];
    if (r !== 0) return r;
    if (seqMode && a.phase === 'delivery' && b.phase === 'delivery') return a.deliveryTask.stop_seq - b.deliveryTask.stop_seq;
    return (a.deliveryTask.created_at || 0) - (b.deliveryTask.created_at || 0);
  });

  return result;
}
// ── END COPY: getDriverOrders ──

module.exports = { getDriverOrders, TASK_STATUS, TASK_TYPE };
