'use strict';
// S1a frozen keys — a RENAMED name-keyed product through the REAL publisher. A third restaurant keyed by name renames a dish
// under its kept key (frozen_keys {display.id: key}); pre-publish AND pre-flip validation judge the version by its own map, the
// version record and the reader carry it, the kept key still prices (extras included), a version that drops the map is refused
// before anything is written, and a rollback either way passes the pre-flip validator. Run: npm run test:frozenkeys-publish
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');   // initialises the admin app exactly as production does
const fs = admin.firestore();
const rtdb = admin.database();
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getRestaurantDocs, getActivePointer } = require('../catalog/catalog-firestore');
const { readVersionMenu } = require('../catalog/catalog-menu');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');
const MP = require('../menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('frozenkeys-publish(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'tb_merch_4';
const KEY = 'Dish One';
const source = (dish1Name, frozen) => ({ restaurant_id: RID, schema_version: 2, key_mode: 'name', ...(frozen ? { frozen_keys: frozen } : {}),
  items: [{ key: KEY, price: 100, display: { id: 1, name: dish1Name, cat: 'c1', price: 100 } },
    { key: 'Dish Two', price: 80, display: { id: 2, name: 'Dish Two', cat: 'c1', price: 80 } }],
  extras: [{ key: 'Extra X', price: 15, display: { id: 'e1', name: 'Extra X', cat: 'Adicionales', price: 15 } }],
  structure: { schema_version: 1, categories: [{ id: 'c1', name: 'Cat One' }], item_order: [KEY, 'Dish Two'], extra_categories: ['Adicionales'],
    exposure: { category_allow: { c1: ['Adicionales'] }, item_overrides: {} }, extras_by_category: { c1: ['Adicionales'] }, pickup_only_cats: [], weekend_only_cats: [] } });
const inputOf = (src, sha) => { const { inputs, built } = buildSourceCandidate(RID, src); return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, key_mode: built.key_mode, ...(built.frozen_keys ? { frozen_keys: built.frozen_keys } : {}) }; };
const recordOf = async (v) => (await fs.collection('restaurants').doc(RID).collection('versions').doc(v).get()).data() || {};
const MAP = { 1: KEY };

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const mirror = () => makeRtdbMirror(rtdb);

  // v1: the plain menu
  const v1 = await publishVersion(fs, RID, inputOf(source('Dish One'), 'fk-v1'), { expected: { activeVersionId: null }, mirror: mirror() });
  assert.ok(v1 && v1.versionId);
  assert.strictEqual((await recordOf(v1.versionId)).frozen_keys, undefined, 'FKP-PLAIN an unrenamed version records no map');

  // v2: dish 1 renamed under its kept key — pre-publish AND pre-flip judge it by its own map
  const v2 = await publishVersion(fs, RID, inputOf(source('Dish One Renamed', MAP), 'fk-v2'), { expected: { activeVersionId: v1.versionId }, mirror: mirror() });
  assert.ok(v2 && v2.versionId, 'FKP-PUBLISH a renamed version publishes through the real publisher');
  assert.deepStrictEqual((await recordOf(v2.versionId)).frozen_keys, MAP, 'FKP-RECORD the version record carries the map');
  const served = await readVersionMenu(fs, RID, v2.versionId);
  assert.deepStrictEqual(served.frozenKeys, MAP, 'FKP-READ the version reader returns it');
  assert.strictEqual(served.items.find((i) => i.display && i.display.id === 1).display.name, 'Dish One Renamed');
  ok('a renamed name-keyed dish publishes under its kept key; the record and the reader carry the map');

  // the kept key still prices through the real reader + resolver (the name is a label until the resolution stage, S1b)
  {
    const reader = createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid) });
    const tables = await createPricingResolver({ reader }).getPricingTables(RID);
    const line = { id: 1, name: KEY, qty: 1, extras: [{ id: 'e1', name: 'Extra X', qty: 1 }] };
    assert.strictEqual(MP.computeServerTotal([line], RID, tables).total, 115, 'FKP-PRICE the kept key prices 100 + 15');
    assert.ok(Number.isNaN(MP.computeServerTotal([{ ...line, name: 'Dish One Renamed' }], RID, tables).total), 'FKP-PRICE the new label alone does not price (the switch stays off until S1b)');
    ok('the kept key prices 100 + 15 at the renamed version; the new label does not price on its own');
  }

  // a version that drops the map (or carries a malformed one) is refused BEFORE anything is written
  {
    const before = (await fs.collection('restaurants').doc(RID).collection('versions').get()).size;
    const noMap = inputOf(source('Dish One Renamed', MAP), 'fk-bad'); delete noMap.frozen_keys;
    await assert.rejects(publishVersion(fs, RID, noMap, { expected: { activeVersionId: v2.versionId }, mirror: mirror() }), /publish_refused_invalid[\s\S]*key does not match its display record/, 'FKP-REFUSE a renamed version without its map');
    const bad = { ...inputOf(source('Dish One Renamed', MAP), 'fk-bad2'), frozen_keys: { 1: '' } };
    await assert.rejects(publishVersion(fs, RID, bad, { expected: { activeVersionId: v2.versionId }, mirror: mirror() }), /publish_refused_invalid[\s\S]*frozen_keys/, 'FKP-REFUSE a malformed map');
    assert.strictEqual((await fs.collection('restaurants').doc(RID).collection('versions').get()).size, before, 'nothing written');
    assert.strictEqual((await getActivePointer(fs, RID)).version, v2.versionId);
    ok('a renamed version without its map, or with a malformed one, is refused before any write');
  }

  // rollback to the plain v1, then back to the renamed v2 — each judged by its own map at pre-flip
  {
    const rb1 = await rollbackVersion(fs, RID, v1.versionId, { mirror: mirror(), expected: { activeVersionId: v2.versionId } });
    assert.ok(rb1 && rb1.rolledBack, 'FKP-ROLLBACK to the plain version');
    const rb2 = await rollbackVersion(fs, RID, v2.versionId, { mirror: mirror(), expected: { activeVersionId: v1.versionId } });
    assert.ok(rb2 && rb2.rolledBack, 'FKP-ROLLBACK back to the renamed version passes the pre-flip validator by its own map');
    assert.strictEqual((await getActivePointer(fs, RID)).version, v2.versionId);
    ok('a rollback to the plain version and back to the renamed one both pass pre-flip');
  }

  FINISHED = true;
  console.log(`\nfrozenkeys-publish(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('frozenkeys-publish(emulator) FAILED:', e); process.exit(1); });
