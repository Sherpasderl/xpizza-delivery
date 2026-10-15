'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyAction } = require('./merchant-transitions');

const T0 = 1_700_000_000_000;
const order = (over = {}) => ({ order_id: 'o1', restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery', ...over });
const req = (action, payload = {}, op = 'op_aaaaaaaa', rid = 'tb_norte') => ({ action, op_id: op, rid, payload });
const ctx = (uid = 'hh_n1', hash = 'h1', nowMs = T0) => ({ uid, payloadHash: hash, nowMs });
const code = (r) => (r.abort ? r.abort.code : 'COMMIT');

test('accept: new → preparing with full prep, marker and receipt in ONE commit', () => {
  const r = applyAction(order(), req('accept', { prep_min: 23 }), ctx());
  assert.ok(r.commit);
  assert.strictEqual(r.commit.status, 'preparing');
  assert.deepStrictEqual(r.commit.prep, { committed_min: 23, extra_min: 0, accepted_at: T0, ready_at: T0 + 23 * 60000 });
  assert.deepStrictEqual(r.commit.handheld_answered, { kind: 'accepted', at: T0, by: 'hh_n1', op_id: 'op_aaaaaaaa' });
  assert.deepStrictEqual(r.commit.handheld_ops.op_aaaaaaaa, { action: 'accept', payload_hash: 'h1', by: 'hh_n1', at: T0, result: r.result });
  assert.deepStrictEqual(r.result, { ok: true, action: 'accept', status: 'preparing', prep: r.commit.prep });
});

test('receipt FIRST: same caller+action+payload replays the stored result even after later ops; anything else → op_conflict', () => {
  let n = applyAction(order(), req('accept', { prep_min: 20 }, 'op_accept1'), ctx()).commit;
  const firstMore = applyAction(n, req('more', { add_min: 5 }, 'op_more001'), ctx('hh_n1', 'm5', T0 + 1000));
  n = firstMore.commit;
  n = applyAction(n, req('more', { add_min: 10 }, 'op_more002'), ctx('hh_n1', 'm10', T0 + 2000)).commit;
  const replay = applyAction(n, req('more', { add_min: 5 }, 'op_more001'), ctx('hh_n1', 'm5', T0 + 9000));
  assert.deepStrictEqual(replay.abort, firstMore.result);               // original result, no second +5
  assert.strictEqual(n.prep.extra_min, 15);
  assert.strictEqual(code(applyAction(n, req('more', { add_min: 5 }, 'op_more001'), ctx('hh_n9', 'm5'))), 'op_conflict');   // other device
  assert.strictEqual(code(applyAction(n, req('more', { add_min: 10 }, 'op_more001'), ctx('hh_n1', 'm10'))), 'op_conflict'); // other payload
  assert.strictEqual(code(applyAction(n, req('ready', {}, 'op_more001'), ctx('hh_n1', 'm5'))), 'op_conflict');             // other action
});

test('receipt is checked BEFORE served/status preconditions (a replay after cancellation still returns its result)', () => {
  const a = applyAction(order(), req('accept', { prep_min: 18 }), ctx());
  const cancelled = { ...a.commit, status: 'cancelled', cancel_claim_id: 'c1' };
  assert.deepStrictEqual(applyAction(cancelled, req('accept', { prep_min: 18 }), ctx()).abort, a.result);
});

test('served order only (checked on the live node): stored rid and on-brand provenance', () => {
  assert.strictEqual(code(applyAction(order(), req('accept', { prep_min: 18 }, 'op_aaaaaaaa', 'tb_centro'), ctx())), 'not_served');
  const legacy = order(); delete legacy.routing_reason;
  assert.strictEqual(code(applyAction(legacy, req('accept', { prep_min: 18 }), ctx())), 'not_served');
  assert.strictEqual(code(applyAction(null, req('accept', { prep_min: 18 }), ctx())), 'not_found');
});

test('cancel claim / terminal status → stale_state', () => {
  assert.strictEqual(code(applyAction(order({ cancel_claim_id: 'c1' }), req('accept', { prep_min: 18 }), ctx())), 'stale_state');
  for (const s of ['cancelled', 'delivered', 'completed']) assert.strictEqual(code(applyAction(order({ status: s }), req('reject', { reason: 'otro' }), ctx())), 'stale_state');
});

test('accept only from new and unanswered', () => {
  assert.strictEqual(code(applyAction(order({ status: 'preparing' }), req('accept', { prep_min: 18 }), ctx())), 'stale_state');
  const rq = applyAction(order(), req('reject', { reason: 'saturada' }, 'op_reject01'), ctx()).commit;
  assert.strictEqual(code(applyAction(rq, req('accept', { prep_min: 18 }, 'op_accept9'), ctx())), 'stale_state');
});

test('más tiempo: needs a valid full prep; cap 30; exact ready_at recompute', () => {
  let n = applyAction(order(), req('accept', { prep_min: 20 }, 'op_acc00001'), ctx()).commit;
  n = applyAction(n, req('more', { add_min: 15 }, 'op_m0000001'), ctx('hh_n1', 'a')).commit;
  n = applyAction(n, req('more', { add_min: 15 }, 'op_m0000002'), ctx('hh_n1', 'b')).commit;
  assert.strictEqual(n.prep.extra_min, 30);
  assert.strictEqual(n.prep.ready_at, T0 + 50 * 60000);
  assert.strictEqual(code(applyAction(n, req('more', { add_min: 5 }, 'op_m0000003'), ctx('hh_n1', 'c'))), 'cap_reached');
  const broken = { ...n, prep: { ...n.prep, ready_at: 1 } };
  assert.strictEqual(code(applyAction(broken, req('more', { add_min: 5 }, 'op_m0000004'), ctx('hh_n1', 'd'))), 'stale_state');
  assert.strictEqual(code(applyAction(order({ status: 'new' }), req('more', { add_min: 5 }), ctx())), 'stale_state');
});

test('listo: full prep gets ready_marked_at; NO prep → ready-only shape; malformed prep → bad_stored_state', () => {
  const n = applyAction(order(), req('accept', { prep_min: 18 }, 'op_acc00001'), ctx()).commit;
  const r = applyAction(n, req('ready', {}, 'op_ready001'), ctx('hh_n1', 'r', T0 + 600000));
  assert.strictEqual(r.commit.status, 'ready');
  assert.strictEqual(r.commit.prep.ready_marked_at, T0 + 600000);
  assert.strictEqual(r.commit.prep.committed_min, 18);
  const noPrep = applyAction(order({ status: 'preparing' }), req('ready', {}, 'op_ready002'), ctx());
  assert.deepStrictEqual(noPrep.commit.prep, { ready_marked_at: T0 });
  assert.strictEqual(code(applyAction(order({ status: 'preparing', prep: { foo: 1 } }), req('ready', {}, 'op_ready003'), ctx())), 'bad_stored_state');
  assert.strictEqual(code(applyAction(order({ status: 'new' }), req('ready', {}), ctx())), 'stale_state');
});

test('entregado: pickup ready → completed; delivery refused', () => {
  assert.strictEqual(applyAction(order({ status: 'ready', order_type: 'pickup' }), req('handed'), ctx()).commit.status, 'completed');
  assert.strictEqual(code(applyAction(order({ status: 'ready', order_type: 'delivery' }), req('handed'), ctx())), 'stale_state');
});

test('reject: intent + marker + receipt in one commit; order stays new; second reject → already_requested', () => {
  const r = applyAction(order(), req('reject', { reason: 'agotado', note: null, gone_items: ['Pollo frito 3 piezas'] }, 'op_rej00001'), ctx());
  assert.strictEqual(r.commit.status, 'new');
  assert.deepStrictEqual(r.commit.reject_intent, { type: 'reject', reason: 'agotado', note: null, gone_items: ['Pollo frito 3 piezas'], op_id: 'op_rej00001', by: 'hh_n1', at: T0 });
  assert.strictEqual(r.commit.handheld_answered.kind, 'reject_requested');
  assert.ok(r.commit.handheld_ops.op_rej00001);
  assert.strictEqual(code(applyAction(r.commit, req('reject', { reason: 'otro' }, 'op_rej00002'), ctx('hh_n1', 'z'))), 'already_requested');
});

test('pure: the input node is never mutated', () => {
  const n = order();
  const snap = JSON.stringify(n);
  applyAction(n, req('accept', { prep_min: 18 }), ctx());
  applyAction(n, req('reject', { reason: 'otro' }), ctx());
  assert.strictEqual(JSON.stringify(n), snap);
});

test('unknown action → bad_input', () => {
  assert.strictEqual(code(applyAction(order(), req('teleport'), ctx())), 'bad_input');
});
