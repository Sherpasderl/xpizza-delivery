// board-model.js — PURE order-board derivation for mobile dispatch-lite.
// No DOM, no Firebase — node-testable. Mirrors the desktop dispatch's own
// assignment predicates (xpizza-dispatch/index.html: a delivery task with no
// assigned_driver_id and status !== 'cancelled' is unassigned).

export const SECTIONS = ['nuevos', 'preparacion', 'listos', 'camino', 'completados'];

// order.status → board section. Pickup orders have no driver leg, so they can
// never be "En camino" — a (malformed) pickup at out_for_delivery still shows in Listos.
export function sectionForOrder(order) {
  const s = order && order.status;
  switch (s) {
    case 'new': return 'nuevos';
    case 'preparing': return 'preparacion';
    case 'ready': return 'listos';
    case 'out_for_delivery': return order.order_type === 'pickup' ? 'listos' : 'camino';
    case 'delivered':
    case 'completed': return 'completados';
    default: return null; // scheduled/releasing/pending_payment/cancelled — not on the live board
  }
}

export const deliveryTaskId = (orderId) => `${orderId}_delivery`;

// The delivery task's assigned driver, or null. Mirrors dispatch's read.
export function assignedDriverId(orderId, tasks) {
  const dt = (tasks || {})[deliveryTaskId(orderId)];
  return dt && dt.assigned_driver_id ? dt.assigned_driver_id : null;
}

// A delivery order is "on the live board and eligible for a driver" when it's a delivery (not pickup),
// maps to a live section (not completed/scheduled/cancelled), and its delivery task isn't
// cancelled/completed. Mirrors the desktop dispatch's pending/active predicate (getPendingOrders /
// getActiveOrders key on a non-cancelled/-completed delivery task, regardless of order.status) — so a
// driver can be assigned from the moment the order exists, NOT only once the kitchen marks it ready.
function isLiveDelivery(order, orderId, tasks) {
  if (!order || order.order_type === 'pickup') return false;
  const sec = sectionForOrder(order);
  if (!sec || sec === 'completados') return false;
  const dt = (tasks || {})[deliveryTaskId(orderId)];
  if (dt && (dt.status === 'cancelled' || dt.status === 'completed')) return false;
  return true;
}

// "Sin asignar": a live delivery order (ANY stage — new/preparing/ready/en camino) whose delivery task
// has no driver. A missing task row counts as unassigned (nothing claimed it yet). Pickup is never
// "sin asignar". Broadened to match desktop getPendingOrders — surfaces before the order is ready.
export function isUnassignedDelivery(order, orderId, tasks) {
  if (!isLiveDelivery(order, orderId, tasks)) return false;
  const dt = (tasks || {})[deliveryTaskId(orderId)];
  return !(dt && dt.assigned_driver_id);
}

// The assign/reassign action is available on any live delivery order (new/preparing/ready/en camino)
// whose delivery task isn't cancelled/completed — whether unassigned (→ "Asignar") or already assigned
// (→ "Reasignar"). Broadened from the old ready/out-only rule to match the desktop dispatch, so an
// unassigned order gets a driver immediately instead of waiting for "listo". Pickup/scheduled/completed
// have no driver leg → no action.
export function canReassign(order, orderId, tasks) {
  return isLiveDelivery(order, orderId, tasks);
}

export const typeChip = (order) => (order && order.order_type === 'pickup' ? 'pickup' : 'delivery');

export function matchesChip(order, orderId, tasks, chip) {
  if (!sectionForOrder(order)) return false; // only live-board orders
  switch (chip) {
    case 'todos': return true;
    case 'delivery': return typeChip(order) === 'delivery';
    case 'pickup': return typeChip(order) === 'pickup';
    case 'unassigned': return isUnassignedDelivery(order, orderId, tasks);
    default: return true;
  }
}

export function chipCounts(orders, tasks, scheduledCount = 0) {
  let delivery = 0, pickup = 0, unassigned = 0;
  for (const id of Object.keys(orders || {})) {
    const o = orders[id];
    if (!sectionForOrder(o)) continue;
    if (typeChip(o) === 'pickup') pickup++; else delivery++;
    if (isUnassignedDelivery(o, id, tasks)) unassigned++;
  }
  const programados = scheduledCount || 0;
  return { delivery, pickup, programados, unassigned, todos: delivery + pickup + programados };
}

// Within a status section, delivery sorts before pickup; then by created_at (oldest first).
export function orderCompare(a, b) {
  const at = typeChip(a) === 'pickup' ? 1 : 0;
  const bt = typeChip(b) === 'pickup' ? 1 : 0;
  if (at !== bt) return at - bt;
  return (a.created_at || 0) - (b.created_at || 0);
}
