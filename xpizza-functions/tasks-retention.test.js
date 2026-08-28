'use strict';
// RTDB egress Stage 1 — /tasks retention decisions. Run: node tasks-retention.test.js
const assert = require('assert');
const { REALTIME_TERMINAL_STATUSES, tasksToDelete, entersTerminalEdge } = require('./tasks-retention');
const { HEAL_TERMINAL_STATUSES, assignmentStrandState } = require('./sweep-pending');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const R = REALTIME_TERMINAL_STATUSES;

// ── entersTerminalEdge (real-time trigger edge; REALTIME set = {delivered, completed}, NOT cancelled) ──
assert.equal(entersTerminalEdge('new', 'delivered', R), true);
assert.equal(entersTerminalEdge('out_for_delivery', 'delivered', R), true);
assert.equal(entersTerminalEdge('ready', 'completed', R), true);
ok('entering delivered/completed → fires (both task legs nulled)');
assert.equal(entersTerminalEdge('new', 'cancelled', R), false);
ok('entering CANCELLED → does NOT fire (excluded — notifyDriverOnCancellation race; backstop reclaims it)');
assert.equal(entersTerminalEdge('new', 'preparing', R), false);
assert.equal(entersTerminalEdge('preparing', 'out_for_delivery', R), false);
ok('live→live transition → no-op');
assert.equal(entersTerminalEdge('delivered', 'completed', R), false);
ok('terminal→terminal (before already in set) → no-op (fires once)');
assert.equal(entersTerminalEdge('delivered', 'delivered', R), false);
ok('no change → no-op');
// a LIVE order's status never matches `after` in the set → its tasks are never touched by the trigger
for (const live of ['new', 'preparing', 'ready', 'out_for_delivery', 'pending_payment', 'scheduled', 'releasing']) {
  assert.equal(entersTerminalEdge('preparing', live, R), false, `live after=${live}`);
}
ok('IMPOSSIBLE-REGRESSION: no live status is an entering-terminal edge → a live order never loses tasks (trigger)');

// ── tasksToDelete (periodic drain/backstop; terminal set = HEAL = {cancelled, delivered, completed}) ──
{
  const orders = {
    live1: { order_id: 'live1', status: 'new' },
    live2: { order_id: 'live2', status: 'out_for_delivery' },
    live3: { order_id: 'live3', status: 'pending_payment' },
    doneD: { order_id: 'doneD', status: 'delivered' },
    doneC: { order_id: 'doneC', status: 'completed' },
    cxl:   { order_id: 'cxl',   status: 'cancelled' },
    // (orphanOrder deliberately absent)
  };
  const tasks = {
    live1_pickup: { order_id: 'live1' }, live1_delivery: { order_id: 'live1' },
    live2_delivery: { order_id: 'live2' }, live3_pickup: { order_id: 'live3' },
    doneD_pickup: { order_id: 'doneD' }, doneD_delivery: { order_id: 'doneD' },
    doneC_delivery: { order_id: 'doneC' }, cxl_pickup: { order_id: 'cxl' }, cxl_delivery: { order_id: 'cxl' },
    orphan_pickup: { order_id: 'gone' },   // its order no longer exists
    orphan_no_field: {},                   // no order_id → derive from taskId 'orphan_no_field' → absent → orphan
  };
  const del = tasksToDelete(orders, tasks, HEAL_TERMINAL_STATUSES).sort();
  assert.deepEqual(del, ['cxl_delivery', 'cxl_pickup', 'doneC_delivery', 'doneD_delivery', 'doneD_pickup', 'orphan_no_field', 'orphan_pickup'].sort());
  ok('deletes terminal (delivered/completed/CANCELLED) + orphans; the backstop reclaims cancelled too');
  // the invariant: NO live order's task is ever in the delete set
  for (const t of del) assert.ok(!t.startsWith('live1') && !t.startsWith('live2') && !t.startsWith('live3'), `live task ${t} must NOT be deleted`);
  ok('IMPOSSIBLE-REGRESSION: no live order task in the delete set (drain/backstop)');
  // orphan detection needs the FULL orders snapshot — an empty orders map would (correctly, by contract) treat
  // everything as an orphan; the caller reads all of /orders so a live order is always present.
  assert.deepEqual(tasksToDelete({}, { a_pickup: { order_id: 'a' } }, HEAL_TERMINAL_STATUSES), ['a_pickup']);
  ok('empty orders → all orphans (contract: caller passes a COMPLETE /orders snapshot)');
}

