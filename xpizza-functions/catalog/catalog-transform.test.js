'use strict';
// Unit tests for the pure catalog transforms. Run: node catalog/catalog-transform.test.js
const assert = require('assert');
const { buildTablesFromDocs, codeTablesToCatalogDocs } = require('./catalog-transform');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// buildTablesFromDocs: docs (each {key, price}) → the {key: price} table shape
const items = [{ key: 'Margherita', price: 299 }, { key: 'Pepperoni', price: 307 }];
const extras = [{ key: 'Extra Cheese', price: 40 }];
const tables = buildTablesFromDocs(items, extras);
assert.deepStrictEqual(tables, { menu: { Margherita: 299, Pepperoni: 307 }, extras: { 'Extra Cheese': 40 } });
ok('buildTablesFromDocs → {key: price} tables');

// codeTablesToCatalogDocs: table → docs (the inverse)
const docs = codeTablesToCatalogDocs({ Margherita: 299, Pepperoni: 307 }, { 'Extra Cheese': 40 });
assert.deepStrictEqual(docs.itemDocs.sort((a, b) => (a.key < b.key ? -1 : 1)), [{ key: 'Margherita', price: 299 }, { key: 'Pepperoni', price: 307 }]);
assert.deepStrictEqual(docs.extraDocs, [{ key: 'Extra Cheese', price: 40 }]);
ok('codeTablesToCatalogDocs → docs');

// round-trip identity (id-keyed brand too: keys are opaque)
const laMenu = { dimsum_01: 223, dimsum_02: 248 };
const rt = buildTablesFromDocs(codeTablesToCatalogDocs(laMenu, {}).itemDocs, []);
assert.deepStrictEqual(rt.menu, laMenu);
ok('round-trip is identity (key-agnostic: works for id-keyed la_musa)');

// empty extras → empty object, not undefined
assert.deepStrictEqual(buildTablesFromDocs([], []), { menu: {}, extras: {} });
ok('empty → {menu:{}, extras:{}}');
console.log(`catalog-transform: OK (${n})`);

// ── Transform correctness (NOT parity): the pure transforms are mutual inverses on the live tables. ──
// This does NOT prove the CATALOG reproduces prices (no Firestore here) — Task 6's emulator round-trip does.
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
for (const rid of ['x_pizza', 'la_musa']) {
  const menu = MENU_BY_RESTAURANT[rid];
  const extras = EXTRAS_BY_RESTAURANT[rid] || {};
  const encoded = codeTablesToCatalogDocs(menu, extras);
  const back = buildTablesFromDocs(encoded.itemDocs, encoded.extraDocs);
  assert.deepStrictEqual(back.menu, menu, `${rid} menu transform round-trip`);
  assert.deepStrictEqual(back.extras, extras, `${rid} extras transform round-trip`);
  ok(`transform round-trip ${rid}: ${Object.keys(menu).length} items + ${Object.keys(extras).length} extras`);
}
console.log(`catalog-transform (incl. live-table round-trip): OK (${n})`);
