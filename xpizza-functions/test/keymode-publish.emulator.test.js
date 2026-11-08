'use strict';
// S0 key mode as data — a NON-DEFAULT mode through the REAL publisher (Codex S0 r1 #1). A third restaurant whose rid default is
// `name` but whose source pins key_mode 'id' must publish (pre-publish AND pre-flip validation judge it by its own mode), carry
// the mode on the version record, the active snapshot and the mirror, roll back carrying it, and price an id-keyed cart —
// extras included — through the real catalog reader and resolver. Run: npm run test:keymode-publish
require('./_emulator-required').harness(['firestore', 'database']);
const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');   // initialises the admin app exactly as production does
const fs = admin.firestore();
const rtdb = admin.database();
const { publishVersion, rollbackVersion } = require('../catalog/catalog-publish');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { getRestaurantDocs, getActivePointer, readVersionDocs } = require('../catalog/catalog-firestore');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');
const MP = require('../menu-pricing');
const { normalizeReorderItemsWithPrices } = require('../reorder-normalize');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('keymode-publish(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'tb_merch_3';
const source = (dish1Price) => ({ restaurant_id: RID, schema_version: 2, key_mode: 'id',
  items: [{ key: 'tb_dish_1', price: dish1Price, display: { id: 'tb_dish_1', name: 'Dish One', cat: 'c1', price: dish1Price } },
    { key: 'tb_dish_2', price: 80, display: { id: 'tb_dish_2', name: 'Dish Two', cat: 'c1', price: 80 } }],
  extras: [{ key: 'tb_x', price: 15, display: { id: 'tb_x', name: 'Extra X', cat: 'Adicionales', price: 15 } }],
  structure: { schema_version: 1, categories: [{ id: 'c1', name: 'Cat One' }], item_order: ['tb_dish_1', 'tb_dish_2'], extra_categories: ['Adicionales'],
    exposure: { category_allow: { c1: ['Adicionales'] }, item_overrides: {} }, extras_by_category: { c1: ['Adicionales'] } } });
const inputOf = (src, sha) => { const { inputs, built } = buildSourceCandidate(RID, src); return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, key_mode: built.key_mode }; };
async function modes(versionId) {
  const rec = (await fs.collection('restaurants').doc(RID).collection('versions').doc(versionId).get()).data() || {};
  const snap = (await fs.collection('restaurants').doc(RID).collection('meta').doc('active_snapshot').get()).data() || {};
  const mir = (await rtdb.ref(`catalog_snapshot/${RID}`).get()).val() || {};
  return [rec.key_mode, snap.key_mode, mir.key_mode, snap.version, mir.version];
}

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'id', active: true, schema_version: 2 });
  await sourceRefOf(fs, RID).set(canonicalize(source(100)));
  assert.strictEqual(MP.defaultKeyMode(RID), 'name', 'premise: this rid\'s default is name, so only its pinned mode can key it by id');

  // publish v1 — pre-publish AND pre-flip validation must judge it by its own mode
  const v1 = await publishVersion(fs, RID, inputOf(source(100), 'km-pub-v1'), { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  assert.ok(v1 && v1.versionId, 'KP-PUBLISH an id-keyed third restaurant publishes through the real publisher');
  assert.deepStrictEqual(await modes(v1.versionId), ['id', 'id', 'id', v1.versionId, v1.versionId], 'KP-PUBLISH-MODE record / snapshot / mirror carry id');
  assert.strictEqual((await readVersionDocs(fs, RID, v1.versionId)).keyMode, 'id');
  ok('a non-default (id) mode publishes; the version record, active snapshot and mirror carry it');

  // the real reader + resolver price an id-keyed cart, extras included, and refuse the name
  {
    const reader = createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid) });
    const tables = await createPricingResolver({ reader }).getPricingTables(RID);
    assert.strictEqual(MP.keyModeOfTables(tables), 'id', 'KP-SERVE the served tables carry the version\'s mode');
    const line = { id: 'tb_dish_1', name: 'Dish One', qty: 1, extras: [{ id: 'tb_x', name: 'Extra X', qty: 1 }] };
    assert.strictEqual(MP.computeServerTotal([line], RID, tables).total, 115, 'KP-PRICE 100 + 15 by id');
    assert.ok(Number.isNaN(MP.computeServerTotal([{ id: 'nope', name: 'Dish One', qty: 1, extras: [] }], RID, tables).total), 'the name alone does not price');
    // Codex S0 r1 #2: the reorder recipe keeps the extra it charged for (keyed by the mode), so its snapshot and recipe agree
    const r = normalizeReorderItemsWithPrices([line], RID, tables);
    assert.ok(JSON.stringify(r.items).includes('tb_x'), `KP-REORDER the recipe keeps the extra (${JSON.stringify(r.items)})`);
    ok('the real reader + resolver price 100 + 15 by id; the reorder recipe keeps the extra it charged');
  }

  // publish v2, then roll back to v1 — the rollback (same pre-flip validator) carries v1's mode
  const v2 = await publishVersion(fs, RID, inputOf(source(120), 'km-pub-v2'), { expected: { activeVersionId: v1.versionId }, mirror: makeRtdbMirror(rtdb) });
  assert.deepStrictEqual(await modes(v2.versionId), ['id', 'id', 'id', v2.versionId, v2.versionId]);
  const rb = await rollbackVersion(fs, RID, v1.versionId, { mirror: makeRtdbMirror(rtdb), expected: { activeVersionId: v2.versionId } });
  assert.ok(rb && rb.rolledBack, 'KP-ROLLBACK the rollback to an id-keyed version passes the pre-flip validator');
  assert.strictEqual((await getActivePointer(fs, RID)).version, v1.versionId);
  assert.deepStrictEqual(await modes(v1.versionId), ['id', 'id', 'id', v1.versionId, v1.versionId], 'KP-ROLLBACK-MODE the rollback re-emits v1\'s mode on the snapshot and mirror');
  ok('a second publish and a rollback to the first: both pass the pre-flip validator and carry id');

  FINISHED = true;
  console.log(`\nkeymode-publish(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('keymode-publish(emulator) FAILED:', e); process.exit(1); });
