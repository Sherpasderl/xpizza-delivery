'use strict';
// H1a amendment A-R1 — the two hooks index.js calls from EXISTING functions (one-line hunks, reversed by tools/h1-inverse):
//   heldByReject(order)            autoAssignOnOrderCreate, the sweepPendingOrders offer pass (+ its fresh re-check) and
//                                  monitorAssignmentTimeout's first-strike reassign skip an order a handheld rejected or
//                                  that a cancel currently claims. Manual assignment is untouched.
//   holdAfterClaim(db, oid, isGone) codex r1 P1-2: autoAssignOnOrderCreate and monitorAssignmentTimeout's reassign re-read the
//                                  order AFTER their delivery claim and BEFORE finalize (mirroring the sweeper's fresh re-check).
//                                  → 'gone' (absent / isGone(order) / unreadable — fail closed), 'held' (heldByReject), or null.
//   releaseHeld(db, oid, driverId)   codex r2 P1: the timeout reassign's HELD release. Like index.js releaseToSinAsignar, but each
//                                  task is released in its OWN transaction that writes pending ONLY while the task is not
//                                  cancelled / completed at write time — a cancel finishing in the overlap is never revived.
//   safeRejectRepair(db, orders, now)  the stuck-orders sweep runs it AFTER its own loop, on the snapshot it already read. It NEVER
//                                  throws, so the existing sweep's loop, thresholds and markers are unaffected.
const { heldByReject } = require('./merchant-gate');
const { repairRejects } = require('./merchant-reject-repair');
const { releaseDeliveryFromDriver } = require('../claim-delivery');

async function holdAfterClaim(db, oid, isGone) {
  let order;
  // codex r2 P2: an UNREADABLE order is not a gone one — finalize as before H1a (non-handheld parity), logged. Only a confirmed
  // absent / isGone order rolls back.
  try { order = (await db.ref(`orders/${oid}`).once('value')).val(); } catch (e) { console.error(`holdAfterClaim: ${oid} unreadable — finalizing as before`, e && e.message); return null; }
  if (!order || isGone(order)) return 'gone';
  return heldByReject(order) ? 'held' : null;
}

const TASK_DONE = new Set(['cancelled', 'completed']);
async function releaseHeld(db, oid, driverId) {
  await db.ref(`tasks/${oid}_delivery/half_claim_since`).set(null);
  const { released } = await releaseDeliveryFromDriver(db, oid, driverId);
  if (!released) return false;                       // not ours (already null / re-owned) — leave it, no alert
  for (const type of ['pickup', 'delivery']) {
    await db.ref(`tasks/${oid}_${type}`).transaction((t) => {
      if (t === null) return null;                    // null-first safe; never invents a task
      if (!t || typeof t !== 'object' || TASK_DONE.has(t.status)) return undefined;   // terminal at write time → keep it
      const next = { ...t, assigned_driver_id: null, status: 'pending', assignment_deadline: null };
      if (type === 'delivery') next.half_claim_since = null;
      return next;
    });
  }
  return true;
}

async function safeRejectRepair(db, orders, nowMs) {
  try {
    const stats = await repairRejects({ db, clock: () => Date.now() }, orders, nowMs);
    if (stats.selected || stats.pruned) console.log('rejectRepair', JSON.stringify(stats));
    return stats;
  } catch (e) {
    console.error('rejectRepair: pass failed', e && e.message);
    return null;
  }
}

module.exports = { heldByReject, holdAfterClaim, releaseHeld, safeRejectRepair };
