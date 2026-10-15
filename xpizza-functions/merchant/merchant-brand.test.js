'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const { makeResolveBrand } = require('./merchant-brand');

const fakeF1 = { brandIdOf: (rid, identity, brands) => (identity && identity.brand_id) || (brands && brands[rid] && brands[rid].activation && brands[rid].activation.state === 'legacy' ? rid : 'unknown') };

test('resolveBrand reads ONE identity + ONE brand record and delegates to F1 brandIdOf', async () => {
  const db = createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } }, x_pizza: { identity: {} } }, brands: { x_pizza: { activation: { state: 'legacy' } } } });
  const resolve = makeResolveBrand(fakeF1);
  assert.strictEqual(await resolve(db, 'tb_norte'), 'tb');
  assert.strictEqual(await resolve(db, 'x_pizza'), 'x_pizza');
  assert.strictEqual(await resolve(db, 'zz'), 'unknown');
});

test('without F1 on this base the resolver fails CLOSED (unknown) — the handheld stays refused', async () => {
  const resolve = makeResolveBrand(null);
  assert.strictEqual(await resolve(createFakeDb({ restaurants: { tb_norte: { identity: { brand_id: 'tb' } } } }), 'tb_norte'), 'unknown');
});

test('a read failure propagates (callers map it to unavailable)', async () => {
  const db = createFakeDb({});
  db.failReads.add('restaurants/tb_norte');
  await assert.rejects(() => makeResolveBrand(fakeF1)(db, 'tb_norte'));
});
