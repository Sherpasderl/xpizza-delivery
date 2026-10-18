'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const R = require('./merchant-reject');
const M = require('./merchant-orders');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const T0 = 1_700_000_000_000;
// Third synthetic brand ('tb_'), never a production literal.
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const world = (order = {}) => ({
  restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { hh_n1: { kind: 'handheld', revoked: false } } } },
  orders: { o1: { order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery', display_number: 41, ...order } },
  tasks: { o1_delivery: { assigned_driver_id: null } },
});
const dev = { uid: 'hh_n1', token: { handheld: true, rid: 'tb_norte' } };
const data = (op = 'op_rej00001') => ({ rid: 'tb_norte', oid: 'o1', reason: 'saturada', gone_items: [], op_id: op });

// A fake core that records calls; `apply` mutates the db like the real core's finalize would.
function fakeCore(db, result, { apply, delayMs = 0, throws } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (throws) throw new Error(throws);
    if (apply) apply(db);
    return result;
  };
  fn.calls = calls;
  return fn;
}
const deps = (db, cancelCore, over = {}) => ({ db, resolveBrand, HttpsError, now: () => T0, cancelCore, newClaimId: () => `claim_${cancelCore.calls.length}`, ...over });
const reject = (db, core, op, over) => R.runReject(deps(db, core, over), dev, data(op), M.runOrderActionDetailed);
const cancelled = (ps) => (db) => { db.put('orders/o1/status', 'cancelled'); if (ps) db.put('orders/o1/payment_status', ps); };

test('classify: the approved table — known results only; everything else null', () => {
  const r = (status, outcome) => R.classify({ status, body: { outcome } });
  assert.deepStrictEqual(r(200, 'cancelled'), { state: 'cancelled', notice: null });
  assert.deepStrictEqual(r(200, 'already_cancelled'), { state: 'cancelled', notice: null });
  assert.deepStrictEqual(r(409, 'refund_pending'), { state: 'refund_pending', notice: 'refund_pending' });
  for (const o of ['manual_review', 'resolving_in_progress', 'claim_lost']) assert.deepStrictEqual(r(409, o), { state: 'manual_review', notice: 'manual_review', code: o });
  for (const [s, o] of [[503, 'retryable'], [404, undefined], [409, 'not_cancelable'], [409, 'in_recon_surface'], [200, 'weird'], [500, 'cancelled']]) assert.strictEqual(r(s, o), null, `${s} ${o}`);
  assert.strictEqual(R.classify(null), null); assert.strictEqual(R.classify({ status: 200 }), null);
});

test('cash reject → core called once with a fresh claim id and handheld actor → outcome cancelled, no notice', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 200, body: { outcome: 'cancelled' } }, { apply: cancelled() });
  const r = await reject(db, core);
  assert.strictEqual(r.state, 'cancelled');
  assert.strictEqual(core.calls.length, 1);
  assert.deepStrictEqual([core.calls[0].orderId, core.calls[0].actor, core.calls[0].claimId], ['o1', 'handheld:hh_n1', 'claim_0']);
  assert.match(core.calls[0].reason, /^rechazado en sucursal: saturada$/);
  assert.deepStrictEqual(db.get('orders/o1/reject_outcome'), { state: 'cancelled', at: T0, op_id: 'op_rej00001', by: 'handler' });
  assert.strictEqual(db.get('dispatcher_alerts'), null);
  assert.strictEqual(db.get('orders/o1/handheld_answered/kind'), 'rejected');
});

test('refund_pending → the keyed notice (with the mockup copy and N) is written BEFORE the outcome', async () => {
  const db = createFakeDb(world());
  let noticeSeenAtOutcome = null;
  const realTxn = db.ref;
  const core = fakeCore(db, { status: 409, body: { outcome: 'refund_pending' } }, { apply: cancelled('refund_pending') });
  db.hooks.onTxn = null;
  const r = await R.runReject({ ...deps(db, core), db: { ...db, ref: (p) => {
    const ref = realTxn(p);
    if (p === 'orders/o1') return { ...ref, transaction: async (fn) => { noticeSeenAtOutcome = db.get('dispatcher_alerts/handheld_reject_refund_pending_o1') !== null; return ref.transaction(fn); } };
    return ref;
  } } }, dev, data(), M.runOrderActionDetailed);
  assert.strictEqual(r.state, 'refund_pending');
  assert.strictEqual(noticeSeenAtOutcome, true, 'notice existed when the outcome transaction ran');
  const a = db.get('dispatcher_alerts/handheld_reject_refund_pending_o1');
  assert.strictEqual(a.type, 'payment_handheld_reject_refund_pending');
  assert.deepStrictEqual(a.detail, { orderId: 'o1', rid: 'tb_norte', display_number: 41, reason: 'saturada', outcome: 'refund_pending',
    action: 'Pedido #41 cancelado por la sucursal. El reembolso no se completó: revisá el pago y terminá la devolución al cliente.' });
  assert.strictEqual(db.get('merchant_reject_notices/o1/refund_pending'), T0);
  assert.strictEqual(db.get('orders/o1/reject_outcome/state'), 'refund_pending');
});

test('manual_review family → manual_review outcome with code + manual_review notice; N falls back to the short id', async () => {
  for (const code of ['manual_review', 'resolving_in_progress', 'claim_lost']) {
    const db = createFakeDb(world({ display_number: null }));
    const core = fakeCore(db, { status: 409, body: { outcome: code } });
    const r = await reject(db, core);
    assert.strictEqual(r.state, 'manual_review');
    assert.deepStrictEqual(db.get('orders/o1/reject_outcome'), { state: 'manual_review', at: T0, op_id: 'op_rej00001', by: 'handler', code });
    const a = db.get('dispatcher_alerts/handheld_reject_manual_review_o1');
    assert.strictEqual(a.detail.action, 'La cancelación necesita revisión: confirmá el estado del pago antes de cancelar o reasignar.');
    assert.strictEqual(db.get('orders/o1/status'), 'new');
  }
});

