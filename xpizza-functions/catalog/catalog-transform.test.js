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
