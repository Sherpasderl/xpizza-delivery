'use strict';
// Pure doc-derivation tests for the seed core (write I/O is proven in test/catalog-parity.emulator.test.js).
// Run: node catalog/seed-catalog-core.test.js
const assert = require('assert');
const { catalogDocsForRestaurant, docId, PROFILE_FIELDS } = require('./seed-catalog-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const d = catalogDocsForRestaurant({ Margherita: 299 }, { 'Extra Cheese': 40 });
assert.deepStrictEqual(d.itemDocs, [{ id: docId('Margherita'), key: 'Margherita', price: 299 }]);
assert.deepStrictEqual(d.extraDocs, [{ id: docId('Extra Cheese'), key: 'Extra Cheese', price: 40 }]);
ok('catalogDocsForRestaurant → docs with deterministic id + exact key + price');
assert.strictEqual(docId('Cacio e Pepe'), docId('Cacio e Pepe'), 'docId deterministic'); ok('docId stable');
assert.notStrictEqual(docId('a'), docId('b')); ok('distinct keys → distinct ids');

// A RENAME yields a NEW doc id (this is what orphans the old doc and makes reconcile observable in T6).
assert.notStrictEqual(docId('Margherita'), docId('Margherita (RENAMED)'));
ok('renaming a key changes the doc id (so re-seed must reconcile the orphan)');

// Firestore doc-id safety: item NAMEs contain spaces/accents — the id must be plain hex, never the key.
for (const k of ['Sweet Corn & Calabrian Chili', 'Jamón', 'Pistaccio Mortadella']) {
  assert.match(docId(k), /^[0-9a-f]{20}$/, `docId(${k}) is Firestore-safe hex`);
}
ok('doc ids are Firestore-safe hex, never derived-from/equal-to the pricing key');

// ── Codex F10: pricing_key_mode written by the seed MUST match the live itemPricingKey resolver. ──
const { itemPricingKey } = require('../menu-pricing');
const probe = { name: 'THE_NAME', id: 'the_id' };
for (const [rid, mode] of [['x_pizza', 'name'], ['la_musa', 'id']]) {
  assert.strictEqual(itemPricingKey(probe, rid), probe[mode], `${rid} resolver keys by ${mode}`);
  assert.ok(PROFILE_FIELDS.has('pricing_key_mode'), 'pricing_key_mode is an allowlisted profile field');
  ok(`pricing_key_mode '${mode}' matches itemPricingKey for ${rid}`);
}
console.log(`seed-core: OK (${n})`);