// ── HEAL no-regression: purging a DELIVERED order's tasks does NOT affect a LIVE order's strand detection ──
{
  const STALE = 120_000, NOW = 1_000_000, HC = { staleMs: STALE };
  const orders = { o1: { order_id: 'o1', status: 'new' }, o2: { order_id: 'o2', status: 'delivered' } };
  const tasks = {
    // o1 = a LIVE half-claim strand (delivery on d1, pickup null, marker older than staleMs → 'heal')
    o1_pickup: { order_id: 'o1', type: 'pickup', status: 'pending', assigned_driver_id: null },
    o1_delivery: { order_id: 'o1', type: 'delivery', status: 'pending', assigned_driver_id: 'd1', half_claim_since: NOW - STALE - 1 },
    // o2 = delivered → its tasks are dead weight
    o2_pickup: { order_id: 'o2' }, o2_delivery: { order_id: 'o2' },
  };
  const del = tasksToDelete(orders, tasks, HEAL_TERMINAL_STATUSES).sort();
  assert.deepEqual(del, ['o2_delivery', 'o2_pickup']);   // ONLY the delivered order's tasks
  ok('heal-regression: retention purges the delivered order tasks, keeps the live strand order tasks');
  // apply the purge, then confirm the LIVE order's strand is STILL detected off its surviving tasks
  for (const t of del) delete tasks[t];
  assert.strictEqual(assignmentStrandState(tasks.o1_pickup, tasks.o1_delivery, NOW, HC), 'heal');
  ok('heal-regression: LIVE order strand STILL detected/healed after the delivered tasks are gone');
}

// ── Static wiring guards on index.js (not require-safe) ──
{
  const fs = require('fs');
  const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
  const has = (re, m) => assert.ok(re.test(SRC), m);
  // Part A — trigger uses the RACE-SAFE set via entersTerminalEdge, on the /status leaf, retry, nulls BOTH legs
  has(/exports\.deleteTasksOnOrderTerminal = onValueWritten\(/, 'Part A: deleteTasksOnOrderTerminal trigger present');
  has(/entersTerminalEdge\(before, after, REALTIME_TERMINAL_STATUSES\)/, 'Part A: uses entersTerminalEdge + REALTIME set (cancelled excluded)');
  has(/\[`tasks\/\$\{orderId\}_pickup`\]: null, \[`tasks\/\$\{orderId\}_delivery`\]: null/, 'Part A: nulls both task legs (idempotent)');
  has(/exports\.deleteTasksOnOrderTerminal[\s\S]*?ref: '\/orders\/\{orderId\}\/status'[\s\S]*?retry: true/, 'Part A: /status leaf + retry:true');
  // retention sweep — dry-run gated, HEAL set (incl cancelled), reads FULL orders+tasks
  has(/exports\.retentionSweepTasks = onSchedule\(/, 'backstop: retentionSweepTasks present');
  has(/config\/retention\/tasks_mode/, 'backstop: gated on config/retention/tasks_mode');
  has(/if \(mode !== 'execute'\)/, 'backstop: DRY-RUN unless mode==="execute"');
  has(/tasksToDelete\(orders, tasks, HEAL_TERMINAL_STATUSES\)/, 'backstop: uses tasksToDelete + HEAL set (incl cancelled)');
  // Part C — sweepStuckOrders 2→5 min; sweepPendingOrders UNCHANGED (heal pass wants 1-min frequency)
  has(/exports\.sweepStuckOrders = onSchedule\(\s*[\s\S]*?schedule: 'every 5 minutes'/, 'Part C: sweepStuckOrders → every 5 minutes');
  assert.ok(!/exports\.sweepStuckOrders[\s\S]{0,200}every 2 minutes/.test(SRC), 'Part C: no lingering 2-min on sweepStuckOrders');
  // sweepPendingOrders schedule byte-unchanged (still its original cadence — not touched)
  const sp = SRC.indexOf('exports.sweepPendingOrders'); assert.ok(sp !== -1, 'sweepPendingOrders present');
  assert.ok(!/exports\.sweepPendingOrders[\s\S]{0,200}every 5 minutes/.test(SRC), 'no-regression: sweepPendingOrders NOT retimed to 5 min');
  ok('static: Part A race-safe trigger + dry-run backstop + Part C cadence; sweepPendingOrders untouched');
}

console.log(`\ntasks-retention.test.js: ${pass} passed`);
