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
