'use strict';
// Task 4 — THREAD THE COMPLETE DISPLAY DATASET THROUGH build → persist → seed.
//
// `sourceToBuildInputs` has produced extras_display and the exposure maps all along; buildCatalogV2
// dropped them on the floor and catalogDocsForRestaurant persisted extras as {key, price}. So the
// catalog could not describe an extra to a customer even though the source could.
//
// 🔴 THE MONEY INVARIANT: the numeric tables computeServerTotal reads must come out BYTE-IDENTICAL.
// Display metadata travels ALONGSIDE the charging table, never inside it — these are separate
// namespaces, and the whole slice fails if adding a name to an extra can move a price.
//
// Run: node catalog/display-threading.test.js
const assert = require('assert');
const { buildCatalogV2 } = require('./form-menu-source');
const { catalogDocsForRestaurant } = require('./seed-catalog-core');
const { codeTablesToCatalogDocs } = require('./catalog-transform');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceToBuildInputs, validateSource } = require('./source-store');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, computeServerTotal } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const BRANDS = ['x_pizza', 'la_musa'];

// ── THE CHARGING TABLE IS UNTOUCHED ─────────────────────────────────────────────────────────────
for (const rid of BRANDS) {
  const menu = MENU_BY_RESTAURANT[rid];
  const extras = EXTRAS_BY_RESTAURANT[rid] || {};
  const source = buildSourceFromCode(rid);
  const v2 = new Map(source.items.map((i) => [i.key, i]));
  const v2Extras = new Map(source.extras.map((e) => [e.key, e]));

  const before = codeTablesToCatalogDocs(menu, extras);
  const after = catalogDocsForRestaurant(menu, extras, v2, v2Extras);

  // The charging PROJECTION — exactly the fields the pricing reader consumes — must be identical.
  const charging = (docs) => docs.map((d) => ({ key: d.key, price: d.price }));
  assert.deepStrictEqual(charging(after.itemDocs), charging(before.itemDocs), `🔴 ${rid}: item charging table moved`);
  assert.deepStrictEqual(charging(after.extraDocs), charging(before.extraDocs), `🔴 ${rid}: EXTRA charging table moved`);
  // ...and byte-identical as serialised, so no key order or numeric formatting drifted either.
  assert.strictEqual(JSON.stringify(charging(after.extraDocs)), JSON.stringify(charging(before.extraDocs)),
    `🔴 ${rid}: the extras charging table is not byte-identical`);

  // and the tables rebuilt from the docs still price a cart exactly as the code tables do
  const rebuilt = { menu: {}, extras: {} };
  for (const d of after.itemDocs) rebuilt.menu[d.key] = d.price;
  for (const d of after.extraDocs) rebuilt.extras[d.key] = d.price;
  assert.deepStrictEqual(rebuilt.menu, menu, `🔴 ${rid}: the menu table rebuilt from persisted docs differs from code`);
  assert.deepStrictEqual(rebuilt.extras, extras, `🔴 ${rid}: the extras table rebuilt from persisted docs differs from code`);
  ok(`${rid}: charging tables byte-identical after threading display data (${after.itemDocs.length} items, ${after.extraDocs.length} extras)`);
}

// ── A REAL CART PRICES THE SAME ─────────────────────────────────────────────────────────────────
{
  // The tables agreeing is the mechanism; what matters is that a cart costs the same. Priced through
  // the REAL calculator, with the rebuilt tables against the code tables.
  // The brands key a cart line differently — x_pizza by NAME, la_musa by ID (menu-pricing.js:127) —
  // and the same asymmetry runs through extras. Getting it wrong here would price nothing and the
  // test would pass for the wrong reason, so both carts are asserted to price non-trivially first.
  const carts = {
    x_pizza: [{ name: 'Carnivora', qty: 2, extras: [{ name: 'Pepperoni' }, { name: 'Mozzarella' }] }, { name: 'Margherita', qty: 1, extras: [] }],
    la_musa: [{ id: 'rice_03', qty: 1, extras: [{ id: 'protein_chicken', qty: 2 }] }, { id: 'noodle_01_pollo', qty: 3, extras: [] }],
  };
  for (const rid of BRANDS) {
    const source = buildSourceFromCode(rid);
    const after = catalogDocsForRestaurant(MENU_BY_RESTAURANT[rid], EXTRAS_BY_RESTAURANT[rid] || {},
      new Map(source.items.map((i) => [i.key, i])), new Map(source.extras.map((e) => [e.key, e])));
    const tables = { restaurantId: rid, menu: {}, extras: {} };   // the calculator refuses tables that do not name their brand
    for (const d of after.itemDocs) tables.menu[d.key] = d.price;
    for (const d of after.extraDocs) tables.extras[d.key] = d.price;
    const fromCatalog = computeServerTotal(carts[rid], rid, tables);
    const fromCode = computeServerTotal(carts[rid], rid);
    assert.ok(Number.isFinite(fromCode.total) && fromCode.total > 0, `premise: ${rid} cart prices at all (${JSON.stringify(fromCode)})`);
    assert.deepStrictEqual(fromCatalog, fromCode, `🔴 ${rid}: a real cart prices differently off the threaded catalog`);
    ok(`${rid}: a real cart prices identically off the threaded catalog (L ${fromCode.total})`);
  }
}

