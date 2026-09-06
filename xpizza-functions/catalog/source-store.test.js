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
const GOOD = () => ({
  restaurant_id: 'x_pizza', schema_version: 1,
  items: [{ key: 'Margherita', price: 299, display: { id: 8, cat: 'individual', name: 'Margherita', price: 299 } }],
  extras: [{ key: 'Mozzarella', price: 50, display: { id: 'e4', cat: 'Salsas & Queso', name: 'Mozzarella', price: 50 } }],
  structure: { categories: [{ id: 'individual' }], item_order: ['Margherita'], pickup_only_cats: [], weekend_only_cats: [] },
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
      restaurant_id: 'la_musa', schema_version: 1,
      items: [{ key: 'dimsum_01', price: 223, display: { id: 'dimsum_01', cat: 'dim_sum', name: 'Wonton', price: 223 } }],
      extras: [{ key: 'Arroz Blanco', price: 50, display: { id: 'rice_white', cat: 'Acompañamientos', name: 'Arroz Blanco', price: 50 } }],
      structure: { categories: [{ id: 'dim_sum' }], item_order: ['dimsum_01'] },
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
