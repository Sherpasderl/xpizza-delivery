'use strict';
// Phase 1c-a — schema-v2 bootstrap + display round-trip. Run: node catalog-schemav2.test.js
//
// The claim under test: the catalog is a LOSSLESS store of today's menu — every display field, the
// category structure, the variants, the photo set and the ITEM ORDER survive a round trip, so 1c-b
// can regenerate the form bundle byte-identically. Plus PIN 1 (pricing untouched) and PIN 2
// (key is immutable identity, name is display data).
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { buildCatalogV2, rebuildFormMenu, formSource, readLiteral, readSetLiteral, pricingKeyOf } = require('./catalog/form-menu-source');
const { catalogDocsForRestaurant } = require('./catalog/seed-catalog-core');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const V2 = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };

// ── 1. LOSSLESS DISPLAY ROUND-TRIP: catalog → form arrays, byte-identical, both brands ──────────
for (const rid of ['x_pizza', 'la_musa']) {
  const src = formSource(rid);
  const formDishes = readLiteral(src, 'MENU');
  const { items, structure } = V2[rid];
  const rebuilt = rebuildFormMenu(rid, items, structure);
  assert.deepStrictEqual(rebuilt.dishes, formDishes, `${rid}: the rebuilt dish array must equal the form's, field for field AND in order`);
  ok(`display round-trip ${rid}: ${formDishes.length} dishes reconstructed byte-identical (fields + order)`);
}
{
  const src = formSource('la_musa');
  const { items, structure } = V2.la_musa;
  const rebuilt = rebuildFormMenu('la_musa', items, structure);
  assert.deepStrictEqual(rebuilt.categories, readLiteral(src, 'CATEGORIES'), 'la_musa categories (order, labels, subcats, layout)');
  assert.deepStrictEqual(rebuilt.variant_items, readLiteral(src, 'VARIANT_ITEMS', '{', '}'), 'la_musa VARIANT_ITEMS');
  assert.deepStrictEqual(rebuilt.has_photo, readSetLiteral(src, 'HAS_PHOTO').slice().sort(), 'la_musa HAS_PHOTO set');
  ok(`la_musa structure round-trip: ${rebuilt.categories.length} categories (w/ subcats+layout), variants, ${rebuilt.has_photo.length}-item photo set`);
}
{
  const src = formSource('x_pizza');
  const rebuilt = rebuildFormMenu('x_pizza', V2.x_pizza.items, V2.x_pizza.structure);
  assert.deepStrictEqual(rebuilt.pickup_only_cats, readLiteral(src, 'PICKUP_ONLY_CATS'), 'x_pizza PICKUP_ONLY_CATS carried as data');
  assert.deepStrictEqual(rebuilt.weekend_only_cats, readLiteral(src, 'WEEKEND_ONLY_CATS'), 'x_pizza WEEKEND_ONLY_CATS carried as data');
  const catOrder = []; for (const d of readLiteral(src, 'MENU')) if (!catOrder.includes(d.cat)) catOrder.push(d.cat);
  assert.deepStrictEqual(rebuilt.categories.map((c) => c.id), catOrder, 'x_pizza category order preserved');
  ok('x_pizza structure round-trip: category order + the PICKUP_ONLY / WEEKEND_ONLY gate flags as data');
}

// ── 2. NON-VACUITY + SENTINEL: the rebuild reads the CATALOG records, not the form ──────────────
{
  const { items, structure } = V2.la_musa;
  const mutated = items.map((i) => (i.key === structure.item_order[0]
    ? { ...i, display: { ...i.display, name: 'SENTINEL DISH', desc: 'catalog-only text', emoji: '🛰️' } } : i));
  const rebuilt = rebuildFormMenu('la_musa', mutated, structure);
  assert.strictEqual(rebuilt.dishes[0].name, 'SENTINEL DISH', 'a catalog-only display value must surface in the rebuild');
  assert.strictEqual(rebuilt.dishes[0].emoji, '🛰️');
  assert.notStrictEqual(rebuilt.dishes[0].name, readLiteral(formSource('la_musa'), 'MENU')[0].name);
  ok('non-vacuity: a catalog-only display value drives the rebuild (reading the form instead would fail here)');
}
{
  // Order is data too: permuting item_order must permute the rebuilt array.
  const { items, structure } = V2.x_pizza;
  const flipped = { ...structure, item_order: [structure.item_order[1], structure.item_order[0], ...structure.item_order.slice(2)] };
  const rebuilt = rebuildFormMenu('x_pizza', items, flipped);
  assert.strictEqual(rebuilt.dishes[0].name, structure.item_order[1], 'item_order drives the emitted order');
  ok('non-vacuity: item_order actually drives dish order (Firestore returns docs in hashed-id order)');
}
{
  // has_photo is catalog data, not a form re-read.
  const { items, structure } = V2.la_musa;
  const none = items.map((i) => ({ ...i, has_photo: false }));
  assert.deepStrictEqual(rebuildFormMenu('la_musa', none, structure).has_photo, [], 'has_photo comes from the catalog records');
  ok('non-vacuity: the photo set is rebuilt from catalog data');
}

