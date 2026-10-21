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
// PLAN-portal-membership r3: owners / managers in brand_members; a valid brand record listing the locations.
const world = (over = {}) => ({
  platform_config: { handheld_pairing_enabled: true },
  brands: { tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_norte: 'member' }, activation: { state: 'on', since: 1 } } },
  brand_members: { tb: { owners: { own_tb: { granted_at: 1, granted_by: 'cli:op' } }, managers: { tb_centro: { mgr_c: { granted_at: 1, granted_by: 'own_tb' } } } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', prep_default_min: 18 }, handhelds: { hh_tb_centro_a: { kind: 'handheld', revoked: false } } },
    tb_norte: { identity: { brand_id: 'tb' }, handhelds: { hh_tb_norte_b: { kind: 'handheld', revoked: false }, human_row: { revoked: false } } },
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
  assert.deepStrictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r4nd'), { kind: 'handheld', label: 'Mostrador', paired_at: T0, paired_by: 'mgr_c', revoked: false, pair_gen: 1 });
});

test('H1c (codex H1c-server r3): every pairing takes the NEXT server-issued pair_gen from one counter; a malformed / unreadable counter refuses', async () => {
  const db = createFakeDb(world()); let n = 0;
  const d = { ...deps(db, fakeAuth()), randomId: () => `r${++n}` };
  await D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'A' });
  await D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'B' });
  assert.deepStrictEqual([db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r1/pair_gen'), db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r2/pair_gen'),
    db.get('platform_config/handheld_pair_gen')], [1, 2, 2]);
  db.put('platform_config/handheld_pair_gen', 'junk');
  await rejectsCode(D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'C' }), 'unavailable');
  assert.strictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r3'), null, 'never a re-issued generation');
  for (const bad of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 2 ** 60, 1.5]) {
    db.put('platform_config/handheld_pair_gen', bad);
    await rejectsCode(D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'X' }), 'unavailable');
  }
  assert.strictEqual(db.get('platform_config/handheld_pair_gen'), 1.5, 'an exhausted / unsafe counter is never incremented');
  db.put('platform_config/handheld_pair_gen', Number.MAX_SAFE_INTEGER - 1);
  await D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'Last' });
  assert.strictEqual(db.get('platform_config/handheld_pair_gen'), Number.MAX_SAFE_INTEGER, 'the last safe generation is issued');
  db.put('platform_config/handheld_pair_gen', 2);
  db.failReads.add('platform_config/handheld_pair_gen');
  await rejectsCode(D.pairDevice(d, human('mgr_c'), { rid: 'tb_centro', label: 'D' }), 'unavailable');
  assert.strictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r4'), null, 'no generation → no device');
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

test('pair: PRECONDITION — a location without a valid prep_default_min (5–120) is refused before any Auth call', async () => {
  for (const bad of [undefined, null, 4, 121, 18.5, '18']) {
    const w = world(); if (bad === undefined) delete w.restaurants.tb_centro.identity.prep_default_min; else w.restaurants.tb_centro.identity.prep_default_min = bad;   // identity.brand_id stays (membership r3)
    const db = createFakeDb(w); const a = fakeAuth();
    await rejectsCode(D.pairDevice(deps(db, a), human('mgr_c'), { rid: 'tb_centro', label: 'x' }), 'failed-precondition');
    assert.deepStrictEqual(a.calls, [], `no Auth call for ${JSON.stringify(bad)}`);
    assert.strictEqual(db.get('restaurants/tb_centro/handhelds/hh_tb_centro_r4nd'), null);
  }
  const broken = createFakeDb(world()); broken.failReads.add('restaurants/tb_centro/identity');
  await rejectsCode(D.pairDevice(deps(broken, fakeAuth()), human('mgr_c'), { rid: 'tb_centro', label: 'x' }), 'unavailable');
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

test('myLocations: owner → every member location of their brand; manager → only theirs; retired excluded; devices/customers refused', async () => {
  const on = { active: true, activation: { state: 'on', since: 1 } };
  const g = { granted_at: 1, granted_by: 'x' };
  const db = createFakeDb({
    brands: { tb: { name: 'TB', ...on, locations: { tb_centro: 'member', tb_norte: 'member', tb_viejo: 'retired' } }, zz: { name: 'ZZ', ...on, locations: { zz_1: 'member' } } },
    brand_members: { tb: { owners: { own_tb: g }, managers: { tb_centro: { mgr_c: g } } }, zz: { managers: { zz_1: { mgr_c: g } } } },
    member_of: { own_tb: { brands: { tb: 'owner' } }, mgr_c: { locations: { tb_centro: 'manager', zz_1: 'manager' } } },
    restaurants: {
      tb_centro: { identity: { brand_id: 'tb', location_name: 'Centro', prep_default_min: 18 } },
      tb_norte: { identity: { brand_id: 'tb', location_name: 'Norte', prep_default_min: 200 } },
      tb_viejo: { identity: { brand_id: 'tb', location_name: 'Viejo', prep_default_min: 20 } },
      zz_1: { identity: { brand_id: 'zz', location_name: 'Uno', prep_default_min: 25 } },
    },
  });
  const d = deps(db, fakeAuth());
  assert.deepStrictEqual(await D.myLocations(d, human('own_tb'), {}), [
    { rid: 'tb_centro', brand_id: 'tb', location_name: 'Centro', prep_default_min: 18 }, { rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: null }]);
  assert.deepStrictEqual(await D.myLocations(d, human('mgr_c'), {}), [
    { rid: 'tb_centro', brand_id: 'tb', location_name: 'Centro', prep_default_min: 18 }, { rid: 'zz_1', brand_id: 'zz', location_name: 'Uno', prep_default_min: 25 }]);
  assert.deepStrictEqual(await D.myLocations(d, human('nobody'), {}), []);
  await rejectsCode(D.myLocations(d, { uid: 'hh_x', token: { handheld: true, rid: 'tb_centro' } }, {}), 'permission-denied');
  await rejectsCode(D.myLocations(d, human('own_tb', { customer: true }), {}), 'permission-denied');
  await rejectsCode(D.myLocations(d, null, {}), 'unauthenticated');
  const broken = createFakeDb({}); broken.failReads.add('member_of');
  await rejectsCode(D.myLocations(deps(broken, fakeAuth()), human('own_tb'), {}), 'unavailable');
});
