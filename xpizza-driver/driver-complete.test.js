// Regression + equivalence suite for the 2026-11-07 live prod bug (driver Elmer, X.Pizza #962 Carolina Sierra).
//
// Owner sequence: Carolina assigned → owner UNASSIGNS her, leaves Angelo → Elmer swipes "Recogí" on Angelo
// (Angelo pickup done, Elmer in Angelo's DELIVERY leg) → owner REASSIGNS Carolina while Elmer is already
// out_for_delivery, so her legs are stacked-accepted but her PICKUP is not completed → Elmer delivers Angelo →
// Carolina's card shows "Parada actual" + "Recogí el pedido", slide LOCKED.
//
// Root cause: buildCompleteTaskUpdates promoted the next ACCEPTED DELIVERY to current_task_id without checking
// that order's PICKUP was completed, so the pointer named Carolina's DELIVERY while her working task was her
// PICKUP. drv2ResolveActivePointer couldn't resolve it → the fail-closed pointer gate locked the pickup slide.
// Fix: point current_task_id at the next stop's WORKING task (its pickup when the pickup isn't completed, else
// its delivery). This cell was RED before the fix (got 'C_del'); it is GREEN after.
import assert from 'node:assert/strict';
import { buildCompleteTaskUpdates, TASK_STATUS, TASK_TYPE } from './driver-complete.js';
import { buildCompleteTaskUpdates as buildOLD } from './driver-complete.baseline.fixture.mjs'; // origin/main 51dc55ab, verbatim

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}

const UID = 'elmer';

t('bug #962: deliver stop 1 (Angelo) while stop 2 (Carolina) pickup is not completed → pointer names Carolina PICKUP (working task), not her delivery', () => {
  const A_pu = { order_id: 'angelo', type: TASK_TYPE.PICKUP, status: TASK_STATUS.COMPLETED, assigned_driver_id: UID, created_at: 100, linked_task_id: 'A_del' };
  const A_del = { order_id: 'angelo', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'A_pu' };
  // Carolina stacked-accepted but NOT picked up: pickup ACCEPTED (so her card renders the pickup slide), delivery ACCEPTED.
  const C_pu = { order_id: 'carolina', type: TASK_TYPE.PICKUP, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 200, linked_task_id: 'C_del' };
  const C_del = { order_id: 'carolina', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'C_pu' };
  const updates = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_pu, A_del, C_pu, C_del }, now: 1000 });
  assert.equal(updates[`drivers/${UID}/current_task_id`], 'C_pu', 'pointer must be Carolina PICKUP so the pickup slide is armed');
});

t('control: deliver stop 1 with stop 2 already picked up (pickup COMPLETED, delivery accepted) → pointer names stop 2 DELIVERY (unchanged)', () => {
  const A_del = { order_id: 'angelo', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'A_pu' };
  const C_pu = { order_id: 'carolina', type: TASK_TYPE.PICKUP, status: TASK_STATUS.COMPLETED, assigned_driver_id: UID, created_at: 200, linked_task_id: 'C_del' };
  const C_del = { order_id: 'carolina', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'C_pu' };
  const updates = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, C_pu, C_del }, now: 1000 });
  assert.equal(updates[`drivers/${UID}/current_task_id`], 'C_del', 'already picked up → working task is the delivery');
});

t('single-order golden: deliver the only order → pointer null + RETURNING (unchanged)', () => {
  const A_del = { order_id: 'angelo', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'A_pu' };
  const updates = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del }, now: 1000 });
  assert.equal(updates[`drivers/${UID}/current_task_id`], null);
  assert.equal(updates[`drivers/${UID}/status`], 'returning');
});

