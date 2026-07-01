'use strict';

// Unit tests for the pure sweep-pending predicate (S3). Run: node sweep-pending.test.js
// A too-loose predicate is the main way the pending-order sweeper misbehaves, so this is the core gate:
// it must sweep ONLY a genuinely-stuck, unparked, past-grace, unassigned, auto-assignable order.
const assert = require('assert');
const { sweepDecision, activeOrderCount, assignmentStrandState } = require('./sweep-pending');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const NOW = 1_800_000_000_000;
const OLD = NOW - (30_000 + 60_000) - 1;   // just past grace(30s)+interval(60s)
const OPTS = { graceMs: 30_000, sweepIntervalMs: 60_000, retryMax: 2 };

// A clean sweepable order: auto-assignable, old enough, both tasks unassigned/pending, not parked.
const mk = (orderExtra = {}, pkExtra = {}, dlExtra = {}) => {
  const order = { order_id: 'o1', status: 'new', created_at: OLD, ...orderExtra };
  const tasks = {
    o1_pickup:   { order_id: 'o1', type: 'pickup',   status: 'pending', assigned_driver_id: null, ...pkExtra },
    o1_delivery: { order_id: 'o1', type: 'delivery', status: 'pending', assigned_driver_id: null, ...dlExtra },
  };
  return { order, tasks };
};
const swept = (m) => sweepDecision(m.order, m.tasks, NOW, OPTS);

// ✅ the one thing it MUST do
{ const r = swept(mk()); assert.deepStrictEqual(r, { sweep: true }, 'clean pending order → sweep'); ok('clean unparked past-grace unassigned auto-assignable order → sweep'); }
{ const r = swept(mk({ status: 'preparing' })); assert.strictEqual(r.sweep, true); ok('preparing status → sweep'); }
{ const r = swept(mk({ status: 'ready' })); assert.strictEqual(r.sweep, true); ok('ready status → sweep'); }

// 🚫 every way it must NOT sweep
{ const r = swept(mk({ dispatch_parked: true })); assert.deepStrictEqual(r, { sweep: false, reason: 'parked' }, 'parked'); ok('dispatch_parked → skip (the escape hatch)'); }
{ const r = swept(mk({ status: 'delivered' })); assert.strictEqual(r.sweep, false); ok('non-auto-assignable status (delivered) → skip'); }
{ const r = swept(mk({ status: 'cancelled' })); assert.strictEqual(r.sweep, false); ok('cancelled order status → skip'); }
{ const r = sweepDecision({ order_id: 'o1', status: 'new', created_at: OLD }, {}, NOW, OPTS); assert.strictEqual(r.sweep, false); ok('no tasks → skip'); }
{ const r = swept(mk({}, { status: 'cancelled' })); assert.strictEqual(r.sweep, false); ok('a cancelled task → skip'); }
{ const r = swept(mk({}, { assigned_driver_id: 'd1' })); assert.strictEqual(r.sweep, false); ok('pickup already assigned → skip'); }
{ const r = swept(mk({}, {}, { assigned_driver_id: 'd2' })); assert.strictEqual(r.sweep, false); ok('delivery already assigned → skip'); }
{ const r = swept(mk({}, { assignment_deadline: NOW + 10_000 })); assert.strictEqual(r.sweep, false); ok('live assignment_deadline (mid-assignment) → skip'); }
{ const r = swept(mk({}, {}, { retry_count: 2 })); assert.strictEqual(r.sweep, false); ok('retry_count >= RETRY_MAX → skip (throttle, still visible in SIN ASIGNAR)'); }
{ const r = swept(mk({}, {}, { retry_count: 1 })); assert.strictEqual(r.sweep, true); ok('retry_count < RETRY_MAX → still sweep'); }
{ const r = swept(mk({ created_at: NOW - 1000 })); assert.strictEqual(r.sweep, false); ok('within grace+interval (too young) → skip (no collision with autoAssign)'); }
{ const r = swept(mk({ created_at: undefined })); assert.strictEqual(r.sweep, false); ok('no created_at → skip (defensive)'); }
{ const r = sweepDecision(null, {}, NOW, OPTS); assert.strictEqual(r.sweep, false); ok('no order → skip'); }

