// Portal 2b-2b Task 3 — the edit state. Run: node --test xpizza-portal/editor.test.mjs
//
// 🔴 MONEY. This module holds the merchant's uncommitted price changes and produces the source
// document that editCatalog validates and publishEdited publishes. Everything a customer is charged
// for a changed dish passes through here first.
//
// Three properties carry it:
//
//   THE DRAFT IS A SOURCE DOCUMENT, not a view model. The mock keeps {sections, groups} — a demo shape.
//   What editCatalog sends is `body.source`, and validateSource checks THAT. A separate edit model
//   would have to be translated back, and the translation is where a price goes missing.
//
//   price AND display.price MOVE TOGETHER. validateSource fails a source whose display.price disagrees
//   with its authoritative price, so an edit that updated one and not the other is unpublishable —
//   and it fails at the server, after the merchant thought they were done.
//
//   A NON-PRICE IS NOT A PRICE. isPositiveInt is the server's rule; "12.5", "12abc" and "" are not
//   prices, and silently turning them into 12 or 0 would charge a customer a number nobody typed.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  createDraft, setItemPrice, setExtraPrice, pendingChanges, pendingCount,
  isPublishable, invalidKeys, discard, draftSource, parsePrice,
} from './editor.js';

const SRC = () => ({
  restaurant_id: 'merch_a',
  schema_version: 1,
  items: [
    { key: 'Plato Uno', price: 250, display: { id: 1, cat: 'c1', name: 'Plato Uno', price: 250, desc: 'a dish' } },
    { key: 'Plato Dos', price: 310, display: { id: 2, cat: 'c1', name: 'Plato Dos', price: 310 } },
  ],
  extras: [{ key: 'Queso', price: 40, display: { id: 'e1', name: 'Queso', price: 40 } }],
  structure: { schema_version: 2, item_order: ['Plato Uno', 'Plato Dos'], categories: [{ id: 'c1' }] },
});

test('parsePrice accepts only what the server would accept as a price', () => {
  // isPositiveInt on the server: Number.isInteger(p) && p > 0. Anything else must come back null and
  // be shown as "Sin precio" — never coerced into a number the merchant did not type.
  for (const good of ['1', '250', '  310  ', '99999']) {
    assert.strictEqual(parsePrice(good), Number(String(good).trim()), `${JSON.stringify(good)} is a price`);
  }
  for (const bad of ['', '   ', '0', '-5', '12.5', '12abc', 'abc', '1e3', '0x10', '١٢', null, undefined, {}, [], '  ']) {
    assert.strictEqual(parsePrice(bad), null, `${JSON.stringify(bad)} is NOT a price and must not be coerced into one`);
  }
  // the truncation trap specifically: parseInt('12.9') is 12, which is a WRONG price, not an invalid one
  assert.notStrictEqual(parsePrice('12.9'), 12, 'a decimal must be refused, never truncated into a different price');
  assert.strictEqual(parsePrice('12.9'), null, '...it is simply not a price');
});

test('a fresh draft is clean, and equals the source it came from', () => {
  const d = createDraft(SRC());
  assert.strictEqual(pendingCount(d), 0, 'nothing pending before anything is typed');
  assert.deepStrictEqual(pendingChanges(d), [], 'and no changes to review');
  assert.deepStrictEqual(draftSource(d), SRC(), 'the draft source is byte-identical to what was loaded');
  assert.ok(isPublishable(d), 'a loaded source is publishable as-is');
  assert.deepStrictEqual(invalidKeys(d), [], 'and has no invalid rows');
  // ORIG must be insulated: mutating the draft must not reach back into the loaded original
  setItemPrice(d, 'Plato Uno', '999');
  assert.strictEqual(SRC().items[0].price, 250, 'the fixture is untouched');
  assert.strictEqual(pendingCount(d), 1, 'and the edit registered');
});

