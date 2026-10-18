'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const P = require('./merchant-reject-repair');
const { safeRejectRepair, heldByReject } = require('./merchant-hooks');

const T0 = 1_700_000_000_000;
const MIN = 60000;
// Third synthetic brand ('tb_').
const rej = (oid, ageMin, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', status: 'new', display_number: 7,
  handheld_answered: { kind: 'rejected', op_id: `op_${oid}`, at: T0 - ageMin * MIN, by: 'hh_n1' },
  reject_intent: { type: 'reject', reason: 'saturada', op_id: `op_${oid}`, at: T0 - ageMin * MIN, by: 'hh_n1' }, ...over });
const run = (db, orders, nowMs = T0, opts) => P.repairRejects({ db, clock: () => 0 }, orders, nowMs, opts);

test('needs(): the repair table', () => {
  const n = (o, notices) => P.needs(o, notices, T0);
  assert.deepStrictEqual(n(rej('a', 3)).notice, 'stranded');
  assert.deepStrictEqual(n(rej('a', 3, { cancel_claim_id: 'c', resolving_action: 'cancel' })).notice, 'claim_held');
  assert.deepStrictEqual(n(rej('a', 3, { reject_outcome: { state: 'manual_review', op_id: 'op_a' } })).notice, 'manual_review');
  const cr = n(rej('a', 3, { status: 'cancelled', payment_status: 'refund_pending' }));
  assert.deepStrictEqual([cr.notice, cr.outcome], ['refund_pending', 'refund_pending']);
  const cc = n(rej('a', 3, { status: 'cancelled' }));
  assert.deepStrictEqual([cc.notice, cc.outcome], [null, 'cancelled']);
  assert.strictEqual(n(rej('a', 3, { status: 'cancelled', reject_outcome: { state: 'cancelled', op_id: 'op_a' } })), null, 'cancelled with outcome = handled');
  assert.strictEqual(n(rej('a', 3, { status: 'cancelled', reject_outcome: { state: 'refund_pending', op_id: 'op_a' } }), { refund_pending: 1 }), null);
  assert.strictEqual(n(rej('a', 3), { stranded: 1 }), null, 'notice exists = handled');
  assert.strictEqual(n(rej('a', 1)), null, 'younger than 2 min');
  assert.strictEqual(n(rej('a', 24 * 60 + 1)), null, 'older than 24 h');
  assert.strictEqual(n(rej('a', 3, { status: 'preparing' })).notice, 'stranded', 'a live non-new order whose reject never resolved');
  assert.strictEqual(n(rej('a', 3, { status: 'preparing', reject_outcome: { state: 'cancelled', op_id: 'op_a' } })), null, 'a live order with a known outcome is handled');
  // codex r1 P2-4
  for (const st of ['delivered', 'completed']) {
    const t = n(rej('a', 3, { status: st }));
    assert.deepStrictEqual([t.notice, t.outcome], ['not_cancelable', 'not_cancelable'], st);
    assert.strictEqual(n(rej('a', 3, { status: st, reject_outcome: { state: 'not_cancelable', op_id: 'op_a' } })).notice, 'not_cancelable', 'a lost notice is re-raised');
    assert.strictEqual(n(rej('a', 3, { status: st, reject_outcome: { state: 'not_cancelable', op_id: 'op_a' } }), { not_cancelable: 1 }), null);
  }
  const rr = n(rej('a', 3, { status: 'pending_payment', payment_status: 'manual_reconciliation' }));
  assert.deepStrictEqual([rr.notice, rr.outcome], ['referred_recon', 'referred_recon']);
  const rm = n(rej('a', 3, { status: 'pending_payment', payment_status: 'manual_reconciliation' }), { referred_recon: 1 });
  assert.deepStrictEqual([rm.notice, rm.outcome], [null, 'referred_recon'], 'notice already raised; the outcome is still written');
  assert.strictEqual(n(rej('a', 3, { status: 'pending_payment' })).notice, 'stranded', 'pending_payment outside the recon surface: the core would cancel it');
  assert.strictEqual(n({ status: 'new', reject_intent: { at: T0 - 5 * MIN } }), null, 'no rejected marker → not a handheld reject');
  assert.strictEqual(n(rej('a', 3, { reject_outcome: { state: 'manual_review', op_id: 'op_OTHER' } })).notice, 'stranded', 'another op\'s outcome is ignored');
});

