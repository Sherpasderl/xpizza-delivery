'use strict';
require('./_no-secrets');   // R3 P1-a (codex r2 P1-1c): no real credential in a test process
// R3 P0 — THE WRITE GATE + MATCHER acceptance cells (PLAN-R3 rev 4.1 §2b.1–§2b.4). Nothing RUNS here: every DB trigger
// discovered from index.js is matched and RECORDED, and the formed event is inspected through the scheduler's tap.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-gate
require('../test/_emulator-required')('database', 'firestore');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
const D = require('./discovery');
const { createScheduler, expandUnder, bindPrefix, segsOf } = require('./scheduler');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;

const app = require('../index.js');
const TRIGGERS = D.dbTriggers(D.runtimeInventory(app));
const TAPPED = [];
const S = createScheduler({ admin, triggers: TRIGGERS, run: new Set(), tap: (rec, event) => TAPPED.push({ rec, event }) }).install();
const rtdb = admin.database();
const since = (mark) => ({ tr: S.state.transitions.slice(mark.t), rec: S.state.records.slice(mark.r), tap: TAPPED.slice(mark.p) });
const mark = () => ({ t: S.state.transitions.length, r: S.state.records.length, p: TAPPED.length });
const of = (recs, exp, p) => recs.filter((r) => r.export === exp && (p === undefined || r.path === p));

