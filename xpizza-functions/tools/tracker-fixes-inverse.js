'use strict';
// TRACKER FIXES T8 (BUILD-tracker-fixes r1.5 §4) — the test-only INVERSE of this slice's index.js footprint: the flag-branched hunks
// (H1/H2 sendOrderStatusNotifications, H3 clearTrackerMirrorOnDone, H4 the fenced ingest + its holds, H5 the recompute trigger
// exports, H6 the requires). unapplyTrackerFixesIndex(index.js) === e8e77e24:index.js byte-for-byte (tracker-fixes-wiring.guard).
// Newest layer → applied INNERMOST in every index.js fold consumer: unapplyA1Index(unapplyTrackerFixesIndex(<source>)).
// Each hunk must occur EXACTLY once, else this throws. GENERATED from base (e8e77e24) vs candidate; JSON-quoted [now, was] pairs.

const INDEX_HUNKS = [
 [
  "const { activeDropOrderId, shouldMirror, shouldMarkStackedWaiting, stackedWaitingTxn } = require('./tracking-mirror');   // stacked-tracker: shouldMarkStackedWaiting (the OFD stacked-WAITING is_active_drop:false decision) + stackedWaitingTxn (its atomic no-downgrade write)\nconst { trackerFixesEnabled } = require('./tracking/flag');   // TRACKER FIXES (PLAN-tracker-fixes): the dark flag; OFF = today's code verbatim\nconst { recomputeOrderTracker } = require('./tracking/recompute');\nconst { driverFanout } = require('./tracking/fanout');\nconst { makeIngestUpdater, sampleInWindow } = require('./tracking/ingest-txn');\nconst { tagOf } = require('./tracking/tag');\nconst { trackerHold } = require('./tracking/hold');   // TRACKER FIXES: test-only hold seam (inert unless a test installs it)\nconst { sweepDecision, activeOrderCount, assignmentStrandState, HEAL_TERMINAL_STATUSES } = require('./sweep-pending');\n",
  "const { activeDropOrderId, shouldMirror, shouldMarkStackedWaiting, stackedWaitingTxn } = require('./tracking-mirror');   // stacked-tracker: shouldMarkStackedWaiting (the OFD stacked-WAITING is_active_drop:false decision) + stackedWaitingTxn (its atomic no-downgrade write)\nconst { sweepDecision, activeOrderCount, assignmentStrandState, HEAL_TERMINAL_STATUSES } = require('./sweep-pending');\n"
 ],
 [
  "  // auto-upgrades to the map when this driver becomes its active drop).\n  const tf = await trackerFixesEnabled(db);   // TRACKER FIXES H4: ONE flag decision for this request\n  if (tf) {\n    // ON: live location ONLY, fenced at commit by mode / owner / the AUTHENTICATED shift / epoch / status / watermark (P§2)\n    try {\n      await trackerHold('ingest:auth', { uid, shift_id: tokenRec.shift_id });   // test seam (inert in production)\n      const oid = activeDropOrderId(driver.current_task_id);\n      const nowMs = Date.now();\n      if (oid && Number.isFinite(final.lat) && Number.isFinite(final.lng) && Number.isFinite(final.ts) && sampleInWindow(final.ts, nowMs)) {\n        const ord = (await db.ref(`orders/${oid}`).once('value')).val() || {};\n        const token = ord.tracking_token;\n        if (token) {\n          const node = (await db.ref(`order_tracking/${token}`).once('value')).val();\n          const mx = node && node.mx;\n          await trackerHold('ingest:epoch', { uid, orderId: oid, epoch: mx && mx.epoch });\n          if (mx && shouldMirror(node.driver_location || null, { lat: final.lat, lng: final.lng }, nowMs, { throttleMs: 12000, minMoveMeters: 40 })) {\n            await trackerHold('ingest:commit', { uid, orderId: oid, epoch: mx.epoch });\n            await db.ref(`order_tracking/${token}`).transaction(makeIngestUpdater({\n              uidTag: tagOf(process.env.MAKE_SECRET, uid), shiftId: tokenRec.shift_id, epoch: mx.epoch,\n              sample: { lat: final.lat, lng: final.lng, measured_at: final.ts },\n              dest: { lat: ord.lat, lng: ord.lng },\n            }));\n          }\n        }\n      }\n    } catch (e) { console.warn('ingestDriverLocation: tracker mirror (fenced) failed', e && e.message); }\n  } else try {\n    const oid = activeDropOrderId(driver.current_task_id);\n",
  "  // auto-upgrades to the map when this driver becomes its active drop).\n  try {\n    const oid = activeDropOrderId(driver.current_task_id);\n"
 ],
 [
  "    const after = event.data.after.val();\n    const db = getDatabase();\n    if (await trackerFixesEnabled(db)) {   // TRACKER FIXES H3: ON → recompute from CURRENT truth (+ the fan-out); throws → retry\n      if (before !== 'out_for_delivery' || after === 'out_for_delivery') return;\n      const r = await recomputeOrderTracker(db, event.params.orderId);\n      const ord = (await db.ref(`orders/${event.params.orderId}`).once('value')).val() || {};\n      for (const uid of new Set([r && r.owner, ord.delivered_by_driver_uid].filter(Boolean))) await driverFanout(db, uid);\n      return;\n    }\n    if (before !== 'out_for_delivery' || after === 'out_for_delivery') return;   // only the leaving edge\n    const orderId = event.params.orderId;\n    const token = (await db.ref(`orders/${orderId}/tracking_token`).once('value')).val();\n",
  "    const after = event.data.after.val();\n    if (before !== 'out_for_delivery' || after === 'out_for_delivery') return;   // only the leaving edge\n    const orderId = event.params.orderId;\n    const db = getDatabase();\n    const token = (await db.ref(`orders/${orderId}/tracking_token`).once('value')).val();\n"
 ],
 [
  "// Runs alongside clearTrackerMirrorOnDone on the same /status leaf (Firebase allows multiple triggers).\n// ── TRACKER FIXES H1b + H5 (PLAN-tracker-fixes §1.1): the order-side and driver-side recompute triggers. All retry:true; each\n// reads the flag ONCE and returns when OFF. Event payloads only pick WHOM to recompute; decisions are current truth (recompute).\nexports.trackerOnOrderStatus = onValueWritten(\n  { ref: '/orders/{orderId}/status', region: 'us-central1', retry: true },\n  async (event) => {\n    const db = getDatabase();\n    if (!(await trackerFixesEnabled(db))) return;\n    const r = await recomputeOrderTracker(db, event.params.orderId);\n    if (r && r.owner) await driverFanout(db, r.owner);\n  }\n);\nasync function trackerOnTask(event) {\n  const db = getDatabase();\n  if (!(await trackerFixesEnabled(db))) return;\n  const taskId = event.params.taskId;\n  const m = /^(.+)_(pickup|delivery)$/.exec(taskId);\n  if (!m) return;\n  const orderId = m[1];\n  await recomputeOrderTracker(db, orderId);\n  const owners = new Set();\n  const b = event.data.before.val(), a = event.data.after.val();\n  for (const v of [b, a]) if (typeof v === 'string' && v) owners.add(v);\n  const t = (await db.ref(`tasks/${orderId}_delivery/assigned_driver_id`).once('value')).val();\n  if (t) owners.add(t);\n  for (const uid of owners) await driverFanout(db, uid);\n}\nexports.trackerOnTaskOwner = onValueWritten({ ref: '/tasks/{taskId}/assigned_driver_id', region: 'us-central1', retry: true }, trackerOnTask);\nexports.trackerOnTaskStatus = onValueWritten({ ref: '/tasks/{taskId}/status', region: 'us-central1', retry: true }, async (event) => {\n  const db = getDatabase();\n  if (!(await trackerFixesEnabled(db))) return;\n  const m = /^(.+)_(pickup|delivery)$/.exec(event.params.taskId);\n  if (!m) return;\n  await recomputeOrderTracker(db, m[1]);\n  const owner = (await db.ref(`tasks/${event.params.taskId}/assigned_driver_id`).once('value')).val();\n  if (owner) await driverFanout(db, owner);\n});\nasync function trackerOnDriver(event) {\n  const db = getDatabase();\n  if (!(await trackerFixesEnabled(db))) return;\n  await driverFanout(db, event.params.uid);\n}\nexports.trackerOnDriverPointer = onValueWritten({ ref: '/drivers/{uid}/current_task_id', region: 'us-central1', retry: true }, trackerOnDriver);\nexports.trackerOnDriverActive = onValueWritten({ ref: '/drivers/{uid}/active', region: 'us-central1', retry: true }, trackerOnDriver);\nexports.trackerOnDriverShiftId = onValueWritten({ ref: '/drivers/{uid}/current_shift_id', region: 'us-central1', retry: true }, trackerOnDriver);\n\nexports.deleteTasksOnOrderTerminal = onValueWritten(\n",
  "// Runs alongside clearTrackerMirrorOnDone on the same /status leaf (Firebase allows multiple triggers).\nexports.deleteTasksOnOrderTerminal = onValueWritten(\n"
 ],
 [
  "    const db = getDatabase();\n    const tf = await trackerFixesEnabled(db);   // TRACKER FIXES H1: ONE flag decision for this invocation (H1 + H2)\n\n",
  "    const db = getDatabase();\n\n"
 ],
 [
  "\n    if (!tf && trackingToken) {   // TRACKER FIXES H1: ON → the tracker is published by trackerOnOrderStatus (retry:true) instead\n      const trackingUpdates = { [`order_tracking/${trackingToken}/status`]: after };\n",
  "\n    if (trackingToken) {\n      const trackingUpdates = { [`order_tracking/${trackingToken}/status`]: after };\n"
 ],
 [
  "        // Mirror driver_name into the tracking record (for the public site)\n        if (!tf && driverName && trackingToken) {   // TRACKER FIXES H2: ON → the recompute is the single name writer (O3)\n          try {\n",
  "        // Mirror driver_name into the tracking record (for the public site)\n        if (driverName && trackingToken) {\n          try {\n"
 ]
];

function unapplyTrackerFixesIndex(src) {
  let out = src;
  for (const [now, was] of INDEX_HUNKS) {
    const n = out.split(now).length - 1;
    if (n !== 1) throw new Error(`tracker-fixes-inverse index.js: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(now.slice(0, 120))}`);
    out = out.replace(now, () => was);
  }
  return out;
}

module.exports = { unapplyTrackerFixesIndex, INDEX_HUNKS };
