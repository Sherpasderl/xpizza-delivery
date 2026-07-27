'use strict';

// Unit test for normalizeReorderItems (P3 reorder recipe). Proves: menu-allowlisted keys only
// (x_pizza by NAME, la_musa by ID — mirroring computeServerTotal); unknown item/extra DROPPED; qty
// preserved + bounds-checked; recognized options kept per-restaurant; array capped; guest/empty → [].
// Run: node reorder-normalize.test.js
const assert = require('assert');
const { normalizeReorderItems } = require('./reorder-normalize');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── x_pizza: name-keyed items + name-based extras ──
assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Hongos' }] }], 'x_pizza'),
  [{ key: 'Margherita', qty: 2, options: [{ name: 'Mozzarella', count: 1 }, { name: 'Hongos', count: 1 }] }]);
ok('x_pizza item + recognized extras → {name,count}');

assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'Pepperoni', qty: 3 }], 'x_pizza'),
  [{ key: 'Pepperoni', qty: 3 }]);
ok('x_pizza item no extras');

assert.deepStrictEqual(
  normalizeReorderItems([{ id: 'zzz', name: 'Pepperoni', qty: 1 }], 'x_pizza'),
  [{ key: 'Pepperoni', qty: 1 }]);
ok('x_pizza keys by NAME (posted id ignored)');

assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'FakePizza', qty: 1 }, { name: 'Margherita', qty: 1 }], 'x_pizza'),
  [{ key: 'Margherita', qty: 1 }]);
ok('x_pizza unknown item DROPPED');

assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'Margherita', qty: 1, extras: [{ name: 'FakeExtra' }, { name: 'Mozzarella' }] }], 'x_pizza'),
  [{ key: 'Margherita', qty: 1, options: [{ name: 'Mozzarella', count: 1 }] }]);
ok('x_pizza unknown extra DROPPED, recognized kept ({name,count})');

// x_pizza multiplicity — an extra on N pizza instances is priced ×N by computeServerTotal (no server
// dedup), so the recipe must COUNT it (Option 3 fix — old dedup-once lost this).
assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Mozzarella' }] }], 'x_pizza'),
  [{ key: 'Margherita', qty: 2, options: [{ name: 'Mozzarella', count: 2 }] }]);
ok('x_pizza extra on N instances → count N (multiplicity preserved)');
assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }, { name: 'Mozzarella' }] }], 'x_pizza'),
  [{ key: 'Margherita', qty: 1, options: [{ name: 'Mozzarella', count: 1 }] }]);
ok('x_pizza extra count capped to item qty (cannot exceed pizza instances)');

// ── la_musa: id-keyed items + id-keyed qty-aware extras (variants are distinct ids) ──
assert.deepStrictEqual(
  normalizeReorderItems([{ id: 'noodle_01_pollo', qty: 1, extras: [{ id: 'protein_chicken', qty: 2 }] }], 'la_musa'),
  [{ key: 'noodle_01_pollo', qty: 1, options: [{ id: 'protein_chicken', qty: 2 }] }]);
ok('la_musa variant id + qty-aware extra');

assert.deepStrictEqual(
  normalizeReorderItems([{ name: 'ignored', id: 'dimsum_01', qty: 4 }], 'la_musa'),
  [{ key: 'dimsum_01', qty: 4 }]);
ok('la_musa keys by ID (posted name ignored)');

assert.deepStrictEqual(
  normalizeReorderItems([{ id: 'not_a_real_id', qty: 1 }, { id: 'rice_01', qty: 2 }], 'la_musa'),
  [{ key: 'rice_01', qty: 2 }]);
ok('la_musa unknown id DROPPED');

assert.deepStrictEqual(
  normalizeReorderItems([{ id: 'noodle_02', qty: 1, extras: [{ id: 'fake_extra', qty: 1 }, { id: 'protein_chicken', qty: 1 }, { id: 'protein_chicken', qty: 1 }] }], 'la_musa'),
  [{ key: 'noodle_02', qty: 1, options: [{ id: 'protein_chicken', qty: 1 }] }]);
ok('la_musa unknown extra dropped + duplicate id folded');

// ── qty bounds ──
assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 0 }], 'x_pizza'), []);
ok('qty < 1 → dropped');
assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 99 }], 'x_pizza'), []);
ok('qty > 50 → dropped');
assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1.5 }], 'x_pizza'), []);
ok('non-integer qty → dropped');
assert.deepStrictEqual(
  normalizeReorderItems([{ id: 'rice_01', qty: 1, extras: [{ id: 'rice_white', qty: 0 }] }], 'la_musa'),
  [{ key: 'rice_01', qty: 1 }]);
ok('la_musa extra bad qty → extra dropped, item kept');

// ── guest / empty / malformed → [] ──
assert.deepStrictEqual(normalizeReorderItems([], 'x_pizza'), []); ok('empty array → []');
assert.deepStrictEqual(normalizeReorderItems(null, 'x_pizza'), []); ok('null → []');
assert.deepStrictEqual(normalizeReorderItems('nope', 'la_musa'), []); ok('non-array → []');
assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'unknown_rest'), []); ok('unknown restaurant → []');

// ── cap to MAX_LINES (100) ──
const big = Array.from({ length: 150 }, () => ({ name: 'Margherita', qty: 1 }));
assert.strictEqual(normalizeReorderItems(big, 'x_pizza').length, 100); ok('array capped at 100 lines');

console.log(`\nreorder-normalize: ${n} assertions passed`);
