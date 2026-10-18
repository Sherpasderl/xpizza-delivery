'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('./merchant-push');

const EP = 'epoch_abcdefghij0123';
test('vToken / vEpoch', () => {
  assert.strictEqual(P.vToken('fcm:abc-123_X'), 'fcm:abc-123_X');
  for (const bad of ['', ' ', 'a b', 'x'.repeat(4097), null, 42, {}]) assert.strictEqual(P.vToken(bad), null);
  assert.strictEqual(P.vEpoch(EP), EP);
  for (const bad of ['short', 'x'.repeat(65), 'has space here here', null, 7]) assert.strictEqual(P.vEpoch(bad), null);
});

test('pushTargets: only registered, unrevoked handhelds with a valid token AND epoch; uid-sorted', () => {
  const rows = {
    hh_b: { kind: 'handheld', revoked: false, fcm_token: 'tb', push_epoch: EP },
    hh_a: { kind: 'handheld', revoked: false, fcm_token: 'ta', push_epoch: EP },
    hh_noepoch: { kind: 'handheld', revoked: false, fcm_token: 'tn' },
    hh_rev: { kind: 'handheld', revoked: true, fcm_token: 'tr', push_epoch: EP },
    hh_none: { kind: 'handheld', revoked: false, push_epoch: EP },
    human: { kind: 'human', revoked: false, fcm_token: 'th', push_epoch: EP },
    hh_unk: { kind: 'handheld', fcm_token: 'tu', push_epoch: EP },              // revoked absent → excluded (fail closed)
  };
  assert.deepStrictEqual(P.pushTargets(rows), [{ uid: 'hh_a', token: 'ta', epoch: EP }, { uid: 'hh_b', token: 'tb', epoch: EP }]);
  assert.deepStrictEqual(P.pushTargets(null), []);
});

test('decisions: becameNew, leftNewTo (deletion is NOT a resolution push), answeredNow, servedAtHandheld, stillPending', () => {
  assert.strictEqual(P.becameNew(null, 'new'), true);
  assert.strictEqual(P.becameNew('releasing', 'new'), true);
  assert.strictEqual(P.becameNew('new', 'new'), false);
  assert.strictEqual(P.leftNewTo('new', 'preparing'), true);
  assert.strictEqual(P.leftNewTo('new', 'cancelled'), true);
  assert.strictEqual(P.leftNewTo('new', null), false, 'deletion: no push (reconcile + feed)');
  assert.strictEqual(P.leftNewTo('preparing', 'ready'), false);
  assert.strictEqual(P.answeredNow(null, { kind: 'rejected' }), true);
  assert.strictEqual(P.answeredNow({ kind: 'rejected' }, { kind: 'rejected' }), false);
  const o = { restaurant_id: 'tb_norte', routing_reason: 'nearest' };
  assert.strictEqual(P.servedAtHandheld(o, 'handheld'), true);
  for (const [ord, surf] of [[o, 'kds'], [o, undefined], [o, 'HANDHELD'], [{ restaurant_id: 'tb_norte' }, 'handheld'], [null, 'handheld']]) assert.strictEqual(P.servedAtHandheld(ord, surf), false);
  assert.strictEqual(P.stillPending({ status: 'new' }), true);
  assert.strictEqual(P.stillPending({ status: 'new', handheld_answered: { kind: 'rejected' } }), false, 'already answered → S2 suppresses');
  assert.strictEqual(P.stillPending({ status: 'preparing' }), false);
});

test('codex r4: merchant_push_log updaters are timestamp-conditional (delayed handlers never move it backwards or erase a re-entry)', () => {
  assert.deepStrictEqual(P.logNewUpdate(null, 30), { new_at: 30 }, 'absent → set');
  assert.strictEqual(P.logNewUpdate({ new_at: 30 }, 10), undefined, 'a delayed S2@10 after S2@30 → no overwrite');
  assert.strictEqual(P.logNewUpdate({ new_at: 30 }, 30), undefined, 'a duplicate → no write');
  assert.deepStrictEqual(P.logNewUpdate({ new_at: 30 }, 40), { new_at: 40 });
  assert.strictEqual(P.logResolveUpdate({ new_at: 30 }, 20), undefined, 'a delayed S3@20 after S2@30 → the log is KEPT');
  assert.strictEqual(P.logResolveUpdate({ new_at: 30 }, 30), null, 'resolution at/after the entry → deleted');
  assert.strictEqual(P.logResolveUpdate({ new_at: 30 }, 45), null);
  assert.strictEqual(P.logResolveUpdate(null, 45), null, 'null-first safe');
  assert.strictEqual(P.logNewUpdate({ new_at: 30 }, 'x'), undefined);
});

test('buildDataMessage: DATA-ONLY, string values incl. at + epoch, high priority, 5 min TTL', () => {
  const m = P.buildDataMessage({ token: 'tok', epoch: EP }, 'new_order', 'o1', 'tb_norte', 1700000000123);
  assert.deepStrictEqual(m, { token: 'tok', data: { type: 'new_order', order_id: 'o1', rid: 'tb_norte', at: '1700000000123', epoch: EP }, android: { priority: 'high', ttl: 300000 } });
  assert.ok(!('notification' in m) && !('notification' in m.android));
  assert.throws(() => P.buildDataMessage({ token: 't', epoch: EP }, 'other', 'o', 'r', 1), /bad push type/);
  assert.throws(() => P.buildDataMessage({ token: 't', epoch: EP }, 'resolved', 'o', 'r', NaN), /bad push at/);
});

test('dead tokens: a HANDHELD-only classifier (invalid-argument retained) + compare-and-clear against the token sent', () => {
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/registration-token-not-registered' }), true);
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/invalid-registration-token' }), true);
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/invalid-argument' }), false, 'may be a payload problem → retained');
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/internal-error' }), false);
  const row = { kind: 'handheld', revoked: false, fcm_token: 'T1', fcm_updated_at: 5, push_epoch: EP };
  assert.deepStrictEqual(P.clearTokenUpdate(row, 'T1'), { kind: 'handheld', revoked: false, push_epoch: EP });
  assert.strictEqual(P.clearTokenUpdate({ ...row, fcm_token: 'T2' }, 'T1'), undefined, 'the T1→T2 race: a send to T1 failed after re-register to T2 → T2 kept');
  assert.strictEqual(P.clearTokenUpdate(null, 'T1'), null);
});

test('pendingOf (S1b): new + unanswered + served at this handheld location; at = the log new_at, else created_at', () => {
  const orders = {
    a: { restaurant_id: 'tb_norte', routing_reason: 'n', status: 'new', created_at: 5 },
    b: { restaurant_id: 'tb_norte', routing_reason: 'n', status: 'new', created_at: 6 },
    c: { restaurant_id: 'tb_norte', routing_reason: 'n', status: 'new', handheld_answered: { kind: 'rejected' } },
    d: { restaurant_id: 'tb_norte', routing_reason: 'n', status: 'preparing' },
    e: { restaurant_id: 'tb_centro', routing_reason: 'n', status: 'new' },
    f: { restaurant_id: 'tb_norte', status: 'new' },                          // no provenance
  };
  assert.deepStrictEqual(P.pendingOf(orders, 'tb_norte', 'handheld', { b: { new_at: 30 } }), [{ order_id: 'a', at: 5 }, { order_id: 'b', at: 30 }]);
  assert.deepStrictEqual(P.pendingOf(orders, 'tb_norte', 'kds', {}), [], 'a kds location has no handheld pending');
});