// ---- activeOrderCount(tasks, driverId, excludeOrderId) ----  distinct active order_ids for a driver,
// excluding one order (the one being placed). Used by reassertAssignable in the sweeper: the delivery
// task is CAS-claimed BEFORE the recheck, so without the exclusion the just-claimed order inflates the
// driver to orderCount=2 and a valid stackable candidate is wrongly rejected.
{
  const tasks = {
    a_pickup:   { order_id: 'a', assigned_driver_id: 'd1', status: 'accepted' },
    a_delivery: { order_id: 'a', assigned_driver_id: 'd1', status: 'accepted' },
    b_delivery: { order_id: 'b', assigned_driver_id: 'd1', status: 'assigned' },   // the just-claimed new order
    c_pickup:   { order_id: 'c', assigned_driver_id: 'd2', status: 'accepted' },   // other driver
    done_pickup:{ order_id: 'z', assigned_driver_id: 'd1', status: 'completed' },  // completed → not counted
  };
  assert.strictEqual(activeOrderCount(tasks, 'd1', null), 2, 'd1 has 2 active orders (a, b)');
  assert.strictEqual(activeOrderCount(tasks, 'd1', 'b'), 1, 'excluding the just-claimed order b → 1 (a) → still stackable');
  assert.strictEqual(activeOrderCount(tasks, 'd2', null), 1, 'd2 has 1 (c)');
  assert.strictEqual(activeOrderCount(tasks, 'd1', 'a'), 1, 'excluding a → 1 (b)');
  assert.strictEqual(activeOrderCount({}, 'd1', null), 0, 'no tasks → 0');
  ok('activeOrderCount: distinct active orders, excludes completed/cancelled + the excluded order');
}

// ---- assignmentStrandState(pickup, delivery, now, {staleMs}) ----  self-heal (finding 4, generalized S3i).
// A consistent order ALWAYS has pickup and delivery on the SAME driver (assigned/moved together atomically).
// A MISMATCH arises only in the transient claim→finalize window — a "half-claim" (delivery claimed, pickup
// null; autoAssign/sweeper/manual) or a "split" (delivery→new, pickup still old; timeout-reassign/reassign).
// Every window is < staleMs (server fns die at 90s, client aborts at 90s; staleMs=120s), so a mismatch that
// PERSISTS is a real strand. Two-pass (mark→wait→heal) so a live in-flight window (ms) is never healed.
const STALE = 120_000;
const HC = { staleMs: STALE };
const del = (extra = {}) => ({ order_id: 'o1', type: 'delivery', status: 'pending', assigned_driver_id: 'd1', ...extra });
const pick = (extra = {}) => ({ order_id: 'o1', type: 'pickup', status: 'pending', assigned_driver_id: null, ...extra });

// none: consistent — pickup and delivery agree
{ assert.strictEqual(assignmentStrandState(pick({ assigned_driver_id: 'd1' }), del(), NOW, HC), 'none'); ok('both on same driver (normal assign) → none'); }
{ assert.strictEqual(assignmentStrandState(pick(), del({ assigned_driver_id: null }), NOW, HC), 'none'); ok('both unassigned (plain pending) → none'); }
{ assert.strictEqual(assignmentStrandState(pick({ assigned_driver_id: 'd1', status: 'accepted' }), del({ status: 'accepted' }), NOW, HC), 'none'); ok('both accepted same driver (stacked) → none'); }
// half-claim (delivery=d1, pickup=null): mismatch
{ assert.strictEqual(assignmentStrandState(pick(), del(), NOW, HC), 'mark'); ok('half-claim (delivery set, pickup null), no marker → mark'); }
{ assert.strictEqual(assignmentStrandState(pick(), del({ half_claim_since: NOW - 1000 }), NOW, HC), 'wait'); ok('half-claim, marker fresh (<staleMs) → wait (protects live claim)'); }
{ assert.strictEqual(assignmentStrandState(pick(), del({ half_claim_since: NOW - STALE - 1 }), NOW, HC), 'heal'); ok('half-claim, marker older than staleMs → heal'); }
// SPLIT (delivery=new 'd2', pickup=old 'd1'): the timeout-reassign / reassignOrder strand shape
{ assert.strictEqual(assignmentStrandState(pick({ assigned_driver_id: 'd1', status: 'assigned' }), del({ assigned_driver_id: 'd2', status: 'assigned' }), NOW, HC), 'mark'); ok('split (delivery→d2, pickup still d1), no marker → mark'); }
{ assert.strictEqual(assignmentStrandState(pick({ assigned_driver_id: 'd1' }), del({ assigned_driver_id: 'd2', half_claim_since: NOW - 1000 }), NOW, HC), 'wait'); ok('split, marker fresh → wait (protects live reassign)'); }
{ assert.strictEqual(assignmentStrandState(pick({ assigned_driver_id: 'd1' }), del({ assigned_driver_id: 'd2', half_claim_since: NOW - STALE - 1 }), NOW, HC), 'heal'); ok('split, marker older than staleMs → heal'); }
// defensive: missing task → none
{ assert.strictEqual(assignmentStrandState(null, del(), NOW, HC), 'none'); ok('missing pickup → none'); }
{ assert.strictEqual(assignmentStrandState(pick(), null, NOW, HC), 'none'); ok('missing delivery → none'); }

console.log(`sweep-pending: OK (${n} cases)`);
