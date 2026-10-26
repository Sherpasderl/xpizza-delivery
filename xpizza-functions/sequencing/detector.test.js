'use strict';
// BUILD-stacked-seq-server r5 T7 — the out-of-sequence detector: delivery-time evidence ONLY. A missed alert is acceptable; a
// false one is not. The alert IS the record: ONE create-only dispatcher_alerts/oos_<stack_id>, checked FIRST so a retry exits.
// Run: node sequencing/detector.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { detectOutOfSequence, isDeliveryCompletion } = require('./detector');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('detector: FAILED — exited without completing'); process.exitCode = 1; } });

const UID = 'drv_tb_1'; const SID = 'stk_tb';
const copy = (oid, seq, over = {}) => ({ order_id: oid, type: 'delivery', status: 'accepted', assigned_driver_id: UID, assigned_at: 1000, stack_id: SID, stop_seq: seq, stack_uid: UID, stack_at: 1000, ...over });
// ord_a is rank 1, ord_b rank 2; the driver delivers ord_b FIRST
function world(over = {}) {
  return createFakeDb({
    stacks: { [SID]: { state: 'committed', driver_uid: UID, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 2 } },
    orders: { ord_a: { status: 'preparing' }, ord_b: { status: 'delivered', delivered_by_driver_uid: UID } },
    tasks: { ord_a_delivery: copy('ord_a', 1), ...(over.tasks || {}) },
    ...(over.root || {}),
  });
}
const bAfter = (over = {}) => copy('ord_b', 2, { status: 'completed', completed_at: 5000, ...over });
const bBefore = copy('ord_b', 2);
const run = (db, { taskId = 'ord_b_delivery', before = bBefore, after = bAfter() } = {}) => detectOutOfSequence({ db, taskId, before, after });
const alerts = (db) => db.get('dispatcher_alerts') || {};

