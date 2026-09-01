'use strict';
// THE MONEY PROOF. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-parity
// Seeds a REAL (emulated) Firestore from the live tables, reads it back via the REAL adapter, and asserts
// byte-identical to MENU_BY_RESTAURANT/EXTRAS_BY_RESTAURANT — both brands. Plus falsifiability, reconcile
// drift, and the trust-boundary guards (not-found / empty / malformed must never read back as success).
const assert = require('assert');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');

admin.initializeApp({ projectId: 'demo-xpizza' }); // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
const R = (over = {}) => ({
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship' }, menu: over.x_pizza || MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship' }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
});
const read = async (rid) => { const d = await getRestaurantDocs(db, rid); return buildTablesFromDocs(d.itemDocs, d.extraDocs); };

(async () => {
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
  // (1) THE PROOF — seed live tables, read via the real adapter, assert byte-identical both brands
  await seedCatalog(db, R());
  for (const rid of ['x_pizza', 'la_musa']) {
    const back = await read(rid);
    assert.deepStrictEqual(back.menu, MENU_BY_RESTAURANT[rid], `${rid} menu catalog==code`);
    assert.deepStrictEqual(back.extras, EXTRAS_BY_RESTAURANT[rid] || {}, `${rid} extras catalog==code`);
    ok(`PARITY(emulator) ${rid}: ${Object.keys(back.menu).length} items + ${Object.keys(back.extras).length} extras round-trip byte-identical`);
  }
  // (2) FALSIFIABILITY — a mutated PRICE must be detected (proves the parity assertion can fail on a value)
  const firstKey = Object.keys(MENU_BY_RESTAURANT.x_pizza)[0];
  await seedCatalog(db, R({ x_pizza: { ...MENU_BY_RESTAURANT.x_pizza, [firstKey]: 99999 } }));
  const mutated = await read('x_pizza');
  assert.notDeepStrictEqual(mutated.menu, MENU_BY_RESTAURANT.x_pizza, 'mutated price MUST be detected');
  assert.strictEqual(mutated.menu[firstKey], 99999, 'catalog reflects the mutation');
  ok('falsifiable: a mutated price is detected');
  // (3) RECONCILE — Codex: must RENAME a key, NOT mutate a price. A rename gives a NEW hashed doc id and
  //     ORPHANS the old one; a price mutation reuses the same id (overwrite, no orphan) and never exercises
  //     the batch.delete reconcile branch. Seed a rename → then a clean re-seed MUST delete the orphan.
  const renamed = { ...MENU_BY_RESTAURANT.x_pizza }; const val = renamed[firstKey];
  delete renamed[firstKey]; renamed[`${firstKey} (RENAMED)`] = val;
  await seedCatalog(db, R({ x_pizza: renamed }));                                   // creates the orphan (old id stale)
  const drifted = await read('x_pizza');
  assert.ok(!(firstKey in drifted.menu) && `${firstKey} (RENAMED)` in drifted.menu, 'rename actually landed as a NEW doc id');
  await seedCatalog(db, R());                                                        // clean re-seed MUST reconcile it away
  const healed = await read('x_pizza');
  assert.deepStrictEqual(healed.menu, MENU_BY_RESTAURANT.x_pizza, 're-seed reconciles the orphan; byte-identical');
  assert.strictEqual(Object.keys(healed.menu).length, Object.keys(MENU_BY_RESTAURANT.x_pizza).length, 'no orphan survives — exact item count');
  ok('reconcile: a renamed-key orphan is DELETED on re-seed (actually exercises batch.delete)');
  // (4) TRUST BOUNDARY (grill Q5 + Codex) — nothing malformed may read back as a plausible success.
  await assert.rejects(() => getRestaurantDocs(db, 'never_seeded'), /restaurant_not_found/);
  ok('not-found restaurant → throws (not a silent empty)');
  await db.collection('restaurants').doc('empty_shell').set({ name: 'Empty' });      // profile, no menu_items
  await assert.rejects(() => getRestaurantDocs(db, 'empty_shell'), /catalog_empty/);
  ok('profile present but NO menu items → throws catalog_empty (not a plausible-empty success)');
  const bad = db.collection('restaurants').doc('bad_shop');
  await bad.set({ name: 'Bad' });
  await bad.collection('menu_items').doc('d1').set({ key: 'Pizza', price: 299.5 });  // non-integer price
  await assert.rejects(() => getRestaurantDocs(db, 'bad_shop'), /price not a positive integer/);
  ok('non-integer price → throws (would otherwise reach total += menu[key]*qty in 1b → {total:NaN, error:null})');
  // 1d Stage 1a tightened the rule from >= 0 to > 0: a zero price is a corrupt/fat-fingered value, not
  // a free item, and must never reach a calculator.
  await bad.collection('menu_items').doc('d1').set({ key: 'Pizza', price: 0 });
  await assert.rejects(() => getRestaurantDocs(db, 'bad_shop'), /price not a positive integer/);
  await bad.collection('menu_items').doc('d1').set({ key: 'Pizza', price: -1 });
  await assert.rejects(() => getRestaurantDocs(db, 'bad_shop'), /price not a positive integer/);
  await bad.collection('menu_items').doc('d1').set({ key: 'Pizza', price: 1 });
  await assert.doesNotReject(() => getRestaurantDocs(db, 'bad_shop'), 'a positive integer price is accepted');
  ok('1d-1a: zero and negative prices throw at the reader; a positive integer is accepted');
  await bad.collection('menu_items').doc('d1').set({ key: 'Pizza', price: 299 });
  await bad.collection('menu_items').doc('d2').set({ price: 100 });                  // missing key
  await assert.rejects(() => getRestaurantDocs(db, 'bad_shop'), /missing\/non-string key/);
  ok('doc with a missing key → throws (never silently dropped from the menu)');
  await bad.collection('menu_items').doc('d2').set({ key: 'Pizza', price: 100 });    // duplicate key, different id
  await assert.rejects(() => getRestaurantDocs(db, 'bad_shop'), /catalog_dup_key/);
  ok('duplicate pricing key across two docs → throws (no silent last-write-wins)');
  // (5) PROFILE IS FULLY SEED-OWNED (advisor gate, security) — {merge:true} would leave a pre-existing
  //     private field alive on the PUBLIC-READ profile. The allowlist only constrains what WE write, not
  //     the doc's final contents, so the seed must FULL-OVERWRITE. Pre-plant a secret, re-seed, assert gone.
  await db.collection('restaurants').doc('x_pizza').set({ name: 'X. Pizza', tier: 'flagship', bank_account: 'SECRET-HN-0001' });
  await seedCatalog(db, R());
  const prof = (await db.collection('restaurants').doc('x_pizza').get()).data();
  assert.ok(!('bank_account' in prof), 'a pre-existing private field MUST be scrubbed from the public profile');
  assert.deepStrictEqual(Object.keys(prof).sort(), ['name', 'tier'], 'profile contains EXACTLY the seeded allowlisted fields');
  ok('profile full-overwrite scrubs a pre-existing private field (no payout data on a public-read doc)');
  // (6) BATCH CHUNKING (advisor gate, robustness) — 1a's tables are 24/43 items, so nothing here would
  //     otherwise cross Firestore's 500-op batch cap. Seed 600 synthetic items (>450 sets → multi-chunk),
  //     then reconcile ALL of them away (>450 deletes → multi-chunk) and confirm both directions commit.
  const big = {}; for (let i = 0; i < 600; i++) big[`synthetic_item_${i}`] = 100 + i;
  await seedCatalog(db, { bulk_shop: { profile: { name: 'Bulk', tier: 'flagship' }, menu: big, extras: {} } });
  const bulk = await read('bulk_shop');
  assert.strictEqual(Object.keys(bulk.menu).length, 600, '600 items survive a multi-chunk commit');
  assert.strictEqual(bulk.menu.synthetic_item_599, 699, 'the LAST item of the last chunk landed');
  ok('chunking: 600 items (>450 ops) commit across multiple batches');
  await seedCatalog(db, { bulk_shop: { profile: { name: 'Bulk', tier: 'flagship' }, menu: { only_one: 1 }, extras: {} } });
  const shrunk = await read('bulk_shop');
  assert.deepStrictEqual(shrunk.menu, { only_one: 1 }, '599 stale docs reconciled away across multiple delete chunks');
  ok('chunking: >450 stale deletes reconcile across multiple batches');
  console.log(`catalog-parity(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('PARITY FAILED:', e && e.message); process.exit(1); });
