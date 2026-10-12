'use strict';
// PURE, write-free helpers for the live-tracker location mirror (Phase A). No DOM, no Firebase.
// Decide (a) which order is the driver's ACTIVE drop and (b) whether a new GPS fix is worth mirroring
// (throttle so RTDB writes stay bounded). The I/O lives in ingestDriverLocation; these just decide.

// The active drop is the order whose DELIVERY leg is the driver's current task. Only the delivery leg is
// customer-facing live tracking — during the pickup leg (or no task) there is no active drop, so no map.
function activeDropOrderId(currentTaskId) {
  if (typeof currentTaskId !== 'string') return null;
  const m = currentTaskId.match(/^(.+)_delivery$/);
  return m ? m[1] : null;
}

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = (d) => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Mirror the new fix when: no prior fix (first write), the throttle window elapsed, or the driver moved a
// meaningful distance since the last mirrored fix. Otherwise skip (bounded writes).
function shouldMirror(prev, next, now, { throttleMs, minMoveMeters }) {
  if (!prev || !Number.isFinite(prev.at)) return true;                       // first write
  if (now - prev.at >= throttleMs) return true;                             // throttle window elapsed
  if (Number.isFinite(prev.lat) && Number.isFinite(next.lat) &&
      haversineM(prev.lat, prev.lng, next.lat, next.lng) >= minMoveMeters) return true; // meaningful move
  return false;
}

// STACKED-WAITING decision (pure core for the status→out_for_delivery tracker signal). Decide whether an
// order that just went out_for_delivery should be marked is_active_drop:false — i.e. the driver is actively
// delivering a DIFFERENT order right now, so this one is genuinely stacked-WAITING (the tracker then shows
// the "one quick stop first" copy and suppresses the naive countdown, instead of a map of the driver
// visiting someone else).
//   thisOrderId         — the order whose status just became out_for_delivery
//   driverCurrentTaskId — drivers/<id>/current_task_id (whatever leg the driver is on right now)
//   activeOrderStatus   — orders/<activeDropOrderId>/status (the order the driver's delivery leg points at)
// ⚠️ FAIL-SAFE: returns true ONLY when a DIFFERENT order is CONFIRMED to be the driver's active
// out_for_delivery drop. A single/non-stacked order, a driver mid-transition (no/pickup task), or a STALE
// pointer at an already-delivered order (status !== out_for_delivery) all return false → no false is written,
// the tracker falls to today's neutral branch (never worse than today, never a wrong "1 parada" on a normal
// delivery). The false→true upgrade is handled elsewhere (the ingest mirror, once this order becomes active).
function shouldMarkStackedWaiting(thisOrderId, driverCurrentTaskId, activeOrderStatus) {
  if (typeof thisOrderId !== 'string' || !thisOrderId) return false;
  const activeOrderId = activeDropOrderId(driverCurrentTaskId);
  if (!activeOrderId) return false;                              // no parseable active drop (pickup leg / none / uncertain)
  if (activeOrderId === thisOrderId) return false;              // THIS order is itself the active drop → not waiting
  if (activeOrderStatus !== 'out_for_delivery') return false;  // stale pointer / already delivered → fail-safe
  return true;                                                 // a DIFFERENT order is actively being delivered now
}

// Atomic conditional resolver for the stacked-waiting false write (RTDB transaction updater). The decision
// to write false is made from a READ of the driver's state; between that read and the write the world can
// move — order #1 finishes, order #2 becomes the active drop, and the ingest mirror writes is_active_drop
// TRUE for order #2. A plain set(false) would then CLOBBER that true and downgrade a customer already on the
// live map back to the "waiting" state (worse than today). As a transaction updater this can NEVER clobber a
// true: return undefined to ABORT (leave the current value — the promotion stands); otherwise write false
// (genuine stacked-waiting: current is absent/null/false). Fail-safe is preserved — a transaction failure in
// the caller's try/catch is just no write.
function stackedWaitingTxn(cur) {
  return cur === true ? undefined : false;   // never downgrade an active drop; else mark waiting
}

module.exports = { activeDropOrderId, shouldMirror, shouldMarkStackedWaiting, stackedWaitingTxn };
