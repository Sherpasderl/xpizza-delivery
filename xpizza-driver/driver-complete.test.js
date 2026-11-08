// Regression + equivalence suite for the 2026-11-07 live prod bug (driver Elmer, X.Pizza #962 Carolina Sierra)
// and its Codex r1 revision (valid-actionable-pair predicate; oracle-based equivalence).
//
// Bug: after delivering stop 1, buildCompleteTaskUpdates promoted the next accepted DELIVERY to current_task_id
// without checking that order's PICKUP was completed, so a stacked order that joined post-pickup (delivery accepted,
// pickup pending) got a pointer on its DELIVERY while its working task was its PICKUP → the fail-closed pointer gate
// locked the «Recogí el pedido» slide. Fix: point at the next stop's WORKING task — its pickup ONLY for a valid
// actionable pair (type pickup, same order, same driver, accepted|in_progress, reciprocal link), else its delivery.
import assert from 'node:assert/strict';
import { buildCompleteTaskUpdates, TASK_STATUS, TASK_TYPE } from './driver-complete.js';
import { buildCompleteTaskUpdates as buildOLD } from './driver-complete.baseline.fixture.mjs'; // origin/main 51dc55ab, verbatim

const NOW = 1000;
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; }
}
const UID = 'elmer';
const mk = (o) => o; // readability

