'use strict';
// S1d D1 (PLAN-portal-item-edit r6 §2.5; design D4c-grill/item-s1/S1d-DESIGN.md D1 + ruling Q1) — LABELS ride beside the prices.
// A dish's label ({key: display.name}) is read from the SAME docs as its price and crosses every boundary the price crosses —
// the doc mapper, the cached reader (version AND flat), the resolver (live, flat, last_good, mirror, mirror_cold), the RTDB
// mirror (keys encoded exactly like the price keys) — as a plain `labels` sibling on internal objects and a NON-ENUMERABLE
// symbol on the tables handed to callers. It never enters a price hash, an equality or a fingerprint. A route without labels
// (a pre-label mirror or last_good, flat docs without display) yields null — fall back, never refuse. Extras carry none.
// Run: node catalog/labels.test.js
const assert = require('assert');
const MP = require('../menu-pricing');
const { mapDocs } = require('./catalog-firestore');
const { labelsFromDocs, buildTablesFromDocs } = require('./catalog-transform');
const { createCatalogReader } = require('./catalog');
const { createPricingResolver, tablesEqual, menuHash } = require('./pricing-tables');
const { createSnapshotFallback } = require('./snapshot-fallback');
const { encodeMirrorTables, decodeMirror } = require('./mirror-keys');
const { makeRtdbMirror } = require('./mirror-rtdb');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('labels: FAILED — exited without completing'); process.exitCode = 1; } });
const snapOf = (rows) => ({ docs: rows.map((v, i) => ({ id: `d${i}`, data: () => v })) });
const LABELS = { 'Dish One': 'Dish One Renamed', 'N.Y. Slice': 'N.Y. Slice' };

