'use strict';
// Phase 1c-a — schema-v2 against a REAL Firestore (emulator).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-schemav2
//
// Two claims. (1) REGRESSION: the schema-v2 seed still reproduces the {key, price} pricing tables
// byte-identical through the REAL pricing reader — the money path cannot notice the new fields.
// (2) The display half round-trips through the REAL display reader, byte-identical to the forms.
const assert = require('assert');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');       // PRICING reader (unchanged)
const { getRestaurantMenu } = require('../catalog/catalog-menu');            // DISPLAY reader (new, dormant)
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
const { buildCatalogV2, rebuildFormMenu, formSource, readLiteral, readSetLiteral } = require('../catalog/form-menu-source');

admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const V2 = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };
const R = (over = {}) => ({
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship', schema_version: 2 }, menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza,
             v2Items: over.x_pizza_items || V2.x_pizza.items, structure: over.x_pizza_structure || V2.x_pizza.structure },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship', schema_version: 2 }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa,
             v2Items: V2.la_musa.items, structure: V2.la_musa.structure },
});

(async () => {
  await seedCatalog(db, R());

  // (1) REGRESSION — the money path is blind to schema-v2.
  for (const rid of ['x_pizza', 'la_musa']) {
    const d = await getRestaurantDocs(db, rid);
    const back = buildTablesFromDocs(d.itemDocs, d.extraDocs);
    assert.deepStrictEqual(back.menu, MENU_BY_RESTAURANT[rid], `${rid} pricing menu still byte-identical under schema-v2`);
    assert.deepStrictEqual(back.extras, EXTRAS_BY_RESTAURANT[rid], `${rid} pricing extras still byte-identical`);
    assert.deepStrictEqual(Object.keys(d.itemDocs[0]).sort(), ['key', 'price'], 'the PRICING reader projects ONLY {key, price} — schema-v2 fields are invisible to it (PIN 1)');
    ok(`PIN 1 regression ${rid}: pricing parity holds against schema-v2 docs; reader projects only {key, price}`);
  }

  // (2) DISPLAY round-trip through the REAL reader → the form arrays, byte-identical.
  for (const rid of ['x_pizza', 'la_musa']) {
    const { items, structure } = await getRestaurantMenu(db, rid);
    assert.notStrictEqual(items, V2[rid].items, 'the records really came from Firestore');
    const rebuilt = rebuildFormMenu(rid, items, structure);
    assert.deepStrictEqual(rebuilt.dishes, readLiteral(formSource(rid), 'MENU'), `${rid}: form dish array reconstructed byte-identical from the REAL catalog`);
    ok(`display parity ${rid}: ${rebuilt.dishes.length} dishes reconstructed byte-identical off the REAL Firestore read`);
  }
  {
    const { items, structure } = await getRestaurantMenu(db, 'la_musa');
    const rebuilt = rebuildFormMenu('la_musa', items, structure);
    const src = formSource('la_musa');
    assert.deepStrictEqual(rebuilt.categories, readLiteral(src, 'CATEGORIES'));
    assert.deepStrictEqual(rebuilt.variant_items, readLiteral(src, 'VARIANT_ITEMS', '{', '}'));
    assert.deepStrictEqual(rebuilt.has_photo, readSetLiteral(src, 'HAS_PHOTO').slice().sort());
    ok('display parity la_musa: categories + subcats + variants + photo set survive the real Firestore round-trip');
  }

  // (3) SENTINEL — a display value that exists ONLY in the catalog must surface. Proves the display
  //     reader is exercised rather than the test quietly re-reading the form.
  {
    const items = V2.x_pizza.items.map((i, idx) => (idx === 0
      ? { ...i, display: { ...i.display, name: i.display.name, desc: 'SENTINEL-ONLY-IN-CATALOG' } } : i));
    await seedCatalog(db, R({ x_pizza_items: items }));
    const got = await getRestaurantMenu(db, 'x_pizza');
    const first = got.items.find((r) => r.key === V2.x_pizza.items[0].key);
    assert.strictEqual(first.display.desc, 'SENTINEL-ONLY-IN-CATALOG', 'the catalog-only description must round-trip through the real reader');
    assert.notStrictEqual(readLiteral(formSource('x_pizza'), 'MENU')[0].desc, 'SENTINEL-ONLY-IN-CATALOG');
    ok('sentinel: a description existing ONLY in Firestore round-trips through the real display reader');
    await seedCatalog(db, R());   // restore
  }

  // (4) TRUST BOUNDARY — a half-migrated or structurally broken menu must throw, never render empty.
  await assert.rejects(() => getRestaurantMenu(db, 'never_seeded'), /restaurant_not_found/);
  ok('trust boundary: an unseeded restaurant throws (never a plausible-empty menu)');
  {
    const rref = db.collection('restaurants').doc('v1_shop');
    await rref.collection('menu_items').doc('d1').set({ key: 'Legacy', price: 100 });   // v1 doc: no display
    await rref.collection('meta').doc('menu_structure').set({ schema_version: 2, item_order: ['Legacy'] });
    await rref.set({ name: 'V1' });
    await assert.rejects(() => getRestaurantMenu(db, 'v1_shop'), /catalog_missing_display/);
    ok('trust boundary: a v1 doc with no display record throws (a half-migrated menu must not render)');
  }
  {
    const rref = db.collection('restaurants').doc('noorder_shop');
    await rref.collection('menu_items').doc('d1').set({ key: 'A', price: 1, display: { id: 'A' } });
    await rref.set({ name: 'NO' });
    await assert.rejects(() => getRestaurantMenu(db, 'noorder_shop'), /menu_structure_missing/);
    await rref.collection('meta').doc('menu_structure').set({ schema_version: 2, item_order: ['A', 'GHOST'] });
    await assert.rejects(() => getRestaurantMenu(db, 'noorder_shop'), /item_order references missing item GHOST/);
    ok('trust boundary: a missing or inconsistent menu_structure throws (no silently dropped/reordered dish)');
  }
  console.log(`catalog-schemav2(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('SCHEMA-V2 FAILED:', e && e.message); process.exit(1); });
