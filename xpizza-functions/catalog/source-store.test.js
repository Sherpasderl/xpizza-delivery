'use strict';
// Portal 2a Task 1 — the SOURCE STORE: reader, validator, build-input mapper, canonical serialization.
// Run: node catalog/source-store.test.js
//
// `restaurants/{rid}/source` becomes the single authority for everything menu-derived. Everything here
// is fail-closed: a source that is missing, malformed, or internally inconsistent must THROW rather
// than produce partial build inputs — a half-read source would publish a half-menu.
const assert = require('assert');
const { readSource, validateSource, sourceToBuildInputs, canonicalize } = require('./source-store');
const { readLiteral, formSource, pricingKeyOf } = require('./form-menu-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// A minimal well-formed x_pizza-shaped source (x_pizza keys items AND extras by NAME).
// Updated for the 1A complete schema (Task 2): schema_version 2, and the ordered extra-category
// namespace the extras are validated against. The record shapes were already complete — the fixture
// carried display prices and full extra records all along — so nothing here had to be invented.
const GOOD = () => ({
  restaurant_id: 'x_pizza', schema_version: 2,
  items: [{ key: 'Margherita', price: 299, display: { id: 8, cat: 'individual', name: 'Margherita', price: 299 } }],
  extras: [{ key: 'Mozzarella', price: 50, display: { id: 'e4', cat: 'Salsas & Queso', name: 'Mozzarella', price: 50 } }],
  structure: {
    categories: [{ id: 'individual' }], item_order: ['Margherita'],
    extra_categories: ['Salsas & Queso'],
    pickup_only_cats: [], weekend_only_cats: [],
  },
});

(async () => {
  // ── validateSource FAILS CLOSED on every corruption class ──────────────────────────────────────
  for (const [label, mutate] of [
    ['float price', (s) => { s.items[0].price = 12.5; }],
    ['zero price', (s) => { s.items[0].price = 0; }],
    ['negative price', (s) => { s.items[0].price = -1; }],
    ['string price', (s) => { s.items[0].price = '299'; }],
    ['corrupt EXTRA price', (s) => { s.extras[0].price = 0; }],
    ['missing display', (s) => { delete s.items[0].display; }],
    ['missing price field', (s) => { delete s.items[0].price; }],
    ['missing key', (s) => { delete s.items[0].key; }],
    ['duplicate key', (s) => { s.items.push({ ...s.items[0] }); }],
    ['key↔display non-bijection', (s) => { s.items[0].key = 'NotTheName'; }],
    ['dangling category', (s) => { s.items[0].display.cat = 'ghost_cat'; }],
    ['item_order missing an item', (s) => { s.structure.item_order = []; }],
    ['item_order duplicate', (s) => { s.structure.item_order = ['Margherita', 'Margherita']; }],
    ['item_order references a ghost', (s) => { s.structure.item_order = ['Ghost']; }],
    ['wrong restaurant_id', (s) => { s.restaurant_id = 'la_musa'; }],
  ]) {
    const s = GOOD(); mutate(s);
    assert.throws(() => validateSource(s, 'x_pizza'), /source_malformed|source_invalid/, `${label} must THROW`);
  }
  ok(`validateSource fails closed on 15 corruption classes (price, shape, bijection, ordering, identity)`);
  assert.doesNotThrow(() => validateSource(GOOD(), 'x_pizza'), 'a well-formed source validates');
  ok('validateSource accepts a well-formed source');

  // ── 🔒 EXTRAS KEYING — the landmine. x_pizza extras price by NAME while their display record ALSO
  //    carries an `id` ('e1'); la_musa extras price by that id. A seed that keyed x_pizza extras by
  //    'e1' would round-trip cleanly and hash stably, and price NOTHING, because no cart line would
  //    ever match — a byte-identical no-op that quietly breaks every extra. ────────────────────────
  {
    const s = GOOD(); s.extras[0].key = 'e4';                                  // the form-local handle, not the price key
    assert.throws(() => validateSource(s, 'x_pizza'), /extras key by NAME/, 'x_pizza extra keyed by its form id must THROW');
    const lm = {
      restaurant_id: 'la_musa', schema_version: 2,
      items: [{ key: 'dimsum_01', price: 223, display: { id: 'dimsum_01', cat: 'dim_sum', name: 'Wonton', price: 223 } }],
      extras: [{ key: 'Arroz Blanco', price: 50, display: { id: 'rice_white', cat: 'Acompañamientos', name: 'Arroz Blanco', price: 50 } }],
      structure: { categories: [{ id: 'dim_sum' }], item_order: ['dimsum_01'], extra_categories: ['Acompañamientos'] },
    };
    assert.throws(() => validateSource(lm, 'la_musa'), /does not match its display record/, 'la_musa extra keyed by NAME must THROW (it prices by id)');
    lm.extras[0].key = 'rice_white';
    assert.doesNotThrow(() => validateSource(lm, 'la_musa'), 'correctly keyed la_musa extra validates');
    ok('extras keying: x_pizza must key by NAME, la_musa by id — the wrong one fails closed (the silent-no-op trap)');
  }
  {
    // A display record carrying its own price must AGREE with the authoritative one, or the form shows
    // one number while the server charges another.
    const a = GOOD(); a.extras[0].display.price = 99;
    assert.throws(() => validateSource(a, 'x_pizza'), /disagrees with the authoritative price/, 'extra inline-price mismatch throws');
    const b = GOOD(); b.items[0].display.price = 99;
    assert.throws(() => validateSource(b, 'x_pizza'), /disagrees with the authoritative price/, 'item inline-price mismatch throws');
    ok('inline-price agreement: a display price that disagrees with the authoritative price fails closed (both items and extras)');
  }
  {
    // CATEGORY SUPERSET — categories are store-authored now, so they can drift from the dishes.
    const s = GOOD(); s.structure.categories = [{ id: 'other' }];
    assert.throws(() => validateSource(s, 'x_pizza'), /authored categories are missing individual|references unknown category/,
      'authored categories must cover every category a dish uses');
    const ok2 = GOOD(); ok2.structure.categories = [{ id: 'individual' }, { id: 'ny' }];
    assert.doesNotThrow(() => validateSource(ok2, 'x_pizza'), 'a SUPERSET is fine — an empty category is a legitimate portal state');
    ok('category superset: authored categories must cover the dishes\' categories; a superset is allowed');
  }

  // ── sourceToBuildInputs maps to exactly what buildCatalogV2 consumes ───────────────────────────
  {
    const { priceTable, formData, extras } = sourceToBuildInputs(GOOD());
    assert.deepStrictEqual(priceTable, { Margherita: 299 }, 'priceTable is {key: price}');
    assert.deepStrictEqual(extras, { Mozzarella: 50 }, 'extras is {key: price} — the server table shape');
    assert.deepStrictEqual(formData.dishes, [{ id: 8, cat: 'individual', name: 'Margherita', price: 299 }], 'dishes are the VERBATIM display records');
    assert.deepStrictEqual(formData.item_order, ['Margherita'], 'item_order carried');
    assert.deepStrictEqual(formData.categories, [{ id: 'individual' }]);
    ok('sourceToBuildInputs → { priceTable, formData, extras } in the shapes buildCatalogV2 consumes');
  }

  // ── canonicalize: stable recursive key ordering (the descriptor must not move with property order) ──
  {
    const a = canonicalize({ b: 1, a: { d: 4, c: [{ z: 1, y: 2 }] } });
    const b = canonicalize({ a: { c: [{ y: 2, z: 1 }], d: 4 }, b: 1 });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'the same content in any key order canonicalizes identically');
    assert.strictEqual(JSON.stringify(a), '{"a":{"c":[{"y":2,"z":1}],"d":4},"b":1}', 'and to a pinned form');
    assert.notStrictEqual(JSON.stringify(canonicalize({ a: 1 })), JSON.stringify(canonicalize({ a: 2 })), 'content still distinguishes');
    assert.deepStrictEqual(canonicalize([3, 1, 2]), [3, 1, 2], 'ARRAY ORDER IS CONTENT — never sorted (item_order would be destroyed)');
    ok('canonicalize: stable recursive key ordering, pinned output, array order preserved as content');
  }

  // ── 🔒 SCHEMA COMPLETENESS (grill C1): every field the CODE path reads must be representable ────
  //    A future code-only field would otherwise be invisible to the store and silently lost at 2b.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'form-menu-source.js'), 'utf8');
    const literalNames = [...src.matchAll(/read(?:Set)?Literal\(src, '([A-Z_]+)'/g)].map((m) => m[1]);
    assert.ok(literalNames.length >= 5, `expected the code path to read several literals, found ${literalNames}`);
    const { SOURCE_COVERED_LITERALS } = require('./source-store');
    for (const nm of literalNames) {
      assert.ok(SOURCE_COVERED_LITERALS.includes(nm), `the store schema must cover the code literal ${nm} — otherwise a store edit could never change it`);
    }
    ok(`schema completeness: all ${literalNames.length} code-path literals (${literalNames.join(', ')}) are covered by the store schema`);
    // and the form-side extras maps the code path does NOT read, but 2b must be able to edit
    for (const nm of ['EXTRAS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM']) {
      assert.ok(SOURCE_COVERED_LITERALS.includes(nm), `${nm} must be in the store — the form reads it and the portal must own it`);
    }
    ok('schema completeness: the form-side extras maps (EXTRAS, EXTRAS_BY_CATEGORY, EXTRAS_BY_ITEM) are covered too');
  }

  // ── readSource is fail-closed on a missing/partial doc ────────────────────────────────────────
  {
    const missing = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }) }) };
    await assert.rejects(() => readSource(missing, 'x_pizza'), /source_missing/, 'an absent source THROWS — never a partial build');
    const malformed = { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ restaurant_id: 'x_pizza' }) }) }) }) }) }) };
    await assert.rejects(() => readSource(malformed, 'x_pizza'), /source_malformed|source_invalid/, 'a partial source THROWS');
    ok('readSource fails closed: missing → source_missing, partial → source_malformed (never a half-menu)');
  }
  console.log(`source-store: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });

// ═══ Task 2 — THE COMPLETE DISPLAY-PAYLOAD VALIDATOR ═════════════════════════════════════════════
// 1A makes the catalog the single source the customer form is built from, so "valid" stops meaning
// "prices are sane" and starts meaning "everything a customer sees is present, consistent, and safe
// to render". Every rule below is its own case, both brands, and rejects rather than repairs: a
// publish that cannot fully describe the menu must not happen.
{
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  const { extrasKeyOf } = require('./source-store');
  const rejects = (label, source, rid, match) => {
    let threw = null;
    try { validateSource(source, rid); } catch (e) { threw = e; }
    assert.ok(threw, `EXPECTED REJECTION: ${label}`);
    if (match) assert.ok(match.test(threw.message), `${label} — wrong reason: ${threw.message}`);
    ok(label);
  };
  // Start from the REAL seed and break exactly one thing, so every case is grounded in live data and
  // the diff between valid and invalid is the rule under test.
  const broken = (rid, mutate) => { const s = buildSourceFromCode(rid); mutate(s); return s; };

  // ── the baseline: today's real menus must PASS, or the validator is an outage ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const s = buildSourceFromCode(rid);
    assert.doesNotThrow(() => validateSource(s, rid), `real ${rid} source must validate`);
    assert.strictEqual(s.schema_version, 2, `${rid} — the complete schema is stamped`);
    ok(`${rid}: the real complete source validates and is stamped schema_version 2`);
  }

  // ── PRICES: display price is mandatory now, not "checked when present" ──
  for (const rid of ['x_pizza', 'la_musa']) {
    rejects(`${rid}: a dish with NO display.price`, broken(rid, (s) => { delete s.items[0].display.price; }), rid, /display price/i);
    rejects(`${rid}: a dish whose display.price disagrees`, broken(rid, (s) => { s.items[0].display.price = s.items[0].price + 1; }), rid, /disagrees/);
    rejects(`${rid}: an extra with NO display record`, broken(rid, (s) => { delete s.extras[0].display; }), rid, /display record/);
    rejects(`${rid}: an extra with NO display.price`, broken(rid, (s) => { delete s.extras[0].display.price; }), rid, /display price/i);
    rejects(`${rid}: an extra whose display price disagrees`, broken(rid, (s) => { s.extras[0].display.price = s.extras[0].price + 1; }), rid, /disagrees/);
  }

  // ── EXTRAS: record shape, bijection, and the SEPARATE category namespace ──
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const field of ['id', 'cat', 'name']) {
      // The PRICING KEY is derived from the display record and differs per brand — x_pizza extras key
      // by name, la_musa by id — so removing the keying field is caught as a key mismatch rather than
      // as a missing field. Either is a correct rejection; what matters is that it cannot pass.
      rejects(`${rid}: an extra display missing ${field}`,
        broken(rid, (s) => { delete s.extras[0].display[field]; }), rid, new RegExp(`${field}|key does not match`));
    }
    // 🔴 The extra-category namespace is NOT structure.categories. Requiring membership there would
    // reject every real extra — "Salsas & Queso" is not a dish category and never was.
    rejects(`${rid}: an extra in an undeclared extra-category`,
      broken(rid, (s) => { s.extras[0].display.cat = 'Not A Real Extra Category'; }), rid, /extra-category/);
    rejects(`${rid}: the extra-category namespace missing entirely`,
      broken(rid, (s) => { delete s.structure.extra_categories; }), rid, /extra_categories/);
    // a dish category is not an extra category, and vice versa — the two namespaces stay apart
    rejects(`${rid}: an extra borrowing a DISH category`,
      broken(rid, (s) => { s.extras[0].display.cat = s.structure.categories[0].id; }), rid, /extra-category/);
  }
  // 🔴 THE PEPPERONI CASE: x_pizza has a dish AND an extra named Pepperoni, and they price from
  // different tables. A validator that indexed display records by name alone would fuse them.
  {
    const s = buildSourceFromCode('x_pizza');
    const dish = s.items.find((i) => i.key === 'Pepperoni');
    const extra = s.extras.find((e) => e.key === 'Pepperoni');
    assert.ok(dish && extra, 'premise: x_pizza really does have both a Pepperoni dish and a Pepperoni extra');
    assert.notStrictEqual(dish.price, extra.price, 'premise: and they cost different amounts');
    assert.doesNotThrow(() => validateSource(s, 'x_pizza'), 'the two coexist without conflating');
    ok('x_pizza: the Pepperoni dish and the Pepperoni extra stay in separate namespaces');
  }

  // ── EXPOSURE-MAP VALUES (today only the keys were checked) ──
  {
    const rid = 'la_musa';
    rejects('la_musa: extras_by_category VALUE naming an unknown extra-category',
      broken(rid, (s) => { s.structure.extras_by_category.rice = ['Ghost Category']; }), rid, /extras_by_category/);
    rejects('la_musa: extras_by_item VALUE naming an unknown extra-category',
      broken(rid, (s) => { s.structure.extras_by_item.rice_03 = ['Ghost Category']; }), rid, /extras_by_item/);
    // a value MAY name an individual extra (Task 1's key-level add) — but only a real one
    rejects('la_musa: extras_by_item VALUE naming an unknown extra KEY',
      broken(rid, (s) => { s.structure.extras_by_item.rice_03 = ['no_such_extra']; }), rid, /extras_by_item/);
    const okAdd = broken(rid, (s) => { s.structure.extras_by_item.rice_03 = [s.extras[0].key]; });
    assert.doesNotThrow(() => validateSource(okAdd, rid), 'a value naming a REAL extra key is accepted');
    ok('la_musa: exposure values are validated, and a real extra key is a legal value');
  }

  // ── STRUCTURE: ids, categories, subcategories ──
  for (const rid of ['x_pizza', 'la_musa']) {
    // For la_musa the UI id IS the pricing key, so a duplicate is caught by the key check that already
    // existed; for x_pizza the id is a separate numeric handle and only the new UI-id rule sees it.
    // Both must reject — which rule fires is a property of the brand's keying, not of the menu.
    rejects(`${rid}: two dishes sharing a UI id`,
      broken(rid, (s) => { s.items[1].display.id = s.items[0].display.id; }), rid, /duplicate ui id|duplicate item key|key does not match/i);
    rejects(`${rid}: a dish with no category at all`,
      broken(rid, (s) => { delete s.items[0].display.cat; }), rid, /category/);
  }
  // 🔴 An item whose subcat is not declared by its category VANISHES from the menu — the renderer
  // groups by the declared subcats and drops everything else. Silent, so it must reject.
  rejects('la_musa: an item whose subcat its category never declares',
    broken('la_musa', (s) => {
      const it = s.items.find((i) => i.display.subcat);
      it.display.subcat = 'Undeclared Subcat';
    }), 'la_musa', /subcat/);
  {
    const s = buildSourceFromCode('la_musa');
    assert.ok(s.items.some((i) => i.display.subcat), 'premise: la_musa really does use subcategories');
    ok('la_musa: subcategory coverage is a real rule on real data');
  }

  // ── VARIANT GRAPH ──
  {
    const rid = 'la_musa';
    rejects('la_musa: a variant whose launcher does not exist (orphan)',
      broken(rid, (s) => { s.structure.variant_items = { ghost_launcher: { variantIds: ['noodle_01_sin'] } }; }), rid, /orphan/);
    rejects('la_musa: a launcher listing a variant that does not exist',
      broken(rid, (s) => { s.structure.variant_items.noodle_01.variantIds.push('no_such_variant'); }), rid, /not a real item/);
    rejects('la_musa: a launcher with an EMPTY choice list',
      broken(rid, (s) => { s.structure.variant_items.noodle_01.variantIds = []; }), rid, /empty choice/);
    rejects('la_musa: a launcher that is its own variant (cycle)',
      broken(rid, (s) => { s.structure.variant_items.noodle_01.variantIds.push('noodle_01'); }), rid, /cycle/);
    rejects('la_musa: a variant pointing at a different launcher than the one listing it',
      broken(rid, (s) => { s.items.find((i) => i.key === 'noodle_01_sin').display.variantOf = 'rice_01'; }), rid, /bad parent/);
    // Two launchers offering the same variant: whichever the customer arrives through, the other
    // launcher's choice is a lie. Caught before the parent check, because "claimed twice" describes
    // the graph better than "one of the two parents disagrees".
    rejects('la_musa: one variant claimed by TWO launchers',
      broken(rid, (s) => { s.structure.variant_items.rice_01 = { label: 'X', variantIds: ['noodle_01_sin'] }; }), rid, /claimed by both/);
    rejects('la_musa: a variant nobody lists (missing coverage)',
      broken(rid, (s) => { s.structure.variant_items.noodle_01.variantIds = s.structure.variant_items.noodle_01.variantIds.filter((v) => v !== 'noodle_01_sin'); }), rid, /missing coverage/);
  }

  // ── SCHEMA VERSION ───────────────────────────────────────────────────────────────────────────
  // Nothing pinned this: every fixture already carried the new version, so the check could be deleted
  // with the whole suite green. A source on the OLD schema is one the strict reader cannot serve.
  for (const rid of ['x_pizza', 'la_musa']) {
    rejects(`${rid}: a source still on the old schema_version`,
      broken(rid, (s) => { s.schema_version = 1; }), rid, /schema_version/);
  }

  // ── RENDERING SAFETY: both sinks, rejected BEFORE activation ──
  for (const rid of ['x_pizza', 'la_musa']) {
    // x_pizza keys items BY NAME, so a hostile name must be planted WITH its key re-derived — else the
    // key check rejects first and the safety rule is never reached. The payload has to arrive the way
    // a real merchant edit would: as a renamed dish, consistently keyed.
    const rename = (s, value) => { s.items[0].display.name = value; s.items[0].key = pricingKeyOf(rid, s.items[0].display); s.structure.item_order[0] = s.items[0].key; };
    rejects(`${rid}: a BODY-context name carrying markup (La Musa innerHTML)`,
      broken(rid, (s) => rename(s, '<img src=x onerror=alert(1)>')), rid, /display_unsafe/);
    // 🔴 no angle brackets at all — the case a markup filter passes and the alt= sink executes
    rejects(`${rid}: an ATTRIBUTE-breaking name (X.Pizza alt="\${p.name}")`,
      broken(rid, (s) => rename(s, '" onmouseover="alert(1)')), rid, /display_unsafe/);
    rejects(`${rid}: a handler-breaking category id (La Musa inline onclick)`,
      broken(rid, (s) => { const c = s.structure.categories[0].id; s.structure.categories[0].id = "x');alert(1);//"; for (const i of s.items) if (i.display.cat === c) i.display.cat = "x');alert(1);//"; }), rid, /display_unsafe/);
    rejects(`${rid}: an unsafe extra id reaching toggleDetailExtra('<id>')`,
      broken(rid, (s) => { s.extras[0].display.id = "e1');alert(1);//"; s.extras[0].key = extrasKeyOf(rid, s.extras[0].display); }), rid, /display_unsafe/);
    // A category whose NAME is unsafe — no item carries that field, so only the category-level safety
    // pass can see it. Without this the category check was covered by the item check and could go.
    rejects(`${rid}: a category NAME carrying markup`,
      broken(rid, (s) => { s.structure.categories[0].name = '<img src=x onerror=alert(1)>'; }), rid, /display_unsafe.*name/);
    rejects(`${rid}: an image path with a javascript: scheme`,
      broken(rid, (s) => { s.items[0].display.img = 'javascript:alert(1)'; }), rid, /display_unsafe/);
  }
}
