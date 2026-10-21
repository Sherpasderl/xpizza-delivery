/**
 * Pure helpers for the native driver-location ingest path (Step 2b).
 *
 * No Firebase Admin / db / crypto-keyed side effects — unit-tested with plain
 * `node driver-ingest.test.js` (same idiom as driver-push.js / pixelpay-webhook.js).
 * The onRequest `ingestDriverLocation` endpoint composes these.
 */

const crypto = require('crypto');

const EARTH_RADIUS_M = 6371000;
// Coords are copied verbatim from the restaurant identity's hub into the order/task and then the driver
// snapshot, so an exact match is expected; a tiny epsilon (~0.11m) tolerates any float-representation
// noise while staying far below the gap between any two restaurant hubs (the closest pair is ~400m apart).
const HUB_MATCH_EPS = 1e-6;

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

/** True iff (lat,lng) are finite numbers within HUB_MATCH_EPS of `hub`. */
function coordsMatchHub(hub, lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && Math.abs(lat - hub.lat) < HUB_MATCH_EPS && Math.abs(lng - hub.lng) < HUB_MATCH_EPS;
}

/**
 * Fail-closed hub guard (S1 E4; BRAND-AGNOSTIC SERVER X1, PLAN r0 §2.2). A driver's hub snapshot is trusted ONLY when its
 * restaurant_id is non-null, that restaurant's identity resolves to a hub (`hubs[rid]`, preloaded by the caller from the
 * identity — no static table) AND the snapshot coords match it. A null restaurant_id is NEVER resolvable (it never maps to
 * any brand); an unknown rid, a hub-less identity, or mismatched / absent coords are refused (the caller skips the geofence).
 */
function isHubResolvable(restaurantId, hubLat, hubLng, hubs) {
  if (restaurantId == null) return false;
  const hub = hubs && hubs[restaurantId];
  if (!hub) return false;
  return coordsMatchHub(hub, hubLat, hubLng);
}

/**
 * BRAND-AGNOSTIC SERVER (PLAN r3 §D) — which restaurant's hub the ingest geofence uses: current_restaurant_id when non-null
 * (the task's snapshot, versioned exactly as today); when it is null and the driver has NO task → return_restaurant_id (the
 * restaurant they last served — a returning driver); otherwise null (no geofence — a null rid never maps to any brand).
 */
function ingestHubRid(driver) {
  const d = driver || {};
  if (d.current_restaurant_id != null) return d.current_restaurant_id;
  if (!d.current_task_id && typeof d.return_restaurant_id === 'string') return d.return_restaurant_id;
  return null;
}

/**
 * The ingest geofence hub → { hubLat, hubLng } | null, given `hubs` (the caller's peek of ingestHubRid's restaurant). The
 * version stamp gates both paths exactly as today (current_hub_task_id null — legacy / accept-lag leniency — or ===
 * current_task_id). The snapshot path then trusts the snapshot coords only when isHubResolvable (absent coords → null); the
 * return path uses the return restaurant's own identity hub. Pure.
 */
function ingestHubFor(driver, hubs) {
  const d = driver || {};
  const rid = ingestHubRid(d);
  if (rid == null) return null;
  // the S1 version stamp gates BOTH paths, exactly as today (a versioned-but-stale snapshot self-detects and fail-closes)
  const versionCurrent = d.current_hub_task_id == null || d.current_hub_task_id === d.current_task_id;
  if (!versionCurrent) return null;
  if (d.current_restaurant_id != null) {
    return isHubResolvable(rid, d.current_hub_lat, d.current_hub_lng, hubs) ? { hubLat: d.current_hub_lat, hubLng: d.current_hub_lng } : null;
  }
  const hub = hubs && hubs[rid];
  return hub ? { hubLat: hub.lat, hubLng: hub.lng } : null;
}

/**
 * BRAND-AGNOSTIC SERVER (PLAN r3 §A) — the return-base invariant. Any update that leaves `current_restaurant_id` null while
 * the driver's prior value was non-null ALSO records that prior value as `return_restaurant_id`, in the same update — so a
 * returning driver geofences at the restaurant they last served. A null prior writes nothing, so the history survives empty,
 * duplicate and repeated clears. `prefix` is the multi-path prefix (`drivers/${uid}/`) for the shift callables. Pure.
 */
