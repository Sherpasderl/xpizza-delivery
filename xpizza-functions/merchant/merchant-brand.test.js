'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const { makeResolveBrand, resolveBrand } = require('./merchant-brand');

const fakeF1 = { brandIdOf: (rid, identity, brands) => (identity && identity.brand_id) || (brands && brands[rid] && brands[rid].activation && brands[rid].activation.state === 'legacy' ? rid : 'unknown') };

test('resolveBrand reads ONE identity + ONE brand record and delegates to F1 brandIdOf', async () => {
  const db = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } }, x_pizza: { identity: {} } }, brands: { x_pizza: { activation: { state: 'legacy' } } } });
  const resolve = makeResolveBrand(fakeF1);
  assert.strictEqual(await resolve(db, 'tb_norte'), 'tb');
  assert.strictEqual(await resolve(db, 'x_pizza'), 'x_pizza');
  assert.strictEqual(await resolve(db, 'zz'), 'unknown');
});

test('without an F1 module the resolver fails CLOSED (unknown) — the handheld stays refused', async () => {
  const resolve = makeResolveBrand(null);
  assert.strictEqual(await resolve(createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } } }), 'tb_norte'), 'unknown');
});

test('the exported resolver runs the REAL F1 brandIdOf (explicit brand_id, valid legacy singleton, else unknown)', async () => {
  // Third synthetic brand ('tb'); legacy record shape per brands/brand-model.js validateBrand.
  const legacy = (rid) => ({ name: 'Legado', active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
  const db = createFakeDb({
    restaurants: { tb_norte: { identity: { brand_id: 'tb' } }, tb_solo: { identity: {} }, tb_bad: { identity: { brand_id: 'Not Valid' } }, tb_half: { identity: {} } },
    brands: { tb_solo: legacy('tb_solo'), tb_half: { ...legacy('tb_half'), activation: { state: 'on', since: 1 } } },
  });
  assert.strictEqual(await resolveBrand(db, 'tb_norte'), 'tb');
  assert.strictEqual(await resolveBrand(db, 'tb_solo'), 'tb_solo');
  assert.strictEqual(await resolveBrand(db, 'tb_bad'), 'unknown', 'a malformed brand_id fails closed');
  assert.strictEqual(await resolveBrand(db, 'tb_half'), 'unknown', 'a non-legacy singleton is not its own brand');
  assert.strictEqual(await resolveBrand(db, 'tb_none'), 'unknown');
});

test('a read failure propagates (callers map it to unavailable)', async () => {
  const db = createFakeDb({});
  db.failReads.add('restaurants/tb_norte');
  await assert.rejects(() => makeResolveBrand(fakeF1)(db, 'tb_norte'));
});
