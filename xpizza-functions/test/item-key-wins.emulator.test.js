'use strict';
// S2-12 «item_key wins» (advisor ruling 2026-11-10; S2-DESIGN §2 r1 A, S2-12) — through the REAL publisher, reader, resolver, ladder
// and mirror: a fallback route can serve an OLDER version than the customer's menu. On each such route a renamed line
// { name: <new name>, item_key: <its key> } resolves to the KEY, is priced by the key and described by the SERVED version's label
// (never the client's text): a pre-rename LAST_GOOD, a pre-rename MIRROR, a pre-S1d label-less MIRROR (cold), a ROLLBACK past the
// rename. And the price never comes from the legacy field: a line naming a DIFFERENT-priced dish beside a held item_key is priced
// by the key. Run: npm run test:item-key-wins
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
const { createPricingResolver, envelopeOf } = require('../catalog/pricing-tables');
const { createSnapshotFallback, makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
const { resolveLines } = require('../catalog/resolve-lines');
const { pricedLineItems } = require('../factura/pricing');
const MP = require('../menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('item-key-wins(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const RID = 'tb_merch_ikw';
const KEY = 'Dish One';
const OTHER = 'Dish Two';
const NEW = 'Dish One Renamed';
const source = (dish1Name) => ({ restaurant_id: RID, schema_version: 2, key_mode: 'name', ...(dish1Name !== KEY ? { frozen_keys: { 2: KEY } } : {}),
  items: [{ key: KEY, price: 100, display: { id: 2, name: dish1Name, cat: 'c1', price: 100 } },
    { key: OTHER, price: 80, display: { id: 1, name: OTHER, cat: 'c1', price: 80 } }],
  extras: [{ key: 'Extra X', price: 15, display: { id: 'e1', name: 'Extra X', cat: 'Adicionales', price: 15 } }],
  structure: { schema_version: 1, categories: [{ id: 'c1', name: 'Cat One' }], item_order: [KEY, OTHER], extra_categories: ['Adicionales'],
    exposure: { category_allow: { c1: ['Adicionales'] }, item_overrides: {} }, extras_by_category: { c1: ['Adicionales'] }, pickup_only_cats: [], weekend_only_cats: [] } });
const inputOf = (src, sha) => { const { inputs, built } = buildSourceCandidate(RID, src); return { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: sha, key_mode: built.key_mode, ...(built.frozen_keys ? { frozen_keys: built.frozen_keys } : {}) }; };
const down = { getTables: async () => { throw new Error('down'); } };
// the renamed line as an updated client sends it, and what each route must answer
const judge = (tables, label, wantDescription) => {
  const body = { items: [{ name: NEW, item_key: KEY, qty: 1 }] };
  assert.deepStrictEqual(resolveLines(RID, body, tables), { ok: true }, `IKW-${label} the renamed line resolves (never invalid_line)`);
  assert.strictEqual(body.items[0][MP.PRICING_KEY_STAMP], KEY, `IKW-${label} stamped with the KEY`);
  const f = pricedLineItems(body.items, tables.menu, tables.extras, MP.labelsOfTables(tables), null);
  assert.strictEqual(f.items[0].line_gross_cents, 100 * 100, `IKW-${label} priced by the key`);
  assert.strictEqual(f.items[0].description, wantDescription, `IKW-${label} described by the SERVED version's label, never the client's text`);
};

(async () => {
  assert.match(String(process.env.FIRESTORE_EMULATOR_HOST || ''), /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, '🔴 refusing: not the local Firestore emulator');
  for (const c of await fs.listCollections()) await fs.recursiveDelete(c);
  await rtdb.ref().remove();
  await fs.collection('restaurants').doc(RID).set({ name: RID, pricing_key_mode: 'name', active: true, schema_version: 2 });
  const mirror = makeRtdbMirror(rtdb);
  const freshReader = () => createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(fs, rid), getActiveVersionId: (rid) => getActiveVersionId(fs, rid) });   // a fresh reader per live read (no cached pointer)
  const reader = freshReader();

  // v1 (before the rename): served once, so the ladder records it as last_good and the mirror holds it
  const v1 = await publishVersion(fs, RID, inputOf(source(KEY), 'ikw-v1'), { expected: { activeVersionId: null }, mirror });
  const ladder = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} });
  const t1 = await createPricingResolver({ reader, alarm: () => {}, ladder }).getPricingTables(RID);
  // v2 renames the dish; published WITHOUT the mirror, so the mirror still holds v1 (a stale fallback)
  const v2 = await publishVersion(fs, RID, inputOf(source(NEW), 'ikw-v2'), { expected: { activeVersionId: v1.versionId } });
  assert.deepStrictEqual(MP.labelsOfTables(await createPricingResolver({ reader: freshReader(), alarm: () => {} }).getPricingTables(RID)), { [KEY]: NEW, [OTHER]: OTHER }, 'premise: the live version names the dish anew');

  // ── 1 · a pre-rename LAST_GOOD ──
  const lg = await createPricingResolver({ reader: down, alarm: () => {}, ladder }).getPricingTables(RID);
  assert.strictEqual(envelopeOf(lg).source, 'last_good', 'premise: served from last_good'); assert.strictEqual(envelopeOf(lg).versionId, v1.versionId, 'premise: the PRE-rename version');
  judge(lg, 'LASTGOOD', KEY);
  // ── 2 · a pre-rename MIRROR (warm) ──
  const warm = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} });
  warm.recordActive(RID, v1.versionId, envelopeOf(t1).seq);
  const wm = await createPricingResolver({ reader: down, alarm: () => {}, ladder: warm }).getPricingTables(RID);
  assert.strictEqual(envelopeOf(wm).source, 'mirror', 'premise: served from the mirror'); assert.strictEqual(envelopeOf(wm).versionId, v1.versionId, 'premise: the PRE-rename version');
  judge(wm, 'MIRROR', KEY);
  ok('a pre-rename last_good and a pre-rename mirror: the renamed line resolves by its key, priced by it, described by the served label');

  // ── 3 · a pre-S1d mirror carries NO labels (cold) ──
  const raw = (await rtdb.ref(`catalog_snapshot/${RID}`).get()).val();
  const { labels: _drop, ...noLabels } = raw;   // eslint-disable-line no-unused-vars
  await rtdb.ref(`catalog_snapshot/${RID}`).set(noLabels);
  const cold = await createPricingResolver({ reader: down, alarm: () => {}, ladder: createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} }) }).getPricingTables(RID);
  assert.strictEqual(envelopeOf(cold).source, 'mirror_cold', 'premise: a cold mirror'); assert.strictEqual(MP.labelsOfTables(cold), null, 'premise: the pre-S1d mirror carries no labels');
  judge(cold, 'MIRROR-NOLABELS', KEY);
  ok('a pre-S1d label-less mirror: resolved by the key, described by the legacy key (today\'s fallback)');

  // ── 4 · a ROLLBACK past the rename ──
  await rollbackVersion(fs, RID, v1.versionId, { mirror, expected: { activeVersionId: v2.versionId } });
  const rb = await createPricingResolver({ reader: freshReader(), alarm: () => {} }).getPricingTables(RID);
  assert.strictEqual(envelopeOf(rb).versionId, v1.versionId, 'premise: the live version is the rolled-to one');
  judge(rb, 'ROLLBACK', KEY);
  ok('a rollback past the rename: resolved by the key, described by the rolled-to version\'s label');

  // ── 5 · the price NEVER comes from the legacy field ──
  {
    const live = await createPricingResolver({ reader: freshReader(), alarm: () => {} }).getPricingTables(RID);
    const body = { items: [{ name: OTHER, item_key: KEY, qty: 1 }] };
    assert.deepStrictEqual(resolveLines(RID, body, live), { ok: true }, 'IKW-PRICE premise');
    assert.strictEqual(MP.itemPricingKey(body.items[0], RID, MP.keyModeOfTables(live)), KEY, 'IKW-PRICE the key, never the legacy name');
    const f = pricedLineItems(body.items, live.menu, live.extras, MP.labelsOfTables(live), null);
    assert.strictEqual(f.items[0].line_gross_cents, 100 * 100, 'IKW-PRICE priced at the KEY\'s price (100), never the legacy dish\'s (80)');
    ok('a legacy name of a different-priced dish beside a held item_key: priced by the key');
  }
  FINISHED = true;
  console.log(`\nitem-key-wins(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
