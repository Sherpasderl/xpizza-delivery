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
} = require('./driver-ingest');
// brand-agnostic server X1: hubs come from each restaurant's identity — here the SEEDED identities, preloaded as the `hubs` map
const { IDENTITIES } = require('./seed_identity');
const X_PIZZA_HUB = { lat: IDENTITIES.x_pizza.hub_lat, lng: IDENTITIES.x_pizza.hub_lng };
const LA_MUSA_HUB = { lat: IDENTITIES.la_musa.hub_lat, lng: IDENTITIES.la_musa.hub_lng };
const HUBS = { x_pizza: X_PIZZA_HUB, la_musa: LA_MUSA_HUB };

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

// ---- isHubResolvable(restaurantId, hubLat, hubLng, hubs) ----  S1 E4 + brand-agnostic X1 (r0 §2.2): fail-closed
// A driver's hub snapshot is trusted ONLY when its restaurant_id is non-null, that restaurant resolves to a hub in the
// preloaded `hubs` (from its identity — no static table) AND the coords match. A null restaurant_id is NEVER resolvable.
{
  assert.strictEqual(isHubResolvable('x_pizza', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng, HUBS), true, 'x_pizza + matching coords → ok');
  assert.strictEqual(isHubResolvable('la_musa', LA_MUSA_HUB.lat, LA_MUSA_HUB.lng, HUBS), true, 'la_musa + matching coords → ok');
  assert.strictEqual(isHubResolvable('tb_norte', 15.53, -88.01, { tb_norte: { lat: 15.53, lng: -88.01 } }), true, 'a third brand resolves from its identity alone');
  assert.strictEqual(isHubResolvable('la_musa', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng, HUBS), false, 'la_musa + mismatched (x_pizza) coords → fail-closed');
  assert.strictEqual(isHubResolvable('x_pizza', undefined, undefined, HUBS), false, 'known rid + absent coords → fail-closed (coords required)');
  assert.strictEqual(isHubResolvable('unknown_rid', 15.5, -88.0, HUBS), false, 'unknown restaurant_id → fail-closed');
  assert.strictEqual(isHubResolvable('x_pizza', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng, {}), false, 'a restaurant missing from hubs (hub-less / failed read) → fail-closed');
  assert.strictEqual(isHubResolvable('x_pizza', X_PIZZA_HUB.lat, X_PIZZA_HUB.lng, undefined), false, 'no hubs at all → fail-closed');
  for (const [lat, lng] of [[undefined, undefined], [X_PIZZA_HUB.lat, X_PIZZA_HUB.lng], [15.6, -88.1]]) {
    assert.strictEqual(isHubResolvable(null, lat, lng, HUBS), false, `a null restaurant_id is never resolvable (coords ${lat})`);
    assert.strictEqual(isHubResolvable(undefined, lat, lng, HUBS), false, 'nor an undefined one');
  }
  ok('hub guard: identity hub + coords-match; mismatched / unknown / hub-less / null rid → fail-closed (no x_pizza special case)');
}

