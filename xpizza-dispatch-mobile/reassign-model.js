// reassign-model.js — PURE driver-pick list for the reassign sheet. No DOM/Firebase.
// It only RANKS drivers for display; the actual assignment is the SDK's
// assignOrderToDriver / reassignOrder (Task 8). We add no assignment rules here.

const ACTIVE = new Set(['accepted', 'in_progress']);

export function driverLoad(driverId, tasks) {
  let n = 0;
  for (const t of Object.values(tasks || {})) {
    if (t && t.assigned_driver_id === driverId && ACTIVE.has(t.status)) n++;
  }
  return n;
}

function haversineM(a, b) {
  if (!a || !b || typeof a.lat !== 'number' || typeof b.lat !== 'number') return Infinity;
  const R = 6371000, toR = (d) => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Sorted candidate list for the reassign sheet. `hub` = the order's origin (drivers are ranked by
// proximity to where the order is picked up). The current assigned driver is flagged (isCurrent) and
// never filtered out — the sheet shows "actual" and offers the swap. `isStale(last_ping)` is injected
// so the module stays pure (the app passes XPD.isStalePing).
export function driverPickList({ order, orderId, drivers, tasks, hub, now, isStale }) {
  const currentId = (tasks || {})[`${orderId}_delivery`]?.assigned_driver_id || null;
  const anchor = hub || null;
  const rows = [];
  for (const [id, d] of Object.entries(drivers || {})) {
    if (!d) continue;
    const pos = (typeof d.lat === 'number') ? { lat:d.lat, lng:d.lng } : null;
    rows.push({
      id,
      name: d.name || 'Repartidor',
      status: d.status || 'unknown',
      distanceM: haversineM(anchor, pos),
      load: driverLoad(id, tasks),
      live: !isStale(d.last_ping),
      isCurrent: id === currentId,
    });
  }
  // nearest first; the current driver stays visible wherever it sorts
  return rows.sort((a, b) => a.distanceM - b.distanceM);
}