// ===== EQUIVALENCE (owner no-regression, ironclad): OLD (origin/main, verbatim) vs NEW over the task-state space.
// Dimensions: 1-3 orders; each order's pickup + delivery leg ∈ {assigned,accepted,in_progress,completed,cancelled};
// the completing task = each existing leg (pickup or delivery). (Hub is NOT an input to buildCompleteTaskUpdates —
// it has no hub parameter — so same/cross hub cannot change its output and is not a dimension here.) NEW must be
// byte-identical to OLD EXCEPT exactly the combos where the promoted next order's DELIVERY is accepted/in_progress
// while its PICKUP is not completed — the bug case the fix corrects.
const STATUSES = [TASK_STATUS.ASSIGNED, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED];
function* legCombos(n) {                       // every (pu,del) status assignment for n orders
  if (n === 0) { yield []; return; }
  for (const rest of legCombos(n - 1)) for (const pu of STATUSES) for (const del of STATUSES) yield [...rest, { pu, del }];
}
function buildTasks(combo) {
  const all = {};
  combo.forEach(({ pu, del }, i) => {
    const oid = `o${i}`;
    all[`${oid}_pickup`]   = { order_id: oid, type: TASK_TYPE.PICKUP,   status: pu,  assigned_driver_id: UID, created_at: 100 + i * 10,     linked_task_id: `${oid}_delivery` };
    all[`${oid}_delivery`] = { order_id: oid, type: TASK_TYPE.DELIVERY, status: del, assigned_driver_id: UID, created_at: 100 + i * 10 + 1, linked_task_id: `${oid}_pickup` };
  });
  return all;
}
function keysUnion(a, b) { return [...new Set([...Object.keys(a), ...Object.keys(b)])]; }
function diffLeaves(a, b) { return keysUnion(a, b).filter((k) => a[k] !== b[k]); }

t('EQUIVALENCE: NEW === OLD everywhere except the {next delivery accepted, its pickup not completed} case', () => {
  const PTR = `drivers/${UID}/current_task_id`;
  let scenarios = 0, diffs = 0, oldThrow = 0;
  for (let n = 1; n <= 3; n++) {
    for (const combo of legCombos(n)) {
      const base = buildTasks(combo);
      for (const taskId of Object.keys(base)) {
        scenarios++;
        const allTasks = base;
        const task = allTasks[taskId];
        let oldRes, newRes, oldErr = null, newErr = null;
        try { oldRes = buildOLD({ driverId: UID, taskId, task, allTasks, now: 1000 }); } catch (e) { oldErr = e.message; }
        try { newRes = buildCompleteTaskUpdates({ driverId: UID, taskId, task, allTasks, now: 1000 }); } catch (e) { newErr = e.message; }
        // Throw behaviour must be identical (cancelled/missing completing task).
        assert.equal(!!oldErr, !!newErr, `throw mismatch @ n=${n} task=${taskId}: old=${oldErr} new=${newErr}`);
        if (oldErr) { assert.equal(oldErr, newErr, `error text mismatch @ ${taskId}`); oldThrow++; continue; }
        const d = diffLeaves(oldRes, newRes);
        if (d.length === 0) continue;
        diffs++;
        // The ONLY permitted difference: the pointer leaf, where OLD named a DELIVERY whose order's PICKUP is not completed.
        assert.deepEqual(d, [PTR], `@ n=${n} task=${taskId}: diffs beyond the pointer: ${JSON.stringify(d)}`);
        const oldPtr = oldRes[PTR];
        assert.ok(typeof oldPtr === 'string' && oldPtr.endsWith('_delivery'), `OLD pointer should be a delivery here; got ${JSON.stringify(oldPtr)}`);
        const pickupId = allTasks[oldPtr] && allTasks[oldPtr].linked_task_id;
        assert.equal(newRes[PTR], pickupId, `NEW pointer should be that order's pickup; got ${JSON.stringify(newRes[PTR])}`);
        assert.notEqual(allTasks[pickupId] && allTasks[pickupId].status, TASK_STATUS.COMPLETED, 'the differing case must have an uncompleted pickup');
        // And OLD's chosen delivery was itself accepted/in_progress (the promotion gate).
        assert.ok([TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS].includes(allTasks[oldPtr].status), 'OLD-chosen delivery must be accepted/in_progress');
      }
    }
  }
  console.log(`    enumerated ${scenarios} scenarios (${oldThrow} identical throws); ${diffs} differ — all the {next delivery accepted, pickup not completed} case`);
  assert.ok(diffs > 0, 'the bug case must be reachable in the enumeration');
});

console.log(`driver-complete (#962 regression + equivalence): ${passed} passed`);
