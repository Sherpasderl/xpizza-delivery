'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('./_fake-db');
const G = require('./merchant-gate');

test('pairing gate: only an explicit true opens it; absent / other / read error → closed', async () => {
  assert.strictEqual(await G.pairingEnabled(createFakeDb({})), false);
  assert.strictEqual(await G.pairingEnabled(createFakeDb({ platform_config: { handheld_pairing_enabled: 'true' } })), false);
  assert.strictEqual(await G.pairingEnabled(createFakeDb({ platform_config: { handheld_pairing_enabled: true } })), true);
  const db = createFakeDb({ platform_config: { handheld_pairing_enabled: true } });
  db.failReads.add('platform_config');
  assert.strictEqual(await G.pairingEnabled(db), false);
});

test('surface: absent / malformed → kds; handheld only when exactly "handheld"; read error throws unavailable', async () => {
  assert.strictEqual(await G.surfaceOf(createFakeDb({}), 'tb_centro'), 'kds');
  assert.strictEqual(await G.surfaceOf(createFakeDb({ restaurants: { tb_centro: { order_surface: 'HANDHELD' } } }), 'tb_centro'), 'kds');
  assert.strictEqual(await G.surfaceOf(createFakeDb({ restaurants: { tb_centro: { order_surface: { x: 1 } } } }), 'tb_centro'), 'kds');
  assert.strictEqual(await G.surfaceOf(createFakeDb({ restaurants: { tb_norte: { order_surface: 'handheld' } } }), 'tb_norte'), 'handheld');
  const db = createFakeDb({ restaurants: { tb_norte: { order_surface: 'handheld' } } });
  db.failReads.add('restaurants/tb_norte');
  await assert.rejects(() => G.surfaceOf(db, 'tb_norte'), (e) => e.code === 'unavailable');
});

test('dual-role check (BC1): uids present in BOTH kitchen and dispatchers', () => {
  assert.deepStrictEqual(G.dualRoleConflicts(['a', 'b', 'c'], ['c', 'd']), ['c']);
  assert.deepStrictEqual(G.dualRoleConflicts([], ['x']), []);
  assert.deepStrictEqual(G.dualRoleConflicts(['b', 'a'], ['a', 'b']), ['a', 'b']);
});
