'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('./merchant-validate');

test('vPrep: type and finiteness FIRST, then the approved clamp to an integer 5–90', () => {
  for (const bad of [null, undefined, '', '30', true, false, NaN, Infinity, -Infinity, -0, {}, []]) assert.strictEqual(V.vPrep(bad), null, `rejects ${String(bad)}`);
  assert.strictEqual(V.vPrep(3), 5);
  assert.strictEqual(V.vPrep(120), 90);
  assert.strictEqual(V.vPrep(18), 18);
  assert.strictEqual(V.vPrep(22.6), 23);
  assert.strictEqual(V.vPrep(0), 5);
});

test('small enums and ids', () => {
  assert.strictEqual(V.vAdd(5), 5); assert.strictEqual(V.vAdd(15), 15);
  for (const bad of [0, 20, '5', null, 7]) assert.strictEqual(V.vAdd(bad), null);
  for (const r of ['agotado', 'saturada', 'cerrando', 'otro']) assert.strictEqual(V.vReason(r), r);
  assert.strictEqual(V.vReason('cancel'), null);
  assert.strictEqual(V.vOpId('abcd_1234-XY'), 'abcd_1234-XY');
  for (const bad of ['short', 'has space1', 'a/b/c/d/e/f', 'x'.repeat(65), 123]) assert.strictEqual(V.vOpId(bad), null);
  assert.strictEqual(V.vRid('tb_norte'), 'tb_norte');
  for (const bad of ['TB', 'a/b', '', 'x'.repeat(41), '__proto__', 'unknown', '123']) assert.strictEqual(V.vRid(bad), null, `rid ${bad}`);
  assert.strictEqual(V.vOid('-Nabc_123'), '-Nabc_123');
  for (const bad of ['', 'a/b', 'a.b', 'a#b', 'a$b', 'a[b', 'x'.repeat(129), 5]) assert.strictEqual(V.vOid(bad), null);
  assert.strictEqual(V.vLabel('  Mostrador  '), 'Mostrador');
  assert.strictEqual(V.vLabel(''), null);
  assert.strictEqual(V.vLabel('x'.repeat(41)), null);
});

test('vNote / vItems', () => {
  assert.strictEqual(V.vNote(undefined), null);
  assert.strictEqual(V.vNote('  sin cebolla '), 'sin cebolla');
  assert.strictEqual(V.vNote('x'.repeat(141)), undefined);   // present but invalid → caller refuses
  assert.deepStrictEqual(V.vItems(undefined), []);
  assert.deepStrictEqual(V.vItems(['Pollo frito 3 piezas']), ['Pollo frito 3 piezas']);
  assert.strictEqual(V.vItems('x'), undefined);
  assert.strictEqual(V.vItems(new Array(21).fill('a')), undefined);
  assert.strictEqual(V.vItems(['x'.repeat(81)]), undefined);
  assert.strictEqual(V.vItems([1]), undefined);
});

test('vStoredPrep: full | ready_only | null', () => {
  const full = { committed_min: 18, extra_min: 5, accepted_at: 1000, ready_at: 1000 + 23 * 60000 };
  assert.strictEqual(V.vStoredPrep(full), 'full');
  assert.strictEqual(V.vStoredPrep({ ...full, ready_marked_at: 5 }), 'full');
  assert.strictEqual(V.vStoredPrep({ ready_marked_at: 5 }), 'ready_only');
  assert.strictEqual(V.vStoredPrep({ ...full, ready_at: 1 }), null);            // inconsistent ready_at
  assert.strictEqual(V.vStoredPrep({ ...full, extra_min: '5' }), null);
  assert.strictEqual(V.vStoredPrep({ ...full, junk: 1 }), null);
  assert.strictEqual(V.vStoredPrep({ ready_marked_at: 5, x: 1 }), null);
  assert.strictEqual(V.vStoredPrep(null), null);
  assert.strictEqual(V.vStoredPrep({}), null);
});
