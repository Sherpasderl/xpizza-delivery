/**
 * Unit tests for the pure driver-location-ingest helpers (Step 2b).
 * Run: `node driver-ingest.test.js`.
 *
 * Covers the safety-critical, bug-prone logic Codex flagged: the geofence state
 * machine (ported server-side), offline-batch ordering/stale-rejection, and
 * ingest-token validation. The onRequest endpoint + db side effects stay thin.
 */
const assert = require('assert');
const {
  haversineMeters,
  geofenceTransition,
  isHubResolvable,
  resolveHubFromTask,
  selectIngestPoints,
  hashToken,
  validateIngestToken,
  coerceTs
} = require('./driver-ingest');
const { X_PIZZA_HUB, LA_MUSA_HUB } = require('./assign-hub');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const HUB = { lat: 15.5075, lng: -88.0398 };
const RADIUS = 50;
// A point ~1.1km away (0.01° ≈ 1.1km) — clearly outside the 50m geofence.
const FAR = { lat: HUB.lat + 0.01, lng: HUB.lng };

// ---- haversineMeters ----
{
  assert.strictEqual(haversineMeters(HUB.lat, HUB.lng, HUB.lat, HUB.lng), 0,
    'same point is 0m');
  ok('haversine: same point → 0');

  // 0.001° latitude ≈ 111.32m
  const d = haversineMeters(0, 0, 0.001, 0);
  assert.ok(Math.abs(d - 111.32) < 1, `~111m, got ${d.toFixed(2)}`);
  ok('haversine: 0.001° lat ≈ 111m');
}

// ---- geofenceTransition ----
// Faithful port of the client checkGeofenceTransition state machine:
//   returning + inGeofence            → at_restaurant (+arrived)
//   assigned + hasTask + inGeofence   → at_restaurant (+arrived)
//   at_restaurant + hasTask + EXIT    → en_route_delivery
//   at_restaurant + noTask + inGeofence → available
// Anything else → null (no transition).
{
  const inHub = (status, hasTask) =>
    geofenceTransition({ status, hasTask, hubLat: HUB.lat, hubLng: HUB.lng, lat: HUB.lat, lng: HUB.lng, radiusM: RADIUS });
  const atFar = (status, hasTask) =>
    geofenceTransition({ status, hasTask, hubLat: HUB.lat, hubLng: HUB.lng, lat: FAR.lat, lng: FAR.lng, radiusM: RADIUS });

  assert.deepStrictEqual(inHub('returning', false), { status: 'at_restaurant', arrivedAtRestaurant: true },
    'returning → arrives');
  ok('geofence: returning + inGeofence → at_restaurant (+arrived)');

  assert.deepStrictEqual(inHub('assigned', true), { status: 'at_restaurant', arrivedAtRestaurant: true },
    'assigned w/ task → arrives');
  ok('geofence: assigned + task + inGeofence → at_restaurant (+arrived)');

  assert.strictEqual(inHub('assigned', false), null,
    'assigned without a task → no transition');
  ok('geofence: assigned + no task + inGeofence → null');

  assert.deepStrictEqual(atFar('at_restaurant', true), { status: 'en_route_delivery' },
    'left the hub with a task → en route');
  ok('geofence: at_restaurant + task + exit → en_route_delivery');

  assert.deepStrictEqual(inHub('at_restaurant', false), { status: 'available' },
    'back at hub, no task → available');
  ok('geofence: at_restaurant + no task + inGeofence → available');

  assert.strictEqual(inHub('at_restaurant', true), null,
    'still in the hub with a task → no exit transition yet');
  ok('geofence: at_restaurant + task + still inGeofence → null');

  assert.strictEqual(atFar('en_route_delivery', true), null, 'en_route far → no rule');
  assert.strictEqual(inHub('available', false), null, 'available in hub → no rule');
  assert.strictEqual(inHub('off_shift', false), null, 'off_shift → no rule');
  ok('geofence: non-matching states → null');
}

// ---- isHubResolvable(restaurantId, hubLat, hubLng) ----  S1 E4: allowlist + coords-match, fail-closed
// A per-restaurant current_hub snapshot is trusted ONLY when its restaurant_id is in ALLOWED_HUBS
// AND its coords match that hub. Legacy/today (no restaurant_id) resolves as x_pizza only when coords
// are absent (pre-snapshot) or exactly the x_pizza hub. Any present-but-mismatched hub → fail-closed.
{
  // legacy single-hub
  assert.strictEqual(isHubResolvable(null), true, 'no restaurant_id + no coords (today) → ok');
  assert.strictEqual(isHubResolvable(undefined), true, 'undefined + no coords → ok');
  assert.strictEqual(isHubResolvable(null, X_PIZZA_HUB.lat, X_PIZZA_HUB.lng), true, 'legacy null + x_pizza coords → ok');
  assert.strictEqual(isHubResolvable(null, 15.6, -88.1), false, 'legacy null + non-x_pizza coords → fail-closed');
  // known restaurants WITH matching coords
  assert.strictEqual(isHubResolvable('x_pizza', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng), true, 'x_pizza + matching coords → ok');
  assert.strictEqual(isHubResolvable('la_musa', LA_MUSA_HUB.lat, LA_MUSA_HUB.lng), true, 'la_musa + matching coords → ok (now resolvable)');
  // fail-closed cases
  assert.strictEqual(isHubResolvable('la_musa', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng), false, 'la_musa + mismatched (x_pizza) coords → fail-closed');
  assert.strictEqual(isHubResolvable('x_pizza'), false, 'known rid + absent coords → fail-closed (coords required)');
  assert.strictEqual(isHubResolvable('unknown_rid', 15.5, -88.0), false, 'unknown restaurant_id → fail-closed');
  ok('hub guard: allowlist + coords-match; mismatched/unknown → fail-closed');
}