test('editing an item price moves price AND display.price together', () => {
  const d = createDraft(SRC());
  setItemPrice(d, 'Plato Uno', '299');
  const out = draftSource(d);
  const it = out.items.find((i) => i.key === 'Plato Uno');
  assert.strictEqual(it.price, 299, 'the authoritative price changed');
  assert.strictEqual(it.display.price, 299,
    'and display.price with it — validateSource FAILS a source where they disagree, so a one-sided edit is unpublishable');
  // everything else about the row is untouched
  assert.strictEqual(it.display.name, 'Plato Uno', 'the name is not a price and must not move');
  assert.strictEqual(it.display.desc, 'a dish', '...nor the description');
  assert.strictEqual(it.display.cat, 'c1', '...nor the category');
  // and no OTHER row moved
  assert.strictEqual(out.items.find((i) => i.key === 'Plato Dos').price, 310, 'the untouched row is untouched');
});

test('a display record with no price does not grow one', () => {
  // The agreement check is conditional (`display.price !== undefined`), so a source that never carried
  // display.price is valid without it. Adding the field would change the document's shape for no
  // reason — and shape is what the CAS hash is taken over.
  const src = SRC();
  delete src.items[1].display.price;
  const d = createDraft(src);
  setItemPrice(d, 'Plato Dos', '400');
  const it = draftSource(d).items.find((i) => i.key === 'Plato Dos');
  assert.strictEqual(it.price, 400, 'the authoritative price still moves');
  assert.ok(!('price' in it.display), 'but display.price is not invented — the row had none and still has none');
});

test('extras edit the same way', () => {
  const d = createDraft(SRC());
  setExtraPrice(d, 'Queso', '55');
  const ex = draftSource(d).extras.find((e) => e.key === 'Queso');
  assert.strictEqual(ex.price, 55, 'the extra price moved');
  assert.strictEqual(ex.display.price, 55, 'and its display.price — extras carry the SAME agreement rule as items');
  assert.strictEqual(pendingCount(d), 1, 'and it counts as one pending change');
});

test('pendingChanges reports what actually differs, and returning to the original clears it', () => {
  const d = createDraft(SRC());
  setItemPrice(d, 'Plato Uno', '299');
  setExtraPrice(d, 'Queso', '55');
  assert.strictEqual(pendingCount(d), 2);
  assert.deepStrictEqual(pendingChanges(d).map((c) => [c.surface, c.key, c.from, c.to]).sort(), [
    ['extra', 'Queso', 40, 55],
    ['item', 'Plato Uno', 250, 299],
  ], 'each change names its surface, key, and both values');

  // TYPING BACK TO THE ORIGINAL IS NOT A CHANGE. A count that only ever went up would tell a merchant
  // they have unpublished work when they have none, and the review screen would list a no-op.
  setItemPrice(d, 'Plato Uno', '250');
  assert.strictEqual(pendingCount(d), 1, 'returning a price to its original value clears that change');
  assert.deepStrictEqual(pendingChanges(d).map((c) => c.key), ['Queso'], 'and it drops out of the review list');
});

test('a non-positive or unparseable price is held, marked invalid, and blocks publishing', () => {
  const d = createDraft(SRC());
  setItemPrice(d, 'Plato Uno', '0');
  // The value is HELD, not discarded: a field that snapped back while typing would fight the merchant.
  assert.strictEqual(pendingCount(d), 1, 'the edit is pending');
  assert.deepStrictEqual(invalidKeys(d), [{ surface: 'item', key: 'Plato Uno' }], 'and the row is marked invalid');
  assert.ok(!isPublishable(d), 'a zero price cannot be published — the server would refuse it anyway, later and less clearly');

  for (const bad of ['', '-1', '12.5', 'abc']) {
    setItemPrice(d, 'Plato Uno', bad);
    assert.ok(!isPublishable(d), `${JSON.stringify(bad)} keeps the draft unpublishable`);
    assert.strictEqual(draftSource(d).items[0].price, null, '...and the source carries null, never a coerced number');
  }
  setItemPrice(d, 'Plato Uno', '299');
  assert.ok(isPublishable(d), 'a valid price makes it publishable again');
  assert.deepStrictEqual(invalidKeys(d), [], 'and clears the invalid mark');
});

