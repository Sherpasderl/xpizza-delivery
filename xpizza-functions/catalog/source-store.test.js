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
      // la_musa's renderer prints category labels, so the contract requires every category to carry one.
      structure: { categories: [{ id: 'dim_sum', name: 'Dim Sum' }], item_order: ['dimsum_01'], extra_categories: ['Acompañamientos'] },
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
    // The rule is now "present AND equal" in one check — the conditional version it replaced skipped
    // the case where the field was absent, which is the one that renders a blank price.
    assert.throws(() => validateSource(a, 'x_pizza'), /must be present and equal to the authoritative price/, 'extra inline-price mismatch throws');
    const b = GOOD(); b.items[0].display.price = 99;
    assert.throws(() => validateSource(b, 'x_pizza'), /must be present and equal to the authoritative price/, 'item inline-price mismatch throws');
    ok('inline-price agreement: a display price that disagrees with the authoritative price fails closed (both items and extras)');
  }
  {
    // CATEGORY SUPERSET — categories are store-authored now, so they can drift from the dishes.
    const s = GOOD(); s.structure.categories = [{ id: 'other' }];
    assert.throws(() => validateSource(s, 'x_pizza'), /authored categories are missing individual|references unknown category/,
      'authored categories must cover every category a dish uses');
    // 🔴 REVERSED AT 1A, DELIBERATELY. This asserted the opposite — that a superset was fine, because
    // a portal could plausibly pre-create an empty category. 1A means the catalog is COMPLETE AND
    // CONSISTENT: a declared category nothing is in renders an empty section, and it is far more
    // likely a rename that half-landed than an intention. It rejects no real data (both brands'
    // categories are exactly used today). If pre-creating empty categories is ever wanted, that is a
    // deliberate relaxation with a UI behind it, not a gap left open in the validator.
    const ok2 = GOOD(); ok2.structure.categories = [{ id: 'individual' }, { id: 'ny' }];
    assert.throws(() => validateSource(ok2, 'x_pizza'), /declared but no dish is in it/,
      'a declared-but-unused category is now REFUSED (1A completeness ruling)');
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
  const { pricingKeyOf: pkeyOf } = require('./form-menu-source');
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
    rejects(`${rid}: a dish with NO display.price`, broken(rid, (s) => { delete s.items[0].display.price; }), rid, /display[. ]price|is required/i);
    rejects(`${rid}: a dish whose display.price disagrees`, broken(rid, (s) => { s.items[0].display.price = s.items[0].price + 1; }), rid, /must be present and equal|is required/);
    rejects(`${rid}: an extra with NO display record`, broken(rid, (s) => { delete s.extras[0].display; }), rid, /display record|display is required/);
    rejects(`${rid}: an extra with NO display.price`, broken(rid, (s) => { delete s.extras[0].display.price; }), rid, /display[. ]price|is required/i);
    rejects(`${rid}: an extra whose display price disagrees`, broken(rid, (s) => { s.extras[0].display.price = s.extras[0].price + 1; }), rid, /must be present and equal|is required/);
  }

  // ── EXTRAS: record shape, bijection, and the SEPARATE category namespace ──
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const field of ['id', 'cat', 'name']) {
      // The PRICING KEY is derived from the display record and differs per brand — x_pizza extras key
      // by name, la_musa by id — so removing the keying field is caught as a key mismatch rather than
      // as a missing field. Either is a correct rejection; what matters is that it cannot pass.
      rejects(`${rid}: an extra display missing ${field}`,
        broken(rid, (s) => { delete s.extras[0].display[field]; }), rid, new RegExp(`${field}|key does not match|is required`));
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
      broken(rid, (s) => { delete s.items[0].display.cat; }), rid, /category|display\.cat is required/);
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
      // Drop a NON-cheapest variant, so the derived-basePrice rule stays satisfied and coverage is the
      // only thing that can fire. Removing the cheapest would also move "desde" and reject for that.
      broken(rid, (s) => { s.structure.variant_items.noodle_01.variantIds = s.structure.variant_items.noodle_01.variantIds.filter((v) => v !== 'noodle_01_camaron'); }), rid, /missing coverage/);
  }

  // ── the four rules the census plants could not isolate ───────────────────────────────────────
  // Each of these survived mutation at first: the census plants ONE bad value per field, and for
  // these fields a different bad value is caught by a different rule. A field can be covered and a
  // RULE still be untested.
  for (const rid of ['x_pizza', 'la_musa']) {
    // the census plants markup in the name; nothing planted its ABSENCE
    rejects(`${rid}: a dish with no name at all`,
      broken(rid, (s) => { delete s.items[0].display.name; s.items[0].key = pkeyOf(rid, s.items[0].display); s.structure.item_order[0] = s.items[0].key; }),
      // x_pizza's pricing key IS the name, so deleting it also destroys the key — either rejection is
      // correct, and which one fires is a property of the brand's keying rather than of the menu.
      rid, /display[. ]name|key does not match|missing a string key|is required/);
  }
  // the census plants an UNDECLARED subcat; the renderer drops an item with NO subcat just as surely
  rejects('la_musa: an item with no subcat in a category that GROUPS by subcats',
    broken('la_musa', (s) => { const it = s.items.find((i) => i.display.subcat); delete it.display.subcat; }),
    'la_musa', /groups by subcategory/);
  // 🔴 SUPERSEDED BY TASK 3, and worth saying why rather than just deleting. This asserted that an
  // authored basePrice of 999 was refused for not equalling the cheapest variant. There is no authored
  // basePrice any more: "desde" is derived at emission, so the source stores no copy for anything to
  // disagree with, and authoring one at all is refused — including the CORRECT value, since being
  // right today was never the property. The derivation itself is covered in desde-derivation.test.js.
  rejects('la_musa: authoring a basePrice at all (even the right one)',
    broken('la_musa', (s) => { s.structure.variant_items.noodle_01.basePrice = 307; }), 'la_musa', /must not be stored/);
  rejects('la_musa: authoring a WRONG basePrice',
    broken('la_musa', (s) => { s.structure.variant_items.noodle_01.basePrice = 999; }), 'la_musa', /must not be stored/);
  {
    // The launcher's own higher price is NOT the desde. Pinning this stops a "fix" that equates them:
    // Pad Thai launches at L414 and starts from L307, and both facts are load-bearing.
    const s = buildSourceFromCode('la_musa');
    assert.strictEqual(s.items.find((i) => i.key === 'noodle_01').price, 414, 'the launcher keeps its own authoritative price');
    assert.strictEqual(s.structure.variant_items.noodle_01.basePrice, undefined, 'and the source stores no starting price');
    assert.doesNotThrow(() => validateSource(s, 'la_musa'), 'the two coexist — they are different facts');
    ok('la_musa: the launcher price is authoritative and the desde is not stored beside it');
  }
  // A two-node cycle has no self-edge, so the self-reference check never sees it — this is the case
  // the gate reported as passing. It is now refused.
  //
  // Worth being exact about WHICH rule catches it: making variant coverage unconditional means every
  // node in a cycle is a variant no launcher lists, so coverage fires first. The general cycle walk
  // is therefore a backstop rather than the thing standing here today, and it is reported as a
  // mutation survivor rather than claimed as load-bearing. It is kept because coverage is a statement
  // about launcher LISTS while the walk is a statement about the parent chain TERMINATING, and the
  // day those two stop implying each other is not a day anyone will be watching for it.
  rejects('la_musa: a variantOf CYCLE between two items (no self-reference)',
    broken('la_musa', (s) => {
      const a = s.items.find((i) => i.key === 'rice_01');
      const b = s.items.find((i) => i.key === 'rice_02');
      a.display.variantOf = b.display.id; a.display.choice = 'A';
      b.display.variantOf = a.display.id; b.display.choice = 'B';
    }), 'la_musa', /cycle|missing coverage/);

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
    // Name EVERY category — x_pizza's carry none today, and a partially named set is refused by its
    // own rule, which would reject this for the wrong reason.
    rejects(`${rid}: a category NAME carrying markup`,
      broken(rid, (s) => { s.structure.categories.forEach((c, i) => { c.name = i === 0 ? '<img src=x onerror=alert(1)>' : `Cat ${i}`; }); }),
      rid, /display_unsafe|name/);
    rejects(`${rid}: an image path with a javascript: scheme`,
      broken(rid, (s) => { s.items[0].display.img = 'javascript:alert(1)'; }), rid, /display_unsafe/);
  }
}

