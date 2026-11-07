'use strict';
// BUILD-stacked-seq-server r5 T8 — the cancel promotion (D11 (a), flag-gated) inside cancel-order-core's cleanupTasksAndDriver.
//   OFF: byte-identical — ONE update() exactly as today.
//   ON:  (1) the task cancels FIRST, in their own update(), unconditionally; (2) the survivor = the driver's EXACTLY ONE other
//        accepted / in-progress delivery whose pickup is completed, on this driver, its order non-terminal (a read failure → none);
//        (3) a transaction on drivers/{uid} that aborts unless current_task_id still names a leg of THIS order: survivor →
//        current_task_id = survivor's delivery, status unchanged; none → today's end state; (4) a failure before the promotion
//        commits → today's end state through the same pointer-guarded transaction.
//   D13 (accepted residual): overlapping cancels can leave the pointer on a cancelled survivor — pinned exactly.
// Run: node sequencing/cancel-promotion.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { cleanupTasksAndDriver } = require('../cancel-order-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('cancel-promotion: FAILED — exited without completing'); process.exitCode = 1; } });

const UID = 'drv_tb_1';
const ORD = { order_type: 'delivery', status: 'cancelled' };
// the driver picked up BOTH a and b (a stacked pair, a = stop 1 live); `current` names a's delivery
function world({ flag = true, current = 'ord_a_delivery', status = 'en_route_delivery', bPicked = true, bOrder = 'out_for_delivery', extra = {} } = {}) {
  const leg = (oid, type, st) => ({ order_id: oid, type, status: st, assigned_driver_id: UID });
  return createFakeDb({
    config: flag === 'ABSENT' ? {} : { stack_sequencing_enabled: flag },
    drivers: { [UID]: { name: 'D', status, current_task_id: current } },
    orders: { ord_a: { status: 'cancelled' }, ord_b: { status: bOrder } },
    tasks: {
      ord_a_pickup: leg('ord_a', 'pickup', 'completed'), ord_a_delivery: leg('ord_a', 'delivery', 'in_progress'),
      ord_b_pickup: leg('ord_b', 'pickup', bPicked ? 'completed' : 'accepted'), ord_b_delivery: leg('ord_b', 'delivery', 'accepted'),
      ...extra,
    },
  });
}
// count update() / transaction() calls
function spy(db) {
  const log = [];
  const ref = (p = '') => { const r = db.ref(p); return { ...r, update: (o) => { log.push(['update', p, Object.keys(o).sort()]); return r.update(o); }, transaction: (...a) => { log.push(['transaction', p]); return r.transaction(...a); } }; };
  return { db: { ...db, ref }, log };
}
const clean = (db, oid = 'ord_a') => cleanupTasksAndDriver({ db }, oid, ORD, 1);

