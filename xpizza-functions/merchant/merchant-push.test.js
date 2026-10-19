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

test('targetsOf: entries of THIS rid, valid token / epoch / claim, whose uid is a registered unrevoked handheld; uid then hash order', () => {
  const C = (n) => String(n).repeat(24);
  const e = (rid, uid, token, over = {}) => ({ rid, uid, epoch: EP, token, claim: C(1), at: 5, ...over });
  const entries = {
    h2: e('tb_norte', 'hh_b', 'tb'), h1: e('tb_norte', 'hh_a', 'ta1'), h0: e('tb_norte', 'hh_a', 'ta0', { claim: C(2) }),
    hx: e('tb_centro', 'hh_a', 'tx'), hr: e('tb_norte', 'hh_rev', 'tr'), hn: e('tb_norte', 'hh_none', 'tn'), hh: e('tb_norte', 'human', 'th'),
    hbadc: e('tb_norte', 'hh_a', 'tc', { claim: 'nothex' }), hbade: e('tb_norte', 'hh_a', 'te', { epoch: 'short' }), hbadt: e('tb_norte', 'hh_a', 'a b'),
    hu: e('tb_norte', 'hh_unk', 'tu'),
  };
  const rows = { hh_a: { kind: 'handheld', revoked: false }, hh_b: { kind: 'handheld', revoked: false }, hh_rev: { kind: 'handheld', revoked: true },
    human: { kind: 'human', revoked: false }, hh_unk: { kind: 'handheld' } };
  assert.deepStrictEqual(P.targetsOf(entries, rows, 'tb_norte'), [
    { hash: 'h0', uid: 'hh_a', token: 'ta0', epoch: EP, claim: C(2) }, { hash: 'h1', uid: 'hh_a', token: 'ta1', epoch: EP, claim: C(1) },
    { hash: 'h2', uid: 'hh_b', token: 'tb', epoch: EP, claim: C(1) }]);
  assert.deepStrictEqual(P.targetsOf(null, rows, 'tb_norte'), []);
  assert.deepStrictEqual(P.targetsOf(entries, null, 'tb_norte'), [], 'no rows → no device is registered');
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

test('dead tokens: a HANDHELD-only classifier (invalid-argument retained)', () => {
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/registration-token-not-registered' }), true);
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/invalid-registration-token' }), true);
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/invalid-argument' }), false, 'may be a payload problem → retained');
  assert.strictEqual(P.isDeadHandheldToken({ code: 'messaging/internal-error' }), false);
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

test('codex r2: ONE registration record per token — a unique claim per registration; the newer REQUEST wins; clears match the exact claim', () => {
  const C1 = 'aaaaaaaaaaaaaaaaaaaaaaaa'; const C2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const old = { rid: 'tb_norte', uid: 'hh_a', epoch: EP, token: 'T', claim: C1, at: 100 };
  const fresh = { rid: 'tb_centro', uid: 'hh_c', epoch: 'epoch_ZYXWVUTSRQ9876', token: 'T', claim: C2, at: 200 };
  assert.deepStrictEqual(P.claimUpdate(null, old), old, 'first registration');
  assert.deepStrictEqual(P.claimUpdate(old, fresh), fresh, 'a newer request replaces (incl. a move to another device)');
  assert.strictEqual(P.claimUpdate(fresh, old), undefined, 'a STALE request (began earlier) landing late never overwrites');
  assert.deepStrictEqual(P.claimUpdate({ ...old, at: 200 }, fresh), fresh, 'same start ms: the claim breaks the tie (C2 > C1)');
  assert.strictEqual(P.claimUpdate({ ...fresh, at: 200 }, { ...old, at: 200 }), undefined, '…deterministically, both ways');
  assert.deepStrictEqual(P.claimUpdate({ rid: 'x', junk: true }, old), old, 'a malformed stored entry never blocks');
  assert.strictEqual(P.clearClaimUpdate(old, C1), null, 'the exact registration is cleared');
  assert.strictEqual(P.clearClaimUpdate(fresh, C1), undefined, 'a delayed cleanup of an OLD registration never clears a new one');
  assert.strictEqual(P.clearClaimUpdate(null, C1), null);
  assert.strictEqual(P.clearClaimUpdate(old, 'nothex'), undefined);
  assert.deepStrictEqual(P.unregisterMatches({ h1: old, h2: fresh, h3: { ...old, epoch: 'epoch_ZYXWVUTSRQ9876', claim: C2 } }, 'tb_norte', 'hh_a', EP), [{ hash: 'h1', claim: C1 }], 'only this pairing\'s epoch');
  assert.strictEqual(P.vClaim(C1), C1);
  for (const bad of ['a'.repeat(23), 'A'.repeat(24), 'g'.repeat(24), null, 5]) assert.strictEqual(P.vClaim(bad), null);
});
