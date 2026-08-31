'use strict';
// Integrity-descriptor unit tests (pure). Run: node catalog/catalog-integrity.test.js
const assert = require('assert');
const { canonicalPairs, hashTable, integrityDescriptor, assertComplete } = require('./catalog-integrity');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// canonical pairs are order-independent
assert.deepStrictEqual(canonicalPairs({ b: 2, a: 1 }), [['a', 1], ['b', 2]]);
assert.deepStrictEqual(canonicalPairs({ a: 1, b: 2 }), [['a', 1], ['b', 2]]);
ok('canonicalPairs sorts by key (order-independent)');

// same table → same hash regardless of insertion order
assert.strictEqual(hashTable({ a: 1, b: 2 }), hashTable({ b: 2, a: 1 }));
ok('hashTable is order-independent');

// FULL sha-256 (64 hex chars), never truncated
assert.strictEqual(hashTable({ a: 1 }).length, 64);
assert.ok(/^[0-9a-f]{64}$/.test(hashTable({ a: 1 })), 'full untruncated hex');
ok('hashTable is a FULL 64-char SHA-256 (money-grade, not the 12-char log hash)');

// falsifiable: a single price change → different hash
assert.notStrictEqual(hashTable({ a: 1 }), hashTable({ a: 2 }));
assert.notStrictEqual(hashTable({ a: 1, b: 2 }), hashTable({ a: 1, b: 3 }));
ok('a changed price changes the hash (falsifiable)');

// NAMESPACE SEPARATION — the whole point of two hashes. A value moving between a menu key and an
// extras key of the SAME name must NOT cancel out. Merged single-hash would miss it; separate hashes catch it.
{
  const menuA = { Cheese: 100 }, extraA = { Cheese: 50 };
  const menuB = { Cheese: 50 }, extraB = { Cheese: 100 };   // swapped across namespaces
  const dA = integrityDescriptor(menuA, extraA), dB = integrityDescriptor(menuB, extraB);
  assert.notStrictEqual(dA.menu_hash, dB.menu_hash, 'menu side detects the swap');
  assert.notStrictEqual(dA.extras_hash, dB.extras_hash, 'extras side detects the swap');
  ok('namespace separation: a menu↔extras value swap is caught (merged hash would hide it)');
}

// descriptor counts
{
  const d = integrityDescriptor({ a: 1, b: 2, c: 3 }, { x: 9 });
  assert.strictEqual(d.item_count, 3);
  assert.strictEqual(d.extra_count, 1);
  ok('integrityDescriptor reports item_count / extra_count');
}

// assertComplete — passes on a match
{
  const menu = { a: 1, b: 2 }, extras = { x: 9 };
  const rec = integrityDescriptor(menu, extras);
  assert.strictEqual(assertComplete(rec, menu, extras, 'v1'), true);
  ok('assertComplete: matching read+record → true');
}

// assertComplete — throws on each mismatch class
{
  const menu = { a: 1, b: 2 }, extras = { x: 9 };
  const rec = integrityDescriptor(menu, extras);
  // torn menu read (one item dropped) → count mismatch
  assert.throws(() => assertComplete(rec, { a: 1 }, extras, 'v1'), /catalog_incomplete_item_count/);
  // torn extras read → extra count mismatch
  assert.throws(() => assertComplete(rec, menu, {}, 'v1'), /catalog_incomplete_extra_count/);
  // tampered menu price (same count) → menu hash mismatch
  assert.throws(() => assertComplete(rec, { a: 1, b: 999 }, extras, 'v1'), /catalog_incomplete_menu_hash/);
  // tampered extras price (same count) → extras hash mismatch
  assert.throws(() => assertComplete(rec, menu, { x: 999 }, 'v1'), /catalog_incomplete_extras_hash/);
  ok('assertComplete: torn menu / torn extras / tampered menu price / tampered extras price all THROW');
}

console.log(`catalog-integrity: OK (${n})`);
