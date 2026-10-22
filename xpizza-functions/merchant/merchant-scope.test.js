'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const S = require('./merchant-scope');

// Third brand `tb` with two locations; resolveBrand is injected (F1's brandIdOf behind the adapter in production).
const brandOf = async (_db, rid) => (rid === 'tb_centro' || rid === 'tb_norte' ? 'tb' : rid === 'x_pizza' ? 'x_pizza' : 'unknown');
// PLAN-portal-membership r3: owners / managers live in brand_members; the brand record must validate and list the location.
const base = () => ({
  brands: { tb: { name: 'TB', active: true, locations: { tb_centro: 'member', tb_norte: 'member', tb_viejo: 'retired' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb' }, handhelds: { hh_c1: { kind: 'handheld', revoked: false }, hh_rev: { kind: 'handheld', revoked: true }, hh_nokind: { revoked: false } } },
    tb_norte: { identity: { brand_id: 'tb' }, handhelds: { hh_n1: { kind: 'handheld', revoked: false } } },
    tb_viejo: { identity: { brand_id: 'tb' } },
  },
  brand_members: { tb: { owners: { own_tb: { granted_at: 1, granted_by: 'cli:op' } }, managers: { tb_centro: { mgr_c: { granted_at: 1, granted_by: 'own_tb' } } } } },
  dispatchers: { disp_only: true },
});
const tok = (uid, rid, extra = {}) => ({ uid, token: { handheld: true, rid, ...extra } });

test('authorizeHandheld: registered, unrevoked device of THAT location only', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await S.authorizeHandheld(db, tok('hh_c1', 'tb_centro'), 'tb_centro', { resolveBrand: brandOf }),
    { ok: true, uid: 'hh_c1', row: { kind: 'handheld', revoked: false } }, 'the registry row read for THIS decision comes back (H1c reads pair_gen from it)');
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_c1', 'tb_centro'), 'tb_norte', { resolveBrand: brandOf })).code, 'forbidden');       // claim rid ≠ arg rid
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_c1', 'tb_norte'), 'tb_norte', { resolveBrand: brandOf })).code, 'forbidden');       // not in tb_norte registry
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_rev', 'tb_centro'), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden');    // revoked
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_nokind', 'tb_centro'), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden'); // not server-created
  assert.strictEqual((await S.authorizeHandheld(db, { uid: 'hh_c1', token: { rid: 'tb_centro' } }, 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden'); // no claim
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_c1', 'tb_centro', { customer: true }), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden');
  assert.strictEqual((await S.authorizeHandheld(db, null, 'tb_centro', { resolveBrand: brandOf })).code, 'unauthenticated');
});

test('authorizeHandheld: unknown brand refused BEFORE the registry is read; read error → unavailable', async () => {
  const db = createFakeDb(base());
  db.failReads.add('restaurants/zz_lost');
  assert.strictEqual((await S.authorizeHandheld(db, tok('hh_x', 'zz_lost'), 'zz_lost', { resolveBrand: brandOf })).code, 'forbidden');   // no read attempted (it would throw)
  const db2 = createFakeDb(base());
  db2.failReads.add('restaurants/tb_centro/handhelds');
  assert.strictEqual((await S.authorizeHandheld(db2, tok('hh_c1', 'tb_centro'), 'tb_centro', { resolveBrand: brandOf })).code, 'unavailable');
  const db3 = createFakeDb(base());
  const throwing = async () => { throw new Error('boom'); };
  assert.strictEqual((await S.authorizeHandheld(db3, tok('hh_c1', 'tb_centro'), 'tb_centro', { resolveBrand: throwing })).code, 'unavailable');
});

test('authorizeManager (pairing / revoking): brand owner on any location, manager on theirs only; devices and customers never', async () => {
  const db = createFakeDb(base());
  const u = (uid, extra = {}) => ({ uid, token: { ...extra } });
  assert.strictEqual((await S.authorizeManager(db, u('own_tb'), 'tb_norte', { resolveBrand: brandOf })).ok, true);
  assert.strictEqual((await S.authorizeManager(db, u('mgr_c'), 'tb_centro', { resolveBrand: brandOf })).ok, true);
  assert.strictEqual((await S.authorizeManager(db, u('mgr_c'), 'tb_norte', { resolveBrand: brandOf })).code, 'forbidden');
  assert.strictEqual((await S.authorizeManager(db, u('hh_c1', { handheld: true, rid: 'tb_centro' }), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden');
  assert.strictEqual((await S.authorizeManager(db, u('own_tb', { customer: true }), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden');
  assert.strictEqual((await S.authorizeManager(db, u('own_tb'), 'zz_lost', { resolveBrand: brandOf })).code, 'forbidden');
  // PLAN-portal-membership r3: a RETIRED location is not pairing-eligible (owner keeps read-only history only)
  assert.strictEqual((await S.authorizeManager(db, u('own_tb'), 'tb_viejo', { resolveBrand: brandOf })).code, 'forbidden');
  // a dispatcher ALONE gains no device capability (H1 policy, unchanged)
  assert.strictEqual((await S.authorizeManager(db, u('disp_only'), 'tb_centro', { resolveBrand: brandOf })).code, 'forbidden');
  // a read failure is unavailable, never a lower answer
  const broken = createFakeDb(base()); broken.failReads.add('brand_members');
  assert.strictEqual((await S.authorizeManager(broken, u('own_tb'), 'tb_centro', { resolveBrand: brandOf })).code, 'unavailable');
});
