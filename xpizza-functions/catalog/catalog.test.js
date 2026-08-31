'use strict';
// Version-aware bounded cache tests (fake source). Run: node catalog/catalog.test.js
const assert = require('assert');
const { createCatalogReader } = require('./catalog');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // ── back-compat: no pointer probe → every call is a full read (the 1b PIN-E wiring shape) ──
  {
    let calls = 0;
    const getRestaurantDocs = async (rid) => { calls++; return { versionId: null, itemDocs: [{ key: 'Margherita', price: 299 }], extraDocs: [] }; };
    const reader = createCatalogReader({ getRestaurantDocs, now: () => 1000 });
    const tables = await reader.getTables('x_pizza');
    assert.deepStrictEqual(tables, { menu: { Margherita: 299 }, extras: {} });
    ok('getTables → {menu, extras} from injected docs (flat, no pointer probe)');
  }

  // ── WARM PATH: with a cheap pointer probe, an unchanged active version serves with NO doc fetch ──
  {
    let docCalls = 0, ptrCalls = 0; let t = 1000;
    const getRestaurantDocs = async () => { docCalls++; return { versionId: 'v1', itemDocs: [{ key: 'A', price: 10 }], extraDocs: [] }; };
    const getActiveVersionId = async () => { ptrCalls++; return 'v1'; };
    const reader = createCatalogReader({ getRestaurantDocs, getActiveVersionId, pointerTtlMs: 30000, now: () => t });
    await reader.getTables('x_pizza');                 // cold: 1 pointer + 1 doc read
    assert.strictEqual(docCalls, 1); assert.strictEqual(ptrCalls, 1);
    await reader.getTables('x_pizza');                 // warm within TTL: pointer cached, version cached
    assert.strictEqual(ptrCalls, 1, 'pointer read amortized within the TTL (no re-read)');
    assert.strictEqual(docCalls, 1, 'WARM version-cache hit → NO doc fetch');
    ok('warm path: active version served with no pointer re-read and no doc fetch within the TTL');
    t += 30001;                                        // pointer TTL expires
    await reader.getTables('x_pizza');
    assert.strictEqual(ptrCalls, 2, 'pointer re-read after TTL');
    assert.strictEqual(docCalls, 1, 'same versionId → still a version-cache hit, no doc fetch');
    ok('after pointer TTL: pointer re-read, but the immutable version is still cached (no doc re-fetch)');
  }

  // ── FLIP pickup: when the pointer moves to a new versionId, the reader serves the NEW version within
  //    the TTL, NOT a stale cached one ──
  {
    let t = 1000; let active = 'v1';
    const docsFor = { v1: { versionId: 'v1', itemDocs: [{ key: 'A', price: 10 }], extraDocs: [] },
                      v2: { versionId: 'v2', itemDocs: [{ key: 'A', price: 20 }], extraDocs: [] } };
    const getRestaurantDocs = async () => docsFor[active];
    const getActiveVersionId = async () => active;
    const reader = createCatalogReader({ getRestaurantDocs, getActiveVersionId, pointerTtlMs: 1000, now: () => t });
    assert.strictEqual((await reader.getTables('r')).menu.A, 10, 'serves v1');
    active = 'v2';                                     // a publish flips the pointer
    assert.strictEqual((await reader.getTables('r')).menu.A, 10, 'within the TTL still v1 (bounded staleness)');
    t += 1001;                                         // TTL expires
    assert.strictEqual((await reader.getTables('r')).menu.A, 20, 'after the TTL the flip is picked up → v2');
    ok('flip pickup: a new active versionId is served within the pointer TTL, never stale beyond it');
  }

  // ── FLAT staleness is bounded by the pointer TTL (flat is mutable, no immutable id) ──
  {
    let t = 1000; let price = 10;
    const getRestaurantDocs = async () => ({ versionId: null, itemDocs: [{ key: 'A', price }], extraDocs: [] });
    const getActiveVersionId = async () => null;       // un-migrated
    const reader = createCatalogReader({ getRestaurantDocs, getActiveVersionId, pointerTtlMs: 1000, now: () => t });
    assert.strictEqual((await reader.getTables('r')).menu.A, 10);
    price = 15;                                         // a flat re-seed
    assert.strictEqual((await reader.getTables('r')).menu.A, 10, 'flat cached within the TTL');
    t += 1001;
    assert.strictEqual((await reader.getTables('r')).menu.A, 15, 'flat re-read after the TTL (bounded staleness)');
    ok('flat cache: bounded by the pointer TTL (never an indefinite flat cache that survives a flip)');
  }

  // ── BOUNDED LRU: many versions do not grow the cache without bound; the oldest is evicted ──
  {
    let active = 'v0'; let docCalls = 0;
    const getRestaurantDocs = async () => { docCalls++; return { versionId: active, itemDocs: [{ key: 'A', price: 1 }], extraDocs: [] }; };
    const getActiveVersionId = async () => active;
    const reader = createCatalogReader({ getRestaurantDocs, getActiveVersionId, pointerTtlMs: 0, maxVersions: 3, now: () => 1 });
    for (let i = 0; i < 6; i++) { active = `v${i}`; await reader.getTables('r'); }   // pointerTtl 0 → always re-probe; caches v0..v5
    // cache holds at most 3 → the most-recent v5,v4,v3 are HITS; v0..v2 were evicted → a re-fetch
    docCalls = 0;
    active = 'v5'; await reader.getTables('r'); active = 'v4'; await reader.getTables('r'); active = 'v3'; await reader.getTables('r');
    assert.strictEqual(docCalls, 0, 'the last 3 versions are still cached (no doc fetch)');
    active = 'v0'; await reader.getTables('r');
    assert.strictEqual(docCalls, 1, 'an evicted old version must be re-fetched (cache stayed bounded)');
    ok('bounded LRU: at most maxVersions cached; oldest evicted; size stays bounded across many publishes');
  }

  // ── grill Q5 — a failing source PROPAGATES and is NOT cached (1b needs a fail signal, not a cached empty) ──
  {
    let boom = 0;
    const failReader = createCatalogReader({ getRestaurantDocs: async () => { boom++; throw new Error('firestore down'); }, now: () => 9000 });
    await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
    await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
    assert.strictEqual(boom, 2, 'failure is NOT cached — each call re-invokes the source');
    ok('read failure propagates + is not cached (grill Q5)');
  }
  {
    // a throwing POINTER probe also propagates and is not cached
    let boom = 0;
    const reader = createCatalogReader({ getRestaurantDocs: async () => ({ versionId: 'v', itemDocs: [], extraDocs: [] }), getActiveVersionId: async () => { boom++; throw new Error('pointer read failed'); }, now: () => 1 });
    await assert.rejects(() => reader.getTables('r'), /pointer read failed/);
    await assert.rejects(() => reader.getTables('r'), /pointer read failed/);
    assert.strictEqual(boom, 2, 'a pointer read failure is not cached either');
    ok('pointer-probe failure propagates + is not cached');
  }

  console.log(`catalog reader: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