// ---- ingestHubRid / ingestHubFor (brand-agnostic r3 §D) — the ingest geofence's hub ----
//   current_restaurant_id non-null → it (snapshot coords, versioned exactly as today);
//   null AND no task → return_restaurant_id (that restaurant's own hub);  otherwise → null (no geofence; never x_pizza)
{
  const snapX = { current_restaurant_id: 'x_pizza', current_hub_lat: X_PIZZA_HUB.lat, current_hub_lng: X_PIZZA_HUB.lng, current_task_id: 't1', current_hub_task_id: 't1' };
  assert.strictEqual(ingestHubRid(snapX), 'x_pizza');
  assert.deepStrictEqual(ingestHubFor(snapX, HUBS), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }, 'a live snapshot → its coords');
  assert.strictEqual(ingestHubFor({ ...snapX, current_hub_task_id: 'old' }, HUBS), null, 'a versioned-but-stale snapshot → fail-closed (as today)');
  assert.deepStrictEqual(ingestHubFor({ ...snapX, current_hub_task_id: null }, HUBS), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }, 'an unversioned snapshot stays lenient (as today)');
  assert.strictEqual(ingestHubFor({ ...snapX, current_hub_lat: null, current_hub_lng: null }, HUBS), null, 'a snapshot with absent coords → no geofence');
  assert.strictEqual(ingestHubFor({ ...snapX, current_restaurant_id: 'la_musa' }, HUBS), null, 'a rid / coords mismatch → no geofence');
  const ret = (r, task = null) => ({ current_restaurant_id: null, current_hub_lat: null, current_hub_lng: null, current_task_id: task, current_hub_task_id: null, return_restaurant_id: r });
  assert.strictEqual(ingestHubRid(ret('la_musa')), 'la_musa', 'an idle cleared driver’s hub rid is return_restaurant_id');
  assert.deepStrictEqual(ingestHubFor(ret('la_musa'), HUBS), { hubLat: LA_MUSA_HUB.lat, hubLng: LA_MUSA_HUB.lng }, 'a returning La Musa driver geofences at La Musa');
  assert.deepStrictEqual(ingestHubFor(ret('x_pizza'), HUBS), { hubLat: X_PIZZA_HUB.lat, hubLng: X_PIZZA_HUB.lng }, 'a returning X. Pizza driver at X. Pizza (as before)');
  assert.strictEqual(ingestHubRid(ret(undefined)), null); assert.strictEqual(ingestHubFor(ret(undefined), HUBS), null, 'no history → no geofence (never x_pizza)');
  assert.strictEqual(ingestHubRid(ret('la_musa', 't9')), null, 'a cleared snapshot WITH a task → null (the return base is for an idle driver only)');
  assert.strictEqual(ingestHubFor(ret('la_musa'), {}), null, 'the return restaurant without a hub → no geofence');
  assert.strictEqual(ingestHubFor({ ...ret(undefined), current_hub_lat: X_PIZZA_HUB.lat, current_hub_lng: X_PIZZA_HUB.lng }, HUBS), null, 'null-rid coords never map to x_pizza');
  ok('ingest hub: live snapshot (versioned as today) | idle → return_restaurant_id’s own hub | otherwise none — a null rid never maps to x_pizza');
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

  // delivery, snapshot coords already correct → 'restamp' (advance version to the live delivery task,
  // coords unchanged) so the geofence version-guard stays open through pickup→delivery (exit-backstop)
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, lmSnap), { action: 'restamp' }, 'la_musa delivery + correct hub → restamp version');
  assert.deepStrictEqual(resolveHubFromTask('dx', TASKS, xpSnap), { action: 'restamp' }, 'x_pizza delivery + correct hub → restamp version');

  // ★ delivery, snapshot ABSENT/STALE (pickup write lagged or failed) → BACKFILL from the linked pickup
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, nullSnap),
    { action: 'backfill', hub: { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa' } },
    'la_musa delivery + absent hub → backfill La Musa (fixes the lagged-pickup la_musa bug)');
  assert.deepStrictEqual(resolveHubFromTask('dl', TASKS, xpSnap),
    { action: 'backfill', hub: { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa' } },
    'la_musa delivery + STALE x_pizza hub → backfill La Musa');
  ok('resolveHubFromTask: set / no-op / backfill / clear');
}

// ---- syncDriverHubUpdate(eventAfterTaskId, freshCurrentTaskId, allTasks, existingHub) ----
// The syncDriverHub trigger's pure decision path (S1 E3). Wraps resolveHubFromTask with the
// idempotent recheck: if the live current_task_id no longer equals the event's after-value (a newer
// out-of-order event already advanced it), DO NOT WRITE — return null. Otherwise map the action to
// the driver-record update (or null for no-op). The trigger's only remaining work is the I/O.
{
  const PL = { type: 'pickup', destination_lat: LA_MUSA_HUB.lat, destination_lng: LA_MUSA_HUB.lng, restaurant_id: 'la_musa', linked_task_id: 'dl' };
  const DL = { type: 'delivery', linked_task_id: 'pl' };
  const TASKS = { pl: PL, dl: DL };
  const nullSnap = { current_restaurant_id: null, current_hub_lat: null, current_hub_lng: null };
  const lmSnap = { current_restaurant_id: 'la_musa', current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng };

  // ★ OUT-OF-ORDER: a slow pickup event fires AFTER current_task_id already advanced to the delivery
  // (or to null) → the recheck sees the divergence → NO write (returns null). The #1 race hazard.
  assert.strictEqual(syncDriverHubUpdate('pl', 'dl', TASKS, nullSnap), null,
    'out-of-order: stale pickup event after current_task_id moved on → no write');
  assert.strictEqual(syncDriverHubUpdate('pl', null, TASKS, nullSnap), null,
    'out-of-order: stale pickup event after current_task_id cleared → no write');

  // in-order: pickup event still current → set hub + version-stamp to the pickup task
  assert.deepStrictEqual(syncDriverHubUpdate('pl', 'pl', TASKS, nullSnap),
    { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa', current_hub_task_id: 'pl' },
    'in-order pickup → set hub + version=pl');
  // in-order: delivery still current + correct coords → RESTAMP the version to the delivery task
  // (4th-rev fix: keeps current_hub_task_id === current_task_id through delivery, not a no-op)
  assert.deepStrictEqual(syncDriverHubUpdate('dl', 'dl', TASKS, lmSnap), { current_hub_task_id: 'dl' },
    'in-order delivery + correct hub → restamp version to dl (exit-backstop stays open)');
  // in-order: delivery still current + absent hub → backfill + version-stamp to the delivery task
  assert.deepStrictEqual(syncDriverHubUpdate('dl', 'dl', TASKS, nullSnap),
    { current_hub_lat: LA_MUSA_HUB.lat, current_hub_lng: LA_MUSA_HUB.lng, current_restaurant_id: 'la_musa', current_hub_task_id: 'dl' },
    'in-order delivery + absent hub → backfill + version=dl');
  // in-order: cleared → clear all four (incl. the version) + record the restaurant just served (brand-agnostic server r3 §A)
  assert.deepStrictEqual(syncDriverHubUpdate(null, null, TASKS, lmSnap),
    { current_hub_lat: null, current_hub_lng: null, current_restaurant_id: null, current_hub_task_id: null, return_restaurant_id: 'la_musa' }, 'in-order null → clear (incl version) + return copy');

  // ★ exit-backstop guard (4th-rev): simulate pickupComplete advancing current_task_id pickup→delivery.
  // The version must follow to the delivery task so the geofence guard (current_hub_task_id ===
  // current_task_id) stays OPEN through the delivery phase rather than fail-closing the backstop.
  const afterAccept = syncDriverHubUpdate('pl', 'pl', TASKS, nullSnap);                 // accept → version=pl
  assert.strictEqual(afterAccept.current_hub_task_id, 'pl', 'after accept: version tracks the pickup task');
  const hubAfterAccept = { current_restaurant_id: afterAccept.current_restaurant_id, current_hub_lat: afterAccept.current_hub_lat, current_hub_lng: afterAccept.current_hub_lng };
  const afterPickup = syncDriverHubUpdate('dl', 'dl', TASKS, hubAfterAccept);           // pickupComplete → current_task_id=delivery
  assert.strictEqual(afterPickup.current_hub_task_id, 'dl', 'after pickupComplete: version restamped to delivery → === current_task_id → version-guard stays open');

  ok('syncDriverHubUpdate: out-of-order no-write + versioned set/backfill/clear/restamp + exit-backstop tracking');
}

// ---- real-builder fidelity (finding #3) ----  feed ACTUAL builder pickup output into the resolver,
// not a hand-injected shape — this is the test that would have caught B's missing-restaurant_id gap.
{
  const { buildCreateOrderUpdates } = require('./create-order-build');
  const { buildMaterializeUpdates } = require('./materialize');
  const { COMBOS } = require('./deploy/combo-validation');

  // (a) cash builder — x_pizza, via the audited COMBOS input (guaranteed-valid real shape)
  const cu = buildCreateOrderUpdates({ ...COMBOS.cash_delivery.input, hubSnap: COMBOS.cash_delivery.snapshot });
  const cpk = cu['tasks/ORD1_pickup'];
  assert.strictEqual(cpk.restaurant_id, 'x_pizza', 'real cash builder stamps restaurant_id on the pickup task');
  assert.deepStrictEqual(resolveHubFromTask('ORD1_pickup', { ORD1_pickup: cpk }, {}),
    { action: 'set', hub: { current_hub_lat: cpk.destination_lat, current_hub_lng: cpk.destination_lng, current_restaurant_id: 'x_pizza' } },
    'real cash pickup task → resolver sets the builder hub + x_pizza');

  // (b) online builder — la_musa, via buildMaterializeUpdates (the path that was broken pre-C)
  const order = {
    order_type: 'delivery', payment_method: 'online', customer_name: 'A', customer_phone: '1',
    items_text: 'x', total: 100, lat: 15.6, lng: -88.1, address_detected: 'Somewhere, City',
    restaurant_id: 'la_musa', hub_lat: LA_MUSA_HUB.lat, hub_lng: LA_MUSA_HUB.lng, restaurant_name: 'La Musa', restaurant_phone: 'p',
  };
  const ou = buildMaterializeUpdates({ orderId: 'RB2', order, trackingToken: 'T2', now: 1,
    restaurant: { lat: X_PIZZA_HUB.lat, lng: X_PIZZA_HUB.lng, name: 'X Pizza', phone: 'p' } });
  const opk = ou['tasks/RB2_pickup'];
  assert.strictEqual(opk.restaurant_id, 'la_musa', 'real materialize builder stamps restaurant_id on the pickup task');
  const ores = resolveHubFromTask('RB2_pickup', { RB2_pickup: opk }, {});
  assert.deepStrictEqual(ores,
    { action: 'set', hub: { current_hub_lat: opk.destination_lat, current_hub_lng: opk.destination_lng, current_restaurant_id: 'la_musa' } },
    'real online la_musa pickup task → resolver sets the builder hub + la_musa');
  // and through the trigger core (versioned) — this is what was fail-closing pre-C
  assert.strictEqual(syncDriverHubUpdate('RB2_pickup', 'RB2_pickup', { RB2_pickup: opk }, {}).current_restaurant_id, 'la_musa',
    'real online la_musa pickup → syncDriverHubUpdate snapshots la_musa (resolves, no longer fail-closed)');
  ok('real-builder fidelity: cash + online pickup tasks flow restaurant_id through the resolver/trigger');
}

// ---- resolvePickupHub + driverHasSameHubAccepted (S2 same-hub stacking; brand-agnostic r3 §C) ----
// resolvePickupHub: the pickup's stamped coords must be present AND match its restaurant's identity hub (`hubs`, preloaded);
// absent coords, a null rid, an unknown / hub-less restaurant or a mismatch → null (no stack) for EVERY brand.
// driverHasSameHubAccepted resolves the NEW order's hub the same fail-closed way, so a malformed order can't be force-accepted.
{
  const XP = { lat: X_PIZZA_HUB.lat, lng: X_PIZZA_HUB.lng };
  const LM = { lat: LA_MUSA_HUB.lat, lng: LA_MUSA_HUB.lng };

  assert.deepStrictEqual(resolvePickupHub({ destination_lat: LM.lat, destination_lng: LM.lng, restaurant_id: 'la_musa' }, HUBS), LM, 'la_musa + matching coords → use');
  assert.deepStrictEqual(resolvePickupHub({ destination_lat: XP.lat, destination_lng: XP.lng, restaurant_id: 'x_pizza' }, HUBS), XP, 'x_pizza + matching coords → use');
  assert.deepStrictEqual(resolvePickupHub({ destination_lat: 15.53, destination_lng: -88.01, restaurant_id: 'tb_norte' }, { tb_norte: { lat: 15.53, lng: -88.01 } }), { lat: 15.53, lng: -88.01 }, 'a third brand from its identity alone');
  assert.strictEqual(resolvePickupHub({ restaurant_id: 'x_pizza' }, HUBS), null, 'x_pizza + no coords → no stack (r3 §C: absent coords → null for EVERY brand)');
  assert.strictEqual(resolvePickupHub({}, HUBS), null, 'null restaurant_id + no coords → null (never x_pizza)');
  assert.strictEqual(resolvePickupHub({ destination_lat: XP.lat, destination_lng: XP.lng }, HUBS), null, 'null restaurant_id + x_pizza coords → null (never x_pizza)');
  assert.strictEqual(resolvePickupHub({ restaurant_id: 'la_musa' }, HUBS), null, 'la_musa + no coords → fail-closed');
  assert.strictEqual(resolvePickupHub({ destination_lat: XP.lat, destination_lng: XP.lng, restaurant_id: 'la_musa' }, HUBS), null, 'la_musa stamped w/ x_pizza coords → fail-closed (coord/rid mismatch)');
  assert.strictEqual(resolvePickupHub({ destination_lat: LM.lat, destination_lng: LM.lng, restaurant_id: 'x_pizza' }, HUBS), null, 'x_pizza stamped w/ la_musa coords → fail-closed');
  assert.strictEqual(resolvePickupHub({ destination_lat: '15.5', destination_lng: '-88', restaurant_id: 'la_musa' }, HUBS), null, 'numeric-string coords → fail-closed');
  assert.strictEqual(resolvePickupHub({ destination_lat: 99, destination_lng: 99, restaurant_id: 'zzz' }, HUBS), null, 'unknown restaurant_id → fail-closed');
  assert.strictEqual(resolvePickupHub({ destination_lat: XP.lat, destination_lng: XP.lng, restaurant_id: 'x_pizza' }, {}), null, 'restaurant missing from the preloaded hubs → fail-closed');
  assert.strictEqual(resolvePickupHub(null, HUBS), null, 'no task → null');

  // driverHasSameHubAccepted(tasks, driverId, newOrderId, hubs) — d1 holds accepted o1 (pickup completed, #7); o2 is NEW.
  const mk = (o1Hub, o1Rid, o2Hub, o2Rid) => ({
    o1_pickup:   { order_id: 'o1', type: 'pickup', status: 'completed', assigned_driver_id: 'd1', ...(o1Hub ? { destination_lat: o1Hub.lat, destination_lng: o1Hub.lng } : {}), ...(o1Rid ? { restaurant_id: o1Rid } : {}) },
    o1_delivery: { order_id: 'o1', type: 'delivery', status: 'accepted', assigned_driver_id: 'd1' },
    o2_pickup:   { order_id: 'o2', type: 'pickup', status: 'pending', assigned_driver_id: null, ...(o2Hub ? { destination_lat: o2Hub.lat, destination_lng: o2Hub.lng } : {}), ...(o2Rid ? { restaurant_id: o2Rid } : {}) },
  });
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',XP,'x_pizza'), 'd1', 'o2', HUBS), true, 'accepted x_pizza (pickup completed) + new x_pizza → same-hub (#7)');
  assert.strictEqual(driverHasSameHubAccepted(mk(LM,'la_musa',LM,'la_musa'), 'd1', 'o2', HUBS), true, 'accepted la_musa + new la_musa → same-hub');
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',LM,'la_musa'), 'd1', 'o2', HUBS), false, 'accepted x_pizza + new la_musa → cross-hub');
  assert.strictEqual(driverHasSameHubAccepted(mk(LM,'la_musa',XP,'x_pizza'), 'd1', 'o2', HUBS), false, 'accepted la_musa + new x_pizza → cross-hub');
  assert.strictEqual(driverHasSameHubAccepted(mk(null,null,XP,'x_pizza'), 'd1', 'o2', HUBS), false, 'legacy accepted order with no hub / rid → no force-accept (r3 §C: never maps to x_pizza)');
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',null,'la_musa'), 'd1', 'o2', HUBS), false, 'malformed la_musa new order (no hub) + accepted x_pizza → NOT force-accepted');
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',XP,'la_musa'), 'd1', 'o2', HUBS), false, 'la_musa new order w/ x_pizza coords → NOT force-accepted (coord/rid mismatch)');
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',XP,'x_pizza'), 'd1', 'o2', { la_musa: LM }), false, 'a restaurant absent from the preloaded hubs (appeared after the preload) → no force-accept');
  assert.strictEqual(driverHasSameHubAccepted({ o2_pickup: { order_id: 'o2', type: 'pickup', status: 'assigned', assigned_driver_id: 'd1', destination_lat: XP.lat, destination_lng: XP.lng, restaurant_id: 'x_pizza' } }, 'd1', 'o2', HUBS), false, 'no accepted order → false');
  assert.strictEqual(driverHasSameHubAccepted(mk(XP,'x_pizza',XP,'x_pizza'), 'd1', 'o2', HUBS), true, 'TOCTOU pick-time: same-hub true');
  assert.strictEqual(driverHasSameHubAccepted(mk(LM,'la_musa',XP,'x_pizza'), 'd1', 'o2', HUBS), false, 'TOCTOU recheck: accepted flipped to la_musa → fresh value false');
  ok('resolvePickupHub (identity hub + coords required) + driverHasSameHubAccepted (new-hub fail-closed): mismatch / cross-hub / absent coords / null rid / preload miss / TOCTOU');

  // sameHubRids — what reassertAssignable preloads before its final reads
  const pre = { ...mk(XP, 'x_pizza', LM, 'la_musa'), o3_pickup: { order_id: 'o3', type: 'pickup', status: 'completed', assigned_driver_id: 'd1', restaurant_id: 'tb_norte' },
    o3_delivery: { order_id: 'o3', type: 'delivery', status: 'in_progress', assigned_driver_id: 'd1' }, o4_pickup: { order_id: 'o4', type: 'pickup', status: 'accepted', assigned_driver_id: 'd2', restaurant_id: 'tb_otro' } };
  assert.deepStrictEqual(sameHubRids(pre, 'd1', 'o2'), ['la_musa', 'tb_norte', 'x_pizza'], 'the new order’s pickup + the driver’s accepted / in-progress pickups — not another driver’s');
  assert.deepStrictEqual(sameHubRids({}, 'd1', 'o2'), []);
  ok('sameHubRids: the restaurants a same-hub decision needs (new order + the driver’s accepted orders), from the preload');
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
