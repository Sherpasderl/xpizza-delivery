'use strict';
/**
 * retention-sweep.test.js — EXECUTES the real runRetentionSweep (the extracted retentionSweepTasks execute body)
 * against an in-memory RTDB fake. This is the executable coverage the backstop needs (the prior "composition" test
 * only built its own payload). Run:  node retention-sweep.test.js
 *
 * Proves: dry-run gate; ACTUAL deletes; both terminal statuses capture; cancelled excluded from attribution;
 * existing-capture no-clobber; concurrent-safe (CAS); fresh per-candidate driver read; and — the load-bearing one —
 * a backstop read failure on one candidate NEVER aborts the batch delete (isolated per candidate).
 */
const assert = require('assert');
const { runRetentionSweep } = require('./retention-sweep');
const { HEAL_TERMINAL_STATUSES } = require('./sweep-pending');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const A = 'driverA', B = 'driverB', C = 'driverC', X = 'driverX', Y = 'driverY', Z = 'driverZ';

// RTDB fake: EAGER snapshots (once() captures the value at read time — a later mutation doesn't change an earlier
// snapshot, modelling a real batch snapshot); per-path throw injection; afterRead hook (fires once after a given
// path is read — used to mutate state BETWEEN the batch read and the fresh per-candidate read); update/set reject
// undefined ANYWHERE (nested too); transaction is a CAS.
function makeDb(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const throwReads = new Set();
  const afterRead = new Map();   // exact path → one-shot callback fired after once() captures its snapshot
  const parts = (p) => String(p || '').split('/').filter((s) => s.length);
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const hasUndef = (v) => v === undefined || (v && typeof v === 'object' && Object.values(v).some(hasUndef));
  const getAt = (p) => { let n = store; for (const k of parts(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, v) => {
    if (hasUndef(v)) throw new Error(`RTDB write rejected: undefined in payload at "${p}"`);   // nested too
    const ks = parts(p); let n = store;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== 'object' || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; }
    const leaf = ks[ks.length - 1];
    if (v === null) delete n[leaf]; else n[leaf] = clone(v);
  };
  const ref = (path) => ({
    once: async () => {
      for (const pre of throwReads) if (String(path || '') === pre) throw new Error(`read failure: ${path}`);
      const v = clone(getAt(path));                                   // EAGER snapshot (fixed at read time)
      if (afterRead.has(path)) { const cb = afterRead.get(path); afterRead.delete(path); cb(); }
      return { val: () => v };
    },
    set: async (v) => setAt(path, v),
    update: async (obj) => { for (const k of Object.keys(obj)) setAt(k, obj[k]); },
    transaction: async (fn) => { const res = fn(clone(getAt(path))); if (res === undefined) return { committed: false, snapshot: { val: () => clone(getAt(path)) } }; setAt(path, res); return { committed: true, snapshot: { val: () => clone(res) } }; },
  });
  return { ref, get: getAt, rawSet: setAt, throwReads, afterRead };
}
// A terminal order + its two tasks (delivery carries the driver).
const withTasks = (status, driver, extra = {}) => ({ order: { status, ...extra }, driver });
function seed(orders, execute = true) {
  const state = { orders: {}, tasks: {}, config: { retention: { tasks_mode: execute ? 'execute' : undefined } } };
  for (const [oid, { order, driver }] of Object.entries(orders)) {
    state.orders[oid] = order;
    state.tasks[`${oid}_pickup`] = { order_id: oid };
    state.tasks[`${oid}_delivery`] = { order_id: oid, ...(driver ? { assigned_driver_id: driver } : {}) };
  }
  return makeDb(state);
}
const run = (db) => runRetentionSweep(db, { healTerminalStatuses: HEAL_TERMINAL_STATUSES });

(async () => {
  // 1. DRY-RUN gate — no config → nothing deleted, nothing attributed.
  {
    const db = seed({ O1: withTasks('delivered', A) }, false);
    const r = await run(db);
    assert.strictEqual(r.mode, 'dry_run', 'no execute mode → dry-run');
    assert.ok(db.get('tasks/O1_delivery'), 'dry-run: task NOT deleted');
    assert.strictEqual(db.get('orders/O1/delivered_by_uid'), null, 'dry-run: no attribution');
    ok('dry-run gate: candidates listed, nothing deleted/attributed');
  }

  // 2. Execute — ACTUAL deletes + both terminal statuses capture attribution.
  {
    const db = seed({ O1: withTasks('delivered', A), O2: withTasks('completed', B) });
    const r = await run(db);
    assert.strictEqual(r.mode, 'execute', 'execute mode');
    assert.strictEqual(r.confirmed, 4, 'all 4 task rows confirmed for delete');
    ['O1_pickup', 'O1_delivery', 'O2_pickup', 'O2_delivery'].forEach((t) => assert.strictEqual(db.get(`tasks/${t}`), null, `${t} actually deleted`));
    assert.strictEqual(db.get('orders/O1/delivered_by_uid'), A, 'delivered order → attributed');
    assert.strictEqual(db.get('orders/O2/delivered_by_uid'), B, 'completed order → attributed');
    ok('execute: real deletes of all task legs + attribution for BOTH delivered and completed');
  }

  // 3. Cancelled EXCLUDED from attribution (task still deleted).
  {
    const db = seed({ O3: withTasks('cancelled', C) });
    await run(db);
    assert.strictEqual(db.get('tasks/O3_delivery'), null, 'cancelled: delivery task deleted (HEAL incl cancelled)');
    assert.strictEqual(db.get('orders/O3/delivered_by_uid'), null, 'cancelled: NEVER attributed (was not delivered)');
    ok('cancelled: task reclaimed but NO delivered_by_* (attribution excludes cancelled)');
  }

  // 4. No-clobber / concurrent: an order a real-time capture already stamped keeps its uid even though the task
  //    still carries a (different) driver — the sweep's CAS loses to the prior write. This is the concurrent
  //    real-time-vs-sweep outcome (the CAS in writeDeliveryAttribution is exercised for interleaving in
  //    driver-attribution.test.js §B).
  {
    const db = seed({ O4: withTasks('delivered', Y, { delivered_by_uid: X, delivered_by_name: 'X Name' }) });
    await run(db);
    assert.strictEqual(db.get('tasks/O4_delivery'), null, 'task deleted');
    assert.strictEqual(db.get('orders/O4/delivered_by_uid'), X, 'existing (real-time) attribution PRESERVED — sweep CAS no-clobber');
    assert.strictEqual(db.get('orders/O4/delivered_by_name'), 'X Name', 'existing name preserved');
    ok('no-clobber / concurrent: sweep never overwrites an existing capture (CAS loses to the prior writer)');
  }

  // 5. Fresh per-candidate driver read — NON-VACUOUS: the task's driver CHANGES after the batch snapshot. If the
  //    sweep captured from the stale batch snapshot it would write the OLD driver and this test would FAIL; because
  //    it re-reads the task FRESH per candidate, it writes the NEW driver.
  {
    const db = seed({ O5: withTasks('delivered', X) });   // batch snapshot sees driver X
    db.afterRead.set('tasks', () => db.rawSet('tasks/O5_delivery/assigned_driver_id', Z));   // reassigned to Z AFTER the batch read
    await run(db);
    assert.strictEqual(db.get('orders/O5/delivered_by_uid'), Z, 'attribution == the FRESH per-candidate driver (Z), NOT the stale batch snapshot (X)');
    ok('fresh read (non-vacuous): a post-batch reassignment is captured — stale-batch would have failed this');
  }

  // 6. 🔴 READ-FAILURE ISOLATION: a backstop read throw on ONE candidate must NOT abort the batch delete.
  {
    const db = seed({ O1: withTasks('delivered', A), O2: withTasks('delivered', B) });
    db.throwReads.add('tasks/O1_delivery');   // O1's backstop FRESH task read throws (the initial batch read of 'tasks' is a different path)
    const r = await run(db);
    // Every delete still lands — O1's included (its delete was queued BEFORE the backstop) and O2's untouched.
    ['O1_pickup', 'O1_delivery', 'O2_pickup', 'O2_delivery'].forEach((t) => assert.strictEqual(db.get(`tasks/${t}`), null, `${t} STILL deleted despite O1 backstop read throw`));
    assert.strictEqual(db.get('orders/O1/delivered_by_uid'), null, 'O1 attribution skipped (its read threw) — best-effort');
    assert.strictEqual(db.get('orders/O2/delivered_by_uid'), B, 'O2 attribution unaffected by O1’s failure (isolated per candidate)');
    assert.strictEqual(r.confirmed, 4, 'all 4 deletes confirmed despite the throw');
    ok('read-failure isolation: one candidate’s backstop throw never aborts the batch delete (delete never regresses)');
  }

  // 7. Orphan (task whose order no longer exists) → deleted, no attribution (no order to stamp). (The batch-vs-fresh
  //    LIVE-order skip is confirmTaskDelete's contract, executed in tasks-retention.test.js.)
  {
    const db = makeDb({ tasks: { O7_pickup: { order_id: 'O7' }, O7_delivery: { order_id: 'O7', assigned_driver_id: A } }, config: { retention: { tasks_mode: 'execute' } } });
    const r = await run(db);
    assert.strictEqual(db.get('tasks/O7_delivery'), null, 'orphan delivery task deleted');
    assert.strictEqual(db.get('tasks/O7_pickup'), null, 'orphan pickup task deleted');
    assert.strictEqual(db.get('orders/O7'), null, 'no order to attribute (stays absent)');
    ok('orphan: a task whose order is gone is reclaimed, with no attribution write');
  }

  console.log(`\nAll ${pass} retention-sweep checks passed.`);
})().catch((e) => { console.error('\n✗ FAIL:', e && e.message); process.exit(1); });