test('discard returns the draft to exactly what was loaded', () => {
  const d = createDraft(SRC());
  setItemPrice(d, 'Plato Uno', '1');
  setExtraPrice(d, 'Queso', '2');
  discard(d);
  assert.strictEqual(pendingCount(d), 0, 'nothing pending after a discard');
  assert.deepStrictEqual(draftSource(d), SRC(), 'and the source is byte-identical to the loaded original');
  assert.ok(isPublishable(d), 'and publishable again');
});

test('the draft never mutates the loaded original, however it is edited', () => {
  // ORIG is the yardstick pendingChanges is measured against and what discard restores. If an edit
  // reached it, the change would compare equal to itself: the review screen would show nothing and the
  // merchant would publish a price they never saw listed.
  const src = SRC();
  const d = createDraft(src);
  setItemPrice(d, 'Plato Uno', '999');
  setExtraPrice(d, 'Queso', '888');
  assert.strictEqual(src.items[0].price, 250, 'the object passed in is untouched');
  assert.strictEqual(src.items[0].display.price, 250, '...including nested display records');
  assert.strictEqual(src.extras[0].price, 40, '...and extras');
  assert.strictEqual(pendingCount(d), 2, 'while the draft still reports both changes');
  // and the changes are measured against the ORIGINAL values, not against the previous keystroke
  setItemPrice(d, 'Plato Uno', '111');
  assert.deepStrictEqual(pendingChanges(d).find((c) => c.key === 'Plato Uno'), { surface: 'item', key: 'Plato Uno', from: 250, to: 111 },
    'from is always the loaded value, never the last one typed');
});

test('an unknown key is a no-op, not a new row', () => {
  // Adding items is 2b-2c (it writes pricing KEYS and needs the key-strategy work). A stray setter
  // call must not become a back door to it.
  const d = createDraft(SRC());
  setItemPrice(d, 'No Such Dish', '500');
  setExtraPrice(d, 'No Such Extra', '500');
  assert.strictEqual(pendingCount(d), 0, 'nothing pending');
  assert.strictEqual(draftSource(d).items.length, 2, 'no item was created');
  assert.strictEqual(draftSource(d).extras.length, 1, 'no extra was created');
  assert.deepStrictEqual(draftSource(d), SRC(), 'the source is unchanged');
});

test('only prices are editable — the draft exposes no way to change anything else', () => {
  // Invariant #6: name/add/delete/option-name all write pricing KEYS and are deferred to 2b-2c. The
  // module must not merely leave them un-wired in the UI; it must not implement them at all, so a
  // later caller cannot reach one by accident.
  const d = createDraft(SRC());
  const before = draftSource(d);
  setItemPrice(d, 'Plato Uno', '299');
  const after = draftSource(d);
  // structure, keys and item_order are identical — the only difference is prices
  assert.deepStrictEqual(after.structure, before.structure, 'structure is untouched by a price edit');
  assert.deepStrictEqual(after.items.map((i) => i.key), before.items.map((i) => i.key), 'no key moved or changed');
  assert.deepStrictEqual(after.items.map((i) => i.display.name), before.items.map((i) => i.display.name), 'no name changed');
  assert.strictEqual(after.restaurant_id, before.restaurant_id, 'nor the tenant');
});

// ── Task 4 — OPTION GROUPS ───────────────────────────────────────────────────────────────────────
// The mock models options as first-class `groups` with an id and a required/optional `type`. THE REAL
// SCHEMA HAS NEITHER. Verified against both live sources:
//
//   • `extras` is a FLAT priced list; a group is just the distinct `display.cat` values across it
//     (x_pizza: "Salsas & Queso", "Carnes", "Vegetales & Hierbas" — la_musa: "Acompañamientos",
//     "Salsas", "Proteínas").
//   • there is no `type`, so nothing can truthfully render the mock's required-vs-optional distinction.
//   • `structure.extras_by_category` / `extras_by_item` say WHERE a group is exposed — and la_musa
//     declares both while x_pizza declares NEITHER.
//
// That last one decides the "shared group" note. For la_musa the count is real (32 products reach
// Acompañamientos). For x_pizza the source says nothing, and "en 0 productos" would be a lie about a
// group its customers demonstrably order from. So usage is a NUMBER or it is null, and null renders
// nothing at all.
import { optionGroups, groupUsage, productsUsingGroup } from './editor.js';

