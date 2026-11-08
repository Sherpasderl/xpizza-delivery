// Stacked-order SEQUENCING — driver consumption slice (BUILD-stacked-seq-driver). Composes on the #962 hotfix:
// the completion promotion picks the NEXT stop by lowest remaining server-written stop_seq (coherent stack), THEN
// points at that stop's WORKING task (the hotfix logic). Absent/partial/mismatched stop_seq → created_at fallback,
// byte-identical to legacy. The server (sequencing/plan-stack) writes stop_seq/stack_id on tasks/{oid}_delivery.
import assert from 'node:assert/strict';
import { buildCompleteTaskUpdates, TASK_STATUS, TASK_TYPE } from './driver-complete.js';

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}
const UID = 'drv';
const PTR = `drivers/${UID}/current_task_id`;
const del = (oid, o) => ({ order_id: oid, type: TASK_TYPE.DELIVERY, assigned_driver_id: UID, linked_task_id: `${oid}_pickup`, ...o });
const pu  = (oid, o) => ({ order_id: oid, type: TASK_TYPE.PICKUP,  assigned_driver_id: UID, linked_task_id: `${oid}_delivery`, ...o });

// (b) the promotion keys on lowest remaining stop_seq, NOT created_at, for a coherent sequenced stack.
t('(b) coherent stack: complete the current delivery → promote the LOWEST remaining stop_seq, even when created_at disagrees', () => {
  // Completing X. Remaining A (stop_seq 2, created EARLY) + B (stop_seq 1, created LATE), both picked up, same stack.
  const all = {
    x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup:   pu('a',  { status: TASK_STATUS.COMPLETED, created_at: 200 }),
    a_delivery: del('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2, stack_id: 'S' }),
    b_pickup:   pu('b',  { status: TASK_STATUS.COMPLETED, created_at: 300 }),
    b_delivery: del('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1, stack_id: 'S' }),
  };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], 'b_delivery', 'must promote stop_seq 1 (b), not the earliest-created (a)');
});

t('(b) composes with the working-task pointer: the promoted stop whose PICKUP is not completed → pointer = its PICKUP', () => {
  // Completing X. Remaining A (stop_seq 2, picked up) + B (stop_seq 1, pickup ACCEPTED not completed), same stack.
  const all = {
    x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup:   pu('a',  { status: TASK_STATUS.COMPLETED, created_at: 200 }),
    a_delivery: del('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2, stack_id: 'S' }),
    b_pickup:   pu('b',  { status: TASK_STATUS.ACCEPTED, created_at: 300 }),
    b_delivery: del('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1, stack_id: 'S' }),
  };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], 'b_pickup', 'stop_seq 1 (b) chosen; its pickup not completed → pointer = b_pickup (working task)');
});

t('(b) GOLDEN: no stop_seq (legacy) → earliest created_at, unchanged', () => {
  const all = {
    x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup:   pu('a',  { status: TASK_STATUS.COMPLETED, created_at: 200 }),
    a_delivery: del('a', { status: TASK_STATUS.ACCEPTED, created_at: 201 }),
    b_pickup:   pu('b',  { status: TASK_STATUS.COMPLETED, created_at: 300 }),
    b_delivery: del('b', { status: TASK_STATUS.ACCEPTED, created_at: 301 }),
  };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], 'a_delivery', 'legacy fallback = earliest created_at (a)');
});

t('(b) GOLDEN: mismatched stack (different stack_id) → NOT coherent → created_at fallback', () => {
  const all = {
    x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup:   pu('a',  { status: TASK_STATUS.COMPLETED, created_at: 200 }),
    a_delivery: del('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2, stack_id: 'S1' }),
    b_pickup:   pu('b',  { status: TASK_STATUS.COMPLETED, created_at: 300 }),
    b_delivery: del('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1, stack_id: 'S2' }),
  };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], 'a_delivery', 'different stack_id ⇒ not a coherent stack ⇒ earliest created_at');
});

t('(b) 2-stop: complete stop 1 → the sole remaining stop 2 promoted (byte-identical to legacy for 2-stop)', () => {
  const all = {
    s1_delivery: del('s1', { status: TASK_STATUS.IN_PROGRESS, created_at: 100, stop_seq: 1, stack_id: 'S' }),
    s2_pickup:   pu('s2',  { status: TASK_STATUS.COMPLETED, created_at: 200 }),
    s2_delivery: del('s2', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2, stack_id: 'S' }),
  };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 's1_delivery', task: all.s1_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], 's2_delivery');
});

t('(b) GOLDEN: single order → null + RETURNING', () => {
  const all = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }) };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 });
  assert.equal(u[PTR], null);
  assert.equal(u[`drivers/${UID}/status`], 'returning');
});

console.log(`stackseq-consume (b): ${passed} passed`);
