'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1.1) — driverFanout(db, uid, deps): recompute every order the driver currently holds
// (indexed `assigned_driver_id == uid`, rows with a non-terminal status — r2.10.1 B) ∪ every order with a non-tombstoned claims hint for uid (orders reassigned away, cancelled,
// or whose tasks were deleted). After each recompute, a hint for uid that is no longer the claim owner is tombstoned with that
// recompute's (newer) seq — stale hints cannot accumulate. The index is a hint only; decisions are the per-order recompute's.
const { recomputeOrderTracker } = require('./recompute');
const { tombstoneUpdater } = require('./claims-txn');

const TERMINAL_TASK = new Set(['completed', 'cancelled']);

async function driverOrderIds(db, uid) {
  const ids = new Set();
  const tasks = (await db.ref('tasks').orderByChild('assigned_driver_id').equalTo(uid).once('value')).val() || {};
  // (B, PLAN r2.10.1 §8.3) an order enters from the task index only if at least ONE of this driver's rows for it is non-terminal: an
  // order whose every row is terminal cannot become live / waiting for this driver from a driver-side change; its terminal edge is
  // published by the order-side triggers, and any public claim it still has is found through the live hint below. Bounds the
  // RECOMPUTES by the driver's live work, not by retention (the query still downloads retained rows — bytes are measured, §8.3).
  for (const t of Object.values(tasks)) if (t && t.order_id && !TERMINAL_TASK.has(t.status)) ids.add(t.order_id);
  const claims = (await db.ref(`tracker_claims/${uid}`).once('value')).val() || {};
  for (const [oid, c] of Object.entries(claims)) if (c && c.gone !== true) ids.add(oid);
  return [...ids].sort();
}

async function driverFanout(db, uid, deps = {}) {
  if (!uid) return [];
  const out = [];
  for (const oid of await driverOrderIds(db, uid)) {
    const r = await recomputeOrderTracker(db, oid, deps);
    if (r && r.committed && r.claimOwner !== uid) {
      await db.ref(`tracker_claims/${uid}/${oid}`).transaction((cur) => (cur === null ? null : (cur.gone !== true ? tombstoneUpdater(r.s, (deps.now || Date.now)())(cur) : undefined)));
    }
    out.push({ orderId: oid, ...r });
  }
  return out;
}
module.exports = { driverFanout, driverOrderIds };
