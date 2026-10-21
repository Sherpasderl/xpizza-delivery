'use strict';
// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 + r0 §5) — the test-only INVERSE of this slice's footprint in index.js and
// in the pinned materialize modules (materialize.js / pixelpay-confirm.js / resolve-manual.js — the r3 §E pre-snapshot hub
// fallback). index.js: the return-base copy in startDriverShift / endDriverShift (§A), the X1 hub accessor wiring (imports, the
// ingest hub + guarded transition, reassertAssignable's hub preload, pickEligibleDriver's required hub, RESTAURANT_LAT/LNG
// removed), the hub-less assign paths (§E) and the materialize hubFor deps.
//   unapplyBrandServerIndex(index.js)          === df4a1bdb:index.js byte-for-byte
//   unapplyBrandServerModule(file, file's src) === df4a1bdb:<file> byte-for-byte for every FILES entry (others pass through)
// (brand-server-wiring.guard proves both.) Newest layer → applied INNERMOST in every fold consumer.
// Each hunk must occur EXACTLY once, else this throws. GENERATED from base (df4a1bdb) vs candidate; JSON-quoted [now, was] pairs.

const INDEX_HUNKS = [
 [
   "  withReturnCopy,   // brand-agnostic server r3 §A — the shift callables' return-base copy\n  driverHasSameHubAccepted,\n  sameHubRids,      // brand-agnostic X1 r3 §D — the restaurants reassertAssignable preloads before its final reads\n  ingestHubRid,     // brand-agnostic X1 r3 §D — the ingest geofence's restaurant\n  ingestHubFor,\n",
   "  driverHasSameHubAccepted,\n"
 ],
 [
   "// RESTAURANT is retained ONLY as the materialize name/phone fallback for in-flight pre-3b pending\n// orders (see confirmDeps -> buildMaterializeUpdates); their hub comes from the order's own identity (hubFor, r3 §E). Live intake reads the config\n",
   "// RESTAURANT is retained ONLY as the materialize snapshot-fallback for in-flight pre-3b\n// pending orders (see confirmDeps -> buildMaterializeUpdates). Live intake reads the config\n"
 ],
 [
   "const { resolveAssignHub, hubForFresh, makeHubPeek } = require('./assign-hub');   // brand-agnostic X1: hubs from each restaurant's identity\nconst hubForPeek = makeHubPeek();   // X1 r3 §D: per-instance identity-hub cache for the high-frequency ingest geofence\n",
   "const { resolveAssignHub, X_PIZZA_HUB } = require('./assign-hub');\n"
 ],
 [
   "    restaurant: RESTAURANT,\n    hubFor: (rid) => hubForFresh(db, rid),   // brand-agnostic server r3 §E: a pre-snapshot order's hub = its own identity's\n    buildMaterializeUpdates,\n",
   "    restaurant: RESTAURANT,\n    buildMaterializeUpdates,\n"
 ],
 [
   "    restaurant: RESTAURANT,\n    hubFor: (rid) => hubForFresh(db, rid),   // brand-agnostic server r3 §E: a pre-snapshot order's hub = its own identity's\n    genToken: generateTrackingToken,\n",
   "    restaurant: RESTAURANT,\n    genToken: generateTrackingToken,\n"
 ],
 [
   "  // brand-agnostic server r3 §A: the clock-in clears current_restaurant_id below — record a non-null prior as the return base\n  const priorRid = (await db.ref(`drivers/${uid}/current_restaurant_id`).once('value')).val();\n",
   ""
 ],
 [
   "  const shiftOpen = withReturnCopy(updates, priorRid, `drivers/${uid}/`);   // r3 §A\n  await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(shiftOpen), { site: 'startDriverShift', target: uid });   // S1a §3 — rules-bound shift-open (new-shift transition requires the target eligible)\n",
   "  await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(updates), { site: 'startDriverShift', target: uid });   // S1a §3 — rules-bound shift-open (new-shift transition requires the target eligible)\n"
 ],
 [
   "  // brand-agnostic server r3 §A: current_restaurant_id read together with the token hash — the clock-out clears it below\n  const [hash, priorRid] = (await Promise.all([db.ref(`drivers/${uid}/ingest_token_hash`).once('value'), db.ref(`drivers/${uid}/current_restaurant_id`).once('value')])).map((sn) => sn.val());\n",
   "  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();\n"
 ],
 [
   "  await db.ref().update(withReturnCopy(updates, priorRid, `drivers/${uid}/`));   // r3 §A\n",
   "  await db.ref().update(updates);\n"
 ],
 [
   "  // brand-agnostic X1 (r3 §D): the hub comes from the restaurant's OWN identity (per-instance peek cache), AWAITED before the\n  // transition is computed. Restaurant: current_restaurant_id's snapshot (S1 E4: the coords must match that identity hub; the\n  // S1 version stamp — current_hub_task_id null or === current_task_id — gates it exactly as before), or an idle driver's\n  // return_restaurant_id (the restaurant they last served); otherwise none — a null rid never maps to any brand.\n  const ingestRid = ingestHubRid(driver);\n  await trackerHold('ingest:hub', { uid, rid: ingestRid });   // test seam (inert in production)\n  const ingestHub = ingestHubFor(driver, ingestRid == null ? {} : { [ingestRid]: await hubForPeek(db, ingestRid) });\n  const hubOk = !!ingestHub;\n  const hubLat = hubOk ? ingestHub.hubLat : null;\n  const hubLng = hubOk ? ingestHub.hubLng : null;\n",
   "  const hubLat = driver.current_hub_lat ?? RESTAURANT_LAT;\n  const hubLng = driver.current_hub_lng ?? RESTAURANT_LNG;\n  // S1 E4: resolvable iff the restaurant_id is allow-listed AND the coords match its pinned hub\n  // (a legacy null restaurant_id resolves as X. Pizza when the coords are the fallback). This is the\n  // atomic partner of the syncDriverHub trigger writing current_hub_*; passing the coords defends\n  // against a stale/corrupt snapshot.\n  // S1 version stamp: trust the hub only while it is stamped for the LIVE task\n  // (current_hub_task_id === current_task_id). A versioned-but-stale snapshot — the residual\n  // syncDriverHub recheck window — self-detects here and fail-closes. current_hub_task_id == null is\n  // the legacy / in-flight-at-deploy + sub-second accept-lag case (driver far from any hub) → lenient,\n  // preserving X. Pizza behaviour.\n  const hubVersionCurrent = driver.current_hub_task_id == null\n    || driver.current_hub_task_id === driver.current_task_id;\n  const hubOk = hubVersionCurrent && isHubResolvable(driver.current_restaurant_id, hubLat, hubLng);\n"
 ],
 [
   "    console.warn(`ingestDriverLocation: hub not resolvable for ${uid} (restaurant_id=${driver.current_restaurant_id}, hub rid=${ingestRid}) — geofence skipped`);\n",
   "    console.warn(`ingestDriverLocation: hub not resolvable for ${uid} (restaurant_id=${driver.current_restaurant_id}) — geofence skipped`);\n"
 ],
 [
   "  await db.ref().update(updates);\n  // brand-agnostic X1 (r3 §D): the geofence TRANSITION commits through a transaction that aborts unless the state the decision\n  // used still holds (task / shift / status / restaurant) — a hub lookup that waited cannot apply a stale transition. An abort\n  // drops only the transition; the location above went through as today.\n  if (status !== driver.status || arrived) {\n    const same = (a, b) => (a ?? null) === (b ?? null);\n    await db.ref(`drivers/${uid}`).transaction((cur) => {\n      if (cur === null) return null;   // the first local pass may see no cache — retried with the server value\n      if (!same(cur.current_task_id, driver.current_task_id) || !same(cur.current_shift_id, driver.current_shift_id)\n        || !same(cur.status, driver.status) || !same(cur.current_restaurant_id, driver.current_restaurant_id)) return undefined;   // moved on → abort\n      if (status !== driver.status) cur.status = status;\n      if (arrived) cur.arrived_at_restaurant_at = ServerValue.TIMESTAMP;\n      return cur;\n    }, undefined, false);\n  }\n",
   "  if (status !== driver.status) updates[`drivers/${uid}/status`] = status;\n  if (arrived) updates[`drivers/${uid}/arrived_at_restaurant_at`] = ServerValue.TIMESTAMP;\n  await db.ref().update(updates);\n"
 ],
 [
   "// - The hub an order is ranked FROM comes from the order's stamped snapshot, else its restaurant's\n//   identity (assign-hub.js resolveAssignHub — brand-agnostic X1; no per-brand constant).\n",
   "// - RESTAURANT_LAT/LNG: hardcoded for now. Could read from /config later if\n//   we ever support multiple stores.\n"
 ],
 [
   "const STALE_PING_MS = 90 * 1000;\n\n",
   "const STALE_PING_MS = 90 * 1000;\nconst RESTAURANT_LAT = X_PIZZA_HUB.lat;   // x_pizza hub (single source: assign-hub.js) — geofence + auto-assign fallback\nconst RESTAURANT_LNG = X_PIZZA_HUB.lng;\n\n"
 ],
 [
   "async function pickEligibleDriver(db, excludeDriverIds, hubLat, hubLng) {\n  // brand-agnostic X1: the hub is REQUIRED (no x_pizza default) — a caller without one has nothing to rank from\n  if (!Number.isFinite(hubLat) || !Number.isFinite(hubLng)) { console.error('pickEligibleDriver: no hub — refusing to rank'); return null; }\n  excludeDriverIds = excludeDriverIds || [];\n",
   "async function pickEligibleDriver(db, excludeDriverIds = [], hubLat = RESTAURANT_LAT, hubLng = RESTAURANT_LNG) {\n"
 ],
 [
   "// brand-agnostic X1 (r3 §E): an order with no hub (no stamped snapshot, no restaurant identity hub) is NEVER auto-assigned —\n// ONE keyed dispatcher alert per order, written set-if-absent (the sweep / monitor re-passes raise no duplicate). The order\n// stays in SIN ASIGNAR for the dispatcher.\nasync function alertHubUnresolved(db, orderId, order, site) {\n  try {\n    await db.ref(`dispatcher_alerts/hub_unresolved_${orderId}`).transaction((cur) => (cur == null\n      ? { type: 'hub_unresolved', order_id: orderId, restaurant_id: (order && order.restaurant_id) || null, created_at: Date.now() }\n      : undefined), undefined, false);\n  } catch (e) { console.error(`${site}: hub_unresolved alert failed for ${orderId}`, e && e.message); }\n}\n\nasync function reassertAssignable(db, driverId, newOrderId = null) {\n  // brand-agnostic X1 (r3 §D): the identity I/O happens BEFORE the final state reads — a PRELOAD of tasks (stale is fine) names\n  // the restaurants the same-hub decision needs, their hubs are read fresh, THEN the final reads below, then a synchronous\n  // decision. Nothing is awaited between the final read and the returned decision; a restaurant that appears only in the final\n  // read is missing from `hubs` → no force-accept (fail closed).\n  const preTasks = (await db.ref('tasks').once('value')).val() || {};\n  const hubRids = sameHubRids(preTasks, driverId, newOrderId);\n  await trackerHold('assign:hub', { driverId, newOrderId });   // test seam (inert in production)\n  const hubs = Object.fromEntries(await Promise.all(hubRids.map(async (rid) => [rid, await hubForFresh(db, rid)])));\n",
   "async function reassertAssignable(db, driverId, newOrderId = null) {\n"
 ],
 [
   "  const hasAcceptedSameHubOrder = driverHasSameHubAccepted(tasks, driverId, newOrderId, hubs);\n",
   "  const hasAcceptedSameHubOrder = driverHasSameHubAccepted(tasks, driverId, newOrderId);\n"
 ],
 [
   "    // C1 + brand-agnostic X1: assign against the order's restaurant hub (stamped snapshot, else its identity). No hub → never\n    // auto-assigned (one keyed alert; it stays in SIN ASIGNAR); a failed identity read → skipped now, the sweep retries.\n    const assignHub = await resolveAssignHub(db, orderNow);\n    if (assignHub.unresolved) {\n      console.warn(`autoAssign: ${orderId} has no resolvable hub (${assignHub.unresolved}) — not auto-assigned`);\n      if (assignHub.unresolved === 'no_hub') await alertHubUnresolved(db, orderId, orderNow, 'autoAssign');\n      return;\n    }\n    const { hubLat, hubLng } = assignHub;\n",
   "    const { hubLat, hubLng } = resolveAssignHub(orderNow);   // C1: assign against the order's restaurant hub\n"
 ],
 [
   "    // brand-agnostic X1 (r3 §E): a hub-less order reaches this monitor only through a MANUAL dispatcher assignment (it is never\n    // auto-assigned). The guard sits BEFORE BOTH branches: no reassign, no takeover release, no attempt write — the dispatcher's\n    // assignment is left untouched and the keyed hub_unresolved alert is set-if-absent. An order WITH a hub follows both\n    // branches exactly as before (the hub is resolved once, here).\n    const timeoutHub = await resolveAssignHub(db, orderForTimeout);\n    if (timeoutHub.unresolved) {\n      console.warn(`timeout-monitor: ${orderId} has no resolvable hub (${timeoutHub.unresolved}) — assignment left to the dispatcher`);\n      await alertHubUnresolved(db, orderId, orderForTimeout, 'timeout-monitor');\n      return;\n    }\n\n",
   ""
 ],
 [
   "    const { hubLat, hubLng } = timeoutHub;   // C1: reassign against the order's restaurant hub (resolved above)\n",
   "    const { hubLat, hubLng } = resolveAssignHub(orderForTimeout);   // C1: reassign against the order's restaurant hub\n"
 ],
 [
   "      // brand-agnostic X1 (r3 §E): no hub → skip (no claim, no retry state; the keyed alert is set-if-absent, so no re-alert);\n      // a failed identity read → skip this pass (retried next sweep, not alerted)\n      const sweepHub = await resolveAssignHub(db, order);\n      if (sweepHub.unresolved) { if (sweepHub.unresolved === 'no_hub') await alertHubUnresolved(db, orderId, order, 'sweepPending'); continue; }\n      const { hubLat, hubLng } = sweepHub;\n",
   "      const { hubLat, hubLng } = resolveAssignHub(order);\n"
 ]
];