(async () => {
  // ── the doc mapper and the transform ──
  {
    const docs = mapDocs(snapOf([{ key: 'Dish One', price: 100, display: { name: 'Dish One Renamed' } }, { key: 'N.Y. Slice', price: 80, display: { name: 'N.Y. Slice' } }, { key: 'Bare', price: 50 }]), 'tb');
    assert.deepStrictEqual(docs, [{ key: 'Dish One', price: 100, label: 'Dish One Renamed' }, { key: 'N.Y. Slice', price: 80, label: 'N.Y. Slice' }, { key: 'Bare', price: 50 }], 'LB-MAPDOCS a label is emitted only when display.name is a string');
    assert.deepStrictEqual(buildTablesFromDocs(docs, []), { menu: { 'Dish One': 100, 'N.Y. Slice': 80, Bare: 50 }, extras: {} }, 'LB-TABLES the price tables are unchanged');
    assert.deepStrictEqual(labelsFromDocs(docs), { 'Dish One': 'Dish One Renamed', 'N.Y. Slice': 'N.Y. Slice' }, 'LB-TRANSFORM {key: label} for the docs that carry one');
    assert.strictEqual(labelsFromDocs([{ key: 'A', price: 1 }]), null, 'LB-NONE no labels at all → null (fall back), never {}');
    ok('the mapper emits a label beside the price; the transform builds {key: label} or null; prices unchanged');
  }

  // ── the cached reader: version and flat ──
  {
    for (const versionId of ['v1', null]) {
      const reader = createCatalogReader({ getRestaurantDocs: async () => ({ versionId, seq: versionId ? 3 : null, itemDocs: [{ key: 'Dish One', price: 100, label: 'Dish One Renamed' }], extraDocs: [{ key: 'X', price: 5, label: 'X' }], keyMode: 'name' }) });
      const t = await reader.getTables('tb_merch');
      assert.deepStrictEqual(t.labels, { 'Dish One': 'Dish One Renamed' }, `LB-READER-${versionId ? 'VERSION' : 'FLAT'} the cached tables carry dish labels (extras none)`);
    }
    ok('the cached reader carries labels on the version and the flat route');
  }

  // ── the resolver: live / flat carry them as a hidden symbol; hashes and equality ignore them ──
  {
    const recorded = [];
    const ladder = createSnapshotFallback({ mirrorReader: async () => null, alarm: () => {} });
    const spy = { ...ladder, recordGood: (rid, rec) => { recorded.push(rec); ladder.recordGood(rid, rec); } };
    const cat = { menu: { 'Dish One': 100 }, extras: { X: 5 }, versionId: 'v1', seq: 3, keyMode: 'name', labels: { 'Dish One': 'Dish One Renamed' } };
    const r = createPricingResolver({ reader: { getTables: async () => cat }, alarm: () => {}, ladder: spy });
    const t = await r.getPricingTables('tb_merch');
    assert.deepStrictEqual(MP.labelsOfTables(t), { 'Dish One': 'Dish One Renamed' }, 'LB-LIVE the served tables carry the labels');
    assert.deepStrictEqual(Object.keys(t), ['restaurantId', 'menu', 'extras'], 'LB-HIDDEN not an enumerable field (callers that spread or serialize the tables never see it)');
    assert.strictEqual(JSON.stringify(t), JSON.stringify({ restaurantId: 'tb_merch', menu: cat.menu, extras: cat.extras }), 'LB-HIDDEN serialization is today\'s');
    assert.deepStrictEqual(recorded[0].labels, cat.labels, 'LB-RECORD last_good is recorded with its labels');
    assert.strictEqual(tablesEqual({ menu: cat.menu, extras: cat.extras }, t), true, 'LB-EQUAL equality ignores labels');
    assert.strictEqual(menuHash(t.menu), menuHash(cat.menu), 'LB-HASH the served menu table (what the fingerprint hashes) carries no label');
    assert.ok(!Object.values(t.menu).some((v) => typeof v !== 'number'), 'LB-HASH the price table holds prices only');
    const noLab = await createPricingResolver({ reader: { getTables: async () => ({ ...cat, labels: undefined }) }, alarm: () => {} }).getPricingTables('tb_merch');
    assert.strictEqual(MP.labelsOfTables(noLab), null, 'LB-NULL a route without labels yields null');
    ok('the resolver hands labels to callers as a hidden symbol; hash, equality and serialization ignore them; none → null');
  }

  // ── the ladder: last_good, mirror, mirror_cold ──
  {
    const lg = createSnapshotFallback({ mirrorReader: async () => null, alarm: () => {} });
    lg.recordGood('tb_merch', { versionId: 'v1', seq: 3, menu: { 'Dish One': 100 }, extras: {}, keyMode: 'name', labels: { 'Dish One': 'Dish One Renamed' } });
    const s1 = await lg.snapshotFor('tb_merch');
    assert.deepStrictEqual([s1.source, s1.labels], ['last_good', { 'Dish One': 'Dish One Renamed' }], 'LB-LASTGOOD');
    const mirror = { version: 'v1', seq: 3, rid: 'tb_merch', menu: { 'Dish One': 100 }, extras: {}, key_mode: 'name', labels: { 'Dish One': 'Dish One Renamed' } };
    const cold = createSnapshotFallback({ mirrorReader: async () => mirror, alarm: () => {} });
    const s2 = await cold.snapshotFor('tb_merch');
    assert.deepStrictEqual([s2.source, s2.labels], ['mirror_cold', { 'Dish One': 'Dish One Renamed' }], 'LB-MIRROR-COLD');
    const warm = createSnapshotFallback({ mirrorReader: async () => mirror, alarm: () => {} });
    warm.recordActive('tb_merch', 'v1', 3);
    const s3 = await warm.snapshotFor('tb_merch');
    assert.deepStrictEqual([s3.source, s3.labels], ['mirror', { 'Dish One': 'Dish One Renamed' }], 'LB-MIRROR');
    const old = createSnapshotFallback({ mirrorReader: async () => ({ ...mirror, labels: undefined }), alarm: () => {} });
    assert.strictEqual((await old.snapshotFor('tb_merch')).labels, null, 'LB-MIRROR-PRELABEL a pre-label mirror yields null');
    const r = createPricingResolver({ reader: { getTables: async () => { throw new Error('down'); } }, alarm: () => {}, ladder: cold });
    assert.deepStrictEqual(MP.labelsOfTables(await r.getPricingTables('tb_merch')), { 'Dish One': 'Dish One Renamed' }, 'LB-LADDER the resolver carries a rung\'s labels');
    ok('every rung carries its labels (last_good, mirror, mirror_cold); a pre-label mirror yields null');
  }

  // ── the RTDB mirror: label keys encoded exactly like price keys, in the same decision; decoded back ──
  {
    const plain = encodeMirrorTables({ A: 1 }, { X: 2 }, { A: 'Label A' });
    assert.deepStrictEqual(plain, { menu: { A: 1 }, extras: { X: 2 }, labels: { A: 'Label A' } }, 'LB-MIRROR-PLAIN safe keys: stored as typed');
    const enc = encodeMirrorTables({ 'N.Y. Slice': 80 }, {}, LABELS);
    assert.strictEqual(enc.key_encoding, 'uri1');
    assert.ok(Object.keys(enc.labels).every((k) => !/[.#$/[\]]/.test(k)), 'LB-MIRROR-ENC label keys are encoded with the price keys');
    assert.deepStrictEqual(decodeMirror({ version: 'v', seq: 1, ...enc }).labels, LABELS, 'LB-MIRROR-DEC decoded back exactly');
    const onlyLabelUnsafe = encodeMirrorTables({ A: 1 }, {}, { A: 'A.b' });
    assert.deepStrictEqual(onlyLabelUnsafe, { menu: { A: 1 }, extras: {}, labels: { A: 'A.b' } }, 'LB-MIRROR-VALUES a label VALUE never forces encoding (only keys do)');
    assert.deepStrictEqual(encodeMirrorTables({ A: 1 }, { X: 2 }), { menu: { A: 1 }, extras: { X: 2 } }, 'LB-MIRROR-NONE no labels: today\'s shape exactly');
    const writes = [];
    const fakeRtdb = { ref: (p) => ({ set: async (v) => { writes.push([p, v]); } }) };
    await makeRtdbMirror(fakeRtdb)('tb_merch', { version: 'v1', seq: 3, rid: 'tb_merch', menu: { 'N.Y. Slice': 80 }, extras: {}, keyMode: 'name', labels: LABELS });
    assert.deepStrictEqual(decodeMirror(writes[0][1]).labels, LABELS, 'LB-MIRROR-WRITE the mirror writer stores the labels');
    await makeRtdbMirror(fakeRtdb)('tb_merch', { version: 'v1', seq: 3, rid: 'tb_merch', menu: { A: 1 }, extras: {}, keyMode: 'name' });
    assert.ok(!Object.prototype.hasOwnProperty.call(writes[1][1], 'labels'), 'LB-MIRROR-WRITE-NONE no labels: today\'s mirror');
    ok('the mirror stores label keys under the price keys\' encoding, decodes them exactly, and is today\'s without labels');
  }

  FINISHED = true;
  console.log(`\nlabels: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
