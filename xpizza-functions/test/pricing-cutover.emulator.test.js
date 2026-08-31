'use strict';
// PIN E — the guarded resolver against a REAL Firestore reader (emulator), not a fake.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:pricing-cutover
//
// This is the ONLY pre-prod guard against the wrong-handle wiring: if the reader were built over the
// RTDB handle instead of Firestore, `db.collection` would throw on every call, the resolver's fail-safe
// would swallow it, and we would ship a "cutover" that never reads the catalog — while every
// fake-reader unit test stayed green. On parity the catalog and code values are EQUAL, so value
// comparison cannot tell them apart; we assert object IDENTITY (the returned table must NOT be the
// in-code singleton) plus a silent alarm sink. Those two together prove the read really happened.
const assert = require('assert');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, computeServerTotal } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by emulators:exec
const firestore = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const R = (over = {}) => ({
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship' }, menu: over.x_pizza || MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship' }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
});
// The REAL wiring, exactly as index.js builds it — real reader over real Firestore, fresh each time
// so the 5-min cache never masks a re-seed within this test.
const build = () => {
  const alarms = [];
  const resolver = createPricingResolver({
    reader: createCatalogReader({ getRestaurantDocs: (rid) => getRestaurantDocs(firestore, rid) }),
    codeFor: (rid) => ({ menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] }),
    alarm: (kind, detail) => { alarms.push([kind, detail]); },
  });
  return { resolver, alarms };
};

