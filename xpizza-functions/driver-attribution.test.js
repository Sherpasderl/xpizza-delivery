'use strict';
/**
 * driver-attribution.test.js — the durable delivery-attribution write-side + the shared name cascade.
 * Run:  node driver-attribution.test.js
 *
 * Drives the REAL exported writers against an in-memory RTDB fake that models the dep: transaction() with
 * optimistic-concurrency re-run (so a CAS faces REAL interposed contention, not two sequential awaits); update()/
 * set() reject undefined ANYWHERE in the payload (nested too — real RTDB errors; only null deletes); and injectable
 * read/write failures. The sweep backstop is executed end-to-end in retention-sweep.test.js.
 */
const assert = require('assert');
const {
  resolveDriverName, writeDeliveryAttribution, shouldBackstopAttribution,
  captureDeliveryAttributionAndDelete, DRIVER_DISPLAY_NAMES,
} = require('./driver-attribution');
const { REALTIME_TERMINAL_STATUSES } = require('./tasks-retention');

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

function makeDb(initial) {
  const store = JSON.parse(JSON.stringify(initial || {}));
  const throwReads = new Set();    // path-prefixes whose once('value') throws
  const throwWrites = new Set();   // exact paths whose update()/set()/transaction() throws
  const interpose = new Map();     // path → one-shot callback fired mid-transaction (models a concurrent commit)
  const parts = (p) => String(p || '').split('/').filter((s) => s.length);
  const clone = (v) => (v === undefined || v === null ? v : JSON.parse(JSON.stringify(v)));
  const hasUndef = (v) => v === undefined || (v && typeof v === 'object' && Object.values(v).some(hasUndef));
  const getAt = (p) => { let n = store; for (const k of parts(p)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, v) => {
    if (hasUndef(v)) throw new Error(`RTDB write rejected: undefined in payload at "${p}" (use null to delete)`);   // nested too
    const ks = parts(p); let n = store;
    for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== 'object' || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; }
    const leaf = ks[ks.length - 1];
    if (v === null) delete n[leaf]; else n[leaf] = clone(v);
  };
  const ref = (path) => ({
    once: async () => { for (const pre of throwReads) if (String(path || '').startsWith(pre)) throw new Error(`read failure: ${path}`); return { val: () => clone(getAt(path)) }; },
    set: async (v) => { if (throwWrites.has(path)) throw new Error(`write failure: ${path}`); setAt(path, v); },
    update: async (obj) => { if (throwWrites.has(path || '')) throw new Error(`update failure: ${path || '(root)'}`); for (const k of Object.keys(obj)) setAt(k, obj[k]); },
    transaction: async (fn) => {
      if (throwWrites.has(path)) throw new Error(`transaction failure: ${path}`);
      for (let i = 0; i < 12; i++) {
        const cur = clone(getAt(path));
        const res = fn(cur);
        if (interpose.has(path)) {                 // a concurrent writer commits between our read and our commit
          interpose.get(path)(); interpose.delete(path);
          if (JSON.stringify(getAt(path)) !== JSON.stringify(cur)) continue;   // value moved → RTDB re-runs fn
        }
        if (res === undefined) return { committed: false, snapshot: { val: () => clone(getAt(path)) } };
        setAt(path, res);
        return { committed: true, snapshot: { val: () => clone(res) } };
      }
      throw new Error('transaction: exceeded retries');
    },
  });
  return { ref, get: getAt, rawSet: setAt, throwReads, throwWrites, interpose };
}

const HERMEZ = 'xaHcwaRND1V63w8tpXi5VZ7n9P72';
const XAVIER = 'HUQ4nOdvNvQcbxoqyYinp8wAC7f2';

