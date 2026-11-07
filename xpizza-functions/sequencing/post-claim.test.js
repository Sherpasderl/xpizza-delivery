'use strict';
// BUILD-stacked-seq-server r5 T5 (iii) + §1 — the pure post-claim classifiers and the provenance rule.
//   candidateState(fresh)  → stillOffered | changed: accepted / picked_up / cancelled / moved / held
//   confirmIncumbent(...)  → the decision's other member is still the driver's ONLY other order, on this driver, pre-pickup,
//                            assignable and not held
//   validCopy / validPair  → the §1 validity rule every reader applies (provenance: stack_uid === assigned_driver_id and
//                            assigned_at <= stack_at), so any later assignment makes the copies inert
// Run: node sequencing/post-claim.test.js
const assert = require('assert');
const { candidateState, confirmIncumbent } = require('./post-claim');
const { validCopy, validPair } = require('./validity');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('post-claim: FAILED — exited without completing'); process.exitCode = 1; } });

const UID = 'drv_tb_1';
const ASSIGNABLE = new Set(['new', 'preparing', 'ready']);
const policy = { isAssignable: (o) => ASSIGNABLE.has(o.status), isHeld: (o) => o.held === true };
const fresh = (over = {}) => ({
  pickup: { order_id: 'ord_b', assigned_driver_id: null, status: 'pending', ...(over.pickup || {}) },
  delivery: { order_id: 'ord_b', assigned_driver_id: UID, status: 'pending', ...(over.delivery || {}) },
  order: { status: 'preparing', ...(over.order || {}) },
});
const cs = (f, extra = {}) => candidateState(f, { uid: UID, parked: false, ...policy, ...extra });

