'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('./merchant-push');

test('vToken: non-empty, whitespace-free, ≤ 4096', () => {
  assert.strictEqual(P.vToken('fcm:abc-123_X'), 'fcm:abc-123_X');
  for (const bad of ['', ' ', 'a b', 'x'.repeat(4097), null, 42, {}]) assert.strictEqual(P.vToken(bad), null);
});

test('pushTargets: only registered, unrevoked handhelds with a valid token; uid-sorted', () => {
  const rows = {
    hh_b: { kind: 'handheld', revoked: false, fcm_token: 'tb' },
    hh_a: { kind: 'handheld', revoked: false, fcm_token: 'ta' },
    hh_rev: { kind: 'handheld', revoked: true, fcm_token: 'tr' },
    hh_none: { kind: 'handheld', revoked: false },
    hh_bad: { kind: 'handheld', revoked: false, fcm_token: 'with space' },
    human: { kind: 'human', revoked: false, fcm_token: 'th' },
    hh_unk: { kind: 'handheld', fcm_token: 'tu' },              // revoked absent → not false → excluded (fail closed)
  };
  assert.deepStrictEqual(P.pushTargets(rows), [{ uid: 'hh_a', token: 'ta' }, { uid: 'hh_b', token: 'tb' }]);
  assert.deepStrictEqual(P.pushTargets(null), []);
});

test('decisions: becameNew (intake + scheduled release), servedAtHandheld, leftNew, answeredNow', () => {
  assert.strictEqual(P.becameNew(null, 'new'), true);
  assert.strictEqual(P.becameNew('releasing', 'new'), true);
  assert.strictEqual(P.becameNew('new', 'new'), false);
  assert.strictEqual(P.becameNew('new', 'preparing'), false);
  const o = { restaurant_id: 'tb_norte', routing_reason: 'nearest' };
  assert.strictEqual(P.servedAtHandheld(o, 'handheld'), true);
  assert.strictEqual(P.servedAtHandheld(o, 'kds'), false);
  assert.strictEqual(P.servedAtHandheld({ restaurant_id: 'tb_norte' }, 'handheld'), false, 'no routing provenance → not served');
  assert.strictEqual(P.servedAtHandheld(null, 'handheld'), false);
  assert.strictEqual(P.leftNew('new', 'preparing'), true);
  assert.strictEqual(P.leftNew('new', 'cancelled'), true);
  assert.strictEqual(P.leftNew('preparing', 'ready'), false);
  assert.strictEqual(P.answeredNow(null, { kind: 'rejected' }), true);
  assert.strictEqual(P.answeredNow({ kind: 'rejected' }, { kind: 'rejected' }), false);
});

test('buildDataMessage: DATA-ONLY (no notification block), string values, high priority, 5 min TTL', () => {
  const m = P.buildDataMessage('tok', 'new_order', 'o1', 'tb_norte');
  assert.deepStrictEqual(m, { token: 'tok', data: { type: 'new_order', order_id: 'o1', rid: 'tb_norte' }, android: { priority: 'high', ttl: 300000 } });
  assert.ok(!('notification' in m) && !('notification' in m.android));
  assert.strictEqual(P.buildDataMessage('t', 'resolved', 7, 'r').data.order_id, '7');
  assert.throws(() => P.buildDataMessage('t', 'other', 'o', 'r'), /bad push type/);
});

test('dead-token classification is driver-push\'s, reused verbatim', () => {
  assert.strictEqual(P.isTerminalFcmError({ code: 'messaging/registration-token-not-registered' }), true);
  assert.strictEqual(P.isTerminalFcmError({ code: 'messaging/internal-error' }), false);
});