function withReturnCopy(update, existingRid, prefix = '') {
  if (!update || typeof update !== 'object') return update;
  const key = `${prefix}current_restaurant_id`;
  if (!Object.prototype.hasOwnProperty.call(update, key) || update[key] != null || existingRid == null) return update;
  return { ...update, [`${prefix}return_restaurant_id`]: existingRid };
}

/** The current_hub snapshot fields for a pickup task's stamped hub. */
function hubFromPickupTask(t) {
  return { current_hub_lat: t.destination_lat, current_hub_lng: t.destination_lng, current_restaurant_id: t.restaurant_id || null };
}

/**
 * Pure core of the `syncDriverHub` trigger (S1 E3). Given the driver's NEW current_task_id, the task
 * map, and the driver's existing hub snapshot, decide the hub action:
 *   - null / unknown task          → 'clear'   (returning: the ingest geofences at return_restaurant_id — r3 §A)
 *   - pickup task                  → 'set'     (the pickup-approach hub)
 *   - delivery task, hub correct   → 'noop'    (preserve → keeps the at_restaurant→en_route exit-backstop)
 *   - delivery task, hub stale/absent → 'backfill' from the linked pickup (self-heals a lagged/failed
 *     pickup write so a delivery never runs on another restaurant's hub)
 * The trigger wraps this with an idempotent re-read of current_task_id before writing (the residual
 * out-of-order guard); this function makes no I/O and is unit-tested in isolation.
 */
function resolveHubFromTask(afterTaskId, allTasks, existingHub) {
  if (afterTaskId == null) return { action: 'clear' };
  const task = allTasks && allTasks[afterTaskId];
  if (!task) return { action: 'clear' };                        // defensive: unknown task
  if (task.type === 'pickup') return { action: 'set', hub: hubFromPickupTask(task) };
  if (task.type === 'delivery') {
    const pickup = allTasks[task.linked_task_id];
    if (!pickup || pickup.type !== 'pickup') return { action: 'noop' };  // can't determine → leave as-is
    const expected = hubFromPickupTask(pickup);
    const eh = existingHub || {};
    const correct = eh.current_restaurant_id === expected.current_restaurant_id
      && coordsMatchHub({ lat: expected.current_hub_lat, lng: expected.current_hub_lng }, eh.current_hub_lat, eh.current_hub_lng);
    // Coords already correct → only the version must advance to the live (delivery) task so the
    // geofence's version-guard stays open through pickup→delivery (preserving the exit-backstop);
    // coords stale → backfill them too. Either way the version ends up === the live current_task_id.
    return correct ? { action: 'restamp' } : { action: 'backfill', hub: expected };
  }
  return { action: 'noop' };
}

/**
 * Decision core of the `syncDriverHub` trigger (S1 E3). `eventAfterTaskId` is the current_task_id
 * the write event carried; `freshCurrentTaskId` is a re-read of the LIVE value taken right before
 * deciding. Idempotent recheck (watch-point #1): if they differ, a newer out-of-order event has
 * already advanced current_task_id, so this stale event must NOT write — return null. Otherwise map
 * the resolveHubFromTask action to the driver-record update (or null for a no-op). Pure: the trigger
 * supplies the fresh read + the minimal task map + the existing hub, then applies the returned update.
 */
function syncDriverHubUpdate(eventAfterTaskId, freshCurrentTaskId, allTasks, existingHub) {
  // r3 §A: EVERY resulting update passes through the return copy — 'clear', and also 'set' / 'backfill' from a pickup with no
  // restaurant_id (hubFromPickupTask's `|| null`), which would otherwise null a known restaurant without recording it
  return withReturnCopy(hubUpdateFor(eventAfterTaskId, freshCurrentTaskId, allTasks, existingHub), (existingHub || {}).current_restaurant_id ?? null);
}
function hubUpdateFor(eventAfterTaskId, freshCurrentTaskId, allTasks, existingHub) {
  if (freshCurrentTaskId !== eventAfterTaskId) return null;   // diverged → a newer event handles it
  const r = resolveHubFromTask(eventAfterTaskId, allTasks, existingHub);
  if (r.action === 'noop') return null;
  if (r.action === 'clear') {
    return { current_hub_lat: null, current_hub_lng: null, current_restaurant_id: null, current_hub_task_id: null };
  }
  // 'restamp' — coords already correct (delivery phase), advance ONLY the version to the live task so
  // the geofence version-guard stays open through pickup→delivery.
  if (r.action === 'restamp') return { current_hub_task_id: eventAfterTaskId };
  // 'set' | 'backfill' — stamp current_hub_task_id = the active task this hub is valid for. The
  // geofence trusts the hub only while current_hub_task_id === the live current_task_id, so a
  // versioned-but-stale snapshot (the residual recheck window) self-detects and fail-closes.
  return { ...r.hub, current_hub_task_id: eventAfterTaskId };
}

