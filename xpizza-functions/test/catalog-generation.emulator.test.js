'use strict';
// Phase 1c-b1 — GENERATION against a REAL Firestore (emulator).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-generation
//
// The plain-node parity gates (catalog-form-bundle.test.js / catalog-kds-parity.test.mjs) generate
// from the in-memory catalog snapshot (buildCatalogV2). This proves the SAME generator, fed the REAL
// display reader (getRestaurantMenu reading seeded Firestore docs), produces the COMMITTED artifacts
// byte-identical — i.e. the artifacts are a pure function of the catalog STORE, not just the bootstrap.
// The sentinel mutates a value that exists ONLY in Firestore and proves it flows into the artifact —
// generation reads the catalog, not the form.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { generateFormBundle, generateKdsManifest, serialize } = require('../catalog/generate-form-bundle');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const REPO_ROOT = join(__dirname, '..', '..');
const BUNDLE_PATH = {
  x_pizza: join(REPO_ROOT, 'xpizza-orders', 'menu-bundle.generated.json'),
  la_musa: join(REPO_ROOT, 'la-musa-orders', 'menu-bundle.generated.json'),
};
const MENUS_DIR = join(REPO_ROOT, 'menus');

const V2 = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };
const R = (over = {}) => ({
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship', schema_version: 2 }, menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza,
             v2Items: over.x_pizza_items || V2.x_pizza.items, structure: V2.x_pizza.structure },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship', schema_version: 2 }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa,
             v2Items: over.la_musa_items || V2.la_musa.items, structure: V2.la_musa.structure },
});

(async () => {
  await seedCatalog(db, R());

  // (1) FORM BUNDLE — generated from the REAL Firestore read == the committed artifact, both brands.
  for (const rid of ['x_pizza', 'la_musa']) {
    const snap = await getRestaurantMenu(db, rid);
    assert.notStrictEqual(snap.items, V2[rid].items, 'the records really came from Firestore');
    const fresh = serialize(generateFormBundle(rid, snap));
    assert.strictEqual(fresh, readFileSync(BUNDLE_PATH[rid], 'utf8'),
      `${rid}: bundle generated off the REAL catalog read == the committed menu-bundle.generated.json`);
    ok(`bundle ${rid}: generated off the REAL Firestore catalog read == the committed artifact (byte-identical)`);
  }

  // (2) KDS MANIFEST — generated from the REAL read == the committed menus/{rid}.json, both brands.
  for (const rid of ['x_pizza', 'la_musa']) {
    const snap = await getRestaurantMenu(db, rid);
    const fresh = `${JSON.stringify(generateKdsManifest(rid, snap), null, 2)}\n`;
    assert.strictEqual(fresh, readFileSync(join(MENUS_DIR, `${rid}.json`), 'utf8'),
      `${rid}: KDS manifest generated off the REAL catalog read == the committed menus/${rid}.json`);
    ok(`KDS manifest ${rid}: generated off the REAL Firestore catalog read == the committed manifest`);
  }

  // (3) SENTINEL — a display value that exists ONLY in Firestore must flow into BOTH artifacts, proving
  //     generation reads the catalog store (reading the form instead would ignore this).
  {
    const items = V2.la_musa.items.map((i, idx) => (idx === 0
      ? { ...i, display: { ...i.display, name: 'SENTINEL-ONLY-IN-CATALOG' } } : i));
    await seedCatalog(db, R({ la_musa_items: items }));
    const snap = await getRestaurantMenu(db, 'la_musa');
    const bundle = generateFormBundle('la_musa', snap);
    const manifest = generateKdsManifest('la_musa', snap);
    const firstKey = V2.la_musa.structure.item_order[0];
    assert.strictEqual(bundle.dishes[0].name, 'SENTINEL-ONLY-IN-CATALOG', 'the catalog-only name flows into the form bundle');
    assert.strictEqual(manifest.find((m) => m.key === firstKey).label, 'SENTINEL-ONLY-IN-CATALOG', 'the catalog-only name flows into the KDS label');
    assert.notStrictEqual(JSON.parse(readFileSync(BUNDLE_PATH.la_musa, 'utf8')).dishes[0].name, 'SENTINEL-ONLY-IN-CATALOG', 'the committed artifact does NOT carry the sentinel');
    ok('sentinel: a name existing ONLY in Firestore flows into BOTH the bundle and the KDS manifest (generation reads the catalog)');
    await seedCatalog(db, R());   // restore
  }

  console.log(`catalog-generation(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('GENERATION FAILED:', e && e.message); process.exit(1); });
