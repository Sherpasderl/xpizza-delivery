// Portal 2b-2a Task 6 — the read-only render. Run: node --test xpizza-portal/render.test.mjs
//
// This is the first time a merchant sees their own menu through our software. Two things matter more
// than layout:
//
//   NOTHING MAY SILENTLY DISAPPEAR. A dish that exists in the source but is missing from item_order, or
//   sits in a category the structure never declares, must still be shown. Dropping it would tell a
//   merchant they do not sell something they do sell — and they would believe the screen over their
//   memory. Every failure here is toward showing MORE, never less.
//
//   THE ORDER IS THE MERCHANT'S, NOT THE ARRAY'S. structure.categories and structure.item_order are
//   content: they are how the menu reads to a customer. Rendering in whatever order the JSON happened
//   to arrive in would quietly reorder someone's menu in front of them.
import { test } from 'node:test';
import assert from 'node:assert';
import { groupByCategory, priceLabel } from './render.js';

const SOURCE = {
  items: [
    { key: 'b', price: 20, display: { id: 'b', cat: 'c1', name: 'B' } },
    { key: 'a', price: 10, display: { id: 'a', cat: 'c1', name: 'A' } },
    { key: 'z', price: 30, display: { id: 'z', cat: 'c2', name: 'Z' } },
  ],
  structure: { categories: [{ id: 'c1', name: 'Uno' }, { id: 'c2', name: 'Dos' }], item_order: ['a', 'b', 'z'] },
};

test('categories keep the structure order, and items keep item_order — not array order', () => {
  const g = groupByCategory(SOURCE);
  assert.deepStrictEqual(g.map((x) => x.category.name), ['Uno', 'Dos'], 'categories in structure order');
  assert.deepStrictEqual(g[0].items.map((i) => i.display.name), ['A', 'B'], 'items in item_order, though the array had B first');
  assert.deepStrictEqual(g[1].items.map((i) => i.key), ['z']);
});

test('a category with no name falls back to its id, never a blank heading', () => {
  const g = groupByCategory({ ...SOURCE, structure: { ...SOURCE.structure, categories: [{ id: 'c1' }, { id: 'c2', name: '  ' }] } });
  assert.deepStrictEqual(g.map((x) => x.category.name), ['c1', 'c2'], 'a missing or blank name shows the id');
});

test('an item missing from item_order is still shown, after the ordered ones', () => {
  // Nothing in the source guarantees item_order is complete on arrival, and a dish that vanished from
  // the screen would read as "we deleted your dish".
  const g = groupByCategory({ ...SOURCE, structure: { ...SOURCE.structure, item_order: ['b'] } });
  assert.deepStrictEqual(g[0].items.map((i) => i.key), ['b', 'a'], 'the ordered one first, then the unlisted one');
  assert.strictEqual(g[1].items.length, 1, 'and an item ordered nowhere still appears in its category');
});

test('an item in an UNDECLARED category is surfaced, not dropped', () => {
  const g = groupByCategory({
    items: [...SOURCE.items, { key: 'orphan', price: 5, display: { id: 'orphan', cat: 'ghost', name: 'Huérfano' } }],
    structure: SOURCE.structure,
  });
  const all = g.flatMap((x) => x.items.map((i) => i.key));
  assert.ok(all.includes('orphan'), 'the orphan must appear SOMEWHERE — silently hiding it is the worst outcome');
  const last = g[g.length - 1];
  assert.deepStrictEqual(last.items.map((i) => i.key), ['orphan'], 'in a trailing bucket of its own');
  assert.ok(last.category.id !== 'c1' && last.category.id !== 'c2', 'not folded into a real category it does not belong to');
  assert.ok(last.category.name.length > 0, 'and that bucket is labelled');
});

test('a declared category with no items is still shown', () => {
  // A merchant who made a section and has not filled it should see the empty section, not wonder where
  // it went.
  const g = groupByCategory({ items: [], structure: SOURCE.structure });
  assert.deepStrictEqual(g.map((x) => x.category.id), ['c1', 'c2']);
  assert.deepStrictEqual(g.map((x) => x.items.length), [0, 0]);
});

test('a missing or malformed source yields nothing rather than throwing', () => {
  for (const s of [null, undefined, {}, { items: null }, { items: [], structure: null }, 'nope', 42]) {
    assert.deepStrictEqual(groupByCategory(s), [], `${JSON.stringify(s)} → an empty render, never an exception`);
  }
  // an item with no display at all must not take the whole page down
  const g = groupByCategory({ items: [{ key: 'x', price: 1 }, ...SOURCE.items], structure: SOURCE.structure });
  assert.ok(g.flatMap((x) => x.items).some((i) => i.key === 'x'), 'and a display-less item is still surfaced');
});

test('prices are shown exactly as stored — no arithmetic, no rounding, no currency invention', () => {
  // The source price is the authoritative integer the customer pays. Any transformation here is a lie
  // about a price, which is the one thing this screen must never tell.
  assert.strictEqual(priceLabel(299), 'L299');
  assert.strictEqual(priceLabel(10), 'L10');
  assert.strictEqual(priceLabel(1250), 'L1250');
  // anything that is not a positive integer is not a price we can vouch for — say so rather than
  // rendering "L0", "LNaN" or "Lundefined"
  for (const bad of [0, -5, 12.5, null, undefined, '299', NaN, Infinity, {}]) {
    const l = priceLabel(bad);
    assert.ok(!/NaN|undefined|null|\[object/.test(l), `a bad price (${String(bad)}) must not render a JS artefact, got ${l}`);
    assert.notStrictEqual(l, 'L0', 'and must never read as free');
  }
});