// ── EXTRAS ARE NOW FIRST-CLASS DISPLAY RECORDS ──────────────────────────────────────────────────
for (const rid of BRANDS) {
  const source = buildSourceFromCode(rid);
  const docs = catalogDocsForRestaurant(MENU_BY_RESTAURANT[rid], EXTRAS_BY_RESTAURANT[rid] || {},
    new Map(source.items.map((i) => [i.key, i])), new Map(source.extras.map((e) => [e.key, e])));
  assert.ok(docs.extraDocs.length > 0, `premise: ${rid} has extras`);
  for (const d of docs.extraDocs) {
    assert.ok(d.display, `🔴 ${rid}/extra ${d.key} persists without its display record`);
    for (const f of ['id', 'cat', 'name', 'price']) {
      assert.ok(d.display[f] !== undefined, `🔴 ${rid}/extra ${d.key} display is missing ${f}`);
    }
    assert.strictEqual(d.display.price, d.price, `🔴 ${rid}/extra ${d.key}: display price disagrees with the charged price`);
  }
  ok(`${rid}: every persisted extra carries a complete display record agreeing with its price`);
}

// ── buildCatalogV2 NO LONGER DROPS THEM ─────────────────────────────────────────────────────────
for (const rid of BRANDS) {
  const source = buildSourceFromCode(rid);
  const inputs = sourceToBuildInputs(source);
  const built = buildCatalogV2(rid, { formData: inputs.formData, priceTable: inputs.priceTable, extrasTable: inputs.extras });

  assert.ok(Array.isArray(built.extras) && built.extras.length === source.extras.length,
    `🔴 ${rid}: buildCatalogV2 must carry the extras it was given (got ${built.extras && built.extras.length})`);
  for (const e of built.extras) {
    assert.ok(e.key && Number.isInteger(e.price) && e.display, `🔴 ${rid}: extra ${e.key} is not a complete record`);
  }
  // the exposure maps survive the round trip too — they are how an option set is resolved
  if (rid === 'la_musa') {
    assert.deepStrictEqual(built.structure.extras_by_category, source.structure.extras_by_category, `🔴 ${rid}: exposure by category was dropped`);
    assert.deepStrictEqual(built.structure.extras_by_item, source.structure.extras_by_item, `🔴 ${rid}: exposure by item was dropped`);
  }
  assert.deepStrictEqual(built.structure.extra_categories, source.structure.extra_categories, `🔴 ${rid}: the extra-category namespace was dropped`);
  // Badges specifically, through sourceToBuildInputs — the namespace is DERIVABLE from the extras, so
  // it survives even if the mapper drops it. Badges are not derivable from anything, so only the
  // round trip proves the mapper carries them.
  assert.deepStrictEqual(built.structure.badges, source.structure.badges, `🔴 ${rid}: badge definitions were dropped by the build-input mapper`);

  // 🔴 ROUND-TRIP: what comes out must still validate as a complete source.
  const rebuilt = { restaurant_id: rid, schema_version: 2, items: built.items, extras: built.extras, structure: built.structure };
  assert.doesNotThrow(() => validateSource(rebuilt, rid), `🔴 ${rid}: the built catalog is not a valid complete source`);
  ok(`${rid}: buildCatalogV2 carries extras + exposure + namespace, and its output revalidates`);
}

// ── NO DISPLAY FIELD COMES FROM meta/source AT SERVE TIME ────────────────────────────────────────
{
  // The invariant behind all of this: everything served is derivable from the immutable version. The
  // persisted docs must be self-sufficient — a reader holding only them must be able to describe the
  // menu without going back to the mutable draft.
  const source = buildSourceFromCode('la_musa');
  const docs = catalogDocsForRestaurant(MENU_BY_RESTAURANT.la_musa, EXTRAS_BY_RESTAURANT.la_musa,
    new Map(source.items.map((i) => [i.key, i])), new Map(source.extras.map((e) => [e.key, e])));
  const servedExtra = docs.extraDocs.find((d) => d.key === 'rice_white');
  assert.strictEqual(servedExtra.display.name, 'Arroz Blanco', 'the persisted doc names the extra by itself');
  assert.strictEqual(servedExtra.display.cat, 'Acompañamientos', '...and places it in its option group by itself');
  ok('a persisted extra describes itself — no read of meta/source is needed to render it');
}