// ---- resolveHubFromTask(afterTaskId, allTasks, existingHub) ----  S1 E3: the syncDriverHub pure core
// Decides the driver's current_hub snapshot from the (new) current_task_id. pickup → set its hub;
// delivery → keep the linked-pickup hub (no-op if already correct, else BACKFILL a lagged/absent one);
// null/missing → clear. (The trigger wraps this with an idempotent current_task_id recheck.)
{
  const PX = { type: 'pickup', destination_lat: X_PIZZA_HUB.lat, destination_lng: X_PIZZA_HUB.lng, restaurant_id: 'x_pizza', linked_task_id: 'dx' };
  const DX = { type: 'delivery', linked_task_id: 'px' };
  const PL = { type: 'pickup', destination_lat: LA_MUSA_HUB.lat, destination_lng: LA_MUSA_HUB.lng, restaurant_id: 'la_musa', linked_task_id: 'dl' };
  const DL = { type: 'delivery', linked_task_id: 'pl' };
  const TASKS = { px: PX, dx: DX, pl: PL, dl: DL };
  const lmSnap = { current_restaurant_id: 'la_musa', current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng };
  const xpSnap = { current_restaurant_id: 'x_pizza', current_hub_lat: X_PIZZA_HUB.lat, current_hub_lng: X_PIZZA_HUB.lng };
  const nullSnap = { current_restaurant_id: null, current_hub_lat: null, current_hub_lng: null };

  // null / missing → clear
  assert.deepStrictEqual(resolveHubFromTask(null, TASKS, lmSnap), { action: 'clear' }, 'null task → clear');
  assert.deepStrictEqual(resolveHubFromTask('ghost', TASKS, lmSnap), { action: 'clear' }, 'missing task → clear (defensive)');

  // pickup → set its hub
  assert.deepStrictEqual(resolveHubFromTask('pl', TASKS, nullSnap),
    { action: 'set', hub: { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa' } },
    'la_musa pickup → set La Musa hub');
  assert.deepStrictEqual(resolveHubFromTask('px', TASKS, nullSnap),
    { action: 'set', hub: { current_hub_lat: X_PIZZA_HUB.lat, current_hub_lng: X_PIZZA_HUB.lng, current_restaurant_id: 'x_pizza' } },
    'x_pizza pickup → set X. Pizza hub');

  // delivery, snapshot already correct → no-op (preserves the exit-backstop, behaviour-identical)
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, lmSnap), { action: 'noop' }, 'la_musa delivery + correct hub → no-op');
  assert.deepStrictEqual(resolveHubFromTask('dx', TASKS, xpSnap), { action: 'noop' }, 'x_pizza delivery + correct hub → no-op');

  // ★ delivery, snapshot ABSENT/STALE (pickup write lagged or failed) → BACKFILL from the linked pickup
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, nullSnap),
    { action: 'backfill', hub: { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa' } },
    'la_musa delivery + absent hub → backfill La Musa (fixes the lagged-pickup la_musa bug)');
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, xpSnap),
    { action: 'backfill', hub: { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa' } },
    'la_musa delivery + STALE x_pizza hub → backfill La Musa');
  ok('resolveHubFromTask: set / no-op / backfill / clear');
}

