// Stacked-order SEQUENCING — driver consumption slice (BUILD-stacked-seq-driver), composed on the #962 hotfix.
// Coherence = the ONE server rule validPair (byte-pinned in stack-validity.js): same stack_id/driver, ranks 1+2, and
// PROVENANCE (stack_uid === assigned_driver_id, assigned_at <= stack_at — a reassignment makes stale metadata inert).
// getDriverOrders sorts, buildCompleteTaskUpdates promotes, pickStackPointer points — all keyed on validPair; absent/
// partial/mismatched/stale/non-coherent → legacy (created_at / swiped), byte-identical.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCompleteTaskUpdates, pickStackPointer, TASK_STATUS, TASK_TYPE } from './driver-complete.js';
import { stackPlusMinLabel } from './stacked-view.js';

// Lift getDriverOrders from xpizza-delivery.js (its module imports the Firebase SDK over https; the function is pure).
function liftFn(src, name, scope) {
  const at = src.indexOf(`export function ${name}(`);
  const open = src.indexOf('{', src.indexOf('(', at));
  let depth = 0, end = -1;
  for (let k = open; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { end = k + 1; break; } } }
  const sig = src.slice(src.indexOf('(', at), open);
  const names = Object.keys(scope);
  return new Function(...names, `return (function ${name}${sig}${src.slice(open, end)});`)(...Object.values(scope));
}
const SDK = readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
const { validPair } = await import('./stack-validity.js');
const getDriverOrders = liftFn(SDK, 'getDriverOrders', { TASK_TYPE, TASK_STATUS, validPair });

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}
const UID = 'drv';
const PTR = `drivers/${UID}/current_task_id`;
// a VALID stack-copy delivery (server provenance): stack_id 'S', stack_uid===driver, assigned_at(1) <= stack_at(2).
const vdel = (oid, o) => ({ order_id: oid, type: TASK_TYPE.DELIVERY, assigned_driver_id: UID, linked_task_id: `${oid}_pickup`, stack_id: 'S', stack_uid: UID, assigned_at: 1, stack_at: 2, ...o });
const del  = (oid, o) => ({ order_id: oid, type: TASK_TYPE.DELIVERY, assigned_driver_id: UID, linked_task_id: `${oid}_pickup`, ...o });
const pu   = (oid, o) => ({ order_id: oid, type: TASK_TYPE.PICKUP,  assigned_driver_id: UID, linked_task_id: `${oid}_delivery`, ...o });
const delPhase = (mk, oid, o) => ({ [`${oid}_pickup`]: pu(oid, { status: TASK_STATUS.COMPLETED, created_at: o.created_at - 1 }), [`${oid}_delivery`]: mk(oid, { status: TASK_STATUS.ACCEPTED, ...o }) });
const ord = (tasks) => getDriverOrders(UID, tasks, {}).map((o) => o.orderId);