(async () => {
  // ── 1. flag OFF / absent: today's ONE update() ─────────────────────────────────────────────────────────────
  for (const flag of [false, 'ABSENT']) {
    const base = world({ flag }); const s = spy(base);
    await clean(s.db);
    assert.deepStrictEqual(s.log, [['update', '', ['drivers/drv_tb_1/current_task_id', 'drivers/drv_tb_1/status', 'tasks/ord_a_delivery/status', 'tasks/ord_a_pickup/status']]], `flag ${flag}: one update as today`);
    assert.deepStrictEqual(base.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'today: pointer null + available');
  }
  ok('flag OFF / absent: ONE update() exactly as today (tasks cancelled, pointer null, status available)');

  // ── 2. ON: a post-pickup cancel of stop 1 → stop 2 live, driver still en_route_delivery ─────────────────────
  {
    const base = world(); const s = spy(base);
    await clean(s.db);
    assert.deepStrictEqual(s.log[0], ['update', '', ['tasks/ord_a_delivery/status', 'tasks/ord_a_pickup/status']], 'the task cancels go FIRST, in their own update');
    assert.deepStrictEqual(base.get(`drivers/${UID}`), { name: 'D', status: 'en_route_delivery', current_task_id: 'ord_b_delivery' });
    assert.strictEqual(base.get('tasks/ord_a_pickup/status'), 'cancelled'); assert.strictEqual(base.get('tasks/ord_a_delivery/status'), 'cancelled');
    ok('ON: cancel of the live stop after pickup → the pointer moves to the survivor, status stays en_route_delivery; task cancels written first');
  }

  // ── 3. ON: cancel of stop 2 (not the pointer) → stop 1 unchanged; no other order → today ────────────────────
  {
    const base = world({ current: 'ord_b_delivery' });
    await clean(base);
    assert.deepStrictEqual(base.get(`drivers/${UID}`), { name: 'D', status: 'en_route_delivery', current_task_id: 'ord_b_delivery' }, 'the pointer was not this order → untouched');
    const solo = world({ extra: { ord_b_pickup: null, ord_b_delivery: null } });
    await clean(solo);
    assert.deepStrictEqual(solo.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'no other order → today');
    const notPicked = world({ bPicked: false });
    await clean(notPicked);
    assert.deepStrictEqual(notPicked.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'the other order not picked up → no survivor → today');
    const terminal = world({ bOrder: 'cancelled' });
    await clean(terminal);
    assert.deepStrictEqual(terminal.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'the other order terminal → no survivor → today');
    const two = world({ extra: { ord_c_pickup: { order_id: 'ord_c', type: 'pickup', status: 'completed', assigned_driver_id: UID }, ord_c_delivery: { order_id: 'ord_c', type: 'delivery', status: 'accepted', assigned_driver_id: UID } } });
    two.put('orders/ord_c', { status: 'out_for_delivery' });
    await clean(two);
    assert.deepStrictEqual(two.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'TWO other loaded orders → not exactly one → today');
    ok('ON: cancel of stop 2 leaves stop 1; no other / not picked up / terminal / two others → today’s end state');
  }

  // ── 4. ON: a survivor-read or transaction failure before the promotion commits → today's end state ─────────
  {
    const r = world(); r.failReads.add('orders/ord_b');
    await clean(r);
    assert.deepStrictEqual(r.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'a survivor read failure → today');
    assert.strictEqual(r.get('tasks/ord_a_pickup/status'), 'cancelled', 'the task writes landed');
    // the promotion transaction throws once → the fallback transaction applies today's end state
    const t = world(); const real = t.ref; let thrown = false;
    const db = { ...t, ref: (p) => { const x = real(p); return p === `drivers/${UID}` ? { ...x, transaction: (fn) => { if (!thrown) { thrown = true; return Promise.reject(new Error('txn boom')); } return x.transaction(fn); } } : x; } };
    await cleanupTasksAndDriver({ db }, 'ord_a', ORD, 1);
    assert.deepStrictEqual(t.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'a promotion txn failure → today');
    // both transactions fail → logs and returns (the callers already catch); the task writes have landed
    const f = world(); const realF = f.ref;
    const dbF = { ...f, ref: (p) => { const x = realF(p); return p === `drivers/${UID}` ? { ...x, transaction: () => Promise.reject(new Error('down')) } : x; } };
    await cleanupTasksAndDriver({ db: dbF }, 'ord_a', ORD, 1);
    assert.strictEqual(f.get('tasks/ord_a_delivery/status'), 'cancelled');
    ok('ON: a survivor read failure or a promotion txn failure → today’s end state (pointer-guarded); both txns failing → returns, tasks cancelled');
  }

  // ── 5. ON: idempotent backstop; the pointer guard; overlapping cancels ─────────────────────────────────────
  {
    const base = world(); await clean(base); const after1 = base.get(`drivers/${UID}`);
    await clean(base);
    assert.deepStrictEqual(base.get(`drivers/${UID}`), after1, 'onOrderCancelled re-running → idempotent');
    // common interleaving: A's cleanup promotes to B; then B is cancelled → B's cleanup sees the pointer on B, no survivor → today
    const ov = world(); await clean(ov);
    ov.put('orders/ord_b/status', 'cancelled'); await clean(ov, 'ord_b');
    assert.deepStrictEqual(ov.get(`drivers/${UID}`), { name: 'D', status: 'available' }, 'overlap (common): the final pointer null + today’s status');
    // D13 residual: A's survivor read saw B live; B's cancel + cleanup ran while the pointer still named A; then A promotes to B
    const rs = world(); const realR = rs.ref; let fired = false;
    const dbR = { ...rs, ref: (p) => { const x = realR(p); return p === `drivers/${UID}` ? { ...x, transaction: async (fn) => {
      if (!fired) { fired = true; rs.put('orders/ord_b/status', 'cancelled'); await cleanupTasksAndDriver({ db: rs }, 'ord_b', ORD, 1); }
      return x.transaction(fn);
    } } : x; } };
    await cleanupTasksAndDriver({ db: dbR }, 'ord_a', ORD, 1);
    assert.deepStrictEqual(rs.get(`drivers/${UID}`), { name: 'D', status: 'en_route_delivery', current_task_id: 'ord_b_delivery' }, 'D13: the pointer on the cancelled B (accepted end state)');
    for (const t of ['ord_a_pickup', 'ord_a_delivery', 'ord_b_pickup', 'ord_b_delivery']) assert.strictEqual(rs.get(`tasks/${t}/status`), 'cancelled', `D13: ${t} cancelled`);
    ok('ON: idempotent re-run; overlapping cancels converge (pointer null) in the common order; the D13 residual end state is pinned exactly');
  }

  FINISHED = true;
  console.log(`\ncancel-promotion: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
