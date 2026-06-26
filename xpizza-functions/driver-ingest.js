/**
 * Pure helpers for the native driver-location ingest path (Step 2b).
 *
 * No Firebase Admin / db / crypto-keyed side effects — unit-tested with plain
 * `node driver-ingest.test.js` (same idiom as driver-push.js / pixelpay-webhook.js).
 * The onRequest `ingestDriverLocation` endpoint composes these.
 */

const crypto = require('crypto');

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two lat/lng points, in metres. */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Server-side port of the client `checkGeofenceTransition` state machine.
 * Given the driver's current status, whether they have an active task, the hub
 * coords and the driver's position, return the status transition to apply (with
 * an `arrivedAtRestaurant` flag where the client also stamped a timestamp), or
 * null for no transition. Hub coords come from the persisted snapshot, NOT
 * current_task_id (which is null on cancel/reassign).
 */
function geofenceTransition({ status, hasTask, hubLat, hubLng, lat, lng, radiusM }) {
  const inGeofence = haversineMeters(lat, lng, hubLat, hubLng) < radiusM;

  // returning → arrived at hub
  if (inGeofence && status === 'returning') {
    return { status: 'at_restaurant', arrivedAtRestaurant: true };
  }
  // assigned with a task → arrived at hub for pickup
  if (inGeofence && status === 'assigned' && hasTask) {
    return { status: 'at_restaurant', arrivedAtRestaurant: true };
  }
  // at hub with a task, left the geofence → en route (picked up, heading out)
  if (!inGeofence && status === 'at_restaurant' && hasTask) {
    return { status: 'en_route_delivery' };
  }
  // at hub with no task → available
  if (inGeofence && status === 'at_restaurant' && !hasTask) {
    return { status: 'available' };
  }
  return null;
}

/**
 * Fail-closed hub guard. The server geofence uses the single hardcoded X. Pizza
 * hub, which is only correct while the platform is single-Restaurant. Today's
 * Orders carry no restaurant_id; an explicit `x_pizza` is also fine. Any OTHER
 * restaurant_id means the per-Order hub snapshot (ADR 0002) must exist first —
 * so refuse the geofence (and log) rather than stamp a wrong hub.
 */
function isHubResolvable(restaurantId) {
  return restaurantId == null || restaurantId === 'x_pizza';
}

/**
 * Filter + order a batch of location points from the native uploader's offline
 * queue. Accepts only points that are: well-formed (numeric ts + in-range coords),
 * strictly NEWER than the last device timestamp we persisted (so a delayed replay
 * can't regress the pin or re-fire geofence backwards), within a bounded age, and
 * not absurdly in the future (clock-skew guard). Returns the survivors sorted
 * ascending by ts — the caller runs the geofence forward over them and persists
 * the last (newest) one.
 *
 * `ts` is the plugin-recorded DEVICE time, tracked as `last_location_ts`,
 * separate from the server-received `last_ping`.
 */
/**
 * Normalize a timestamp to epoch milliseconds. Accepts an epoch-ms number
 * (Transistorsoft can be configured to send it) or an ISO-8601 string (its
 * default `timestamp`), returns null for anything unparseable.
 */
function coerceTs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function selectIngestPoints(points, { lastLocationTs = 0, now, maxAgeMs, maxFutureSkewMs } = {}) {
  if (!Array.isArray(points)) return [];
  return points
    .filter((p) => {
      if (!p || !Number.isFinite(p.ts)) return false;
      if (typeof p.lat !== 'number' || p.lat < -90 || p.lat > 90) return false;
      if (typeof p.lng !== 'number' || p.lng < -180 || p.lng > 180) return false;
      if (p.ts <= lastLocationTs) return false;        // stale / already seen / out-of-order
      if (p.ts < now - maxAgeMs) return false;         // beyond bounded age
      if (p.ts > now + maxFutureSkewMs) return false;  // absurd future (clock skew)
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}

/**
 * One-way hash of an opaque ingest token. Tokens are stored at
 * /driver_tokens/{hash}, so a DB read leak yields no usable bearer. Deterministic
 * so the endpoint can look up the presented token by its hash.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Validate a looked-up opaque ingest-token record for this request: it must be
 * known, not revoked, not expired, and bound to the driver's CURRENT shift (so a
 * token from a previous shift can't post after a re-clock-in). Returns
 * { ok:true, uid } or { ok:false, reason }.
 */
function validateIngestToken(record, { now, currentShiftId } = {}) {
  if (!record) return { ok: false, reason: 'unknown_token' };
  if (record.revoked_at) return { ok: false, reason: 'revoked' };
  if (record.expires_at && now > record.expires_at) return { ok: false, reason: 'expired' };
  if (currentShiftId != null && record.shift_id !== currentShiftId) {
    return { ok: false, reason: 'shift_mismatch' };
  }
  return { ok: true, uid: record.uid };
}

module.exports = {
  haversineMeters,
  geofenceTransition,
  isHubResolvable,
  selectIngestPoints,
  hashToken,
  validateIngestToken,
  coerceTs
};