(async () => {
  // ── 1. candidateState ──────────────────────────────────────────────────────────────────────────────────────
  {
    assert.deepStrictEqual(cs(fresh()), { stillOffered: true });
    const C = (over, extra) => cs(fresh(over), extra).changed;
    assert.strictEqual(C({ pickup: { status: 'cancelled' } }), 'cancelled');
    assert.strictEqual(C({ delivery: { status: 'cancelled' } }), 'cancelled');
    assert.strictEqual(C({ order: { status: 'cancelled' } }), 'cancelled');
    assert.strictEqual(C({ delivery: { assigned_driver_id: 'drv_other' } }), 'moved', 'the claim was taken over');
    assert.strictEqual(C({ delivery: { assigned_driver_id: null } }), 'moved', 'the claim was released');
    assert.strictEqual(C({ pickup: { status: 'completed' } }), 'picked_up');
    assert.strictEqual(C({ order: { picked_up_at: 123 } }), 'picked_up');
    assert.strictEqual(C({ pickup: { assigned_driver_id: 'drv_other' } }), 'accepted', 'a manual assign landed on the pickup');
    for (const s of ['accepted', 'in_progress']) assert.strictEqual(C({ pickup: { status: s } }), 'accepted', `pickup ${s}`);
    assert.strictEqual(C({ order: { status: 'out_for_delivery' } }), 'held', 'not assignable');
    assert.strictEqual(C({ order: { held: true } }), 'held', 'heldByReject');
    assert.strictEqual(C({}, { parked: true }), 'held', 'sweep: parked');
    for (const missing of ['pickup', 'delivery', 'order']) { const f = fresh(); f[missing] = null; assert.ok(cs(f).changed, `a missing ${missing} → changed`); }
    ok('candidateState: stillOffered only for an untouched offer; cancelled / moved / picked_up / accepted / held (incl. parked) otherwise; a missing node → changed');
  }

  // ── 2. confirmIncumbent ────────────────────────────────────────────────────────────────────────────────────
  {
    const decision = { stack_id: 'stk_x', pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 2, incumbentOid: 'ord_a' };
    const tasks = (over = {}) => ({
      ord_a_pickup: { order_id: 'ord_a', assigned_driver_id: UID, status: 'accepted', ...(over.ap || {}) },
      ord_a_delivery: { order_id: 'ord_a', assigned_driver_id: UID, status: 'accepted', ...(over.ad || {}) },
      ord_b_pickup: { order_id: 'ord_b', assigned_driver_id: null, status: 'pending' },
      ord_b_delivery: { order_id: 'ord_b', assigned_driver_id: UID, status: 'pending' },
      ...(over.extra || {}),
    });
    const ci = (t, incOrder = { status: 'preparing' }, d = decision) => confirmIncumbent({ tasks: t, uid: UID, newOid: 'ord_b', decision: d, incOrder, ...policy });
    assert.strictEqual(ci(tasks()), true);
    assert.strictEqual(ci(tasks({ ap: { status: 'completed' } })), false, 'the incumbent was picked up');
    assert.strictEqual(ci(tasks({ ap: { status: 'cancelled' }, ad: { status: 'cancelled' } })), false, 'the incumbent was cancelled (tasks)');
    assert.strictEqual(ci(tasks(), { status: 'cancelled' }), false, 'the incumbent order cancelled');
    assert.strictEqual(ci(tasks(), { status: 'preparing', held: true }), false, 'the incumbent order held');
    assert.strictEqual(ci(tasks({ ad: { assigned_driver_id: 'drv_other' } })), false, 'a leg moved to another driver');
    assert.strictEqual(ci(tasks({ extra: { ord_c_delivery: { order_id: 'ord_c', assigned_driver_id: UID, status: 'accepted' } } })), false, 'a third order arrived');
    const t0 = tasks(); delete t0.ord_a_pickup; delete t0.ord_a_delivery;
    assert.strictEqual(ci(t0), false, 'no incumbent left');
    assert.strictEqual(ci(tasks(), { status: 'preparing' }, { ...decision, pair: ['ord_b', 'ord_z'], incumbentOid: 'ord_z' }), false, 'the decision names a different member');
    assert.strictEqual(ci(tasks(), null), false, 'the incumbent order missing');
    ok('confirmIncumbent: true only while the decided incumbent is the ONLY other order, both legs on this driver, pre-pickup, assignable, not held');
  }

  // ── 3. the §1 validity rule (provenance) ──────────────────────────────────────────────────────────────────
  {
    const copy = (seq, over = {}) => ({ stack_id: 'stk_x', stop_seq: seq, stack_uid: UID, assigned_driver_id: UID, assigned_at: 1000, stack_at: 1000, ...over });
    assert.strictEqual(validCopy(copy(1)), true);
    assert.strictEqual(validCopy(copy(2, { assigned_at: 900 })), true, 'assigned before the stack (the incumbent)');
    assert.strictEqual(validCopy(copy(1, { assigned_at: 1001 })), false, 'any later assignment invalidates (transfer, reunion, re-assign)');
    assert.strictEqual(validCopy(copy(1, { assigned_driver_id: 'drv_other' })), false, 'another driver');
    for (const bad of [{ stop_seq: 3 }, { stop_seq: '1' }, { stack_id: 7 }, { stack_id: '' }, { stack_at: null }, { assigned_at: undefined }, { stack_uid: null }]) {
      assert.strictEqual(validCopy(copy(1, bad)), false, JSON.stringify(bad));
    }
    assert.strictEqual(validCopy(null), false);
    assert.strictEqual(validPair(copy(1), copy(2)), true);
    assert.strictEqual(validPair(copy(2), copy(1)), true, 'either order');
    assert.strictEqual(validPair(copy(1), copy(1)), false, 'ranks must be {1,2}');
    assert.strictEqual(validPair(copy(1), copy(2, { stack_id: 'stk_y' })), false, 'one stack');
    assert.strictEqual(validPair(copy(1), copy(2, { assigned_at: 2000 })), false, 'one member reassigned → the pair is inert');
    ok('validity: same stack_id, ranks {1,2}, stack_uid === assigned_driver_id, assigned_at <= stack_at — anything else inert');
  }

  FINISHED = true;
  console.log(`\npost-claim: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