const MODULE_HUNKS = {
  "materialize.js": [
   [
     "// BRAND-AGNOSTIC SERVER (PLAN-brand-agnostic-server r3 §E) — the `restaurant` a materialize caller passes in. A stamped order\n// (charge-time hub snapshot) gets the deps object unchanged, with no read — byte-identical to today. A PRE-SNAPSHOT order gets\n// ITS restaurant's identity hub via the injected deps.hubFor(rid) (never the x_pizza constant); unresolved → null coords, so\n// the task materializes hub-less and the order takes the hub_unresolved intake path. The only I/O is the injected hubFor.\nasync function materializeRestaurant(deps, order) {\n  const base = (deps && deps.restaurant) || {};\n  const o = order || {};\n  if (Number.isFinite(o.hub_lat) && Number.isFinite(o.hub_lng)) return base;\n  let hub = null;\n  try { hub = deps && typeof deps.hubFor === 'function' ? await deps.hubFor(o.restaurant_id || null) : null; } catch (_) { hub = null; }\n  return { ...base, lat: hub ? hub.lat : null, lng: hub ? hub.lng : null };\n}\n\nmodule.exports = { buildMaterializeUpdates, materializeRestaurant };\n",
     "module.exports = { buildMaterializeUpdates };\n"
   ]
  ],
  "pixelpay-confirm.js": [
   [
     "const { materializeRestaurant } = require('./materialize');   // brand-agnostic server r3 §E — the pre-snapshot hub fallback\n",
     ""
   ],
   [
     "  const { db, buildMaterializeUpdates } = deps;\n",
     "  const { db, restaurant, buildMaterializeUpdates } = deps;\n"
   ],
   [
     "  const restaurant = await materializeRestaurant(deps, order);   // brand-agnostic server r3 §E: a pre-snapshot order → its own identity hub\n",
     ""
   ]
  ],
  "resolve-manual.js": [
   [
     " *   restaurant,           // name/phone fallback for buildMaterializeUpdates (the hub of a pre-snapshot order comes from hubFor)\n *   hubFor(rid),          // brand-agnostic server r3 §E — the pre-snapshot order's restaurant identity hub\n",
     " *   restaurant,           // x_pizza hub fallback for buildMaterializeUpdates\n"
   ],
   [
     "const { materializeRestaurant } = require('./materialize');   // brand-agnostic server r3 §E — the pre-snapshot hub fallback\n",
     ""
   ],
   [
     "  const { db, buildMaterializeUpdates } = deps;\n",
     "  const { db, buildMaterializeUpdates, restaurant } = deps;\n"
   ],
   [
     "  const restaurant = await materializeRestaurant(deps, order);   // brand-agnostic server r3 §E: a pre-snapshot order → its own identity hub\n",
     ""
   ]
  ]
};
const FILES = Object.freeze(Object.keys(MODULE_HUNKS));

function unapply(label, hunks, src) {
  let out = src;
  for (const [now, was] of hunks) {
    const n = out.split(now).length - 1;
    if (n !== 1) throw new Error(`brand-server-inverse ${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(now.slice(0, 120))}`);
    out = out.replace(now, () => was);
  }
  return out;
}
const unapplyBrandServerIndex = (src) => unapply('index.js', INDEX_HUNKS, src);
const unapplyBrandServerModule = (file, src) => (MODULE_HUNKS[file] ? unapply(file, MODULE_HUNKS[file], src) : src);

module.exports = { unapplyBrandServerIndex, unapplyBrandServerModule, INDEX_HUNKS, MODULE_HUNKS, FILES };
