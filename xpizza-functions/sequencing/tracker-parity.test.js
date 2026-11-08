'use strict';
// BUILD-stacked-seq-server r5 T6 — tracker parity, BEFORE 2f lands: the pickup batch is driven through a CONTRACT HELPER that
// writes exactly the §1 2f obligation this server build can rely on (after pickup, current_task_id = the delivery of the LOWEST
// VALID stop_seq remaining; else today's pointer), and the REAL tracker derivation (tracking/derive.js, unchanged) is asked at
// every step. What it proves today:
//   • an I-first pair (rank order = order time): pre → stop 1 LIVE / stop 2 WAITING → stop 2 LIVE → terminal;
//   • an N-first pair: with 2f's stop_seq SORT re-copied into tracking/driver-orders.js (and the tie check stop_seq-aware), stop 1
//     is LIVE and stop 2 WAITING (the gap this file pinned is closed);
//   • the stacked-seq consumption matrix at EQUAL created_at (a valid pair → LIVE/WAITING; mismatched / stale provenance →
//     NEUTRAL/NEUTRAL; three orders → legacy created_at);
//   • a survivor after a pre-pickup unassign: its stale copy is inert (validity) → the lone order is LIVE;
//   • a manual reunion (assigned_at > stack_at): order-time, as today;
//   • flag OFF (no copies): today's pointer → today's tracker; the single-order golden is unchanged.
// The joint acceptance cell with the REAL driver SDK + rendered board is 2f's (plan §3).
// Run: node sequencing/tracker-parity.test.js
const assert = require('assert');
const { deriveOrderTracker } = require('../tracking/derive');
const { validPair } = require('./validity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('tracker-parity: FAILED — exited without completing'); process.exitCode = 1; } });

const UID = 'drv_tb_1'; const SID = 'stk_tb';
const leg = (oid, type, status, created_at, extra = {}) => ({ order_id: oid, type, status, assigned_driver_id: UID, assigned_at: 1000, created_at, ...extra });
const copy = (seq, plus = null) => ({ stack_id: SID, stop_seq: seq, stack_uid: UID, stack_at: 1000, stack_plus_min: plus });
// the world: ord_i (older) and ord_n, both accepted on the driver; ranks given
function world({ rankI = 1, copies = true } = {}) {
  const rankN = rankI === 1 ? 2 : 1;
  const tasks = {
    ord_i_pickup: leg('ord_i', 'pickup', 'accepted', 100), ord_i_delivery: leg('ord_i', 'delivery', 'accepted', 100, copies ? copy(rankI, rankI === 2 ? 3 : null) : {}),
    ord_n_pickup: leg('ord_n', 'pickup', 'accepted', 200), ord_n_delivery: leg('ord_n', 'delivery', 'accepted', 200, copies ? copy(rankN, rankN === 2 ? 3 : null) : {}),
  };
  return { tasks, orders: { ord_i: { status: 'preparing' }, ord_n: { status: 'preparing' } }, driver: { uid: UID, active: true, current_shift_id: 'sh', current_task_id: 'ord_i_pickup' } };
}
// THE CONTRACT HELPER — the §1 2f pickup obligation: both pickups completed in one batch (a stacked pickup), the pointer to the
// delivery of the LOWEST VALID stop_seq remaining (validity per §1); with no valid pair, today's pointer (the swiped order's delivery)
function pickupBatch(w, swipedOid) {
  for (const oid of ['ord_i', 'ord_n']) { w.tasks[`${oid}_pickup`].status = 'completed'; w.orders[oid].status = 'out_for_delivery'; }
  w.driver.current_task_id = nextPointer(w) || `${swipedOid}_delivery`;
}
function nextPointer(w) {
  const live = ['ord_i', 'ord_n'].map((o) => w.tasks[`${o}_delivery`]).filter((t) => t && t.status !== 'completed' && t.status !== 'cancelled');
  if (live.length === 2 && validPair(live[0], live[1])) return live[0].stop_seq < live[1].stop_seq ? `${live[0].order_id}_delivery` : `${live[1].order_id}_delivery`;
  return live.length === 1 ? `${live[0].order_id}_delivery` : null;
}
function deliver(w, oid) {
  w.tasks[`${oid}_delivery`].status = 'completed'; w.orders[oid].status = 'delivered';
  w.driver.current_task_id = nextPointer(w);
}
const mode = (w, oid) => deriveOrderTracker({ orderId: oid, order: w.orders[oid], pickup: w.tasks[`${oid}_pickup`], delivery: w.tasks[`${oid}_delivery`], owner: w.driver, ownerTasks: w.tasks }).mode;
const both = (w) => [mode(w, 'ord_i'), mode(w, 'ord_n')];

(() => {
  // ── 1. I-first: pre → live/waiting → live → terminal ────────────────────────────────────────────────────────
  {
    const w = world({ rankI: 1 });
    assert.deepStrictEqual(both(w), ['pre', 'pre'], 'before pickup: pre');
    pickupBatch(w, 'ord_n');   // whichever pickup was swiped, the pointer goes to stop 1
    assert.strictEqual(w.driver.current_task_id, 'ord_i_delivery');
    assert.deepStrictEqual(both(w), ['live', 'waiting'], 'after pickup: stop 1 live, stop 2 waiting');
    deliver(w, 'ord_i');
    assert.deepStrictEqual(both(w), ['terminal', 'live'], 'stop 1 delivered → stop 2 live');
    deliver(w, 'ord_n');
    assert.deepStrictEqual(both(w), ['terminal', 'terminal']);
    ok('I-first: pre → stop 1 LIVE / stop 2 WAITING (whichever pickup was swiped) → stop 2 LIVE → terminal');
  }
  // ── 2. N-first: with 2f's stop_seq sort re-copied, the pointer's stop 1 is element 0 → LIVE / WAITING (gap closed) ──
  {
    const w = world({ rankI: 2 });
    pickupBatch(w, 'ord_i');
    assert.strictEqual(w.driver.current_task_id, 'ord_n_delivery', 'the pointer follows the rank');
    assert.deepStrictEqual(both(w), ['waiting', 'live'], 'N-first: stop 1 (ord_n) LIVE, stop 2 (ord_i) WAITING — the tracker agrees with the driver card');
    deliver(w, 'ord_n');
    assert.deepStrictEqual(both(w), ['live', 'terminal'], 'after stop 1 (N) is delivered, the remaining order is live');
    ok('N-first: stop 1 LIVE / stop 2 WAITING (2f’s stop_seq sort re-copied — the pinned gap closed); after stop 1, the survivor is LIVE');
  }
  // ── 3. a survivor after a pre-pickup unassign of either member: its stale copy is inert ────────────────────────
  for (const gone of ['ord_i', 'ord_n']) {
    const w = world({ rankI: 1 }); const keep = gone === 'ord_i' ? 'ord_n' : 'ord_i';
    for (const t of ['pickup', 'delivery']) { w.tasks[`${gone}_${t}`].assigned_driver_id = null; w.tasks[`${gone}_${t}`].status = 'pending'; }
    w.tasks[`${keep}_pickup`].status = 'completed'; w.orders[keep].status = 'out_for_delivery';
    w.driver.current_task_id = nextPointer({ ...w, tasks: Object.fromEntries(Object.entries(w.tasks).filter(([, t]) => t.assigned_driver_id === UID)) }) || `${keep}_delivery`;
    assert.strictEqual(mode(w, keep), 'live', `survivor ${keep} after ${gone} unassigned: live`);
  }
  ok('a pre-pickup unassign of either member: the survivor is the lone order and LIVE (its stale copy is inert)');
  // ── 4. a manual reunion (assigned_at > stack_at) → order-time, as today ─────────────────────────────────────────
  {
    const w = world({ rankI: 2 });
    w.tasks.ord_i_delivery.assigned_at = 5000;   // re-assigned after the stack (a reunion / transfer)
    pickupBatch(w, 'ord_i');
    assert.strictEqual(w.driver.current_task_id, 'ord_i_delivery', 'an invalid pair → today’s pointer (the swiped order)');
    assert.deepStrictEqual(both(w), ['live', 'waiting'], 'order-time: the older order first, as today');
    ok('a manual reunion (assigned_at > stack_at) → invalid pair → today’s order-time behaviour');
  }
  // ── 5. flag OFF (no copies) and the single-order golden ─────────────────────────────────────────────────────
  {
    const w = world({ copies: false }); pickupBatch(w, 'ord_i');
    assert.deepStrictEqual(both(w), ['live', 'waiting'], 'flag OFF: today');
    const one = world({ copies: false }); delete one.tasks.ord_n_pickup; delete one.tasks.ord_n_delivery; delete one.orders.ord_n;
    one.tasks.ord_i_pickup.status = 'completed'; one.orders.ord_i.status = 'out_for_delivery'; one.driver.current_task_id = 'ord_i_delivery';
    assert.strictEqual(mode(one, 'ord_i'), 'live', 'the single-order golden');
    ok('flag OFF (no copies) behaves as today; the single-order golden is LIVE');
  }
  // ── 6. the stacked-seq consumption matrix (2f stackseq-consume.test.js titles; advisor ruling Codex r1 #3) — EQUAL created_at ──
  const eq = (over = {}) => { const w = world({ rankI: 2 }); w.tasks.ord_n_delivery.created_at = 100; w.tasks.ord_n_pickup.created_at = 100; Object.entries(over).forEach(([k, v]) => Object.assign(w.tasks[k], v)); return w; };
  {
    const w = eq(); pickupBatch(w, 'ord_i');
    assert.deepStrictEqual(both(w), ['waiting', 'live'], 'a VALID pair with EQUAL created_at is never a tie: stop 1 (ord_n) LIVE, stop 2 WAITING');
    ok('valid pair, equal created_at → ordered by stop_seq: LIVE / WAITING (the degenerate the neutral rule must not swallow)');
  }
  {
    const w = eq({ ord_n_delivery: { stack_id: 'stk_other' } }); pickupBatch(w, 'ord_i');
    assert.deepStrictEqual(both(w), ['neutral', 'neutral'], 'mismatched stack_id + equal created_at → an invalid pair → a created_at tie → NEUTRAL for both');
    ok('mismatched stack_id, equal created_at → invalid → NEUTRAL / NEUTRAL');
  }
  for (const [label, over] of [['reassigned away (stack_uid foreign)', { ord_n_delivery: { stack_uid: 'drv_tb_other' } }], ['reassigned AFTER the stack write (assigned_at > stack_at)', { ord_n_delivery: { assigned_at: 5000 } }]]) {
    const w = eq(over); pickupBatch(w, 'ord_i');
    assert.deepStrictEqual(both(w), ['neutral', 'neutral'], `${label} + equal created_at → stale provenance → NEUTRAL for both`);
  }
  ok('stale provenance (stack_uid foreign / assigned after the stack), equal created_at → invalid → NEUTRAL / NEUTRAL');
  {
    // three delivery-phase orders: not exactly one pair → legacy created_at, no stop_seq sequencing (even though ord_i/ord_n are a valid pair)
    const w = world({ rankI: 2 });
    w.tasks.ord_x_pickup = leg('ord_x', 'pickup', 'completed', 300); w.tasks.ord_x_delivery = leg('ord_x', 'delivery', 'accepted', 300); w.orders.ord_x = { status: 'out_for_delivery' };
    pickupBatch(w, 'ord_i'); w.driver.current_task_id = 'ord_i_delivery';   // the driver card under legacy order-time = the oldest
    assert.deepStrictEqual([...both(w), mode(w, 'ord_x')], ['live', 'waiting', 'waiting'], '3 orders: legacy created_at — the oldest (ord_i) LIVE although its stop_seq is 2');
    ok('3 delivery orders (a valid pair + a third) → legacy created_at, no stop_seq sequencing');
  }
  FINISHED = true;
  console.log(`\ntracker-parity: OK (${n})`);
})();
