'use strict';
// codex r1 P1-2 / r2 P1 + P2 — the two assigner hooks: holdAfterClaim's verdicts (an UNREADABLE order finalizes as before, it is
// not "gone") and releaseHeld's per-task release that never revives a task a cancel finished meanwhile.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const { holdAfterClaim, releaseHeld } = require('./merchant-hooks');

const rejected = { kind: 'rejected', at: 1, by: 'hh', op_id: 'op' };
const world = (order) => ({ orders: { o1: order }, tasks: {
  o1_pickup: { order_id: 'o1', type: 'pickup', status: 'assigned', assigned_driver_id: 'dOld', assignment_deadline: 5 },
  o1_delivery: { order_id: 'o1', type: 'delivery', status: 'assigned', assigned_driver_id: 'dNew', assignment_deadline: 5, half_claim_since: 3 } } });
const gone = (o) => o.status === 'cancelled';

test('holdAfterClaim: held / gone / clear — and an UNREADABLE order is null (finalize as before, logged), never gone', async () => {
  assert.strictEqual(await holdAfterClaim(createFakeDb(world({ status: 'new', handheld_answered: rejected })), 'o1', gone), 'held');
  assert.strictEqual(await holdAfterClaim(createFakeDb(world({ status: 'new', cancel_claim_id: 'c' })), 'o1', gone), 'held');
  assert.strictEqual(await holdAfterClaim(createFakeDb(world({ status: 'cancelled' })), 'o1', gone), 'gone');
  assert.strictEqual(await holdAfterClaim(createFakeDb({}), 'o1', gone), 'gone', 'a confirmed absent order');
  assert.strictEqual(await holdAfterClaim(createFakeDb(world({ status: 'new' })), 'o1', gone), null);
  const broken = createFakeDb(world({ status: 'new', handheld_answered: rejected }));
  broken.failReads.add('orders/o1');
  const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
  try { assert.strictEqual(await holdAfterClaim(broken, 'o1', gone), null, 'codex r2 P2: non-handheld parity — the reassignment proceeds'); }
  finally { console.error = orig; }
  assert.ok(errs.some((e) => e.includes('unreadable')), 'and it is logged');
});

test('releaseHeld: both tasks back to SIN ASIGNAR (pending, unassigned, no deadline, no marker) when nothing is terminal', async () => {
  const db = createFakeDb(world({ status: 'new', handheld_answered: rejected }));
  assert.strictEqual(await releaseHeld(db, 'o1', 'dNew'), true);
  for (const t of ['pickup', 'delivery']) {
    const x = db.get(`tasks/o1_${t}`);
    assert.deepStrictEqual([x.status, x.assigned_driver_id == null, x.assignment_deadline == null], ['pending', true, true], t);
  }
  assert.strictEqual(db.get('tasks/o1_delivery/half_claim_since'), null);
});

test('codex r2 P1: a task cancelled by a cancel that finished in the overlap is KEPT cancelled (never revived to pending)', async () => {
  const db = createFakeDb(world({ status: 'new', cancel_claim_id: 'c' }));
  db.hooks.onTxn = async (path) => {                  // the cancel completes between the delivery release and the task writes
    if (path !== 'tasks/o1_delivery/assigned_driver_id') return;
    db.put('orders/o1/status', 'cancelled'); db.put('tasks/o1_pickup/status', 'cancelled'); db.put('tasks/o1_delivery/status', 'cancelled');
  };
  assert.strictEqual(await releaseHeld(db, 'o1', 'dNew'), true);
  assert.deepStrictEqual([db.get('tasks/o1_pickup/status'), db.get('tasks/o1_delivery/status')], ['cancelled', 'cancelled']);
  assert.strictEqual(db.get('tasks/o1_pickup/assigned_driver_id'), 'dOld', 'a terminal task is not touched at all');
});

test('releaseHeld: not ours (the delivery moved to another driver) → false, nothing touched', async () => {
  const db = createFakeDb(world({ status: 'new', handheld_answered: rejected }));
  db.put('tasks/o1_delivery/assigned_driver_id', 'dOther');
  assert.strictEqual(await releaseHeld(db, 'o1', 'dNew'), false);
  assert.strictEqual(db.get('tasks/o1_pickup/status'), 'assigned');
  assert.strictEqual(db.get('tasks/o1_delivery/assigned_driver_id'), 'dOther');
});
