'use strict';
// STACKED-TRACKER — the test-only INVERSE of this slice's index.js footprint (the split-file fold pattern,
// as tools/addproduct-b-inverse.js / addproduct-inverse.js / d4c4-inverse.js). Proof (i):
// unapplyStackedTracker(index.js) === ebc8564:index.js byte-for-byte (stacked-tracker-wiring.guard.test.js).
// Proof (ii): the index.js guards that pin to an integration parent apply it FIRST (this slice landed on top
// of PB-2 @ ebc8564), then add-product B's inverse, then A's, then D4-c4's → e1aeb3f.
// The hunks: (1) the tracking-mirror require adding shouldMarkStackedWaiting + stackedWaitingTxn; (2) the
// sendOrderStatusNotifications out_for_delivery STACKED-WAITING is_active_drop:false block. Each hunk must
// occur EXACTLY once, else this throws (a moved, duplicated or edited hunk is never tolerated).
// GENERATED from the base (ebc8564) vs candidate index.js; JSON-quoted strings.

const INDEX_HUNKS = [
 [
  "const { activeDropOrderId, shouldMirror, shouldMarkStackedWaiting, stackedWaitingTxn } = require('./tracking-mirror');   // stacked-tracker: shouldMarkStackedWaiting (the OFD stacked-WAITING is_active_drop:false decision) + stackedWaitingTxn (its atomic no-downgrade write)",
  "const { activeDropOrderId, shouldMirror } = require('./tracking-mirror');"
 ],
 [
  "      // STACKED-WAITING tracker signal (finishes the tracker's is_active_drop===false branch): when an order\n      // flips to out_for_delivery while the driver is actively delivering a DIFFERENT order, mark THIS one\n      // is_active_drop:false so the tracker shows the gentle \"one quick stop first\" copy and suppresses the\n      // naive 12-min countdown (which would otherwise tick to ~1 min while the driver is at the other\n      // customer's door). The false→true upgrade happens automatically via the ingest mirror once this order\n      // becomes the driver's active drop (it only ever writes is_active_drop:true for activeDropOrderId).\n      // ⚠️ FAIL-SAFE: write false ONLY when a DIFFERENT order is CONFIRMED to be the driver's active\n      // out_for_delivery drop RIGHT NOW. A single/non-stacked order — or ANY uncertainty (no driver, no/stale\n      // current_task_id pointing at a now-delivered order, a pickup leg) — NEVER gets false; it falls to\n      // today's neutral branch (never worse than now, never a wrong \"1 parada antes\" on a normal delivery).\n      if (after === 'out_for_delivery') {\n        try {\n          const deliveryTaskId = order.delivery_task_id || `${orderId}_delivery`;\n          const driverId = ((await db.ref(`tasks/${deliveryTaskId}`).once('value')).val() || {}).assigned_driver_id;\n          if (driverId) {\n            const curTask = (await db.ref(`drivers/${driverId}/current_task_id`).once('value')).val();\n            const activeOrderId = activeDropOrderId(typeof curTask === 'string' ? curTask : null);\n            // Only read the OTHER order's status when the driver's active drop is a different, parseable order\n            // (avoids a wasted read on the common single-order case); the pure decision confirms the rest.\n            const activeStatus = (activeOrderId && activeOrderId !== orderId)\n              ? (await db.ref(`orders/${activeOrderId}/status`).once('value')).val()\n              : null;\n            if (shouldMarkStackedWaiting(orderId, curTask, activeStatus)) {\n              // ATOMIC conditional (not set): between our read above and this write, order #1 may finish and\n              // the ingest mirror may promote THIS order to is_active_drop:true. The transaction aborts on a\n              // current true → it can never downgrade a customer already on the live map; otherwise it writes\n              // false. (Txn failure stays inside the try/catch below → no write → fail-safe, unchanged.)\n              await db.ref(`order_tracking/${trackingToken}/is_active_drop`).transaction(stackedWaitingTxn);\n            }\n          }\n        } catch (e) {\n          console.warn(`stackedWaitingSignal: ${orderId} skipped (fail-safe — no is_active_drop:false written)`, e.message);\n        }\n      }\n",
  ""
 ],
];

function apply(src, hunks, label) {
  let out = src;
  for (const [cand, base] of hunks) {
    const n = out.split(cand).length - 1;
    if (n !== 1) throw new Error(`${label}: a hunk occurs ${n}× (expected exactly once): ${JSON.stringify(cand.slice(0, 120))}`);
    out = out.replace(cand, () => base);
  }
  return out;
}
const unapplyStackedTracker = (indexSrc) => apply(indexSrc, INDEX_HUNKS, 'stacked-tracker-inverse index.js');

module.exports = { unapplyStackedTracker, INDEX_HUNKS };
