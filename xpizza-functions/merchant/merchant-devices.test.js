'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const D = require('./merchant-devices');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const T0 = 1_700_000_000_000;
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');

function fakeAuth({ failOn } = {}) {
  const calls = [];
  const users = {};
  return {
    calls, users,
    async createUser({ uid }) { calls.push(['createUser', uid]); users[uid] = { disabled: false }; return { uid }; },
    async createCustomToken(uid, claims) { calls.push(['createCustomToken', uid, claims]); return `tok:${uid}:${JSON.stringify(claims)}`; },
    async updateUser(uid, p) { calls.push(['updateUser', uid, p]); if (failOn === 'updateUser') { failOn = null; throw new Error('auth down'); } users[uid] = { ...(users[uid] || {}), ...p }; },
    async revokeRefreshTokens(uid) { calls.push(['revokeRefreshTokens', uid]); },
  };
}
const world = (over = {}) => ({
  platform_config: { handheld_pairing_enabled: true },
  restaurants: {
    tb: { owners: { own_tb: true } },
    tb_centro: { managers: { mgr_c: true }, handhelds: { hh_tb_centro_a: { kind: 'handheld', revoked: false } } },
    tb_norte: { handhelds: { hh_tb_norte_b: { kind: 'handheld', revoked: false }, human_row: { revoked: false } } },
  },
  ...over,
});
const human = (uid, extra = {}) => ({ uid, token: { ...extra } });
const deps = (db, auth) => ({ db, adminAuth: auth, resolveBrand, HttpsError, now: () => T0, randomId: () => 'r4nd' });
const rejectsCode = (p, c) => assert.rejects(p, (e) => e.code === c);

test('pair: manager of the location → device user + registry row + custom token with server-chosen uid/claims', async () => {
  const db = createFakeDb(world()); const a = fakeAuth();
  const r = await D.pairDevice(deps(db, a), human('mgr_c'), { rid: 'tb_centro', label: 'Mostrador' });
  assert.strictEqual(r.uid, 'hh_tb_centro_r4nd');
  assert.deepStrictEqual(a.calls.find((c) => c[0] === 'createCustomToken'), ['createCustomToken', 'hh_tb_centro_r4nd', { handheld: true, rid: 'tb_centro' }]);
  assert.deepStrictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r4nd'), { kind: 'handheld', label: 'Mostrador', paired_at: T0, paired_by: 'mgr_c', revoked: false });
});

test('pair: refused while the pairing gate is off (even for an owner), across locations, for devices, and with client-supplied uid/claims', async () => {
  const off = createFakeDb(world({ platform_config: {} }));
  await rejectsCode(D.pairDevice(deps(off, fakeAuth()), human('own_tb'), { rid: 'tb_centro', label: 'x' }), 'failed-precondition');
  const db = createFakeDb(world());
  await rejectsCode(D.pairDevice(deps(db, fakeAuth()), human('mgr_c'), { rid: 'tb_norte', label: 'x' }), 'permission-denied');
  await rejectsCode(D.pairDevice(deps(db, fakeAuth()), human('hh_tb_centro_a', { handheld: true, rid: 'tb_centro' }), { rid: 'tb_centro', label: 'x' }), 'permission-denied');
  await rejectsCode(D.pairDevice(deps(db, fakeAuth()), human('mgr_c'), { rid: 'tb_centro', label: 'x', uid: 'chosen' }), 'invalid-argument');
  await rejectsCode(D.pairDevice(deps(db, fakeAuth()), human('mgr_c'), { rid: 'tb_centro', label: 'x', claims: { admin: true } }), 'invalid-argument');
});

test('revoke: only an existing kind:handheld row under the authorized rid; nothing created; no Auth call otherwise', async () => {
  for (const target of ['hh_tb_norte_b', 'mgr_c', 'own_tb', 'dispatcher_1', 'cust_1', 'nope', 'human_row']) {
    const db = createFakeDb(world()); const a = fakeAuth();
    const rid = target === 'human_row' ? 'tb_norte' : 'tb_centro';
    const caller = rid === 'tb_norte' ? human('own_tb') : human('mgr_c');
    await rejectsCode(D.revokeDevice(deps(db, a), caller, { rid, uid: target }), 'not-found');
    assert.deepStrictEqual(a.calls, [], `no Auth call for ${target}`);
    assert.strictEqual(db.get(`restaurants/${rid}/handhelds/${target}/revoked`), target === 'human_row' ? false : (target === 'hh_tb_norte_b' && rid === 'tb_norte' ? false : null));
  }
});

test('revoke: ordered, idempotent, recovers a partial Auth failure; works with pairing off and a kds surface', async () => {
  const db = createFakeDb(world({ platform_config: {} })); const a = fakeAuth({ failOn: 'updateUser' });
  await assert.rejects(D.revokeDevice(deps(db, a), human('mgr_c'), { rid: 'tb_centro', uid: 'hh_tb_centro_a' }));
  assert.strictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_a/revoked'), true);   // step 1 landed first
  const r = await D.revokeDevice(deps(db, a), human('mgr_c'), { rid: 'tb_centro', uid: 'hh_tb_centro_a' });
  assert.deepStrictEqual(r, { ok: true, uid: 'hh_tb_centro_a' });
  assert.strictEqual(a.users.hh_tb_centro_a.disabled, true);
  assert.ok(a.calls.some((c) => c[0] === 'revokeRefreshTokens'));
  assert.deepStrictEqual(await D.revokeDevice(deps(db, a), human('mgr_c'), { rid: 'tb_centro', uid: 'hh_tb_centro_a' }), { ok: true, uid: 'hh_tb_centro_a' });
});

test('heartbeat: registered unrevoked device only', async () => {
  const db = createFakeDb(world());
  await D.heartbeat(deps(db, fakeAuth()), { uid: 'hh_tb_centro_a', token: { handheld: true, rid: 'tb_centro' } }, { rid: 'tb_centro' });
  assert.strictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_a/last_seen'), T0);
  await rejectsCode(D.heartbeat(deps(db, fakeAuth()), { uid: 'ghost', token: { handheld: true, rid: 'tb_centro' } }, { rid: 'tb_centro' }), 'permission-denied');
  db.put('restaurants/tb_centro/handhelds/hh_tb_centro_a/revoked', true);
  await rejectsCode(D.heartbeat(deps(db, fakeAuth()), { uid: 'hh_tb_centro_a', token: { handheld: true, rid: 'tb_centro' } }, { rid: 'tb_centro' }), 'permission-denied');
});