(async () => {
  await seedCatalog(firestore, R());

  // (1) PIN E — parity holds → the CATALOG is the source. Identity, not just value, proves the read.
  for (const rid of ['x_pizza', 'la_musa']) {
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables(rid);
    assert.deepStrictEqual(t.menu, MENU_BY_RESTAURANT[rid], `${rid} catalog menu == code menu (values)`);
    assert.deepStrictEqual(t.extras, EXTRAS_BY_RESTAURANT[rid], `${rid} catalog extras == code extras (values)`);
    assert.notStrictEqual(t.menu, MENU_BY_RESTAURANT[rid], `${rid}: returned menu must be the FIRESTORE-read object, not the in-code singleton`);
    assert.notStrictEqual(t.extras, EXTRAS_BY_RESTAURANT[rid], `${rid}: returned extras must be the FIRESTORE-read object`);
    assert.strictEqual(t.restaurantId, rid, 'restaurant-TAGGED');
    assert.deepStrictEqual(alarms, [], `${rid}: NO alarm — a misconfigured reader would have fired catalog_read_failed here`);
    ok(`PIN E ${rid}: real Firestore reader → CATALOG tables (identity-proven), values byte-identical, zero alarms`);
  }

  // (2) End-to-end money proof through the REAL read: an order priced from the catalog == from code.
  for (const [rid, items] of [['x_pizza', [{ name: Object.keys(MENU_BY_RESTAURANT.x_pizza)[0], qty: 3 }]],
                              ['la_musa', [{ id: Object.keys(MENU_BY_RESTAURANT.la_musa)[0], qty: 2, extras: [{ id: 'rice_white', qty: 1 }] }]]]) {
    const { resolver } = build();
    const t = await resolver.getPricingTables(rid);
    assert.deepStrictEqual(computeServerTotal(items, rid, t), computeServerTotal(items, rid), `${rid} order total: catalog-read == code`);
    ok(`money proof ${rid}: a real order priced off the FIRESTORE-read catalog equals the code total`);
  }

  // (3) FALSIFIABLE — mutate one catalog price → mismatch → CODE tables + alarm (never the bad price).
  const firstKey = Object.keys(MENU_BY_RESTAURANT.x_pizza)[0];
  await seedCatalog(firestore, R({ x_pizza: { ...MENU_BY_RESTAURANT.x_pizza, [firstKey]: 99999 } }));
  {
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables('x_pizza');
    assert.strictEqual(t.menu[firstKey], MENU_BY_RESTAURANT.x_pizza[firstKey], 'the CODE price serves, not the diverged catalog price');
    assert.strictEqual(t.menu, MENU_BY_RESTAURANT.x_pizza, 'on mismatch the returned menu IS the in-code table');
    assert.strictEqual(alarms.length, 1);
    assert.strictEqual(alarms[0][0], 'catalog_parity_mismatch');
    assert.strictEqual(alarms[0][1].diff.menu.sample[0].key, firstKey, 'the alarm names the diverged key');
    const priced = computeServerTotal([{ name: firstKey, qty: 1 }], 'x_pizza', t);
    assert.strictEqual(priced.total, MENU_BY_RESTAURANT.x_pizza[firstKey], 'the customer is charged the CODE price — never mispriced');
    ok('falsifiable: a diverged catalog price → CODE tables + catalog_parity_mismatch (customer never mispriced)');
  }

  // (4) Catalog outage / unseeded restaurant → CODE tables + catalog_read_failed (fail-safe).
  {
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables('never_seeded');
    assert.strictEqual(t.restaurantId, 'never_seeded');
    assert.strictEqual(alarms[0][0], 'catalog_read_failed');
    assert.ok(/restaurant_not_found/.test(alarms[0][1].error), 'the 1a reader throw reaches the alarm detail');
    ok('fail-safe: an unreadable catalog → CODE tables + catalog_read_failed (order still prices)');
  }

  // (5) 1b-1b PIN E — the REDEMPTION cluster on the real Firestore-read catalog. Same discriminator:
  //     on parity the values match either way, so we prove the tables were consulted with a sentinel and
  //     prove the fiscal output is byte-identical to the code-fed path.
  await seedCatalog(firestore, R());
  {
    const { computeRedemption } = require('../rewards-redeem');
    const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
    const { resolver } = build();
    const t = await resolver.getPricingTables('x_pizza');
    const paid = [{ name: 'Ham', qty: 1 }];
    const XKEY = 'Margherita';
    const redeem = { type: 'free_pizza_choice', item_id: XKEY };
    const rCat = computeRedemption({ redeem, items: paid, restaurantId: 'x_pizza', tables: t });
    const rCode = computeRedemption({ redeem, items: paid, restaurantId: 'x_pizza' });
    assert.deepStrictEqual(rCat, rCode, 'redemption computed off the FIRESTORE-read catalog == code');
    assert.notStrictEqual(t.menu, MENU_BY_RESTAURANT.x_pizza, 'and the tables really came from Firestore');
    const total = MENU_BY_RESTAURANT.x_pizza.Ham;
    const pCat = applyRedemptionToPricing({ items: paid, restaurantId: 'x_pizza', redemption: rCat, totalLempiras: total, tables: t });
    const pCode = applyRedemptionToPricing({ items: paid, restaurantId: 'x_pizza', redemption: rCode, totalLempiras: total });
    assert.deepStrictEqual(pCat, pCode, 'redeemed FACTURA value (factura_items + desc_rebaja) byte-identical off the real catalog');
    ok(`PIN E 1b-1b: redemption + redeemed factura off the REAL catalog == code (rebaja ${pCat.desc_rebaja_cents})`);
  }
  // (6) 1b-1b falsifiable — a diverged catalog price → the resolver serves CODE, so redemption prices on
  //     CODE too. The whole cluster moves together; there is no split-brain even under divergence.
  {
    const XKEY = 'Margherita';
    await seedCatalog(firestore, R({ x_pizza: { ...MENU_BY_RESTAURANT.x_pizza, [XKEY]: 88888 } }));
    const { computeRedemption } = require('../rewards-redeem');
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables('x_pizza');
    const r = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: XKEY }, items: [{ name: 'Ham', qty: 1 }], restaurantId: 'x_pizza', tables: t });
    assert.strictEqual(r.freeItems[0].price_cents, MENU_BY_RESTAURANT.x_pizza[XKEY] * 100, 'redemption prices on CODE when the catalog diverges');
    assert.strictEqual(alarms[0][0], 'catalog_parity_mismatch');
    ok('PIN E 1b-1b falsifiable: a diverged catalog → redemption prices on CODE + parity alarm (no split-brain)');
  }

  // (7) 1b-2 PIN E — the NON-redeem X. Pizza FACTURA off the real Firestore-read catalog. The factura is
  //     a Void-only SAR document, so this is the strictest byte-identity claim in the migration.
  await seedCatalog(firestore, R());
  {
    const { pricedLineItems } = require('../factura/pricing');
    const { resolvePriceTables } = require('../menu-pricing');
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables('x_pizza');
    assert.notStrictEqual(t.menu, MENU_BY_RESTAURANT.x_pizza, 'the tables really came from Firestore');
    const cart = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }, { name: 'Ham', qty: 1 }];
    const { menu, extraPrices } = resolvePriceTables('x_pizza', t);
    const cat = pricedLineItems(cart, menu, extraPrices);
    const code = pricedLineItems(cart, MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza);
    assert.strictEqual(cat.error, null);
    assert.deepStrictEqual(cat, code, 'non-redeem factura lines byte-identical off the REAL catalog');
    assert.deepStrictEqual(alarms, [], 'no alarm on parity');
    ok(`PIN E 1b-2: non-redeem X. Pizza factura off the REAL catalog == code (${cat.items.length} lines, ${cat.items[0].line_gross_cents} cents on line 1)`);
  }
  // (8) 1b-2 falsifiable — a diverged catalog price → the resolver serves CODE, so the SAR document
  //     carries the CODE value. A factura can never assert a diverged price.
  {
    const { pricedLineItems } = require('../factura/pricing');
    const { resolvePriceTables } = require('../menu-pricing');
    await seedCatalog(firestore, R({ x_pizza: { ...MENU_BY_RESTAURANT.x_pizza, Margherita: 55555 } }));
    const { resolver, alarms } = build();
    const t = await resolver.getPricingTables('x_pizza');
    const { menu, extraPrices } = resolvePriceTables('x_pizza', t);
    const r = pricedLineItems([{ name: 'Margherita', qty: 1 }], menu, extraPrices);
    assert.strictEqual(r.items[0].line_gross_cents, MENU_BY_RESTAURANT.x_pizza.Margherita * 100, 'the factura asserts the CODE price when the catalog diverges');
    assert.strictEqual(alarms[0][0], 'catalog_parity_mismatch');
    ok('PIN E 1b-2 falsifiable: a diverged catalog → the SAR document still carries the CODE value + parity alarm');
  }

  await seedCatalog(firestore, R());   // restore
  console.log(`pricing-cutover(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('PIN E FAILED:', e && e.message); process.exit(1); });
