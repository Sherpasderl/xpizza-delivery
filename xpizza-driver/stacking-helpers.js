/**
 * Pure stacking helper for the driver app. No DOM, no Firebase — unit-tested with
 * `node stacking-helpers.test.js` + assert (repo idiom).
 *
 * When a driver accepts their FIRST order, the rest of their assigned SAME-HUB stack is
 * auto-accepted (the driver takes same-restaurant orders together). This returns the task ids
 * to flip to 'accepted': the driver's OWN tasks, still 'assigned', belonging to a
 * DIFFERENT order at the SAME restaurant hub as the one being accepted (the current order keeps
 * its normal flow). A CROSS-HUB order is NOT cascaded — it stays 'assigned' for an explicit swipe
 * (S2: cross-hub is a real detour decision, never force-accepted). Lone order → []. An order already
 * 'accepted' is left alone — so this is a NO-OP against today's same-hub auto-assign.
 */

// Mirrors driver-ingest.js resolvePickupHub (incl. coord-vs-restaurant_id validation) + the S1 client
// geofence. ALLOWED_HUBS == seed_identity / assign-hub to full precision; same 1e-6 epsilon so the
// client and server gates can't diverge.
const ALLOWED_HUBS = { x_pizza: { lat: 15.507489753573818, lng: -88.0398486953722 }, la_musa: { lat: 15.50414, lng: -88.03848 } };
const HUB_EPS = 1e-6;
const coordsMatch = (h, lat, lng) => typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat - h.lat) < HUB_EPS && Math.abs(lng - h.lng) < HUB_EPS;

function resolvePickupHub(pk) {
  if (!pk) return null;
  const rid = pk.restaurant_id;
  const lat = pk.destination_lat, lng = pk.destination_lng;
  const numeric = typeof lat === 'number' && typeof lng === 'number';
  if (rid == null || rid === 'x_pizza') {
    // legacy/x_pizza: numeric coords must BE X. Pizza; no coords → X. Pizza fallback (legacy unchanged)
    if (numeric) return coordsMatch(ALLOWED_HUBS.x_pizza, lat, lng) ? { lat, lng } : null;
    return { lat: ALLOWED_HUBS.x_pizza.lat, lng: ALLOWED_HUBS.x_pizza.lng };
  }
  // known non-x_pizza: coords must be present AND match the canonical hub → else fail-closed
  const canon = ALLOWED_HUBS[rid];
  return (canon && numeric && coordsMatch(canon, lat, lng)) ? { lat, lng } : null;
}

function sameHub(a, b) {
  return !!a && !!b && Math.abs(a.lat - b.lat) < HUB_EPS && Math.abs(a.lng - b.lng) < HUB_EPS;
}

// F2 §5 — hub-from-order. Resolve the stacking hub from the ORDER's stamped `hub_lat/hub_lng` (+ its
// `restaurant_id`) instead of the sibling `${oid}_pickup` TASK's `destination_lat/lng`. Zero-diff in value:
// create-order-build.js writes the order's hub_lat/hub_lng and the pickup task's destination_lat/lng from the
// SAME hub snapshot, so an order carries the identical coords — and it is split-leg-robust (no dependence on a
// pickup leg owned by another driver). The SAME ALLOWED_HUBS coord validation applies (reuse resolvePickupHub by
// mapping the order into its pickup-shape). An UNSTAMPED legacy x_pizza order (no hub_lat/hub_lng) still falls
// back to the X. Pizza hub exactly as the no-coords pickup task did → legacy stacks keep cascading (BC4: the
// cutover census guarantees 0 ACTIVE unstamped-legacy orders, so the non-x_pizza unstamped gap is empty).
function resolveOrderHub(order) {
  if (!order) return null;
  return resolvePickupHub({ restaurant_id: order.restaurant_id, destination_lat: order.hub_lat, destination_lng: order.hub_lng });
}

export function stackedTasksToAccept(allTasks, allOrders, driverId, currentOrderId) {
  const all = allTasks || {};
  const orders = allOrders || {};
  const currentHub = resolveOrderHub(orders[currentOrderId]);
  const ids = [];
  for (const [tid, t] of Object.entries(all)) {
    if (!t || t.assigned_driver_id !== driverId) continue;
    if (t.order_id === currentOrderId) continue;   // current order: untouched
    if (t.status !== 'assigned') continue;
    // same-hub only (S2): the other order's hub (from ITS order node) must match the current order's hub. A
    // candidate order absent from allOrders → null hub → not cascaded (fail-closed; acceptTask point-gets every
    // candidate order's hub BEFORE calling, per §5).
    if (sameHub(currentHub, resolveOrderHub(orders[t.order_id]))) ids.push(tid);
  }
  return ids;
}