// ═══ THE FIELD CENSUS — exhaustive by construction ═══════════════════════════════════════════════
// A sink map with provenance proves every ENTRY is real; it can never prove the SET is whole. One bad
// value per field is not enough either — basePrice was "covered" by a markup plant while DELETING it
// was accepted, and desc was covered while `{}` sailed through.
//
// So: the seed is walked RECURSIVELY (nested maps, reference arrays and their elements included), and
// every path must have an explicit outcome for all FIVE ways a field can be wrong:
//
//     absent     — the field is gone
//     wrongType  — present, wrong JS type
//     invalid    — right type, meaningless value
//     refs       — right type and shape, naming something that does not exist
//     duplicate  — a collection carrying the same entry twice
//
// absent / wrongType / duplicate are planted GENERICALLY, so they cannot be forgotten. `invalid` and
// `refs` need to know what the field means, so each path declares either a plant or a stated reason
// why the mode does not apply. A path with no entry fails; a mode with neither fails; a plant that is
// ACCEPTED fails. A new field in the seed cannot pass until someone has thought about all five.
{
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  const { extrasKeyOf } = require('./source-store');
  const { pricingKeyOf: pkeyOf } = require('./form-menu-source');
  const XSS = '<img src=x onerror=alert(1)>';
  const MAPS = new Set(['structure.badges', 'structure.extras_by_category', 'structure.extras_by_item', 'structure.variant_items']);

  const walk = (value, prefix, out) => {
    if (Array.isArray(value)) { for (const v of value) walk(v, `${prefix}[]`, out); return; }
    if (value && typeof value === 'object') {
      const isMap = MAPS.has(prefix);
      for (const k of Object.keys(value)) {
        const path = prefix ? `${prefix}.${isMap ? '*' : k}` : k;
        out.add(path); walk(value[k], path, out);
      }
      return;
    }
    if (prefix.endsWith('[]')) out.add(prefix);
  };

  // Resolve a concrete node the path names, so a generic plant can act on it.
  //
  // 🔴 It must choose an element that ACTUALLY CARRIES the field. `items[].display.choice` resolved to
  // items[0], which is not a variant and has no choice — so the generic wrong-type plant wrote a
  // harmless value onto a record the rule does not govern, and the census reported the field as
  // accepted when nothing had really been tried. Optional fields live on SOME records, and a plant
  // aimed at the wrong one proves nothing.
  const resolve = (source, path, pick) => {
    let parent = null; let key = null; let node = source;
    for (const seg of path.split('.')) {
      const m = /^([^[]*)((?:\[\])*)$/.exec(seg);
      const name = m[1]; const arrays = m[2].length / 2;
      if (name === '*') { const k = Object.keys(node)[0]; parent = node; key = k; node = node[k]; }
      else if (name) { parent = node; key = name; node = node[name]; }
      for (let i = 0; i < arrays; i++) { parent = node; key = pick(node, path); node = node[key]; }
      if (node === undefined && name) return { parent, key, value: undefined };
    }
    return { parent, key, value: node };
  };
  // The remaining path after this array, so an element can be scored on whether it has the leaf.
  const locate = (source, path) => {
    const segs = path.split('.');
    const pick = (arr, full) => {
      const idx = arr.findIndex((el) => {
        let cur = el;
        // walk whatever of the path comes AFTER the array we are choosing in
        const after = full.slice(full.indexOf('[]') + 2).split('.').filter(Boolean);
        for (const seg of after) { if (cur == null) return false; cur = cur[seg.replace(/\[\]$/, '')]; }
        return cur !== undefined;
      });
      return idx === -1 ? 0 : idx;
    };
    void segs;
    return resolve(source, path, pick);
  };
  // A wrong type for an OBJECT is a scalar — 7, not a string. `Object.entries('some string')` yields
  // index/char pairs, so a string stands in for a map well enough to trip the NEXT check instead of
  // the type check, and the type check then looks redundant when it is the only thing standing there.
  const WRONG = (v) => (typeof v === 'string' ? {} : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? 'yes'
    : Array.isArray(v) ? { nope: true } : 7);

  const NA = (reason) => ({ exempt: reason });
  // Paths whose `invalid` / `refs` / `absent` outcome needs to know what the field MEANS.
  const CONTRACT = {
    'restaurant_id':            { invalid: (s) => { s.restaurant_id = 'someone_else'; }, refs: NA('the rid is the identity, not a reference') },
    'schema_version':           { invalid: (s) => { s.schema_version = 1; }, refs: NA('a version number is a value, not a reference to another entity') },
    'items':                    { invalid: (s) => { s.items = []; }, refs: NA('the collection itself names nothing') },
    'extras':                   { invalid: NA('an empty extras list is legitimate — a menu may sell no add-ons'), refs: NA('this value is content, not a reference to another catalog entity') },
    'structure':                { invalid: NA('an empty structure fails its required members, which are covered per field'), refs: NA('this value is content, not a reference to another catalog entity') },
    'items[].key':              { invalid: (s) => { s.items[0].key = '   '; }, refs: (s) => { s.items[0].key = 'not_the_derived_key'; } },
    'items[].price':            { invalid: (s) => { s.items[0].price = 0; }, refs: NA('a price is a value, not a reference to another catalog entity') },
    'items[].display':          { invalid: NA('an empty display fails its required members, covered per field'), refs: NA('this value is content, not a reference to another catalog entity') },
    'items[].has_photo':        { collectionAbsent: NA('a menu whose dishes all lack photos is legitimate'), absent: NA('optional — a dish with no photo simply omits it'), invalid: NA('a boolean has exactly two values and both are meaningful'), refs: NA('this value is content, not a reference to another catalog entity') },
    'items[].display.id':       { invalid: (s) => { const d = s.items[0].display; d.id = typeof d.id === 'number' ? -0.5 : '   '; }, refs: NA('a UI id names nothing; its uniqueness is its own rule') },
    'items[].display.cat':      { invalid: (s) => { s.items[0].display.cat = '   '; }, refs: (s) => { s.items[0].display.cat = 'ghost_category'; } },
    'items[].display.name':     { invalid: (s) => { s.items[0].display.name = '   '; rekey(s); }, refs: NA('a display name is content, not a reference to another entity'), unsafeBody: (s) => { s.items[0].display.name = XSS; rekey(s); }, unsafeAttr: (s) => { s.items[0].display.name = '" onmouseover="alert(1)'; rekey(s); } },
    'items[].display.price':    { invalid: (s) => { s.items[0].display.price = s.items[0].price + 1; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'items[].display.desc':     { collectionAbsent: NA('a menu with no descriptions at all is legitimate — beverages already ship blank'), absent: NA('optional by renderer contract — beverages ship with a blank description and variants carry none'), invalid: NA('any string is a description; blankness is legitimate for beverages'), refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { s.items[0].display.desc = XSS; } },
    'items[].display.subcat':   { collectionAbsent: NA('only categories that GROUP by subcategory need one, which is its own rule'), absent: NA('optional — only categories that GROUP by subcategory require one, which is its own rule'), invalid: (s) => { withSub(s).display.subcat = 'Undeclared'; }, refs: NA('covered by invalid: a subcat that its category never declares') },
    'items[].display.emoji':    { collectionAbsent: NA('a menu that renders photos and colours instead of emoji is legitimate'), absent: NA('optional — a dish may render its photo or colour instead'), invalid: NA('any string renders as a label'), refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { s.items[0].display.emoji = XSS; } },
    'items[].display.color':    { collectionAbsent: NA('the renderer has its own default colour for every card'), absent: NA('optional — the renderer falls back to its own default'), invalid: (s) => { s.items[0].display.color = '#12345'; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'items[].display.img':      { collectionAbsent: NA('a menu with no photos at all is legitimate'), absent: NA('optional — a dish without a photo renders emoji+colour'), invalid: (s) => { s.items[0].display.img = 'javascript:alert(1)'; }, refs: NA('an image path points at a file, not at another catalog entity') },
    'items[].display.tags':     { collectionAbsent: NA('a menu with no badges on any dish is the ordinary case'), absent: NA('optional — most dishes carry no badge'), invalid: NA('covered by refs: an entry that names no definition'), refs: (s) => { s.items[0].display.tags = ['ghost_badge']; } },
    'items[].display.tags[]':   { absent: NA('an element cannot be absent; an empty list is the absent case'), invalid: (s) => { s.items[0].display.tags = ['not an identifier']; }, refs: (s) => { s.items[0].display.tags = ['ghost_badge']; } },
    'items[].display.variantOf':{ collectionAbsent: NA('a menu with no variant dishes at all is legitimate'), absent: NA('optional — most dishes are not variants'), invalid: NA('covered by refs: a parent that does not exist'), refs: (s) => { variantItem(s).display.variantOf = 'no_such_launcher'; } },
    'items[].display.choice':   { collectionAbsent: NA('without variants there are no choice labels to carry'), absent: NA('optional — only a variant needs one, which is its own rule'), invalid: (s) => { variantItem(s).display.choice = '   '; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'extras[].key':             { invalid: (s) => { s.extras[0].key = '   '; }, refs: (s) => { s.extras[0].key = 'not_the_derived_key'; } },
    'extras[].price':           { invalid: (s) => { s.extras[0].price = -1; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'extras[].display':         { invalid: NA('an empty display fails its required members, covered per field'), refs: NA('this value is content, not a reference to another catalog entity') },
    'extras[].display.id':      { invalid: (s) => { s.extras[1].display.id = s.extras[0].display.id; }, refs: NA('a selection id names nothing outside the extras list') },
    'extras[].display.cat':     { invalid: (s) => { s.extras[0].display.cat = '   '; }, refs: (s) => { s.extras[0].display.cat = 'Ghost'; } },
    'extras[].display.name':    { invalid: (s) => { s.extras[0].display.name = '   '; s.extras[0].key = extrasKeyOf(s.restaurant_id, s.extras[0].display); }, refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { s.extras[0].display.name = XSS; s.extras[0].key = extrasKeyOf(s.restaurant_id, s.extras[0].display); } },
    'extras[].display.price':   { invalid: (s) => { s.extras[0].display.price = s.extras[0].price + 1; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'structure.schema_version': { absent: NA('optional — the SOURCE version is the one consumers read'), invalid: (s) => { s.structure.schema_version = 0; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'structure.categories':     { invalid: (s) => { s.structure.categories = []; }, refs: NA('the collection names nothing; its members do') },
    'structure.categories[].id':      { invalid: (s) => { cat0(s).id = '   '; }, refs: NA('a category id is the identity dishes reference') },
    'structure.categories[].name':    { invalid: (s) => { cat0(s).name = '   '; }, refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { cat0(s).name = XSS; } },
    'structure.categories[].layout':  { collectionAbsent: NA('every category defaulting to the grid is legitimate'), absent: NA('optional — absence means the default grid'), invalid: (s) => { cat0(s).layout = 'masonry'; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'structure.categories[].subcats': { collectionAbsent: NA('a menu where no category groups by subcategory is legitimate'), absent: NA('optional — most categories do not group'), invalid: NA('covered by refs and duplicate'), refs: (s) => { const c = subCat(s); c.subcats = [...c.subcats, 'NeverUsed']; } },
    'structure.categories[].subcats[]': { absent: NA('an element cannot be absent'), invalid: (s) => { subCat(s).subcats[0] = '   '; }, refs: (s) => { const c = subCat(s); c.subcats = [...c.subcats, 'NeverUsed']; } },
    'structure.extra_categories':     { invalid: NA('covered per element and by duplicate'), refs: (s) => { s.structure.extra_categories = [...s.structure.extra_categories, 'GhostCat']; } },
    'structure.extra_categories[]':   { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure.extra_categories[0] = '   '; }, refs: (s) => { s.structure.extra_categories = [...s.structure.extra_categories, 'GhostCat']; } },
    'structure.item_order':     { invalid: (s) => { s.structure.item_order.pop(); }, refs: (s) => { s.structure.item_order[0] = 'ghost_item'; } },
    'structure.item_order[]':   { absent: NA('an element cannot be absent; a short list is the invalid case above'), invalid: (s) => { s.structure.item_order[0] = '   '; }, refs: (s) => { s.structure.item_order[0] = 'ghost_item'; } },
    'structure.variant_items':  { absent: NA('optional — a menu may have no variant dishes at all'), invalid: NA('covered by the per-member paths enumerated beneath this one'), refs: (s) => { s.structure.variant_items = { ghost_launcher: { label: 'X', variantIds: ['noodle_01_sin'] } }; } },
    'structure.variant_items.*':          { absent: NA('removing a launcher is covered by variant coverage, which then reports its orphans'), invalid: NA('covered by the per-member paths enumerated beneath this one'), refs: NA('the launcher key is covered by the map-level refs plant') },
    'structure.variant_items.*.label':    { invalid: (s) => { spec(s).label = '   '; }, refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { spec(s).label = XSS; } },
    'structure.variant_items.*.variantIds':   { invalid: (s) => { spec(s).variantIds = []; }, refs: (s) => { spec(s).variantIds.push('no_such_variant'); } },
    'structure.variant_items.*.variantIds[]': { absent: NA('an element cannot be absent; an empty list is the invalid case above'), invalid: (s) => { spec(s).variantIds[0] = '   '; }, refs: (s) => { spec(s).variantIds[0] = 'no_such_variant'; } },
    'structure.badges':         { absent: NA('optional — a brand with no badge system declares none'), invalid: NA('covered by the per-definition paths enumerated beneath this one'), refs: NA('the collection names nothing; tags reference INTO it') },
    'structure.badges.*':       { absent: NA('a brand may define fewer badges; removing one only matters if a tag names it'), invalid: (s) => { s.structure.badges.ghost_badge = {}; s.items[0].display.tags = ['ghost_badge']; }, refs: NA('a badge definition is content; tags reference INTO it, not out') },
    'structure.badges.*.label': { invalid: (s) => { badge(s).label = '   '; }, refs: NA('this value is content, not a reference to another catalog entity'), unsafe: (s) => { badge(s).label = XSS; } },
    'structure.badges.*.cls':   { invalid: (s) => { badge(s).cls = 'x"onload="alert(1)'; }, refs: NA('this value is content, not a reference to another catalog entity') },
    'structure.extras_by_category':     { absent: NA('optional — a brand may expose extras without a category map'), invalid: NA('covered by the per-entry paths enumerated beneath this one'), refs: (s) => { s.structure.extras_by_category = { ghost_cat: [s.structure.extra_categories[0]] }; } },
    'structure.extras_by_category.*':   { absent: NA('a category exposing no extras is legitimate — unmapped categories expose nothing today'), invalid: NA('covered per element and by duplicate'), refs: (s) => { s.structure.extras_by_category[cat0(s).id] = ['Ghost']; } },
    'structure.extras_by_category.*[]': { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure.extras_by_category[Object.keys(s.structure.extras_by_category)[0]] = ['   ']; }, refs: (s) => { s.structure.extras_by_category[Object.keys(s.structure.extras_by_category)[0]] = ['Ghost']; } },
    'structure.extras_by_item':         { absent: NA('optional — per-item exposure overrides are rare'), invalid: NA('covered by the per-entry paths enumerated beneath this one'), refs: (s) => { s.structure.extras_by_item = { ghost_item: [s.structure.extra_categories[0]] }; } },
    'structure.extras_by_item.*':       { absent: NA('an item with no per-item override is the ordinary case, not an error'), invalid: NA('covered per element and by duplicate'), refs: (s) => { s.structure.extras_by_item[Object.keys(s.structure.extras_by_item)[0]] = ['Ghost']; } },
    'structure.extras_by_item.*[]':     { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure.extras_by_item[Object.keys(s.structure.extras_by_item)[0]] = ['   ']; }, refs: (s) => { s.structure.extras_by_item[Object.keys(s.structure.extras_by_item)[0]] = ['Ghost']; } },
  };
  for (const f of ['pickup_only_cats', 'weekend_only_cats', 'redeem_eligible_cats']) {
    CONTRACT[`structure.${f}`] = { absent: NA('optional — a brand may gate nothing'), invalid: NA('covered per element and by duplicate'), refs: (s) => { s.structure[f] = ['ghost_cat']; } };
    CONTRACT[`structure.${f}[]`] = { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure[f] = ['   ']; }, refs: (s) => { s.structure[f] = ['ghost_cat']; } };
  }
  CONTRACT['structure.redeem_eligible_items'] = { absent: NA('optional — a brand may declare no redemption allowlist at all'), invalid: NA('covered per element'), refs: (s) => { s.structure.redeem_eligible_items = ['ghost_item']; } };
  CONTRACT['structure.redeem_eligible_items[]'] = { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure.redeem_eligible_items = ['   ']; }, refs: (s) => { s.structure.redeem_eligible_items = ['ghost_item']; } };
  CONTRACT['structure.redeem_eligible_extras'] = { absent: NA('optional — a brand may declare no redemption allowlist at all'), invalid: NA('covered per element'), refs: (s) => { s.structure.redeem_eligible_extras = ['ghost_extra']; } };
  CONTRACT['structure.redeem_eligible_extras[]'] = { absent: NA('an element cannot be absent'), invalid: (s) => { s.structure.redeem_eligible_extras = ['   ']; }, refs: (s) => { s.structure.redeem_eligible_extras = ['ghost_extra']; } };

  const rekey = (s) => { s.items[0].key = pkeyOf(s.restaurant_id, s.items[0].display); s.structure.item_order[0] = s.items[0].key; };
  const withSub = (s) => s.items.find((i) => i.display.subcat);
  const variantItem = (s) => s.items.find((i) => i.display.variantOf != null);
  const cat0 = (s) => s.structure.categories[0];
  const subCat = (s) => s.structure.categories.find((c) => Array.isArray(c.subcats) && c.subcats.length);
  const spec = (s) => s.structure.variant_items[Object.keys(s.structure.variant_items)[0]];
  const badge = (s) => s.structure.badges[Object.keys(s.structure.badges)[0]];

  // Two forms that ONLY their own rule refuses. Both were reported by the gate, and both survived
  // mutation while every other plant for the same field was caught by a neighbouring rule.
  CONTRACT['structure.variant_items.*.variantIds[]'].wrapped = (s) => {
    // `[id]` stringifies to exactly the same text as `id`, so any String()-based comparison accepts
    // it — while the renderer matches strictly (`p.id === vid`) and drops the choice silently.
    const sp = s.structure.variant_items[Object.keys(s.structure.variant_items)[0]];
    sp.variantIds[0] = [sp.variantIds[0]];
  };
  CONTRACT['structure.badges.*'].definedButUnselectable = (s) => {
    // A well-formed ghost definition that NOTHING tags. Only the definition-set rule can refuse it —
    // the tag rule has nothing to look at — so this is what separates the two.
    s.structure.badges.ghost_badge = { label: 'Ghost', cls: 'menu-badge--jade' };
  };
  CONTRACT['structure.badges.*'].notRendererSelectable = (s) => {
    // A WELL-FORMED definition the renderer can never select. Every other badge plant is malformed,
    // so it is caught by the record rules and the contract rule is never the thing standing there —
    // this one has a real label and class and is still refused, because the badge set is the
    // renderer's to decide and not this document's.
    s.structure.badges.ghost_badge = { label: 'Ghost', cls: 'menu-badge--jade' };
    s.items[0].display.tags = ['ghost_badge'];
  };
  CONTRACT['structure.badges.*'].nullDefinition = (s) => {
    // A null definition used to reach `def.label` and crash rather than reject. A validator that
    // throws a TypeError has still failed closed, but it has stopped explaining itself.
    s.structure.badges[Object.keys(s.structure.badges)[0]] = null;
  };

  // 🔴 TWO MODES THE FIRST CENSUS COULD NOT EXPRESS, and the class each one catches:
  //
  //   nullValue        — present, but written as null. Absent and null were treated as the same thing,
  //                      so a present-null collection passed the type gate and crashed on traversal.
  //   collectionAbsent — the field deleted from EVERY record of its type, not just the first. This is
  //                      the whole-collection gap: a rule that infers requiredness from what the
  //                      submission still has is satisfied by removing all of it. Deleting one La Musa
  //                      category name was refused; deleting them all was accepted.
  const MODES = ['absent', 'wrongType', 'nullValue', 'invalid', 'refs', 'duplicate', 'collectionAbsent'];

  // Delete the leaf from every element of the collection the path names, not just the located one.
  const stripAll = (source, path) => {
    const cut = path.lastIndexOf('.');
    if (cut === -1) return false;
    const container = path.slice(0, cut);
    const leaf = path.slice(cut + 1);
    if (leaf.endsWith('[]') || !/\[\]|\.\*/.test(container)) return false;   // not a per-record field
    const each = (node, segs) => {
      if (segs.length === 0) { if (node && typeof node === 'object') delete node[leaf]; return; }
      const [seg, ...rest] = segs;
      const m = /^([^[]*)((?:\[\])*)$/.exec(seg);
      let cur = m[1] === '*' ? node : (m[1] ? node[m[1]] : node);
      if (m[1] === '*') { for (const k of Object.keys(node)) each(node[k], rest); return; }
      if (cur == null) return;
      if (m[2]) { for (const el of cur) each(el, rest); return; }
      each(cur, rest);
    };
    each(source, container.split('.'));
    return true;
  };
  for (const rid of ['x_pizza', 'la_musa']) {
    const seed = buildSourceFromCode(rid);
    const found = new Set(); walk(seed, '', found);
    const paths = [...found].sort();

    const unruled = paths.filter((p) => !Object.prototype.hasOwnProperty.call(CONTRACT, p));
    assert.deepStrictEqual(unruled, [], `${rid} — paths in the real seed with no contract entry:\n    ${unruled.join('\n    ')}`);

    let planted = 0; let exempt = 0;
    for (const path of paths) {
      const entry = CONTRACT[path];
      for (const mode of MODES) {
        let plant = entry[mode];
        // GENERIC plants, so the three mechanical modes can never be forgotten.
        if (plant === undefined) {
          if (mode === 'absent') plant = (s) => { const l = locate(s, path); delete l.parent[l.key]; };
          else if (mode === 'wrongType') plant = (s) => { const l = locate(s, path); l.parent[l.key] = WRONG(l.value); };
          else if (mode === 'nullValue') plant = (s) => { const l = locate(s, path); l.parent[l.key] = null; };
          else if (mode === 'collectionAbsent') {
            // Only meaningful for a field that lives on every record of a collection.
            const probe = buildSourceFromCode(rid);
            if (!stripAll(probe, path)) { exempt++; continue; }
            plant = (s) => { stripAll(s, path); };
          }
          else if (mode === 'duplicate') {
            // Only an ARRAY can carry the same entry twice. Object keys are unique by construction, so
            // for a map this mode is not an exemption anyone chose — it is not expressible.
            if (!Array.isArray(locate(seed, path).value)) { exempt++; continue; }
            plant = (s) => { const l = locate(s, path); l.parent[l.key] = [...l.value, l.value[0]]; };
          }
        }
        if (plant && plant.exempt) { assert.ok(plant.exempt.length > 15, `${rid} — ${path}/${mode}: exemption needs a reason`); exempt++; continue; }
        assert.ok(typeof plant === 'function', `🔴 ${rid} — ${path} declares no outcome for '${mode}' (plant it, or state why it cannot apply)`);
        const s = buildSourceFromCode(rid);
        try { plant(s); } catch (e) { assert.fail(`${rid} — plant ${path}/${mode} could not be applied: ${e.message}`); }
        let threw = null;
        try { validateSource(s, rid); } catch (e) { threw = e; }
        assert.ok(threw, `🔴 ${rid} — ${path} with a ${mode} value was ACCEPTED`);
        // 🔴 AND IT MUST REJECT CLEANLY. A TypeError from reading a property off null is still a
        // closed door, but it has stopped saying what is wrong — and it hid a missing rule, because
        // "it threw" was all the census asked for.
        assert.match(threw.message, /source_malformed|display_unsafe/,
          `🔴 ${rid} — ${path}/${mode} CRASHED instead of rejecting: ${threw.message}`);
        planted++;
      }
      // any extra named plants (unsafe*, etc.) run too
      for (const [k, plant] of Object.entries(entry)) {
        if (MODES.includes(k) || typeof plant !== 'function') continue;
        const s = buildSourceFromCode(rid);
        plant(s);
        let threw = null;
        try { validateSource(s, rid); } catch (e) { threw = e; }
        assert.ok(threw, `🔴 ${rid} — ${path} with a ${k} value was ACCEPTED`);
        assert.match(threw.message, /source_malformed|display_unsafe/,
          `🔴 ${rid} — ${path}/${k} CRASHED instead of rejecting: ${threw.message}`);
        planted++;
      }
    }
    // 🔴 THE CENSUS MUST NOTICE ITS OWN WEAKENING. Deleting a generic plant, or making `locate` stop
    // choosing a record that carries the field, removes coverage without failing anything — the
    // census would simply do less and still report success. Pinning the counts makes any reduction a
    // build failure, and any genuine addition a deliberate edit.
    const EXPECTED = { x_pizza: { paths: 36, planted: 163, exempt: 94 }, la_musa: { paths: 60, planted: 260, exempt: 172 } }[rid];
    assert.strictEqual(paths.length, EXPECTED.paths, `${rid} — path count moved; the walker or the seed changed`);
    assert.strictEqual(planted, EXPECTED.planted, `${rid} — plant count moved (got ${planted}); coverage was added or removed`);
    // The EXEMPTION count is pinned too. Only the plants were, so an exemption could be added — turning
    // a tested mode into a stated one — and the plant count would fall by exactly as much as the
    // exemption count rose, with only one of the two numbers being watched.
    assert.strictEqual(exempt, EXPECTED.exempt, `${rid} — exemption count moved (got ${exempt}); a mode was excused or un-excused`);
    ok(`${rid}: ${paths.length} paths, ${planted} plants all refused, ${exempt} stated exemptions`);
  }

  // The unruled-path check is the census's own backstop, and nothing proved it fires. A comparison of
  // two empty arrays passes forever.
  {
    const seed = buildSourceFromCode('la_musa');
    seed.items[0].display.someNewField = 'x';
    seed.structure.badges.some_new_badge = { label: 'L', cls: 'c', extraField: 1 };
    const found = new Set(); walk(seed, '', found);
    const unruled = [...found].filter((p) => !Object.prototype.hasOwnProperty.call(CONTRACT, p)).sort();
    assert.deepStrictEqual(unruled, ['items[].display.someNewField', 'structure.badges.*.extraField'],
      'the unruled-path detector finds a new field at any depth, including inside a nested map');
    ok('the census detects an unruled path — including a nested one');
  }

  for (const rid of ['x_pizza', 'la_musa']) {
    assert.doesNotThrow(() => validateSource(buildSourceFromCode(rid), rid), `${rid} still validates`);
  }
  ok('both real menus still PASS with the complete rule set');
}

// ── A TAG ANSWERS TO THE RENDERER, NOT TO THE DOCUMENT ────────────────────────────────────────────
// 🔴 THE ACCEPTANCE HALF of the badge rule, and the reason it needs its own fixture: every other
// badge test asserts a REJECTION, and a rule that only ever rejects is satisfied by a rule that
// rejects more.
//
// Swapping `contract.badges` for the source's own keys survives every rejection test, because the
// declared definitions are bound to the contract set — which makes the source's keys a SUBSET, not
// an equal. The two answers only come apart on a tag naming a badge the renderer CAN select that
// this document never declared, and that case is legal: the badge set is a fact about the shipped
// form, so a merchant who deletes a definition has not deleted the renderer's ability to show it.
//
// This was written down in-source as an "equivalent mutant" for a round. It is not equivalent; it
// is killable, and this is the fixture that kills it.
{
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  const source = buildSourceFromCode('la_musa');
  const tagged = source.items.filter((i) => Array.isArray(i.display.tags) && i.display.tags.length);
  assert.ok(tagged.length > 0, 'premise: the real menu actually uses tags');
  const declared = Object.keys(source.structure.badges || {});
  assert.ok(tagged.some((i) => i.display.tags.some((t) => declared.includes(t))),
    'premise: and the tags it uses ARE declared today — so undeclaring them is the discriminating move');

  const undeclared = JSON.parse(JSON.stringify(source));
  undeclared.structure.badges = {};                      // the merchant deleted every definition...
  assert.doesNotThrow(() => validateSource(undeclared, 'la_musa'),
    '🔴 a tag naming a badge the SHIPPED RENDERER can select must be accepted even when this document declares none of them');

  // ...and the rejection half still holds, so the rule did not simply get looser.
  const ghost = JSON.parse(JSON.stringify(source));
  ghost.items.find((i) => i.key === tagged[0].key).display.tags = ['not_a_real_badge'];
  assert.throws(() => validateSource(ghost, 'la_musa'), /is not a badge the renderer can select/,
    'a tag the renderer cannot select is still refused');
  ok('badge tags answer to the RENDERER contract: an undeclared-but-selectable badge is accepted, an unselectable one is refused');
}

// ═══ THE PREDICATE CENSUS — deny by default ═════════════════════════════════════════════════════
// The rule: a presence / emptiness test may gate REQUIREDNESS only. A present value is always
// type-validated.
//
// 🔴 THREE ATTEMPTS AT ENUMERATING THE THINGS TO CLASSIFY, and the first two failed the same way. A
// regex could not see truthiness, spacing, multi-line tests or non-`if` guards. An AST scanner that
// recorded only predicates matching RECOGNISED presence shapes was no better: a spelling the list did
// not anticipate — `!!x`, `Boolean(x)`, `x?.y`, `x.length > 0`, `return x && f(x)`, a comma compound —
// was not judged safe, it was never seen. A whitelist of recognised shapes fails open on everything
// outside it, which is the very defect this audit exists to prevent, one level up.
//
// So the scanner decides NOTHING. Every control predicate acorn yields — every if / ternary / while /
// for test, and every standalone && || ?? — is enumerated, and a human rules each one:
//
//     requiredness        gates only whether a value must be there
//     post-type           runs after the value has been type-validated
//     shape               IS the type test
//     not-a-presence-test an ordinary value or business comparison
//
// A predicate with no ruling fails the build, so an ordinary presence guard cannot be written without
// someone classifying it.
//
// 🔴 AND THAT IS WHERE THIS STOPS. It is a strong LINT over predicate nodes, not a proof that no
// validation is gated on presence. Gating through something that is not a predicate —
// `[x].filter(Boolean).forEach(validate)`, `void (x && f(x))`, `x &&= f(x)`,
// `switch (Boolean(x))` — is out of scope by design, because closing each form only suggests the
// next one. The residual is covered where it actually matters: the FIELD CENSUS above plants seven
// kinds of wrong value into every field of the real seed and requires each to be refused, which
// tests behaviour and does not care how a rule is spelled. Read this as a lint. Do not mistake it
// for a guarantee and reopen the chase.
{
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const { enumeratePredicates, calleeName, runtimeImportGraph } = require('./guard-ast');

  const RULINGS = [
    ['canonicalize :: Array.isArray(value)', 'shape', 'this predicate IS the type test'],
    ["canonicalize :: value && typeof value === 'object'", 'shape', 'this predicate IS the type test'],
    ["<module> :: ts && typeof ts.seconds === 'number'", 'shape', 'this predicate IS the type test'],
    ['<module> :: ts.nanoseconds', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['<module> :: Number.isInteger(p)', 'shape', 'this predicate IS the type test'],
    ['contractTable :: CONTRACT_TABLE', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ["contractTable :: !table || typeof table !== 'object' || Array.isArray(table)", 'shape', 'this predicate IS the type test'],
    ['rendererContract :: !Object.prototype.hasOwnProperty.call(table, rid)', 'requiredness', 'own-property membership separates undescribed from present-but-broken'],
    ["rendererContract :: !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.categoriesNamed !== 'boolean' || !Array.isArray(entry.badges)", 'shape', 'this predicate IS the type test'],
    ["<module> :: typeof v === 'string'", 'shape', 'this predicate IS the type test'],
    ["<module> :: typeof v === 'number' && Number.isFinite(v)", 'shape', 'this predicate IS the type test'],
    ['<module> :: isPositiveInt(v)', 'shape', 'this predicate IS the type test'],
    ["<module> :: typeof v === 'boolean'", 'shape', 'this predicate IS the type test'],
    ["<module> :: v && typeof v === 'object' && !Array.isArray(v)", 'shape', 'this predicate IS the type test'],
    ['<module> :: Array.isArray(v)', 'shape', 'this predicate IS the type test'],
    ["<module> :: Array.isArray(v) && v.every((x) => typeof x === 'string')", 'shape', 'this predicate IS the type test'],
    ["<module> :: typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))", 'shape', 'this predicate IS the type test'],
    ['checkField :: value === undefined', 'requiredness', 'THE mechanism: undefined is absent, everything else is typed below — null included'],
    ['checkField :: rule.required', 'requiredness', 'reads the field rule to decide whether absence is an error'],
    ['checkField :: typeReason', 'post-type', 'reports or dispatches on a check that has already run'],
    ["checkField :: rule.nonEmpty && typeof value === 'string' && !value.trim()", 'shape', 'this predicate IS the type test'],
    ['checkField :: rule.enum && !rule.enum.includes(value)', 'post-type', 'membership, asked after the value has been typed'],
    ['checkField :: rule.unique && Array.isArray(value) && new Set(value).size !== value.length', 'shape', 'this predicate IS the type test'],
    ['checkField :: rule.sink', 'post-type', 'reports or dispatches on a check that has already run'],
    ['checkField :: unsafe', 'post-type', 'reports or dispatches on a check that has already run'],
    ['<module> :: pricingKeyOf(rid, { id: ID_S, name: NAME_S }) === ID_S', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ["validateSource :: !source || typeof source !== 'object'", 'shape', 'this predicate IS the type test'],
    ['validateSource :: source.restaurant_id !== rid', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: !Array.isArray(source.items) || source.items.length === 0', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !Array.isArray(source.extras)', 'shape', 'this predicate IS the type test'],
    ["validateSource :: !st || typeof st !== 'object'", 'shape', 'this predicate IS the type test'],
    ['validateSource :: !Array.isArray(st.categories) || st.categories.length === 0', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !Array.isArray(st.item_order)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: c', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: catIds.size !== st.categories.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: c #2', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: c #3', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: Array.isArray(c.subcats)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: unsafe', 'post-type', 'reports or dispatches on a check that has already run'],
    ["validateSource :: !it || typeof it !== 'object'", 'shape', 'this predicate IS the type test'],
    ["validateSource :: typeof it.key !== 'string' || !it.key", 'shape', 'this predicate IS the type test'],
    ['validateSource :: !isPositiveInt(it.price)', 'shape', 'this predicate IS the type test'],
    ["validateSource :: !it.display || typeof it.display !== 'object'", 'shape', 'this predicate IS the type test'],
    ['validateSource :: derived !== it.key', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: seen.has(it.key)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: it.display.cat != null && !catIds.has(it.display.cat)', 'post-type', 'membership, asked after the value has been typed'],
    ["validateSource :: !ex || typeof ex.key !== 'string' || !ex.key", 'shape', 'this predicate IS the type test'],
    ['validateSource :: !isPositiveInt(ex.price)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: eseen.has(ex.key)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: ex.display', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: derived !== ex.key', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: i.display', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: !catIds.has(c)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: source.schema_version !== SCHEMA_VERSION', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: d.price !== it.price', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ["validateSource :: d.variantOf != null && (typeof d.choice !== 'string' || !d.choice.trim())", 'requiredness', 'being a variant is what makes a choice label required'],
    ['validateSource :: uiIds.has(uid)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: c #4', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: Array.isArray(c && c.subcats)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: c #5', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: declared && declared.length', 'requiredness', 'whether the category GROUPS decides whether a subcat is required'],
    ['validateSource :: sub == null', 'requiredness', 'absence decides whether a dependent field is required; the value itself is typed by its record rules'],
    ['validateSource :: !declared.includes(sub)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: sub != null', 'requiredness', 'absence decides whether a dependent field is required; the value itself is typed by its record rules'],
    ['validateSource :: Array.isArray(extraCats)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !c.trim()', 'post-type', 'blankness, asked after the value is known to be a string'],
    ['validateSource :: source.extras.length > 0 && extraCats.length === 0', 'requiredness', 'emptiness decides only that the namespace must be non-empty; the value is typed unconditionally above'],
    ['validateSource :: Array.isArray(extraCats) #2', 'shape', 'this predicate IS the type test'],
    ['validateSource :: ex.display.price !== ex.price', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: !extraCatSet.has(ex.display.cat)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: extraUiIds.has(euid)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: extraCatSet.has(v)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: map === undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !legalExposureValue(v)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.variant_items === undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !byUiId.has(String(launcherId))', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: spec', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: !Array.isArray(ids) || ids.length === 0', 'shape', 'this predicate IS the type test'],
    ['validateSource :: spec #2', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
            ["validateSource :: spec && Object.prototype.hasOwnProperty.call(spec, 'basePrice')", 'not-a-presence-test', 'asks whether a DERIVED value has been authored AT ALL — the key\u2019s presence IS the defect being reported, not a gate on validating anything'],
    ['validateSource :: desde == null', 'post-type', 'the derivation result, after every variant has been typed — a launcher with no derivable starting price'],
    ["validateSource :: typeof v !== 'string' && typeof v !== 'number'", 'shape', 'this predicate IS the type test'],
    ['validateSource :: Array.isArray(v)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: String(v) === String(launcherId)', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: !item', 'post-type', 'a negated check over an already-typed value'],
    ['validateSource :: claimed.has(String(v))', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: String(parent) !== String(launcherId)', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: parent == null', 'requiredness', 'absence decides whether a dependent field is required; the value itself is typed by its record rules'],
    ['validateSource :: !claimed.has(String(it.display.id))', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: cur && cur.display.variantOf != null', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: seenPath.has(id)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.badges !== undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: st.badges !== undefined #2', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !contract.badges.has(k)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: Array.isArray(it.display.tags)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !badgeKeys.has(t)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: e.display', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: Array.isArray(extraCats) #3', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !usedExtraCats.has(c)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: !usedCatIds.has(c.id)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: !Array.isArray(c.subcats)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: !usedSubs.has(sc)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: c #6', 'post-type', 'a lookup result or an already-validated record; absence here is refused by its own rule'],
    ['validateSource :: new Set(st.item_order).size !== st.item_order.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: !seen.has(k)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.item_order.length !== source.items.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: arr === undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !catIds.has(c) #2', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.redeem_eligible_cats !== undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !Array.isArray(st.redeem_eligible_cats)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: new Set(st.redeem_eligible_cats).size !== st.redeem_eligible_cats.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: !catIds.has(c) #3', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.redeem_eligible_extras !== undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !Array.isArray(st.redeem_eligible_extras)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: new Set(st.redeem_eligible_extras).size !== st.redeem_eligible_extras.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: source.extras', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: e', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: !extraKeys.has(k)', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.redeem_eligible_items !== undefined', 'requiredness', 'undefined only; a present value (null included) reaches its type check'],
    ['validateSource :: !Array.isArray(st.redeem_eligible_items)', 'shape', 'this predicate IS the type test'],
    ['validateSource :: new Set(st.redeem_eligible_items).size !== st.redeem_eligible_items.length', 'post-type', 'a count over an already-typed collection'],
    ['validateSource :: !seen.has(k) #2', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.extras_by_category', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: !catIds.has(c) #4', 'post-type', 'membership, asked after the value has been typed'],
    ['validateSource :: st.extras_by_item', 'not-a-presence-test', 'an ordinary value or business comparison — it asks what a value IS, never whether it is there'],
    ['validateSource :: !seen.has(k) #3', 'post-type', 'membership, asked after the value has been typed'],
    ['sourceToBuildInputs :: source.structure[f] !== undefined', 'post-type', 'sourceToBuildInputs runs on an ALREADY VALIDATED source; it maps, it does not check'],
    ['sourceToBuildInputs :: Array.isArray(source.extras) && source.extras.some((e) => e.display)', 'shape', 'this predicate IS the type test'],
    ['readSource :: !snap || !snap.exists', 'post-type', 'a negated check over an already-typed value'],
  ];
  const RULED = new Map(RULINGS.map(([k, kind, why]) => [k, { kind, why }]));

  // canonicalize MOVED to canonical-json.js (one definition, shared with the version content hash).
  // The census follows it rather than shrinking: a predicate that leaves this file has not stopped
  // being part of the validator's control flow, and a census that quietly covers less than it did is
  // the same failure as a census that never covered it.
  const preds = [
    ...enumeratePredicates(readFileSync(join(__dirname, 'source-store.js'), 'utf8')),
    ...enumeratePredicates(readFileSync(join(__dirname, 'canonical-json.js'), 'utf8')),
  ];
  assert.strictEqual(preds.length, 129, `predicate count moved (got ${preds.length}); a control predicate was added or removed`);

  const unruled = preds.filter((p) => !RULED.has(p.key)).map((p) => `${p.line}: ${p.key}`);
  assert.deepStrictEqual(unruled, [],
    `🔴 control predicates with no ruling. Every one must be classified — requiredness / post-type / shape / not-a-presence-test — because a predicate nobody rules is a presence guard nobody checked:\n    ${unruled.join('\n    ')}`);
  const dead = [...RULED.keys()].filter((k) => !preds.some((p) => p.key === k));
  assert.deepStrictEqual(dead, [], `rulings for predicates that no longer exist:\n    ${dead.join('\n    ')}`);
  const KINDS = ['requiredness', 'post-type', 'shape', 'not-a-presence-test'];
  for (const [k, { kind, why }] of RULED) {
    assert.ok(KINDS.includes(kind), `${k}: unknown ruling ${kind}`);
    assert.ok(why && why.length > 25, `${k}: a ruling needs a reason`);
  }
  const counts = {};
  for (const p of preds) counts[RULED.get(p.key).kind] = (counts[RULED.get(p.key).kind] || 0) + 1;
  assert.deepStrictEqual(counts, { requiredness: 17, 'post-type': 56, shape: 42, 'not-a-presence-test': 14 },
    'the mix of rulings moved — a predicate changed meaning, which is a thing to look at rather than re-pin');
  ok(`all ${preds.length} control predicates ruled (${counts.requiredness} requiredness, ${counts['post-type']} post-type, ${counts.shape} shape, ${counts['not-a-presence-test']} not-a-presence-test)`);

  // ── THE SIX BYPASS SPELLINGS, each planted as a validation-gating guard ───────────────────────
  {
    const BYPASSES = {
      'length comparison':   'function f(x){ if (x.length > 0) { validate(x); } }',
      'double negation':     'function f(x){ if (!!x) { validate(x); } }',
      'Boolean() coercion':  'function f(x){ if (Boolean(x)) { validate(x); } }',
      'optional chaining':   'function f(x){ if (x?.y) { validate(x); } }',
      'return short-circuit':'function f(x){ return x && validate(x); }',
      'comma compound':      'function f(x){ if ((log(x), x !== undefined)) { validate(x); } }',
      // and the ones the regex could not see, kept as regressions
      'bare truthiness':     'function f(x){ if (x) { validate(x); } }',
      'no spacing':          'function f(x){ if(x!==undefined){ validate(x); } }',
      'multiline test':      'function f(x){ if (\n  x !==\n  undefined\n) { validate(x); } }',
      'ternary guard':       'function f(x){ const y = x ? validate(x) : null; return y; }',
      'nested in a callback':'function f(a){ a.forEach(function (x) { if (x.length) { validate(x); } }); }',
    };
    for (const [label, code] of Object.entries(BYPASSES)) {
      const found = enumeratePredicates(code);
      assert.ok(found.length >= 1, `🔴 the scanner missed a ${label} guard — an unseen predicate is an unruled one`);
      assert.ok(found.every((g) => !RULED.has(g.key)),
        `🔴 a planted ${label} guard is not accidentally covered by an existing ruling — it would fail the build, as it must`);
    }
    ok(`all ${Object.keys(BYPASSES).length} bypass spellings are seen by the scanner and would fail the build unruled`);
  }

  // ── CALLEES RESOLVED EXACTLY, not by substring ────────────────────────────────────────────────
  {
    const nameOf = (code) => {
      const { parse } = require('acorn');
      let out = null;
      const walk = (n) => { if (n.type === 'CallExpression' && !out) out = calleeName(n); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && c.type && walk(c)); else if (v && v.type) walk(v); } };
      walk(parse(code, { ecmaVersion: 'latest' }));
      return out;
    };
    assert.strictEqual(nameOf('Array.isArray(x)'), 'Array.isArray', 'the real callee resolves whole');
    assert.strictEqual(nameOf('isArrayOfValidPrices(x)'), 'isArrayOfValidPrices',
      '🔴 a DIFFERENT function whose name merely contains "isArray" resolves as itself, not as Array.isArray');
    assert.strictEqual(nameOf('Object.prototype.hasOwnProperty.call(o, k)'), 'Object.prototype.hasOwnProperty.call', 'dotted callees resolve in full');
    assert.strictEqual(nameOf('o[k]()'), null, 'a computed callee has no static name, and is not guessed at');
    ok('callees resolve exactly — a substring match would have read isArrayOfValidPrices as Array.isArray');
  }
}

// ═══ acorn IS TEST-ONLY, ACROSS THE WHOLE RUNTIME IMPORT GRAPH ═══════════════════════════════════
{
  // Firebase deploys production dependencies only, so a parser in `dependencies` would ship to every
  // function invocation for no runtime purpose. Checking the immediate catalog files was not enough:
  // a module the runtime loads could reach acorn through something IT requires, several hops away.
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const { runtimeImportGraph } = require('./guard-ast');
  const root = join(__dirname, '..');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  assert.ok(!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'acorn'),
    '🔴 acorn must NOT be a runtime dependency — it would ship to every deployed function');
  assert.ok(Object.prototype.hasOwnProperty.call(pkg.devDependencies || {}, 'acorn'),
    'acorn is a devDependency, so CI can parse and the runtime never sees it');

  // Follow every require from the deployed entrypoint, transitively.
  const graph = runtimeImportGraph(['index.js'], root);
  assert.ok(graph.files.length > 20, `sanity: the import graph was actually walked (${graph.files.length} modules)`);
  // 🔴 NON-VACUITY. "acorn is not in the externals list" passes trivially if the walk never collects
  // externals at all — mutation testing found exactly that. The list must be shown to contain the
  // packages the runtime genuinely uses before its NOT containing acorn means anything.
  for (const known of Object.keys(pkg.dependencies || {})) {
    assert.ok(graph.externals.includes(known), `the import graph really collects externals — it must see ${known}`);
  }
  assert.ok(!graph.externals.includes('acorn'),
    `🔴 acorn is reachable from the deployed entrypoint through: ${graph.files.filter((f) => /guard-ast/.test(f)).join(', ') || 'a transitive require'}`);
  assert.ok(!graph.files.some((f) => /guard-ast/.test(f)),
    '🔴 the guard harness itself is reachable from the runtime — it requires acorn');
  // 🔴 AN EDGE THAT CANNOT BE FOLLOWED IS A FAILURE, NOT AN ENDING. Resolution used to accept a bare
  // directory path, fail to read it as a file, and return — so `require('./somedir')` terminated that
  // branch of the walk in silence, and anything beyond it was "not reachable" only because nobody
  // looked. An unfollowable edge is exactly where something unexpected would hide.
  assert.deepStrictEqual(graph.unresolved, [], `🔴 import edges the walk could not follow:\n    ${graph.unresolved.join('\n    ')}`);
  assert.deepStrictEqual(graph.dynamic, [], `🔴 computed require() calls the walk cannot follow:\n    ${graph.dynamic.join('\n    ')}`);
  ok(`acorn is test-only across the whole runtime import graph (${graph.files.length} modules followed, ${graph.externals.length} externals, 0 unfollowable edges)`);

  // ── the two discovery bugs, as regressions ────────────────────────────────────────────────────
  {
    const { mkdtempSync, writeFileSync, mkdirSync } = require('fs');
    const { tmpdir } = require('os');
    const dir = mkdtempSync(join(tmpdir(), 'graph-'));
    // 1. `require ('acorn')` — a space before the paren. The old regex demanded `require(` and so
    //    could not see this at all; imports are read from the syntax tree now.
    writeFileSync(join(dir, 'spaced.js'), "const a = require ('acorn');\nmodule.exports = a;\n");
    const spaced = runtimeImportGraph(['spaced.js'], dir);
    assert.ok(spaced.externals.includes('acorn'), '🔴 `require (\'acorn\')` with a space is discovered');
    // 2. a require of a DIRECTORY. The old resolution accepted the directory path, failed to read it
    //    as a file, and returned — swallowing everything beyond it.
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'index.js'), "module.exports = require('acorn');\n");
    writeFileSync(join(dir, 'viaDir.js'), "module.exports = require('./sub');\n");
    const viaDir = runtimeImportGraph(['viaDir.js'], dir);
    assert.ok(viaDir.externals.includes('acorn'), '🔴 a require of a DIRECTORY is followed into its index.js');
    assert.deepStrictEqual(viaDir.unresolved, [], 'and it resolves cleanly rather than being swallowed');
    // 3. an edge that genuinely cannot resolve must FAIL, not end the walk quietly.
    writeFileSync(join(dir, 'broken.js'), "module.exports = require('./does-not-exist');\n");
    const broken = runtimeImportGraph(['broken.js'], dir);
    assert.strictEqual(broken.unresolved.length, 1, '🔴 an unresolvable edge is REPORTED, not swallowed');
    // 4. a computed specifier cannot be followed, so it is reported too.
    writeFileSync(join(dir, 'dyn.js'), "const n = 'acorn';\nmodule.exports = require(n);\n");
    assert.strictEqual(runtimeImportGraph(['dyn.js'], dir).dynamic.length, 1, '🔴 a computed require is REPORTED');
    ok('the import walk sees spaced requires, follows directory requires, and refuses to swallow an edge it cannot resolve');
  }
}