(async () => {
  // ── 1. out of order → ONE alert, the record ──────────────────────────────────────────────────────────────
  {
    const db = world();
    assert.strictEqual(await run(db), 'alerted');
    assert.deepStrictEqual(alerts(db), { [`oos_${SID}`]: { type: 'out_of_sequence', order_id: 'ord_b', stack_id: SID, driver_uid: UID, at: 5000 } });
    // duplicate events → still one
    assert.strictEqual(await run(db), 'exists'); assert.strictEqual(await run(db), 'exists');
    assert.strictEqual(Object.keys(alerts(db)).length, 1);
    ok('rank 2 delivered while rank 1 is still live → ONE create-only alert oos_<stack_id>; duplicate events → no second write');
  }

  // ── 2. a retry after the alert committed exits on the alert, even with the sibling evidence gone ────────────
  {
    const db = world(); await run(db);
    db.put('tasks/ord_a_delivery', null); db.put('stacks', null);
    let reads = 0; const spy = { ...db, ref: (p) => { const r = db.ref(p); return { ...r, once: (...a) => { reads++; return r.once(...a); } }; } };
    assert.strictEqual(await run(spy), 'exists', 'a retry exits on the existing alert'); assert.strictEqual(reads, 1, 'ONE read: the alert');
    ok('a retry after the alert committed exits on the existing alert with ONE read (the sibling evidence is not needed again)');
  }

  // ── 3. no alert without delivery-time evidence ───────────────────────────────────────────────────────────
  {
    const none = async (label, db, opts) => { assert.strictEqual(await run(db, opts), 'none', label); assert.deepStrictEqual(alerts(db), {}, `${label}: no alert`); };
    // in order: rank 1 completed first (its task gone), then rank 2 completes
    await none('in-order (stop 1 done, its task deleted)', (() => { const d = world(); d.put('tasks/ord_a_delivery', null); return d; })());
    // the rank-1 completion itself
    await none('the rank-1 completion', world(), { taskId: 'ord_a_delivery', before: copy('ord_a', 1), after: copy('ord_a', 1, { status: 'completed', completed_at: 4000 }) });
    // the sibling cancelled: order status FIRST (its task still accepted)
    await none('sibling order cancelled (task still accepted)', world({ root: { orders: { ord_a: { status: 'cancelled' }, ord_b: { status: 'delivered', delivered_by_driver_uid: UID } } } }));
    for (const st of ['delivered', 'completed', 'refund_pending']) {
      await none(`sibling order ${st}`, world({ root: { orders: { ord_a: { status: st }, ord_b: { status: 'delivered', delivered_by_driver_uid: UID } } } }));
    }
    // a manual reunion / transfer: the sibling (or the delivered member) was re-assigned after the stack → provenance invalid
    await none('a manual reunion (sibling assigned_at > stack_at)', world({ tasks: { ord_a_delivery: copy('ord_a', 1, { assigned_at: 2000 }) } }));
    await none('a both-member transfer (delivered member provenance invalid)', world(), { after: bAfter({ assigned_at: 2000 }) });
    await none('sibling on another driver', world({ tasks: { ord_a_delivery: copy('ord_a', 1, { assigned_driver_id: 'drv_x', stack_uid: 'drv_x' }) } }));
    await none('sibling task completed', world({ tasks: { ord_a_delivery: copy('ord_a', 1, { status: 'completed' }) } }));
    await none('sibling task cancelled', world({ tasks: { ord_a_delivery: copy('ord_a', 1, { status: 'cancelled' }) } }));
    // a refused / legacy / manual stack
    await none('a refused record', world({ root: { stacks: { [SID]: { state: 'refused', driver_uid: UID, pair: ['ord_a', 'ord_b'] } } } }));
    await none('no record (legacy / manual)', world({ root: { stacks: null } }));
    await none('the record ranks it 1', world({ root: { stacks: { [SID]: { state: 'committed', driver_uid: UID, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 2, ord_b: 1 } } } } }));
    await none('another driver delivered it', world({ root: { orders: { ord_a: { status: 'preparing' }, ord_b: { status: 'delivered', delivered_by_driver_uid: 'drv_x' } } } }));
    await none('the delivered copy is rank 1', world(), { after: bAfter({ stop_seq: 1 }) });
    await none('no copy at all', world(), { after: { order_id: 'ord_b', type: 'delivery', status: 'completed', assigned_driver_id: UID, assigned_at: 1 } });
    // a read failure → no alert
    const f = world(); f.failReads.add('tasks/ord_a_delivery'); await none('a sibling read failure', f);
    ok('no alert: in order, the rank-1 completion, sibling cancelled/delivered/refund_pending, reunion, transfer, other driver, sibling task done, refused/legacy/re-ranked record, delivered by someone else, no/rank-1 copy, a read failure');
  }

  // ── 4. a non-completion write returns with ZERO reads ────────────────────────────────────────────────────
  {
    let reads = 0; const db = world(); const spy = { ...db, ref: (p) => { reads++; return db.ref(p); } };
    const writes = [
      { taskId: 'ord_b_pickup', before: { status: 'accepted' }, after: { status: 'completed' } },
      { taskId: 'ord_b_delivery', before: null, after: bAfter() },
      { taskId: 'ord_b_delivery', before: bBefore, after: null },
      { taskId: 'ord_b_delivery', before: bAfter(), after: bAfter({ notes: 'x' }) },
      { taskId: 'ord_b_delivery', before: bBefore, after: copy('ord_b', 2, { status: 'in_progress' }) },
    ];
    for (const w of writes) { assert.strictEqual(isDeliveryCompletion(w.taskId, w.before, w.after), false); assert.strictEqual(await run(spy, w), 'skip'); }
    assert.strictEqual(reads, 0, 'zero reads');
    assert.strictEqual(isDeliveryCompletion('ord_b_delivery', bBefore, bAfter()), true);
    ok('a pickup write, a create, a delete, a re-write of a completed task, a non-completion transition → skip with ZERO reads');
  }

  FINISHED = true;
  console.log(`\ndetector: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
