'use strict';
// BUILD-stacked-seq-server r5 T6 — tracker parity, BEFORE 2f lands: the pickup batch is driven through a CONTRACT HELPER that
// writes exactly the §1 2f obligation this server build can rely on (after pickup, current_task_id = the delivery of the LOWEST
// VALID stop_seq remaining; else today's pointer), and the REAL tracker derivation (tracking/derive.js, unchanged) is asked at
// every step. What it proves today:
//   • an I-first pair (rank order = order time): pre → stop 1 LIVE / stop 2 WAITING → stop 2 LIVE → terminal;
//   • an N-first pair: until 2f's SORT is re-copied into tracking/driver-orders.js the tracker shows NEUTRAL for both — never a
//     wrong LIVE (the pointer and element 0 disagree). This cell PINS that gap; 2f's re-copy + the tie-check key flip it;
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
  // ── 2. N-first: NEUTRAL (never a wrong LIVE) until 2f's sort is re-copied — the pinned gap ─────────────────────
  {
    const w = world({ rankI: 2 });
    pickupBatch(w, 'ord_i');
    assert.strictEqual(w.driver.current_task_id, 'ord_n_delivery', 'the pointer follows the rank');
    assert.deepStrictEqual(both(w), ['neutral', 'neutral'], 'N-first today: neutral for both — the order-time sort and the pointer disagree; never a wrong live');
    deliver(w, 'ord_n');
    assert.deepStrictEqual(both(w), ['live', 'terminal'], 'after stop 1 (N) is delivered, the remaining order is live');
    ok('N-first: NEUTRAL for both until 2f’s sort lands (pinned gap — never a wrong LIVE); after stop 1, the survivor is LIVE');
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
  FINISHED = true;
  console.log(`\ntracker-parity: OK (${n})`);
})();