// ───────── (a) getDriverOrders sort ─────────
t('(a) coherent valid stack: delivery-phase stops ordered by stop_seq, NOT created_at', () => {
  const tasks = { ...delPhase(vdel, 'a', { created_at: 101, stop_seq: 2 }), ...delPhase(vdel, 'b', { created_at: 201, stop_seq: 1 }) };
  assert.deepEqual(ord(tasks), ['b', 'a']);
});
t('(a) GOLDEN: no stop_seq → created_at order', () => {
  assert.deepEqual(ord({ ...delPhase(del, 'a', { created_at: 101 }), ...delPhase(del, 'b', { created_at: 201 }) }), ['a', 'b']);
});
t('(a) GOLDEN: partial (one has stop_seq) → not a valid pair → created_at', () => {
  assert.deepEqual(ord({ ...delPhase(vdel, 'a', { created_at: 101, stop_seq: 2 }), ...delPhase(del, 'b', { created_at: 201 }) }), ['a', 'b']);
});
t('(a) GOLDEN: mismatched stack_id → not a valid pair → created_at', () => {
  assert.deepEqual(ord({ ...delPhase(vdel, 'a', { created_at: 101, stop_seq: 2, stack_id: 'S1' }), ...delPhase(vdel, 'b', { created_at: 201, stop_seq: 1, stack_id: 'S2' }) }), ['a', 'b']);
});
t('(a/#4) STALE provenance: stack_uid != driver OR assigned_at > stack_at → NOT valid → created_at', () => {
  // reassigned away (stack_uid foreign)
  assert.deepEqual(ord({ ...delPhase(vdel, 'a', { created_at: 101, stop_seq: 2, stack_uid: 'other' }), ...delPhase(vdel, 'b', { created_at: 201, stop_seq: 1, stack_uid: 'other' }) }), ['a', 'b']);
  // reassigned AFTER the stack write (assigned_at > stack_at)
  assert.deepEqual(ord({ ...delPhase(vdel, 'a', { created_at: 101, stop_seq: 2, assigned_at: 9 }), ...delPhase(vdel, 'b', { created_at: 201, stop_seq: 1, assigned_at: 9 }) }), ['a', 'b']);
});
t('(a/#2) 3 delivery orders (a valid pair + a 3rd) → NOT exactly one pair → legacy; order is TRANSITIVE across input permutations', () => {
  const build = (keys) => { const all = {}; const src = { a: { created_at: 300, stop_seq: 2 }, b: { created_at: 100, stop_seq: 1 }, c: { created_at: 200 } }; for (const k of keys) Object.assign(all, delPhase(k === 'c' ? del : vdel, k, src[k])); return all; };
  const expect = ['b', 'c', 'a'];   // created_at 100 < 200 < 300
  for (const perm of [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'a', 'c'], ['a', 'c', 'b'], ['c', 'a', 'b'], ['b', 'c', 'a']]) {
    assert.deepEqual(ord(build(perm)), expect, `permutation ${perm} must give the same transitive order`);
  }
});
t('(a/#5) non-delivery phase: two accepted PICKUPS never reorder by stop_seq (sequence is delivery-only)', () => {
  // two pickup-phase orders (pickup accepted, delivery pending) with stop_seq present → still ordered by created_at
  const puPhase = (oid, o) => ({ [`${oid}_pickup`]: pu(oid, { status: TASK_STATUS.ACCEPTED, created_at: o.created_at - 1 }), [`${oid}_delivery`]: vdel(oid, { status: TASK_STATUS.PENDING, ...o }) });
  assert.deepEqual(ord({ ...puPhase('a', { created_at: 101, stop_seq: 2 }), ...puPhase('b', { created_at: 201, stop_seq: 1 }) }), ['a', 'b']);
});