(async () => {
  await S.fixture(() => rtdb.ref().set(null));

  // U0 — pure matcher units
  assert.deepStrictEqual(bindPrefix(segsOf('orders/o1/status'), segsOf('orders/{orderId}')), { orderId: 'o1' }, FAIL('U0', 'below: P cut to T binds the param'));
  assert.strictEqual(bindPrefix(segsOf('tasks/t1/x'), segsOf('orders/{orderId}')), null, FAIL('U0', 'a different literal does not bind'));
  assert.deepStrictEqual(expandUnder(['order_events'], segsOf('order_events/{orderId}/{eventId}'), { o1: { e1: 1, e2: 2 }, o2: { e3: 3 } }).sort(),
    ['order_events/o1/e1', 'order_events/o1/e2', 'order_events/o2/e3'], FAIL('U0', 'above: every concrete instance under P'));
  ok('U0 matcher units: below-binding, literal mismatch, above-expansion over a tree');

  // G8 — a declared FIXTURE write records nothing
  {
    const m = mark();
    await S.fixture(() => rtdb.ref('orders/fx').set({ status: 'new' }));
    assert.deepStrictEqual(since(m).tr, [], FAIL('G8', 'a fixture write made a transition'));
    ok('G8 a declared fixture write is not a scenario transition (no record, no fan-out)');
  }

  // G1 — a write BELOW orders/{orderId} and AT orders/{orderId}/status
  {
    await rtdb.ref('orders/g1').set({ status: 'new', order_id: 'g1' });
    const m = mark();
    await rtdb.ref('orders/g1/status').set('preparing');
    const x = since(m);
    assert.strictEqual(x.tr.length, 1, FAIL('G1', 'one transition'));
    const atOrder = of(x.rec, 'autoAssignOnOrderCreate', 'orders/g1');
    const atStatus = of(x.rec, 'mirrorStatusToHistory', 'orders/g1/status');
    assert.ok(atOrder.length === 1 && atOrder[0].params.orderId === 'g1', FAIL('G1', `orders/{orderId} fired once for the BELOW write, params bound (${JSON.stringify(atOrder)})`));
    assert.strictEqual(atStatus.length, 1, FAIL('G1', 'orders/{orderId}/status fired once for the AT write'));
    const ev = x.tap.find((t) => t.rec === atOrder[0]).event;
    assert.ok(ev.data.before.val().status === 'new' && ev.data.after.val().status === 'preparing', FAIL('G1', 'written event: before / after DataSnapshots carry the exact values'));
    assert.strictEqual(ev.data.after.key, 'g1', FAIL('G1', 'after.key is the instance key'));
    const multi = new Set(x.rec.map((r) => r.export));
    ok(`G1 below + at: one transition fired ${x.rec.length} records across ${multi.size} exports (orders/{orderId} once, params {orderId:'g1'}; …/status once); before/after snapshots exact`);
  }

  // G5 — an UNCHANGED write fires no 'written'
  {
    const m = mark();
    await rtdb.ref('orders/g1/status').set('preparing');
    assert.deepStrictEqual(since(m).rec, [], FAIL('G5', `an unchanged write fired ${JSON.stringify(since(m).rec.map((r) => r.export))}`));
    ok('G5 an unchanged write (before == after) records the transition but fires nothing');
  }

  // G2 — a write ABOVE a created pattern: one created fire per new instance, event.data is the snapshot
  {
    const m = mark();
    await rtdb.ref('order_events/g1').set({ e1: { to: 'new', at: 1 }, e2: { to: 'preparing', at: 2 } });
    const x = since(m);
    const created = of(x.rec, 'predictReadyTimeOnNew');
    assert.deepStrictEqual(created.map((r) => r.path).sort(), ['order_events/g1/e1', 'order_events/g1/e2'], FAIL('G2', `one created fire per new instance under the above-write (${JSON.stringify(created.map((r) => r.path))})`));
    const ev = x.tap.find((t) => t.rec === created.find((r) => r.path === 'order_events/g1/e1')).event;
    assert.ok(ev.data.val().to === 'new' && ev.data.key === 'e1' && ev.params.orderId === 'g1' && ev.params.eventId === 'e1', FAIL('G2', 'created event: data.val() works, key + params bound'));
    ok('G2 above a created pattern: one created fire per new instance; event.data is the instance DataSnapshot (val(), key, params {orderId, eventId})');
  }

  // G3 — re-writing existing instances is NOT 'created'; removing an order is a 'written' with after = null
  {
    const m = mark();
    await rtdb.ref('order_events/g1/e1').set({ to: 'new', at: 9 });
    assert.strictEqual(of(since(m).rec, 'predictReadyTimeOnNew').length, 0, FAIL('G3', 'a changed EXISTING instance fired created'));
    const m2 = mark();
    await rtdb.ref('orders/g1').remove();
    const del = of(since(m2).rec, 'autoAssignOnOrderCreate', 'orders/g1');
    const ev = since(m2).tap.find((t) => t.rec === del[0]);
    assert.ok(del.length === 1 && ev.event.data.after.val() === null && ev.event.data.before.val().status === 'preparing', FAIL('G3', 'remove → written with after null'));
    ok('G3 an existing instance changed → no created; remove → written with after = null, before = the old value');
  }

  // G4 — a multipath UPDATE at the root is ONE transition across trees
  {
    const m = mark();
    await rtdb.ref().update({ 'orders/g2/status': 'new', 'tasks/g2_pickup/assigned_driver_id': 'drv_x' });
    const x = since(m);
    assert.strictEqual(x.tr.length, 1, FAIL('G4', `a multipath update is ONE transition (${x.tr.length})`));
    assert.deepStrictEqual(x.tr[0].paths.sort(), ['orders/g2/status', 'tasks/g2_pickup/assigned_driver_id'], FAIL('G4', 'its paths'));
    const exps = new Set(x.rec.map((r) => `${r.export}@${r.path}`));
    for (const want of ['autoAssignOnOrderCreate@orders/g2', 'mirrorStatusToHistory@orders/g2/status', 'notifyDriverOnAssignment@tasks/g2_pickup', 'monitorAssignmentTimeout@tasks/g2_pickup/assigned_driver_id']) {
      assert.ok(exps.has(want), FAIL('G4', `missing ${want} in ${[...exps].join(', ')}`));
    }
    ok(`G4 a root multipath update = ONE transition (2 paths) firing across both trees (${x.rec.length} records incl. tasks/{taskId} and …/assigned_driver_id)`);
  }

  // G6 — a transaction is recorded at its committed result
  {
    const m = mark();
    await rtdb.ref('orders/g3/status').transaction((cur) => (cur === null ? 'new' : cur));
    const x = since(m);
    assert.ok(x.tr.length === 1 && x.tr[0].kind === 'transaction', FAIL('G6', 'one transaction transition'));
    assert.strictEqual(of(x.rec, 'mirrorStatusToHistory', 'orders/g3/status').length, 1, FAIL('G6', 'its committed result fired'));
    ok('G6 a transaction is one transition, matched on its committed result');
  }

  // G7 — push(value): the generated key is the instance; the returned ref resolves to a non-thenable Reference
  {
    const m = mark();
    const ref = rtdb.ref('order_events/g4').push({ to: 'new', at: 3 });
    const k = ref.key;
    const resolved = await ref;
    assert.ok(resolved && resolved.key === k && typeof resolved.then !== 'function', FAIL('G7', 'push resolves to a fresh, non-thenable Reference with the same key'));
    const c = of(since(m).rec, 'predictReadyTimeOnNew');
    assert.ok(c.length === 1 && c[0].path === `order_events/g4/${k}`, FAIL('G7', `push(value) fired created for its own key (${JSON.stringify(c)})`));
    ok('G7 push(value): key generated as the SDK does, written through the gate, created fired for that key; the result resolves to a plain Reference');
  }

  console.log(`\nr3-p0-gate: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-gate FAILED:', e && e.stack || e); process.exit(1); });