// ── 3. PIN 2: `key` is the immutable pricing identity; x_pizza key === name ─────────────────────
for (const it of V2.x_pizza.items) {
  assert.strictEqual(it.key, it.display.name, `x_pizza key must equal name (${it.key})`);
  assert.strictEqual(pricingKeyOf('x_pizza', it.display), it.key);
}
ok(`PIN 2: all ${V2.x_pizza.items.length} x_pizza items have key === display.name (x_pizza prices by NAME)`);
for (const it of V2.la_musa.items) {
  assert.strictEqual(it.key, it.display.id, `la_musa key must equal the id slug (${it.key})`);
}
ok(`PIN 2: all ${V2.la_musa.items.length} la_musa items have key === display.id (la_musa prices by ID)`);

// ── 4. PRICE AUTHORITY: price comes from menu-pricing, and the form agrees ──────────────────────
for (const rid of ['x_pizza', 'la_musa']) {
  const table = MENU_BY_RESTAURANT[rid];
  assert.strictEqual(V2[rid].items.length, Object.keys(table).length, `${rid}: one display record per priced key, no more, no fewer`);
  for (const it of V2[rid].items) {
    assert.strictEqual(it.price, table[it.key], `${rid}/${it.key}: catalog price must be the menu-pricing price`);
    assert.strictEqual(it.display.price, table[it.key], `${rid}/${it.key}: the form price must agree with menu-pricing`);
  }
}
ok('price authority: every item is priced from menu-pricing.js, and the form price agrees (4-source parity intact)');

// ── 5. PIN 1: the seeded {key, price} pair is byte-identical with or without the schema-v2 payload ──
for (const rid of ['x_pizza', 'la_musa']) {
  const v2ByKey = new Map(V2[rid].items.map((i) => [i.key, i]));
  const withV2 = catalogDocsForRestaurant(MENU_BY_RESTAURANT[rid], EXTRAS_BY_RESTAURANT[rid], v2ByKey);
  const without = catalogDocsForRestaurant(MENU_BY_RESTAURANT[rid], EXTRAS_BY_RESTAURANT[rid]);
  assert.deepStrictEqual(withV2.itemDocs.map((d) => ({ id: d.id, key: d.key, price: d.price })),
                         without.itemDocs.map((d) => ({ id: d.id, key: d.key, price: d.price })),
                         `${rid}: doc id + key + price identical with and without the display payload`);
  assert.deepStrictEqual(withV2.extraDocs, without.extraDocs, `${rid}: extras stay {key, price}`);
  assert.ok(withV2.itemDocs.every((d) => d.display), `${rid}: every item doc carries its display record`);
}
ok('PIN 1: adding the schema-v2 payload leaves doc id / key / price byte-identical; extras untouched');