const GROUPED = () => ({
  restaurant_id: 'la_musa',
  schema_version: 1,
  items: [
    { key: 'dim_01', price: 200, display: { id: 'dim_01', cat: 'dim_sum', name: 'Dumpling', price: 200 } },
    { key: 'rice_03', price: 150, display: { id: 'rice_03', cat: 'arroces', name: 'Arroz Frito', price: 150 } },
  ],
  extras: [
    { key: 'rice_white', price: 50, display: { id: 'rice_white', cat: 'Acompañamientos', name: 'Arroz Blanco', price: 50 } },
    { key: 'papas', price: 60, display: { id: 'papas', cat: 'Acompañamientos', name: 'Papas', price: 60 } },
    { key: 'sauce_chili', price: 20, display: { id: 'sauce_chili', cat: 'Salsas', name: 'Chili Oil', price: 20 } },
  ],
  structure: {
    schema_version: 2,
    item_order: ['dim_01', 'rice_03'],
    categories: [{ id: 'dim_sum' }, { id: 'arroces' }],
    extras_by_category: { dim_sum: ['Acompañamientos', 'Salsas'] },
    extras_by_item: { rice_03: ['Acompañamientos'] },
  },
});

test('option groups are DERIVED from the extras, because the schema has no group objects', () => {
  const d = createDraft(GROUPED());
  const gs = optionGroups(d);
  assert.deepStrictEqual(gs.map((g) => g.name), ['Acompañamientos', 'Salsas'], 'one group per distinct display.cat');
  assert.deepStrictEqual(gs[0].options.map((o) => o.key), ['rice_white', 'papas'], 'carrying its own options, in source order');
  assert.deepStrictEqual(gs[0].options.map((o) => o.price), [50, 60], 'with their prices');
  // no invented type — the mock's required/optional does not exist here and must not be faked
  for (const g of gs) assert.ok(!('type' in g) && !('required' in g), 'no required/optional: the schema has no such field');
});

test('an ungrouped extra still appears — nothing may silently disappear', () => {
  // The read-only render's rule holds here too: an extra whose display carries no cat is still a
  // priced line a customer can buy, and hiding it would tell a merchant they do not sell it.
  const src = GROUPED();
  src.extras.push({ key: 'loose', price: 10, display: { id: 'loose', name: 'Suelto', price: 10 } });
  const gs = optionGroups(createDraft(src));
  const all = gs.flatMap((g) => g.options.map((o) => o.key));
  assert.ok(all.includes('loose'), 'the ungrouped extra is still reachable through some group');
  assert.strictEqual(gs.filter((g) => g.name === null).length, 1, 'it lands in an unnamed group rather than being dropped');
});

test('group usage counts real products, and is null when the source declares none', () => {
  const d = createDraft(GROUPED());
  // dim_01 is in dim_sum → exposed to both groups. rice_03 is named directly for Acompañamientos.
  assert.deepStrictEqual(productsUsingGroup(d, 'Acompañamientos').sort(), ['dim_01', 'rice_03'],
    'by category AND by item — both maps count');
  assert.deepStrictEqual(productsUsingGroup(d, 'Salsas'), ['dim_01'], 'category exposure alone');
  assert.strictEqual(groupUsage(d, 'Acompañamientos'), 2);
  assert.strictEqual(groupUsage(d, 'Salsas'), 1);
  assert.strictEqual(groupUsage(d, 'No Such Group'), 0, 'a declared-nowhere group in a source that DOES declare exposure is genuinely 0');

  // 🔴 x_pizza declares NEITHER map. Its extras are demonstrably sold, so 0 would be a false statement
  // about a real group; the honest answer is "this source does not say".
  const noMaps = GROUPED();
  delete noMaps.structure.extras_by_category;
  delete noMaps.structure.extras_by_item;
  const d2 = createDraft(noMaps);
  assert.strictEqual(groupUsage(d2, 'Acompañamientos'), null,
    'a source that declares no exposure at all reports null, never 0 — the note must stay silent rather than lie');
  assert.ok(optionGroups(d2).length > 0, 'while the groups themselves are still listed and editable');
});

