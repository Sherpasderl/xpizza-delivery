'use strict';
// H1a amendment A-R1 — the two hooks index.js calls from EXISTING functions (one-line hunks, reversed by tools/h1-inverse):
//   heldByReject(order)            autoAssignOnOrderCreate, the sweepPendingOrders offer pass (+ its fresh re-check) and
//                                  monitorAssignmentTimeout's first-strike reassign skip an order a handheld rejected or
//                                  that a cancel currently claims. Manual assignment is untouched.
//   holdAfterClaim(db, oid, isGone) codex r1 P1-2: autoAssignOnOrderCreate and monitorAssignmentTimeout's reassign re-read the
//                                  order AFTER their delivery claim and BEFORE finalize (mirroring the sweeper's fresh re-check).
//                                  → 'gone' (absent / isGone(order) / unreadable — fail closed), 'held' (heldByReject), or null.
//   safeRejectRepair(db, orders, now)  the stuck-orders sweep runs it AFTER its own loop, on the snapshot it already read. It NEVER
//                                  throws, so the existing sweep's loop, thresholds and markers are unaffected.
const { heldByReject } = require('./merchant-gate');
const { repairRejects } = require('./merchant-reject-repair');

async function holdAfterClaim(db, oid, isGone) {
  let order;
  try { order = (await db.ref(`orders/${oid}`).once('value')).val(); } catch (_) { return 'gone'; }
  if (!order || isGone(order)) return 'gone';
  return heldByReject(order) ? 'held' : null;
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

module.exports = { heldByReject, holdAfterClaim, safeRejectRepair };