// ── 6. ADDITIVE GUARDRAIL: the money path and the forms are untouched by this phase ─────────────
{
  const root = join(__dirname, '..');
  const pricingReader = readFileSync(join(__dirname, 'catalog', 'catalog-firestore.js'), 'utf8');
  assert.ok(/return \{ key: v\.key, price: v\.price \};/.test(pricingReader),
    'the pricing reader must still project ONLY {key, price} — the new fields are invisible to pricing (PIN 1)');
  assert.ok(!/display|has_photo|menu_structure/.test(pricingReader),
    'the pricing reader must not mention any schema-v2 field');
  for (const f of ['xpizza-orders/index.html', 'la-musa-orders/index.html']) {
    assert.ok(!/getRestaurantMenu|menu_structure/.test(readFileSync(join(root, f), 'utf8')),
      `${f} must not read the catalog in 1c-a (the forms are cut in 1c-b)`);
  }
  ok('additive guardrail: the pricing reader projects only {key, price}; neither form reads the catalog yet');
}
// ── 7. LOSSLESSNESS IS MUTATION-PROVEN, not merely deep-equality-implied ───────────────────────
//    The round-trip above WOULD catch a dropped field, but "would" is not a test. These assert the
//    comparison actually FAILS when a display field goes missing — so losslessness is falsifiable.
for (const rid of ['x_pizza', 'la_musa']) {
  const { items, structure } = buildCatalogV2(rid);
  const formDishes = readLiteral(formSource(rid), 'MENU');
  for (const field of ['desc', 'name', 'cat', 'emoji', 'color']) {
    const lossy = items.map((i, idx) => {
      if (idx !== 0) return i;
      const { [field]: _dropped, ...rest } = i.display;
      return { ...i, display: rest };
    });
    assert.throws(() => assert.deepStrictEqual(rebuildFormMenu(rid, lossy, structure).dishes, formDishes),
      `${rid}: dropping display.${field} MUST fail the round-trip`);
  }
  // and a changed value, not just a missing key
  const altered = items.map((i, idx) => (idx === 0 ? { ...i, display: { ...i.display, desc: 'CHANGED' } } : i));
  assert.throws(() => assert.deepStrictEqual(rebuildFormMenu(rid, altered, structure).dishes, formDishes),
    `${rid}: altering a display value MUST fail the round-trip`);
  ok(`mutation-proven ${rid}: dropping any of 5 display fields — or altering one — fails the round-trip`);
}
{
  // Structure loss must fail too: a dropped la_musa subcat / variant / photo flag.
  const { items, structure } = buildCatalogV2('la_musa');
  const src = formSource('la_musa');
  const noVariants = { ...structure, variant_items: {} };
  assert.throws(() => assert.deepStrictEqual(rebuildFormMenu('la_musa', items, noVariants).variant_items, readLiteral(src, 'VARIANT_ITEMS', '{', '}')),
    'dropping VARIANT_ITEMS must fail');
  const noSubcats = { ...structure, categories: structure.categories.map((c) => ({ id: c.id, name: c.name })) };
  assert.throws(() => assert.deepStrictEqual(rebuildFormMenu('la_musa', items, noSubcats).categories, readLiteral(src, 'CATEGORIES')),
    'dropping the subcats/layout must fail');
  ok('mutation-proven: dropping the variant map or the category subcats/layout fails the round-trip');
}

// ── 8. The literal scanner is string- and comment-aware (SHOULD-FIX 2 hardening) ────────────────
{
  const { readLiteral: rl, readSetLiteral: rsl } = require('./catalog/form-menu-source');
  // A bracket inside a description, and one inside a comment — a raw-character counter mis-slices both.
  const tricky = `const MENU = [\n  // a comment with a ] bracket and a } brace\n  { id:1, name:'Pizza [special]', desc:"con salsa } picante", price:100 },\n  { id:2, name:'Otra', desc:'fin', price:200 }\n];\n`;
  const parsed = rl(tricky, 'MENU');
  assert.strictEqual(parsed.length, 2, 'both dishes must survive a bracket in a string and in a comment');
  assert.strictEqual(parsed[0].name, 'Pizza [special]');
  assert.strictEqual(parsed[0].desc, 'con salsa } picante');
  const set = rsl(`const HAS_PHOTO = new Set(["a]b", "c"]);\n`, 'HAS_PHOTO');
  assert.deepStrictEqual(set, ['a]b', 'c'], 'a bracket inside a Set entry must not truncate the slice');
  ok('scanner: brackets inside strings and comments no longer mis-slice (menu copy is free prose)');
  // And the real forms still slice cleanly (the guard the relay asked for).
  for (const rid of ['x_pizza', 'la_musa']) {
    assert.ok(readLiteral(formSource(rid), 'MENU').length > 0, `${rid} MENU slices cleanly`);
  }
  ok('scanner: both live forms still slice cleanly');
}

console.log(`catalog-schemav2: OK (${n})`);
