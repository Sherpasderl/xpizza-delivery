/**
 * Pure, dependency-free delivery-ETA helpers for the dispatch driver panel (Phase 1a).
 *
 * No google.maps, no DOM — unit-testable in Node. `now` (epoch ms) is always passed in.
 * Phase 1a shows a single-delivery ETA only once the driver physically holds the order's food
 * (its pickup task is COMPLETED); the number is Directions travel + a flat customer-dwell buffer.
 */

export function distanceMeters(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
}

// An ETA is honest only once the driver holds THIS order's food (pickup task completed) and all
// four coords are finite. Before that, the row shows a stage — never a number.
export function etaEligible(f) {
  return f.pickupStatus === 'completed'
    && Number.isFinite(f.destLat) && Number.isFinite(f.destLng)
    && Number.isFinite(f.driverLat) && Number.isFinite(f.driverLng);
}

export function projectArrival(nowMs, travelSec, dwellSec) {
  return nowMs + (Math.max(0, travelSec) + Math.max(0, dwellSec)) * 1000;
}

export function relativeEta(arrivalMs, nowMs) {
  const mins = Math.round((arrivalMs - nowMs) / 60000);
  return mins <= 1 ? 'llegando' : `≈ ${mins} min`;
}

export function clockTime(arrivalMs, tz = 'America/Tegucigalpa') {
  return new Date(arrivalMs).toLocaleTimeString('es-HN', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

export function dueForRefresh(lastComputedAt, nowMs, intervalMs, movedMeters, moveThresholdM) {
  if (lastComputedAt == null) return true;
  if (nowMs - lastComputedAt >= intervalMs) return true;
  return movedMeters >= moveThresholdM;
}
