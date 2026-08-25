'use strict';
// Reader tests (fake Firestore source). Run: node catalog/catalog.test.js
const assert = require('assert');
const { createCatalogReader } = require('./catalog');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

let calls = 0;
const fakeDocs = { x_pizza: { itemDocs: [{ key: 'Margherita', price: 299 }], extraDocs: [] } };
const getRestaurantDocs = async (rid) => { calls++; return fakeDocs[rid] || { itemDocs: [], extraDocs: [] }; };
let t = 1000;
const reader = createCatalogReader({ getRestaurantDocs, cacheTtlMs: 60000, now: () => t });

(async () => {
  const tables = await reader.getTables('x_pizza');
  assert.deepStrictEqual(tables, { menu: { Margherita: 299 }, extras: {} });
  ok('getTables → {menu, extras} from injected docs');
  await reader.getTables('x_pizza');
  assert.strictEqual(calls, 1, 'second read within TTL is cached (no extra fetch)');
  ok('cache hit within TTL');
  t += 60001;
  await reader.getTables('x_pizza');
  assert.strictEqual(calls, 2, 'read after TTL refetches');
  ok('cache expires after TTL');
  // grill Q5 — a failing source PROPAGATES and is NOT cached (1b needs a fail signal, not a cached empty)
  let boom = 0;
  const failReader = createCatalogReader({ getRestaurantDocs: async () => { boom++; throw new Error('firestore down'); }, cacheTtlMs: 60000, now: () => 9000 });
  await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
  await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
  assert.strictEqual(boom, 2, 'failure is NOT cached — each call re-invokes the source');
  ok('read failure propagates + is not cached (grill Q5)');
  console.log(`catalog reader: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