test('repair writes each needed notice once (atomic with its marker) and the post-finalize outcome; a second run writes nothing', async () => {
  const orders = {
    s1: rej('s1', 5),
    c1: rej('c1', 6, { cancel_claim_id: 'cl', resolving_action: 'cancel' }),
    f1: rej('f1', 7, { status: 'cancelled', payment_status: 'refund_pending' }),
    f2: rej('f2', 8, { status: 'cancelled' }),
  };
  const db = createFakeDb({ orders });
  const st = await run(db, orders);
  assert.deepStrictEqual([st.selected, st.repaired, st.failed], [4, 4, 0]);
  assert.strictEqual(db.get('dispatcher_alerts/handheld_reject_stranded_s1/type'), 'payment_handheld_reject_stranded');
  assert.match(db.get('dispatcher_alerts/handheld_reject_claim_held_c1/detail/action'), /se libera sola en unas horas/);
  assert.deepStrictEqual(db.get('orders/f1/reject_outcome'), { state: 'refund_pending', at: T0, op_id: 'op_f1', by: 'sweep' });
  assert.ok(db.get('dispatcher_alerts/handheld_reject_refund_pending_f1'));
  assert.deepStrictEqual(db.get('orders/f2/reject_outcome'), { state: 'cancelled', at: T0, op_id: 'op_f2', by: 'sweep' });
  assert.strictEqual(db.get('orders/f2/status'), 'cancelled');
  const writes = JSON.stringify(db.get(''));
  const again = await run(db, db.get('orders'), T0 + 5 * MIN);
  assert.strictEqual(again.selected, 0);
  assert.strictEqual(JSON.stringify(db.get('')), writes, 'second run wrote nothing');
});

test('BC1 forward progress: 30 unhandled rejects, cap 25 → run 1 repairs the oldest 25, run 2 the remaining 5, long before 24 h', async () => {
  const orders = {};
  for (let i = 0; i < 30; i++) orders[`o${String(i).padStart(2, '0')}`] = rej(`o${String(i).padStart(2, '0')}`, 3 + (30 - i));
  const db = createFakeDb({ orders });
  const r1 = await run(db, orders);
  assert.deepStrictEqual([r1.selected, r1.repaired], [25, 25]);
  assert.strictEqual(db.get('dispatcher_alerts/handheld_reject_stranded_o00') !== null, true, 'oldest first');
  assert.strictEqual(db.get('dispatcher_alerts/handheld_reject_stranded_o29'), null, 'newest waits');
  const r2 = await run(db, orders, T0 + 5 * MIN);
  assert.deepStrictEqual([r2.selected, r2.repaired], [5, 5]);
  for (let i = 0; i < 30; i++) assert.ok(db.get(`dispatcher_alerts/handheld_reject_stranded_o${String(i).padStart(2, '0')}`), `o${i} noticed`);
  assert.strictEqual((await run(db, orders, T0 + 10 * MIN)).selected, 0);
});

test('a pruned alert is not re-raised (the marker survives the prune)', async () => {
  const orders = { s1: rej('s1', 5) };
  const db = createFakeDb({ orders });
  await run(db, orders);
  db.put('dispatcher_alerts/handheld_reject_stranded_s1', null);
  assert.strictEqual((await run(db, orders, T0 + 5 * MIN)).selected, 0);
  assert.deepStrictEqual(Object.keys(db.get('dispatcher_alerts') || {}), []);
});

test('BC3: one candidate failing does not stop the others; the budget stops starting new candidates', async () => {
  const orders = { a: rej('a', 9), b: rej('b', 8, { status: 'cancelled' }), c: rej('c', 7) };
  const db = createFakeDb({ orders });
  db.failReads.add('orders/b');                 // b's outcome transaction throws
  const st = await run(db, orders);
  assert.deepStrictEqual([st.repaired, st.failed], [2, 1]);
  assert.ok(db.get('dispatcher_alerts/handheld_reject_stranded_a'));
  assert.ok(db.get('dispatcher_alerts/handheld_reject_stranded_c'));
  db.failReads.clear();
  assert.strictEqual((await run(db, orders, T0 + MIN)).repaired, 1, 'the failed one is retried next run');

  const db2 = createFakeDb({ orders: { a: rej('a', 9), c: rej('c', 7) } });
  let t = 0;
  const st2 = await P.repairRejects({ db: db2, clock: () => (t += 20000) }, db2.get('orders'), T0, { budgetMs: 30000 });
  assert.deepStrictEqual([st2.repaired, st2.budget_stopped], [1, 1]);
});

test('markers outside the window or for gone orders are pruned', async () => {
  const orders = { live: rej('live', 5), old: rej('old', 25 * 60) };
  const db = createFakeDb({ orders, merchant_reject_notices: { old: { stranded: 1 }, gone: { stranded: 1 }, live: { stranded: 1 } } });
  const st = await run(db, orders);
  assert.strictEqual(st.pruned, 2);
  assert.deepStrictEqual(Object.keys(db.get('merchant_reject_notices')), ['live']);
});

test('safeRejectRepair never throws (a marker read failure is swallowed and logged)', async () => {
  const db = createFakeDb({});
  db.failReads.add('merchant_reject_notices');
  assert.strictEqual(await safeRejectRepair(db, { s1: rej('s1', 5) }, T0), null);
});

test('heldByReject: a rejected marker or any cancel claim holds; legacy orders do not', () => {
  assert.strictEqual(heldByReject({ handheld_answered: { kind: 'rejected' } }), true);
  assert.strictEqual(heldByReject({ cancel_claim_id: 'x' }), true);
  assert.strictEqual(heldByReject({ handheld_answered: { kind: 'accepted' } }), false);
  assert.strictEqual(heldByReject({ status: 'new' }), false);
  assert.strictEqual(heldByReject(null), false);
  assert.strictEqual(heldByReject({ handheld_answered: 'rejected' }), false);
});
