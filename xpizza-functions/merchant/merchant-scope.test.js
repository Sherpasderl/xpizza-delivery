'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const S = require('./merchant-scope');

// Third brand `tb` with two locations; resolveBrand is injected (F1's brandIdOf behind the adapter in production).
const brandOf = async (_db, rid) => (rid === 'tb_centro' || rid === 'tb_norte' ? 'tb' : rid === 'x_pizza' ? 'x_pizza' : 'unknown');
const base = () => ({
  restaurants: {
    tb_centro: { handhelds: { hh_c1: { kind: 'handheld', revoked: false }, hh_rev: { kind: 'handheld', revoked: true }, hh_nokind: { revoked: false } },
                 managers: { mgr_c: true } },
    tb_norte: { handhelds: { hh_n1: { kind: 'handheld', revoked: false } } },
    tb: { owners: { own_tb: true } },
  },
});
const tok = (uid, rid, extra = {}) => ({ uid, token: { handheld: true, rid, ...extra } });

test('authorizeHandheld: registered, unrevoked device of THAT location only', async () => {
  const db = createFakeDb(base());
  assert.deepStrictEqual(await S.authorizeHandheld(db, tok('hh_c1', 'tb_centro'), 'tb_centro', { resolveBrand: brandOf }), { ok: true, uid: 'hh_c1' });
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
});