test('503 / 404 / unknown / throw → NOTHING written; response pending', async () => {
  for (const [res, opts] of [[{ status: 503, body: { outcome: 'retryable' } }], [{ status: 404, body: {} }], [{ status: 200, body: { outcome: 'odd' } }], [null, { throws: 'boom' }]]) {
    const db = createFakeDb(world());
    const core = fakeCore(db, res, opts || {});
    const r = await reject(db, core);
    assert.strictEqual(r.state, 'pending');
    assert.strictEqual(db.get('orders/o1/reject_outcome'), null);
    assert.strictEqual(db.get('dispatcher_alerts'), null);
    assert.strictEqual(db.get('merchant_reject_notices'), null);
  }
});

test('replay of the same op never runs the core: returns the stored outcome, or pending', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 503, body: { outcome: 'retryable' } });
  assert.strictEqual((await reject(db, core)).state, 'pending');
  assert.strictEqual((await reject(db, core)).state, 'pending');
  assert.strictEqual(core.calls.length, 1, 'replay did not call the core');
  db.put('orders/o1/reject_outcome', { state: 'manual_review', at: T0, op_id: 'op_rej00001', by: 'sweep' });
  assert.strictEqual((await reject(db, core)).state, 'manual_review');
  db.put('orders/o1/reject_outcome', { state: 'cancelled', at: T0, op_id: 'op_OTHER', by: 'sweep' });
  assert.strictEqual((await reject(db, core)).state, 'pending', 'an outcome for another op is not this op\'s');
  assert.strictEqual(core.calls.length, 1);
});

test('a second reject (different op) → already_requested, core not called again', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 409, body: { outcome: 'manual_review' } });
  await reject(db, core, 'op_rej00001');
  const r = await reject(db, core, 'op_rej00002');
  assert.deepStrictEqual([r.ok, r.code], [false, 'already_requested']);
  assert.strictEqual(core.calls.length, 1);
});

test('concurrent rejects from two taps → one commits the intent, one core call', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 200, body: { outcome: 'cancelled' } }, { apply: cancelled() });
  let other;
  db.hooks.onTxn = async () => { other = await reject(db, core, 'op_rej00002'); };
  const mine = await reject(db, core, 'op_rej00001');
  assert.strictEqual(other.state, 'cancelled');
  assert.strictEqual(mine.ok, false);
  assert.ok(['already_requested', 'stale_state'].includes(mine.code), `loser refused (${mine.code}): already answered / already cancelled`);
  assert.strictEqual(core.calls.length, 1);
});

test('delayed completion: the response deadline returns pending and writes nothing; the truthful outcome lands when the core settles', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 200, body: { outcome: 'cancelled' } }, { apply: cancelled(), delayMs: 60 });
  const r = await reject(db, core, 'op_rej00001', { responseDeadlineMs: 10 });
  assert.strictEqual(r.state, 'pending');
  assert.strictEqual(db.get('orders/o1/reject_outcome'), null, 'nothing written at the deadline');
  await new Promise((res) => setTimeout(res, 120));
  assert.deepStrictEqual(db.get('orders/o1/reject_outcome'), { state: 'cancelled', at: T0, op_id: 'op_rej00001', by: 'handler' });
});

test('post-finalize failure: the outcome write throws after the core cancelled → response pending, nothing half-written', async () => {
  const db = createFakeDb(world());
  const core = fakeCore(db, { status: 200, body: { outcome: 'cancelled' } }, { apply: (d) => { cancelled()(d); d.failReads.add('orders/o1'); } });
  const r = await reject(db, core);
  assert.strictEqual(r.state, 'pending');
  db.failReads.clear();
  assert.strictEqual(db.get('orders/o1/status'), 'cancelled');
  assert.strictEqual(db.get('orders/o1/reject_outcome'), null, 'left for the repair sweep');
});

test('outcomeUpdate: op-matched, null-first safe, never invents an order', () => {
  const o = { reject_intent: { op_id: 'a' } };
  assert.strictEqual(R.outcomeUpdate(null, 'a', {}), null);
  assert.strictEqual(R.outcomeUpdate({ reject_intent: { op_id: 'b' } }, 'a', {}), undefined);
  assert.strictEqual(R.outcomeUpdate({}, 'a', {}), undefined);
  assert.deepStrictEqual(R.outcomeUpdate(o, 'a', { state: 'cancelled' }), { reject_intent: { op_id: 'a' }, reject_outcome: { state: 'cancelled' } });
  assert.deepStrictEqual(o, { reject_intent: { op_id: 'a' } }, 'input not mutated');
});

test('writeNotice: set semantics (a repeat overwrites the same key), refuses unknown kinds; claim_held copy has no hour promise', async () => {
  const db = createFakeDb(world());
  const order = db.get('orders/o1');
  await R.writeNotice(db, 'stranded', 'o1', order, {}, T0);
  await R.writeNotice(db, 'stranded', 'o1', order, {}, T0 + 1);
  assert.strictEqual(Object.keys(db.get('dispatcher_alerts')).length, 1);
  assert.strictEqual(db.get('dispatcher_alerts/handheld_reject_stranded_o1/detail/action'), 'Rechazado por la sucursal — cancelar o reasignar');
  await assert.rejects(R.writeNotice(db, 'bogus', 'o1', order, {}, T0), /bad notice kind/);
  assert.doesNotMatch(R.ACTION.claim_held(41), /\d+\s*h\b/);
  assert.match(R.ACTION.claim_held(41), /se libera sola en unas horas/);
});