// ---- named cells --------------------------------------------------------------------------------------------
t('bug #962: deliver stop 1 while stop 2 pickup not completed (valid pair) → pointer = stop 2 PICKUP', () => {
  const A_del = mk({ order_id: 'angelo', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'A_pu' });
  const C_pu = mk({ order_id: 'carolina', type: TASK_TYPE.PICKUP, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 200, linked_task_id: 'C_del' });
  const C_del = mk({ order_id: 'carolina', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'C_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, C_pu, C_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], 'C_pu');
});
t('in_progress pickup (valid pair) → pointer = that PICKUP (not accepted-only)', () => {
  const A_del = mk({ order_id: 'a', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'a_pu' });
  const C_pu = mk({ order_id: 'c', type: TASK_TYPE.PICKUP, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 200, linked_task_id: 'c_del' });
  const C_del = mk({ order_id: 'c', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'c_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, c_pu: C_pu, c_del: C_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], 'c_pu');
});
t('malformed: next delivery whose pickup lacks the reciprocal link → KEEPS the delivery pointer (no tasks/undefined exposure)', () => {
  const A_del = mk({ order_id: 'a', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'a_pu' });
  const C_pu = mk({ order_id: 'c', type: TASK_TYPE.PICKUP, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 200 /* NO linked_task_id */ });
  const C_del = mk({ order_id: 'c', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'c_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, c_pu: C_pu, c_del: C_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], 'c_del');
});
t('foreign: next delivery whose pickup belongs to another driver → KEEPS the delivery pointer', () => {
  const A_del = mk({ order_id: 'a', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'a_pu' });
  const C_pu = mk({ order_id: 'c', type: TASK_TYPE.PICKUP, status: TASK_STATUS.ACCEPTED, assigned_driver_id: 'other', created_at: 200, linked_task_id: 'c_del' });
  const C_del = mk({ order_id: 'c', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'c_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, c_pu: C_pu, c_del: C_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], 'c_del');
});
t('control: stop 2 already picked up (pickup completed) → pointer = delivery (unchanged)', () => {
  const A_del = mk({ order_id: 'a', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'a_pu' });
  const C_pu = mk({ order_id: 'c', type: TASK_TYPE.PICKUP, status: TASK_STATUS.COMPLETED, assigned_driver_id: UID, created_at: 200, linked_task_id: 'c_del' });
  const C_del = mk({ order_id: 'c', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED, assigned_driver_id: UID, created_at: 201, linked_task_id: 'c_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del, c_pu: C_pu, c_del: C_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], 'c_del');
});
t('single-order golden: deliver the only order → null + RETURNING (unchanged)', () => {
  const A_del = mk({ order_id: 'a', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'a_pu' });
  const u = buildCompleteTaskUpdates({ driverId: UID, taskId: 'A_del', task: A_del, allTasks: { A_del }, now: NOW });
  assert.equal(u[`drivers/${UID}/current_task_id`], null);
  assert.equal(u[`drivers/${UID}/status`], 'returning');
});

// ---- ORACLE: EXPECTED = OLD with EXACTLY the permitted pointer replacement (mirrors the fix spec). ----------
// deep-compare NEW === EXPECTED on EVERY scenario, so the fix is REQUIRED (not merely permitted) in every case.
const PTR = `drivers/${UID}/current_task_id`;
function expected(taskId, task, allTasks) {
  const old = buildOLD({ driverId: UID, taskId, task, allTasks, now: NOW });
  const dId = old[PTR];
  const d = (typeof dId === 'string') ? allTasks[dId] : null;
  if (d && d.type === TASK_TYPE.DELIVERY) {
    const pId = d.linked_task_id;
    const p = pId ? allTasks[pId] : null;
    const valid = !!(p && p.type === TASK_TYPE.PICKUP && p.order_id === d.order_id && p.assigned_driver_id === UID
      && (p.status === TASK_STATUS.ACCEPTED || p.status === TASK_STATUS.IN_PROGRESS) && p.linked_task_id === dId);
    if (valid) return { ...old, [PTR]: pId };
  }
  return old;
}
function norm(o) { return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]])); }
function compare(label, taskId, task, allTasks, counters) {
  counters.scenarios++;
  let oErr = null, nErr = null, exp, got;
  try { exp = expected(taskId, task, allTasks); } catch (e) { oErr = e.message; }
  try { got = buildCompleteTaskUpdates({ driverId: UID, taskId, task, allTasks, now: NOW }); } catch (e) { nErr = e.message; }
  assert.equal(!!oErr, !!nErr, `${label} throw mismatch: old=${oErr} new=${nErr}`);
  if (oErr) { assert.equal(oErr, nErr, `${label} error text`); counters.throws++; return; }
  assert.equal(norm(got), norm(exp), `${label}\n    expected ${norm(exp)}\n    got      ${norm(got)}`);
  if (got[PTR] !== buildOLD({ driverId: UID, taskId, task, allTasks, now: NOW })[PTR]) counters.subst++;
}

const STATUSES = [TASK_STATUS.ASSIGNED, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED];
function* legCombos(n) {
  if (n === 0) { yield []; return; }
  for (const rest of legCombos(n - 1)) for (const pu of STATUSES) for (const del of STATUSES) yield [...rest, { pu, del }];
}

t('EQUIVALENCE A — status matrix (1–3 orders, reciprocal links): NEW === EXPECTED on every scenario', () => {
  const c = { scenarios: 0, throws: 0, subst: 0 };
  for (let n = 1; n <= 3; n++) for (const combo of legCombos(n)) {
    const all = {};
    combo.forEach(({ pu, del }, i) => {
      all[`o${i}_pickup`]   = { order_id: `o${i}`, type: TASK_TYPE.PICKUP,   status: pu,  assigned_driver_id: UID, created_at: 100 + i * 10,     linked_task_id: `o${i}_delivery` };
      all[`o${i}_delivery`] = { order_id: `o${i}`, type: TASK_TYPE.DELIVERY, status: del, assigned_driver_id: UID, created_at: 100 + i * 10 + 1, linked_task_id: `o${i}_pickup` };
    });
    for (const taskId of Object.keys(all)) compare(`A n=${n} ${taskId}`, taskId, all[taskId], all, c);
  }
  console.log(`    A: ${c.scenarios} scenarios, ${c.throws} identical throws, ${c.subst} pointer substitutions`);
  assert.ok(c.subst > 0, 'substitution must occur somewhere');
});

t('EQUIVALENCE B — adversarial (link mode × owner × statuses): NEW === EXPECTED', () => {
  const c = { scenarios: 0, throws: 0, subst: 0 };
  const LINK = { recip: 'o1_delivery', wrong: 'o9_delivery', missing: undefined };
  const OWNERS = [UID, 'other'];
  // order0 = the completing delivery, picked up; order1 = the promoted candidate, varied.
  for (const puS of STATUSES) for (const delS of [TASK_STATUS.ASSIGNED, TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS]) {
    for (const lk of Object.keys(LINK)) for (const owner of OWNERS) for (const dropPickup of [false, true]) {
      const all = {
        o0_pickup:   { order_id: 'o0', type: TASK_TYPE.PICKUP,   status: TASK_STATUS.COMPLETED,   assigned_driver_id: UID, created_at: 100, linked_task_id: 'o0_delivery' },
        o0_delivery: { order_id: 'o0', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'o0_pickup' },
        o1_delivery: { order_id: 'o1', type: TASK_TYPE.DELIVERY, status: delS, assigned_driver_id: UID, created_at: 110, linked_task_id: 'o1_pickup' },
      };
      if (!dropPickup) all.o1_pickup = { order_id: 'o1', type: TASK_TYPE.PICKUP, status: puS, assigned_driver_id: owner, created_at: 109, linked_task_id: LINK[lk] };
      compare(`B lk=${lk} owner=${owner} pu=${puS} del=${delS} drop=${dropPickup}`, 'o0_delivery', all.o0_delivery, all, c);
    }
  }
  console.log(`    B: ${c.scenarios} scenarios, ${c.throws} throws, ${c.subst} substitutions`);
});

t('EQUIVALENCE C — created_at ties: selection unchanged, NEW === EXPECTED', () => {
  const c = { scenarios: 0, throws: 0, subst: 0 };
  // two candidate deliveries sharing created_at; OLD keeps first-encountered → NEW must match
  const all = {
    x_pickup:   { order_id: 'x', type: TASK_TYPE.PICKUP,   status: TASK_STATUS.COMPLETED,   assigned_driver_id: UID, created_at: 100, linked_task_id: 'x_delivery' },
    x_delivery: { order_id: 'x', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.IN_PROGRESS, assigned_driver_id: UID, created_at: 101, linked_task_id: 'x_pickup' },
    y_pickup:   { order_id: 'y', type: TASK_TYPE.PICKUP,   status: TASK_STATUS.ACCEPTED,    assigned_driver_id: UID, created_at: 200, linked_task_id: 'y_delivery' },
    y_delivery: { order_id: 'y', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED,    assigned_driver_id: UID, created_at: 200, linked_task_id: 'y_pickup' },
    z_pickup:   { order_id: 'z', type: TASK_TYPE.PICKUP,   status: TASK_STATUS.COMPLETED,   assigned_driver_id: UID, created_at: 200, linked_task_id: 'z_delivery' },
    z_delivery: { order_id: 'z', type: TASK_TYPE.DELIVERY, status: TASK_STATUS.ACCEPTED,    assigned_driver_id: UID, created_at: 200, linked_task_id: 'z_pickup' },
  };
  compare('C tie', 'x_delivery', all.x_delivery, all, c);
  console.log(`    C: ${c.scenarios} scenario, ${c.subst} substitution(s)`);
});

console.log(`driver-complete (#962 regression + equivalence r2): ${passed} passed`);