// ───────── (b) buildCompleteTaskUpdates promotion ─────────
t('(b) coherent valid stack: promote lowest remaining stop_seq (not earliest created_at)', () => {
  const all = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup: pu('a', { status: TASK_STATUS.COMPLETED }), a_delivery: vdel('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2 }),
    b_pickup: pu('b', { status: TASK_STATUS.COMPLETED }), b_delivery: vdel('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1 }) };
  assert.equal(buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 })[PTR], 'b_delivery');
});
t('(b) composes with working-task: promoted stop whose pickup is not completed → pointer = its PICKUP', () => {
  const all = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_pickup: pu('a', { status: TASK_STATUS.COMPLETED }), a_delivery: vdel('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2 }),
    b_pickup: pu('b', { status: TASK_STATUS.ACCEPTED }), b_delivery: vdel('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1 }) };
  assert.equal(buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 })[PTR], 'b_pickup');
});
t('(b/#4) stale provenance (assigned_at > stack_at) → legacy earliest created_at', () => {
  const all = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }),
    a_delivery: vdel('a', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2, assigned_at: 9 }),
    b_delivery: vdel('b', { status: TASK_STATUS.ACCEPTED, created_at: 301, stop_seq: 1, assigned_at: 9 }) };
  assert.equal(buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: all.x_delivery, allTasks: all, now: 1 })[PTR], 'a_delivery');
});
t('(b) GOLDEN: no stop_seq → earliest created_at; 2-stop sole remainder; single → null+RETURNING', () => {
  const legacy = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }), a_delivery: del('a', { status: TASK_STATUS.ACCEPTED, created_at: 201 }), b_delivery: del('b', { status: TASK_STATUS.ACCEPTED, created_at: 301 }) };
  assert.equal(buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: legacy.x_delivery, allTasks: legacy, now: 1 })[PTR], 'a_delivery');
  const two = { s1_delivery: vdel('s1', { status: TASK_STATUS.IN_PROGRESS, created_at: 100, stop_seq: 1 }), s2_pickup: pu('s2', { status: TASK_STATUS.COMPLETED }), s2_delivery: vdel('s2', { status: TASK_STATUS.ACCEPTED, created_at: 201, stop_seq: 2 }) };
  assert.equal(buildCompleteTaskUpdates({ driverId: UID, taskId: 's1_delivery', task: two.s1_delivery, allTasks: two, now: 1 })[PTR], 's2_delivery');
  const one = { x_delivery: del('x', { status: TASK_STATUS.IN_PROGRESS, created_at: 100 }) };
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'x_delivery', task: one.x_delivery, allTasks: one, now: 1 });
  assert.equal(u[PTR], null); assert.equal(u[`drivers/${UID}/status`], 'returning');
});

// ───────── (c.1) pickStackPointer (pickupComplete active pointer) ─────────
const M = (id, o) => ({ id, task: vdel(id.replace('_delivery', ''), o) });
t('(c.1) valid pair: pointer = stop_seq 1 delivery even when stop 2 swiped first', () => {
  assert.equal(pickStackPointer([M('b_delivery', { stop_seq: 2 }), M('a_delivery', { stop_seq: 1 })], 'b_delivery'), 'a_delivery');
});
t('(c.1/#1) staggered/repeat-swipe: in-hand includes the earlier-picked-up stop → pointer stays stop 1, not the re-swiped stop 2', () => {
  // the driver re-swipes stop 2; stop 1 (picked up earlier) is still in hand → pointer = stop 1
  assert.equal(pickStackPointer([M('s2_delivery', { stop_seq: 2 }), M('s1_delivery', { stop_seq: 1 })], 's2_delivery'), 's1_delivery');
});
t('(c.1) GOLDEN: single member / stale provenance / mismatched → swiped delivery', () => {
  assert.equal(pickStackPointer([M('x_delivery', { stop_seq: 1 })], 'x_delivery'), 'x_delivery');
  assert.equal(pickStackPointer([{ id: 'b_delivery', task: vdel('b', { stop_seq: 2, stack_uid: 'other' }) }, M('a_delivery', { stop_seq: 1 })], 'b_delivery'), 'b_delivery');
  assert.equal(pickStackPointer([{ id: 'b_delivery', task: vdel('b', { stop_seq: 2, stack_id: 'X' }) }, M('a_delivery', { stop_seq: 1 })], 'b_delivery'), 'b_delivery');
});

// ───────── (c.2) «+N min» positive-only ─────────
t('(c.2) «+N min»: integer N≥1 shows (rounded); null/0/negative/absent hidden', () => {
  assert.match(stackPlusMinLabel({ deliveryTask: { stack_plus_min: 4 } }), /\+4 min/);
  assert.match(stackPlusMinLabel({ deliveryTask: { stack_plus_min: 4.6 } }), /\+5 min/);
  for (const v of [null, 0, -3, undefined, NaN]) assert.equal(stackPlusMinLabel({ deliveryTask: { stack_plus_min: v } }), '');
  assert.equal(stackPlusMinLabel(null), '');
});

console.log(`stackseq-consume (a/b/c + provenance + transitivity): ${passed} passed`);