(async () => {
  // ── A. resolveDriverName — golden + sensitivity across EVERY cascade branch ──────────────────────
  {
    const empty = makeDb({});
    assert.strictEqual(await resolveDriverName(empty, XAVIER), 'Xavier', 'map hit → Xavier');
    assert.strictEqual(await resolveDriverName(empty, HERMEZ), 'Hermez', 'map hit → Hermez');
    assert.deepStrictEqual(DRIVER_DISPLAY_NAMES, { [XAVIER]: 'Xavier', [HERMEZ]: 'Hermez' }, 'hardcoded map = the two known drivers (extraction byte-identical)');
    const dnDb = makeDb({ drivers: { drvA: { display_name: 'Motoboy Uno' }, drvB: { display_name: 'Otro Nombre' } } });
    assert.strictEqual(await resolveDriverName(dnDb, 'drvA'), 'Motoboy Uno', 'display_name → used');
    assert.strictEqual(await resolveDriverName(dnDb, 'drvB'), 'Otro Nombre', 'sensitivity: different display_name → different result');
    const nmDb = makeDb({ drivers: { drvC: { name: 'hermeztalavera' }, drvD: { name: 'juanPEREZ' } } });
    assert.strictEqual(await resolveDriverName(nmDb, 'drvC'), 'Hermeztalavera', 'name → capitalized');
    assert.strictEqual(await resolveDriverName(nmDb, 'drvD'), 'Juanperez', 'sensitivity: capitalize normalizes case');
    assert.strictEqual(await resolveDriverName(makeDb({}), null), null, 'no driverId → null');
    assert.strictEqual(await resolveDriverName(makeDb({ drivers: { e: { display_name: 42 } } }), 'e'), null, 'non-string display_name ignored → null');
    ok('resolveDriverName: map / display_name / name-capitalize / null — golden + sensitivity');
  }

  // ── B. writeDeliveryAttribution — COMMIT-TIME first-writer-wins CAS (incl. REAL interposed contention) ──
  {
    const db = makeDb({ orders: { O1: { status: 'delivered' } } });
    const r = await writeDeliveryAttribution(db, 'O1', HERMEZ);
    assert.ok(r.written && db.get('orders/O1/delivered_by_uid') === HERMEZ && db.get('orders/O1/delivered_by_name') === 'Hermez', 'fresh order → uid + name stamped');

    // Sequential no-clobber: an already-attributed order is not overwritten (even by a different driver).
    const db2 = makeDb({ orders: { O1: { status: 'delivered', delivered_by_uid: XAVIER, delivered_by_name: 'Xavier' } } });
    const r2 = await writeDeliveryAttribution(db2, 'O1', HERMEZ);
    assert.ok(!r2.written && db2.get('orders/O1/delivered_by_uid') === XAVIER && db2.get('orders/O1/delivered_by_name') === 'Xavier', 'sequential no-clobber: existing attribution preserved');

    // REAL contention: a concurrent writer (XAVIER) commits mid-CAS while HERMEZ is writing → HERMEZ re-runs, sees
    // the committed value, ABORTS. The interpose fires between HERMEZ's read (null) and its commit.
    const db3 = makeDb({ orders: { O1: { status: 'delivered' } } });
    db3.interpose.set('orders/O1/delivered_by_uid', () => db3.rawSet('orders/O1/delivered_by_uid', XAVIER));
    const r3 = await writeDeliveryAttribution(db3, 'O1', HERMEZ);
    assert.strictEqual(r3.written, false, 'contention: our CAS lost to the interposed concurrent writer');
    assert.strictEqual(db3.get('orders/O1/delivered_by_uid'), XAVIER, 'contention: the concurrent writer’s uid stands (no wrong-driver overwrite)');

    const db4 = makeDb({ orders: { O1: { status: 'delivered' } } });
    assert.deepStrictEqual(await writeDeliveryAttribution(db4, 'O1', null), { written: false }, 'no driver → not written');
    assert.strictEqual(db4.get('orders/O1/delivered_by_uid'), null, 'no driver → no uid field');

    const db5 = makeDb({ orders: { O1: { status: 'delivered' } }, drivers: { drvT: { display_name: 'x' } } }); db5.throwReads.add('drivers/');
    assert.ok((await writeDeliveryAttribution(db5, 'O1', 'drvT')).written && db5.get('orders/O1/delivered_by_uid') === 'drvT' && db5.get('orders/O1/delivered_by_name') === null, 'name-read throw → uid written, name absent');

    const db6 = makeDb({ orders: { O1: { status: 'delivered' } }, drivers: { drvW: { name: '   ' } } });
    await writeDeliveryAttribution(db6, 'O1', 'drvW');
    assert.ok(db6.get('orders/O1/delivered_by_uid') === 'drvW' && db6.get('orders/O1/delivered_by_name') === null, 'whitespace-only name → omitted (trimmed → absent)');
    ok('writeDeliveryAttribution: CAS first-writer-wins under REAL interposed contention; no-driver/name-fail/whitespace handled');
  }

  // ── C. captureDeliveryAttributionAndDelete — UNCONDITIONAL delete survives EVERY attribution failure ──
  {
    // happy path.
    const db = makeDb({ orders: { O1: { status: 'delivered' } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } });
    await captureDeliveryAttributionAndDelete(db, 'O1');
    assert.ok(db.get('orders/O1/delivered_by_uid') === HERMEZ && db.get('tasks/O1_pickup') === null && db.get('tasks/O1_delivery') === null, 'happy: uid stamped + both tasks deleted');

    // task-READ throw → attribution skipped, delete still happens.
    const dbR = makeDb({ orders: { O1: { status: 'delivered' } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } }); dbR.throwReads.add('tasks/O1_delivery');
    await captureDeliveryAttributionAndDelete(dbR, 'O1');
    assert.ok(dbR.get('tasks/O1_pickup') === null && dbR.get('tasks/O1_delivery') === null && dbR.get('orders/O1/delivered_by_uid') === null, 'delete-safety: task-read throw → tasks STILL deleted, attribution skipped');

    // CAS-transaction throw → attribution skipped, delete still happens.
    const dbC = makeDb({ orders: { O1: { status: 'delivered' } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } }); dbC.throwWrites.add('orders/O1/delivered_by_uid');
    await captureDeliveryAttributionAndDelete(dbC, 'O1');
    assert.ok(dbC.get('tasks/O1_delivery') === null && dbC.get('orders/O1/delivered_by_uid') === null, 'delete-safety: CAS throw → tasks STILL deleted, attribution skipped');

    // name-SET throw → uid CAS committed, name absent, delete still happens.
    const dbN = makeDb({ orders: { O1: { status: 'delivered' } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } }); dbN.throwWrites.add('orders/O1/delivered_by_name');
    await captureDeliveryAttributionAndDelete(dbN, 'O1');
    assert.ok(dbN.get('orders/O1/delivered_by_uid') === HERMEZ && dbN.get('orders/O1/delivered_by_name') === null && dbN.get('tasks/O1_delivery') === null, 'delete-safety: name-set throw → uid kept, name absent, tasks deleted');

    // DELETE failure → the handler THROWS (retry:true re-fires); the retry converges (CAS no-op, delete succeeds).
    const dbD = makeDb({ orders: { O1: { status: 'delivered' } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } }); dbD.throwWrites.add('');
    await assert.rejects(() => captureDeliveryAttributionAndDelete(dbD, 'O1'), /update failure/, 'delete failure propagates (so the retry:true trigger re-runs)');
    assert.strictEqual(dbD.get('orders/O1/delivered_by_uid'), HERMEZ, 'attribution CAS committed before the delete threw');
    dbD.throwWrites.delete('');                     // the retry
    await captureDeliveryAttributionAndDelete(dbD, 'O1');
    assert.ok(dbD.get('tasks/O1_delivery') === null && dbD.get('orders/O1/delivered_by_uid') === HERMEZ, 'retry converges: delete succeeds, attribution stable (CAS no-op)');

    // no-driver → both tasks deleted, no attribution.
    const dbZ = makeDb({ orders: { O1: { status: 'completed' } }, tasks: { O1_pickup: {}, O1_delivery: {} } });
    await captureDeliveryAttributionAndDelete(dbZ, 'O1');
    assert.ok(dbZ.get('tasks/O1_delivery') === null && dbZ.get('orders/O1/delivered_by_uid') === null, 'no-driver: delete happens, no attribution');
    ok('captureDeliveryAttributionAndDelete: delete is UNCONDITIONAL across task-read / CAS / name-set / delete-retry failures');
  }

  // ── D. Terminal-instant identity (documented rare-race) — PIN current behavior ───────────────────
  {
    // Order reached delivered assigned to XAVIER; a dispatch reassignment then landed HERMEZ on the still-present
    // task before the async terminal handler read it. Current (documented) behavior: capture the task's driver AT
    // READ TIME → HERMEZ, then lock it first-writer-wins. This test pins that behavior (not a bug — a rare race).
    const db = makeDb({ orders: { O1: { status: 'delivered', first_assigned_driver_id: XAVIER } }, tasks: { O1_pickup: {}, O1_delivery: { assigned_driver_id: HERMEZ } } });
    await captureDeliveryAttributionAndDelete(db, 'O1');
    assert.strictEqual(db.get('orders/O1/delivered_by_uid'), HERMEZ, 'terminal-instant-identity: captures the task driver at handler-read time (pins the documented rare-race behavior)');
    ok('terminal-instant identity: attribution = the task driver at handler-read time (documented limitation, pinned)');
  }

  // ── E. shouldBackstopAttribution — the sweep's per-candidate pre-filter ──────────────────────────
  {
    assert.strictEqual(shouldBackstopAttribution({ status: 'delivered' }, 'O1_delivery'), true, 'delivered + _delivery + unstamped → backstop');
    assert.strictEqual(shouldBackstopAttribution({ status: 'completed' }, 'O1_delivery'), true, 'completed + _delivery → backstop');
    assert.strictEqual(shouldBackstopAttribution({ status: 'cancelled' }, 'O1_delivery'), false, 'cancelled → NEVER attributed');
    assert.strictEqual(shouldBackstopAttribution({ status: 'delivered' }, 'O1_pickup'), false, 'pickup task → no attribution');
    assert.strictEqual(shouldBackstopAttribution({ status: 'delivered', delivered_by_uid: HERMEZ }, 'O1_delivery'), false, 'already stamped → skip');
    assert.strictEqual(shouldBackstopAttribution({ status: 'new' }, 'O1_delivery'), false, 'live order → no attribution');
    assert.ok(REALTIME_TERMINAL_STATUSES.has('delivered') && REALTIME_TERMINAL_STATUSES.has('completed') && !REALTIME_TERMINAL_STATUSES.has('cancelled'), 'REALTIME set = delivered/completed, not cancelled');
    ok('shouldBackstopAttribution: delivered/completed _delivery unstamped only');
  }

  // ── F. The fake models the dep: NESTED undefined is rejected (not just top-level) ────────────────
  {
    const db = makeDb({});
    assert.throws(() => db.rawSet('orders/O1', { a: { b: undefined } }), /undefined in payload/, 'fake rejects NESTED undefined (models real RTDB — catches accidental undefined writes)');
    ok('fake fidelity: nested undefined is rejected (only null deletes)');
  }

  console.log(`\nAll ${pass} driver-attribution checks passed.`);
})().catch((e) => { console.error('\n✗ FAIL:', e && e.message); process.exit(1); });