// ═══ THE RULES THAT ONLY BITE WHEN SOMETHING IS WRONG ════════════════════════════════════════════
// Everything above runs on data where the display record and the charging table AGREE, which is the
// state the validator enforces — so none of it can tell whether the price came from the authority or
// from the display record. These make them disagree on purpose.
{
  const { formSource, readLiteral } = require('./form-menu-source');
  const fdFor = (rid, mutate) => {
    const src = formSource(rid);
    const fd = { dishes: readLiteral(src, 'MENU'), extras_display: readLiteral(src, 'EXTRAS'), categories: null };
    const order = []; for (const d of fd.dishes) if (!order.includes(d.cat)) order.push(d.cat);
    fd.categories = rid === 'la_musa' ? readLiteral(src, 'CATEGORIES') : order.map((id) => ({ id }));
    if (rid === 'la_musa') { fd.variant_items = readLiteral(src, 'VARIANT_ITEMS', '{', '}'); fd.badges = readLiteral(src, 'TAG_BADGES', '{', '}'); }
    if (mutate) mutate(fd);
    return fd;
  };
  const build = (rid, fd) => buildCatalogV2(rid, { formData: fd, priceTable: MENU_BY_RESTAURANT[rid], extrasTable: EXTRAS_BY_RESTAURANT[rid] });

  // 🔴 THE PRICE COMES FROM THE AUTHORITY, NOT THE DISPLAY RECORD. They agree in every valid source,
  // so only a deliberately disagreeing one can tell which was read — and reading the display record
  // would mean a merchant editing a NAME could move a price.
  {
    const fd = fdFor('x_pizza', (f) => { f.extras_display = f.extras_display.map((e) => ({ ...e, price: 1 })); });
    const built = build('x_pizza', fd);
    const salsa = built.extras.find((e) => e.key === 'Salsa Roja');
    assert.strictEqual(salsa.price, EXTRAS_BY_RESTAURANT.x_pizza['Salsa Roja'],
      '🔴 the charged price is the AUTHORITY\'s, even when the display record claims otherwise');
    assert.notStrictEqual(salsa.price, 1, 'non-vacuity: the display record really did claim something else');
    ok('an extra is priced by the authority, never by its display record');
  }

  // an extra nobody prices, and two display records claiming one key — both fail closed
  {
    assert.throws(() => build('x_pizza', fdFor('x_pizza', (f) => { f.extras_display.push({ id: 'e99', cat: 'Carnes', name: 'Ghost Extra', price: 10 }); })),
      /bootstrap_unpriced_extra/, '🔴 a display record for an extra nobody prices is refused');
    assert.throws(() => build('x_pizza', fdFor('x_pizza', (f) => { f.extras_display.push({ ...f.extras_display[0] }); })),
      /bootstrap_duplicate_extra_key/, '🔴 two display records claiming one pricing key are refused');
    assert.throws(() => build('x_pizza', fdFor('x_pizza', (f) => { f.extras_display = f.extras_display.slice(1); })),
      /bootstrap_missing_extra_display_record/, '🔴 a priced extra with no display record is refused');
    ok('the extras bijection fails closed in both directions, like the items one');
  }

  // badges reach the build — they are not derivable from anything else, so only carrying them works
  {
    const built = build('la_musa', fdFor('la_musa'));
    assert.ok(built.structure.badges && built.structure.badges.chefs_pick,
      '🔴 badge definitions are carried into the built catalog');
    assert.strictEqual(built.structure.badges.chefs_pick.label, 'Selección del chef', '...with their labels intact');
    const without = build('la_musa', fdFor('la_musa', (f) => { delete f.badges; }));
    assert.strictEqual(without.structure.badges, undefined, 'and a source that declares none carries none');
    ok('badge definitions are carried, not invented');
  }
}

// ── THE SEED WRITER THREADS IT ALL THE WAY TO THE DOCS ──────────────────────────────────────────
{
  // catalogDocsForRestaurant being right is not the same as the seed CALLING it right — the display
  // payload has to be handed over, and a caller that forgets writes price-only docs that pass every
  // unit test above.
  const { seedCatalog } = require('./seed-catalog-core');
  const written = [];
  const mkCol = (base) => ({
    doc: (id) => ({
      path: `${base}/${id}`,
      collection: (sub) => mkCol(`${base}/${id}/${sub}`),
      set: async (data) => { written.push({ path: `${base}/${id}`, data }); },
    }),
    get: async () => ({ forEach: () => {} }),        // a first seed: nothing to reconcile
  });
  const db = {
    collection: (c) => mkCol(c),
    batch: () => ({
      set: (ref, data) => { written.push({ path: ref.path, data }); },
      delete: () => {},
      commit: async () => {},
    }),
  };

  const source = buildSourceFromCode('la_musa');
  return seedCatalog(db, {
    la_musa: {
      menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa,
      v2Items: source.items, v2Extras: source.extras,
      profile: { name: 'La Musa', active: true },
    },
  }).then(() => {
    const extraDocs = written.filter((w) => w.path.includes('/extras/'));
    assert.ok(extraDocs.length > 0, `premise: the seed wrote extras (${written.length} docs total)`);
    for (const w of extraDocs) {
      assert.ok(w.data.display, `🔴 the seed wrote extra ${w.data.key} with no display record`);
      assert.strictEqual(w.data.display.price, w.data.price, `🔴 ${w.data.key}: written display price disagrees with the written price`);
    }
    ok(`the seed writer carries display records all the way to the persisted extras (${extraDocs.length} docs)`);
    console.log(`display-threading: OK (${n})`);
  });
}