test('editing one option price is the SHARED value — every product exposing it sees the change', () => {
  // In the mock a group is an object and editing propagates by reference. Here extras are a flat list
  // keyed once, so there is exactly ONE price per option and sharing is structural rather than
  // implemented. That is the property worth pinning: no per-product copy can drift.
  const d = createDraft(GROUPED());
  const users = productsUsingGroup(d, 'Acompañamientos');
  assert.ok(users.length > 1, 'premise: the group really is shared by more than one product');
  setExtraPrice(d, 'rice_white', '75');
  const out = draftSource(d);
  assert.strictEqual(out.extras.filter((e) => e.key === 'rice_white').length, 1, 'still exactly one row for the option');
  assert.strictEqual(out.extras.find((e) => e.key === 'rice_white').price, 75, 'the one authoritative price moved');
  assert.strictEqual(out.extras.find((e) => e.key === 'rice_white').display.price, 75, 'and its display.price with it');
  // it reaches the group view every product reads from
  const g = optionGroups(d).find((x) => x.name === 'Acompañamientos');
  assert.strictEqual(g.options.find((o) => o.key === 'rice_white').price, 75, 'the group view shows the new price');
  // and it is ONE diff entry, not one per product that exposes it
  assert.deepStrictEqual(pendingChanges(d), [{ surface: 'extra', key: 'rice_white', from: 50, to: 75 }],
    'a shared option produces ONE change, however many products expose it');
});

test('option editing cannot add or remove options — that writes keys (2b-2c)', () => {
  const d = createDraft(GROUPED());
  const before = draftSource(d);
  setExtraPrice(d, 'rice_white', '75');
  const after = draftSource(d);
  assert.deepStrictEqual(after.extras.map((e) => e.key), before.extras.map((e) => e.key), 'no option added or removed');
  assert.deepStrictEqual(after.extras.map((e) => e.display.cat), before.extras.map((e) => e.display.cat), 'and none moved group');
  assert.deepStrictEqual(after.structure.extras_by_category, before.structure.extras_by_category, 'the exposure maps are untouched');
  assert.deepStrictEqual(after.structure.extras_by_item, before.structure.extras_by_item, '...both of them');
});

test('the UNNAMED group gets the same null-vs-zero treatment as any other', () => {
  // The drawer used to short-circuit `name === null` to "unknown". That second-guessed groupUsage,
  // which already encodes the whole truth — so an orphan extra on a merchant who DOES declare exposure
  // was reported as unknowable when the honest answer is a real zero: no map names it.
  const src = GROUPED();
  src.extras.push({ key: 'loose', price: 10, display: { id: 'loose', name: 'Suelto', price: 10 } });
  const d = createDraft(src);
  assert.strictEqual(groupUsage(d, null), 0,
    'a declared-exposure source knows the orphan group reaches nothing — that is 0, not "unknown"');
  assert.deepStrictEqual(productsUsingGroup(d, null), [], 'and no product names it');

  // ...while a source that declares NO exposure still cannot say, for the orphan group as for any other
  const noMaps = GROUPED();
  delete noMaps.structure.extras_by_category;
  delete noMaps.structure.extras_by_item;
  noMaps.extras.push({ key: 'loose', price: 10, display: { id: 'loose', name: 'Suelto', price: 10 } });
  assert.strictEqual(groupUsage(createDraft(noMaps), null), null, 'undeclared exposure stays null for the unnamed group too');
  // the two answers must be DIFFERENT, or the distinction the note rests on is not being made
  assert.notStrictEqual(groupUsage(d, null), groupUsage(createDraft(noMaps), null),
    '0 and null must stay distinguishable — the note renders for one and stays silent for the other');
});