// ---- selectIngestPoints ----
// Offline-queue replay safety: accept only points strictly newer than the last
// seen device timestamp, within a bounded age, not absurdly in the future, with
// valid coords — returned in ascending timestamp order so the geofence runs
// forward and the final point is the one persisted.
{
  const NOW = 1781200000000;
  const opts = { lastLocationTs: NOW - 60000, now: NOW, maxAgeMs: 5 * 60 * 1000, maxFutureSkewMs: 2 * 60 * 1000 };
  const P = (ts, lat = 15.5, lng = -88.0) => ({ ts, lat, lng });

  const fresh1 = P(NOW - 30000);
  const fresh2 = P(NOW - 10000);
  const stale = P(NOW - 90000);            // older than lastLocationTs → drop
  const equalLast = P(NOW - 60000);        // == lastLocationTs (not strictly newer) → drop
  const tooOld = P(NOW - 10 * 60 * 1000);  // beyond maxAge → drop
  const future = P(NOW + 5 * 60 * 1000);   // beyond skew → drop
  const badLat = P(NOW - 5000, 200, -88);  // invalid lat → drop
  const badLng = P(NOW - 4000, 15.5, 999); // invalid lng → drop

  // Input deliberately out of order; only fresh1/fresh2 should survive, sorted.
  const out = selectIngestPoints(
    [fresh2, stale, future, fresh1, tooOld, equalLast, badLat, badLng],
    opts
  );
  assert.deepStrictEqual(out.map((p) => p.ts), [NOW - 30000, NOW - 10000],
    'only fresh points, ascending order');
  ok('batch: drops stale/equal/too-old/future/invalid, sorts ascending');

  assert.deepStrictEqual(selectIngestPoints([], opts), [], 'empty in → empty out');
  ok('batch: empty input → empty');

  // No prior last_location_ts (first ever batch this shift) → accept all valid in-window.
  const firstBatch = selectIngestPoints([P(NOW - 20000), P(NOW - 40000)], { ...opts, lastLocationTs: 0 });
  assert.deepStrictEqual(firstBatch.map((p) => p.ts), [NOW - 40000, NOW - 20000],
    'first batch accepts all valid, ordered');
  ok('batch: lastLocationTs=0 accepts all valid in-window, ordered');

  // The persisted point is the last (newest accepted).
  assert.strictEqual(out[out.length - 1].ts, NOW - 10000, 'final = newest accepted');
  ok('batch: final point is the newest accepted');
}

// ---- hashToken ----
// Opaque tokens are stored HASHED, so a /driver_tokens DB read leak yields no
// usable bearer. Deterministic (same raw → same lookup key), one-way.
{
  assert.strictEqual(hashToken('abc'), hashToken('abc'), 'deterministic');
  assert.notStrictEqual(hashToken('abc'), hashToken('abd'), 'different inputs differ');
  assert.match(hashToken('abc'), /^[0-9a-f]{64}$/, 'sha-256 hex');
  assert.notStrictEqual(hashToken('abc'), 'abc', 'not the raw value');
  ok('hashToken: deterministic one-way sha-256 hex');
}

// ---- validateIngestToken ----
// Given the stored token record, decide if this ingest is allowed: known,
// not revoked, not expired, and bound to the driver's CURRENT shift.
{
  const NOW = 1781200000000;
  const good = { uid: 'u1', shift_id: 's1', device_id: 'd1', issued_at: NOW - 1000, expires_at: NOW + 3600000, revoked_at: null };

  assert.deepStrictEqual(
    validateIngestToken(good, { now: NOW, currentShiftId: 's1' }), { ok: true, uid: 'u1' },
    'valid + matching shift');
  ok('token: valid record + matching shift → ok with uid');

  assert.deepStrictEqual(
    validateIngestToken(null, { now: NOW, currentShiftId: 's1' }), { ok: false, reason: 'unknown_token' },
    'no record');
  ok('token: unknown → rejected');

  assert.deepStrictEqual(
    validateIngestToken({ ...good, revoked_at: NOW - 10 }, { now: NOW, currentShiftId: 's1' }),
    { ok: false, reason: 'revoked' }, 'revoked');
  ok('token: revoked → rejected');

  assert.deepStrictEqual(
    validateIngestToken({ ...good, expires_at: NOW - 1 }, { now: NOW, currentShiftId: 's1' }),
    { ok: false, reason: 'expired' }, 'expired');
  ok('token: expired → rejected');

  assert.deepStrictEqual(
    validateIngestToken(good, { now: NOW, currentShiftId: 's2' }),
    { ok: false, reason: 'shift_mismatch' }, 'shift changed (re-clocked-in)');
  ok('token: shift_id != current_shift_id → rejected');
}

// ---- coerceTs ----
// Transistorsoft posts location `timestamp` as an ISO-8601 string; clients/
// curl may send epoch-ms numbers. Normalize both to epoch ms (or null if junk).
{
  assert.strictEqual(coerceTs(1781200000000), 1781200000000, 'epoch ms passes through');
  assert.strictEqual(coerceTs('2026-06-11T17:50:26.000Z'), Date.parse('2026-06-11T17:50:26.000Z'),
    'ISO string → epoch ms');
  assert.strictEqual(coerceTs('not-a-date'), null, 'garbage string → null');
  assert.strictEqual(coerceTs(null), null, 'null → null');
  assert.strictEqual(coerceTs(undefined), null, 'undefined → null');
  assert.strictEqual(coerceTs(NaN), null, 'NaN → null');
  ok('coerceTs: epoch passthrough, ISO→ms, junk→null');
}

// selectIngestPoints must reject non-finite ts (NaN/Infinity), not just non-numbers.
{
  const out = selectIngestPoints(
    [{ ts: NaN, lat: 15.5, lng: -88 }, { ts: Infinity, lat: 15.5, lng: -88 }, { ts: 1000, lat: 15.5, lng: -88 }],
    { lastLocationTs: 0, now: 2000, maxAgeMs: 10000, maxFutureSkewMs: 5000 }
  );
  assert.deepStrictEqual(out.map((p) => p.ts), [1000], 'NaN/Infinity ts dropped');
  ok('batch: rejects non-finite ts');
}

console.log(`\n${pass} passed`);
