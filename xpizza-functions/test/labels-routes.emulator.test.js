'use strict';
// S1d D1 (PLAN-portal-item-edit r6 §2.5 "labels on each route") — through the REAL publisher, reader, resolver and mirror: a
// renamed dish's label (≠ its key) and a dish whose key needs mirror encoding (. / %) reach the caller's tables on the LIVE
// version, the FLAT route, LAST_GOOD, the MIRROR and the MIRROR COLD start; the publish and the rollback each re-emit the
// mirror with the activated version's labels. Run: npm run test:labels-routes
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');
const fs = admin.firestore();
const rtdb = admin.database();
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getRestaurantDocs, getActiveVersionId } = require('../catalog/catalog-firestore');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');
const { createSnapshotFallback, makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { decodeMirror } = require('../catalog/mirror-keys');
const MP = require('../menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('labels-routes(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'tb_merch_lb';
const KEY = 'Dish One';
const ENC = 'N.Y. 1/2 Slice 50%';
const source = (dish1Name) => ({ restaurant_id: RID, schema_version: 2, key_mode: 'name', ...(dish1Name !== KEY ? { frozen_keys: { 2: KEY } } : {}),
  items: [{ key: KEY, price: 100, display: { id: 2, name: dish1Name, cat: 'c1', price: 100 } },
    { key: ENC, price: 80, display: { id: 1, name: ENC, cat: 'c1', price: 80 } }],
  extras: [{ key: 'Extra X', price: 15, display: { id: 'e1', name: 'Extra X', cat: 'Adicionales', price: 15 } }],
  structure: { schema_version: 1, categories: [{ id: 'c1', name: 'Cat One' }], item_order: [KEY, ENC], extra_categories: ['Adicionales'],
    exposure: { category_allow: { c1: ['Adicionales'] }, item_overrides: {} }, extras_by_category: { c1: ['Adicionales'] }, pickup_only_cats: [], weekend_only_cats: [] } });
const inputOf = (src, sha) => { const { inputs, built } = buildSourceCandidate(RID, src); return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, key_mode: built.key_mode, ...(built.frozen_keys ? { frozen_keys: built.frozen_keys } : {}) }; };
const mirrorLabels = async () => decodeMirror((await rtdb.ref(`catalog_snapshot/${RID}`).get()).val()).labels;
const want = (name) => ({ [KEY]: name, [ENC]: ENC });

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const mirror = makeRtdbMirror(rtdb);

  const v1 = await publishVersion(fs, RID, inputOf(source(KEY), 'lb-v1'), { expected: { activeVersionId: null }, mirror });
  const v2 = await publishVersion(fs, RID, inputOf(source('Dish One Renamed'), 'lb-v2'), { expected: { activeVersionId: v1.versionId }, mirror });
  assert.deepStrictEqual(await mirrorLabels(), want('Dish One Renamed'), 'LBR-PUBLISH the publish re-emits the mirror with the version\'s labels (an encoded key included)');
  const raw = (await rtdb.ref(`catalog_snapshot/${RID}`).get()).val();
  assert.strictEqual(raw.key_encoding, 'uri1', 'premise: the mirror needed encoding');

  // LIVE: the real reader + resolver
  const reader = createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid), getActiveVersionId: (rid) => getActiveVersionId(fs, rid) });
  const ladder = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} });
  const live = await createPricingResolver({ reader, alarm: () => {}, ladder }).getPricingTables(RID);
  assert.deepStrictEqual(MP.labelsOfTables(live), want('Dish One Renamed'), 'LBR-LIVE');
  // LAST_GOOD: same ladder, the reader now failing
  const down = { getTables: async () => { throw new Error('down'); } };
  const lg = await createPricingResolver({ reader: down, alarm: () => {}, ladder }).getPricingTables(RID);
  assert.deepStrictEqual(MP.labelsOfTables(lg), want('Dish One Renamed'), 'LBR-LASTGOOD');
  // MIRROR (warm: the active seq is known) and MIRROR COLD
  const warm = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} });
  warm.recordActive(RID, v2.versionId, require('../catalog/pricing-tables').envelopeOf(live).seq);
  const wm = await createPricingResolver({ reader: down, alarm: () => {}, ladder: warm }).getPricingTables(RID);
  assert.deepStrictEqual(MP.labelsOfTables(wm), want('Dish One Renamed'), 'LBR-MIRROR');
  const cold = await createPricingResolver({ reader: down, alarm: () => {}, ladder: createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} }) }).getPricingTables(RID);
  assert.deepStrictEqual(MP.labelsOfTables(cold), want('Dish One Renamed'), 'LBR-MIRROR-COLD');
  ok('live, last_good, mirror and mirror cold all carry the labels, an encoded key included');

  // ROLLBACK re-emits the mirror with the target's labels
  await rollbackVersion(fs, RID, v1.versionId, { mirror, expected: { activeVersionId: v2.versionId } });
  assert.deepStrictEqual(await mirrorLabels(), want(KEY), 'LBR-ROLLBACK the rollback re-emits the target\'s labels');
  ok('the rollback re-emits the mirror with the rolled-to version\'s labels');

  // FLAT: a restaurant with no active version reads the flat docs (labels only where the docs carry display)
  {
    const FR = 'tb_merch_flat';
    const { seedCatalog } = require('../catalog/seed-catalog-core');
    const { buildSourceCandidate: bsc } = require('../catalog/candidate-validate');
    const src = { ...source('Dish One Renamed'), restaurant_id: FR };
    const { built, inputs } = bsc(FR, src);
    await seedCatalog(fs, { [FR]: { profile: { name: FR, pricing_key_mode: 'name' }, menu: Object.fromEntries(built.items.map((i) => [i.key, i.price])), extras: inputs.extras, v2Items: built.items, v2Extras: built.extras } });
    const fr = createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid), getActiveVersionId: (rid) => getActiveVersionId(fs, rid) });
    const flat = await createPricingResolver({ reader: fr, alarm: () => {} }).getPricingTables(FR);
    assert.deepStrictEqual(MP.labelsOfTables(flat), want('Dish One Renamed'), 'LBR-FLAT flat docs seeded with display carry labels');
    ok('the flat route carries labels when its docs carry display');
  }

  FINISHED = true;
  console.log(`\nlabels-routes(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
