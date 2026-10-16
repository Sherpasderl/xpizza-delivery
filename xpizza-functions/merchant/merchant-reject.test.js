'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const R = require('./merchant-reject');

const T0 = 1_700_000_000_000;
const deps = (db, nowMs = T0) => ({ db, now: () => nowMs });
const intent = (op, at, extra = {}) => ({ type: 'reject', reason: 'saturada', note: null, gone_items: [], op_id: op, by: 'hh_n1', at, ...extra });
const world = (orderOver = {}, reqs) => ({
  restaurants: { tb_norte: { order_surface: 'handheld' } },
  orders: { o1: { restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new',
    handheld_answered: { kind: 'reject_requested', at: T0, by: 'hh_n1', op_id: 'op_rej_A' }, reject_intent: intent('op_rej_A', T0), ...orderOver } },
  ...(reqs ? { merchant_requests: { tb_norte: { o1: reqs } } } : {}),
});

test('crash after the order commit, no client retry: the intent trigger alone publishes an open request', async () => {
  const db = createFakeDb(world());
  await R.publishFromIntent(deps(db), 'o1');
  assert.deepStrictEqual(db.get('merchant_requests/tb_norte/o1'), { type: 'reject', reason: 'saturada', note: null, gone_items: [], op_id: 'op_rej_A', by: 'hh_n1', at: T0, state: 'open' });
});

test('replay after resolution: same op never resets a done/declined request to open', async () => {
  for (const state of ['done', 'declined']) {
    const db = createFakeDb(world({}, { ...intent('op_rej_A', T0), state }));
    await R.publishFromIntent(deps(db), 'o1');
    assert.strictEqual(db.get('merchant_requests/tb_norte/o1/state'), state);
  }
});

test('an OLD intent never overwrites a newer request; a NEWER intent reopens only after done/declined', async () => {
  const older = createFakeDb(world({ reject_intent: intent('op_rej_OLD', T0 - 5000) }, { ...intent('op_rej_NEW', T0), state: 'declined' }));
  await R.publishFromIntent(deps(older), 'o1');
  assert.strictEqual(older.get('merchant_requests/tb_norte/o1/op_id'), 'op_rej_NEW');
  const open = createFakeDb(world({ reject_intent: intent('op_rej_B', T0 + 5000) }, { ...intent('op_rej_A', T0), state: 'open' }));
  await R.publishFromIntent(deps(open), 'o1');
  assert.strictEqual(open.get('merchant_requests/tb_norte/o1/op_id'), 'op_rej_A');
  const newer = createFakeDb(world({ reject_intent: intent('op_rej_B', T0 + 5000) }, { ...intent('op_rej_A', T0), state: 'declined' }));
  await R.publishFromIntent(deps(newer), 'o1');
  assert.deepStrictEqual([newer.get('merchant_requests/tb_norte/o1/op_id'), newer.get('merchant_requests/tb_norte/o1/state')], ['op_rej_B', 'open']);
});

test('publisher is inert for a kds-surface location, a missing intent, or a missing order', async () => {
  const kds = createFakeDb(world()); kds.put('restaurants/tb_norte/order_surface', 'kds');
  await R.publishFromIntent(deps(kds), 'o1');
  assert.strictEqual(kds.get('merchant_requests'), null);
  const none = createFakeDb(world({ reject_intent: null }));
  await R.publishFromIntent(deps(none), 'o1');
  assert.strictEqual(none.get('merchant_requests'), null);
  await R.publishFromIntent(deps(createFakeDb({})), 'o1');
});

test('resolve is a transaction conditional on the matching op id and an open state', async () => {
  const db = createFakeDb(world({}, { ...intent('op_rej_A', T0), state: 'open' }));
  assert.deepStrictEqual(await R.resolveRejectRequest(deps(db), 'tb_norte', 'o1', 'op_rej_X', 'declined', 'disp_1'), { ok: false, code: 'stale' });
  assert.strictEqual((await R.resolveRejectRequest(deps(db), 'tb_norte', 'o1', 'op_rej_A', 'declined', 'disp_1')).ok, true);
  assert.strictEqual(db.get('merchant_requests/tb_norte/o1/state'), 'declined');
  assert.deepStrictEqual(await R.resolveRejectRequest(deps(db), 'tb_norte', 'o1', 'op_rej_A', 'done', 'disp_1'), { ok: false, code: 'stale' });
  await assert.rejects(() => R.resolveRejectRequest(deps(db), 'tb_norte', 'o1', 'op_rej_A', 'open', 'd'), /bad outcome/);
});

test('BC2 schedule (a): declined, crash before the order clear → the request trigger clears it (idempotent)', async () => {
  const db = createFakeDb(world({}, { ...intent('op_rej_A', T0), state: 'declined' }));
  await R.clearOnDecline(deps(db), 'tb_norte', 'o1');
  assert.strictEqual(db.get('orders/o1/reject_intent'), null);
  assert.strictEqual(db.get('orders/o1/handheld_answered'), null);
  await R.clearOnDecline(deps(db), 'tb_norte', 'o1');                 // second run: no-op
  assert.strictEqual(db.get('orders/o1/status'), 'new');
});

test('BC2 schedule (b): a newer intent lands between the resolution and the clear → op mismatch, nothing cleared', async () => {
  const db = createFakeDb(world({ reject_intent: intent('op_rej_B', T0 + 9000), handheld_answered: { kind: 'reject_requested', at: T0 + 9000, by: 'hh_n1', op_id: 'op_rej_B' } },
    { ...intent('op_rej_A', T0), state: 'declined' }));
  await R.clearOnDecline(deps(db), 'tb_norte', 'o1');
  assert.strictEqual(db.get('orders/o1/reject_intent/op_id'), 'op_rej_B');
  assert.strictEqual(db.get('orders/o1/handheld_answered/op_id'), 'op_rej_B');
});

test('clearOnDecline ignores open/done requests and other-location orders', async () => {
  for (const state of ['open', 'done']) {
    const db = createFakeDb(world({}, { ...intent('op_rej_A', T0), state }));
    await R.clearOnDecline(deps(db), 'tb_norte', 'o1');
    assert.strictEqual(db.get('orders/o1/reject_intent/op_id'), 'op_rej_A');
  }
  const other = createFakeDb(world({ restaurant_id: 'tb_centro' }, { ...intent('op_rej_A', T0), state: 'declined' }));
  await R.clearOnDecline(deps(other), 'tb_norte', 'o1');
  assert.strictEqual(other.get('orders/o1/reject_intent/op_id'), 'op_rej_A');
});
