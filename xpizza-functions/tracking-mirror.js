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

module.exports = { activeDropOrderId, shouldMirror };