/**
 * Resolve a pickup task's hub for the same-hub stacking decision (S2; BRAND-AGNOSTIC SERVER r3 §C). `hubs` is the caller's
 * preloaded map { rid → {lat,lng} | null } from each restaurant's identity (reassertAssignable reads it BEFORE its final
 * state reads, so this stays pure and synchronous). The pickup's stamped coords must be present AND match its restaurant's
 * hub; absent coords, a null rid, an unknown / hub-less restaurant or a mismatch → null (no stack), for EVERY brand alike.
 */
function resolvePickupHub(pk, hubs) {
  if (!pk) return null;
  const rid = pk.restaurant_id;
  if (rid == null) return null;
  const canon = hubs && hubs[rid];
  const lat = pk.destination_lat;
  const lng = pk.destination_lng;
  if (!canon || typeof lat !== 'number' || typeof lng !== 'number') return null;
  return coordsMatchHub(canon, lat, lng) ? { lat, lng } : null;
}

/**
 * Does the driver have an ACCEPTED (or in_progress) order whose hub matches the NEW order's? — the same-hub gate for stacking
 * force-accept (S2). Reads each accepted order's hub from its pickup task (`${order_id}_pickup`, which persists with the
 * stamped hub even after the pickup flips to completed). Uses the same coordsMatchHub/EPS as isHubResolvable so the geofence
 * and stacking gates agree. Pure: the caller passes a FRESH task map plus the preloaded `hubs`; an order whose restaurant is
 * missing from `hubs` (it appeared after the preload) resolves null → no force-accept (fail closed).
 */
function driverHasSameHubAccepted(tasks, driverId, newOrderId, hubs) {
  const all = tasks || {};
  // Resolve the NEW order's hub FAIL-CLOSED. Unresolvable new hub → no force-accept.
  const newHub = resolvePickupHub(all[`${newOrderId}_pickup`], hubs);
  if (!newHub) return false;
  const acceptedOrderIds = new Set();
  for (const t of Object.values(all)) {
    if (!t || t.assigned_driver_id !== driverId) continue;
    if ((t.status === 'accepted' || t.status === 'in_progress') && t.order_id) acceptedOrderIds.add(t.order_id);
  }
  for (const oid of acceptedOrderIds) {
    const hub = resolvePickupHub(all[`${oid}_pickup`], hubs);
    if (hub && coordsMatchHub(hub, newHub.lat, newHub.lng)) return true;
  }
  return false;
}

/**
 * The restaurant ids whose hubs a same-hub decision for (driverId, newOrderId) needs — the new order's pickup and the driver's
 * accepted / in-progress pickups, from a (possibly stale) PRELOAD task map. reassertAssignable reads these hubs before its
 * final reads. Pure.
 */
function sameHubRids(tasks, driverId, newOrderId) {
  const all = tasks || {};
  const rids = new Set();
  const add = (pk) => { if (pk && typeof pk.restaurant_id === 'string') rids.add(pk.restaurant_id); };
  add(all[`${newOrderId}_pickup`]);
  for (const t of Object.values(all)) {
    if (!t || t.assigned_driver_id !== driverId || !t.order_id) continue;
    if (t.status === 'accepted' || t.status === 'in_progress') add(all[`${t.order_id}_pickup`]);
  }
  return [...rids].sort();
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
  withReturnCopy,
  resolveHubFromTask,
  syncDriverHubUpdate,
  resolvePickupHub,
  driverHasSameHubAccepted,
  sameHubRids,
  ingestHubRid,
  ingestHubFor,
  selectIngestPoints,
  hashToken,
  validateIngestToken,
  coerceTs
};
