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

// ── DOM RENDERING ────────────────────────────────────────────────────────────────────────────────
// render.js imports NOTHING, so node can exercise it directly given a document — the CDN split that
// keeps app.js/boot.js out of node does not apply here. Until now the render layer was covered only
// structurally, and a structural check cannot tell which STRING landed in a cell.
//
// A deliberately small shim: just the surface render.js touches, so a test failure means the renderer
// is wrong rather than the fake being incomplete.
import { renderDetail } from './render.js';

function fakeDom() {
  const mk = (tag) => {
    const n = {
      tag, children: [], attrs: {}, listeners: {}, _class: '', dataset: {},
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: { add: (c) => { n._class = `${n._class} ${c}`.trim(); } },
      // append(string) creates a TEXT NODE in a real DOM. Modelling it as one keeps the shim honest:
      // without this, text appended as a raw string is invisible to the assertions and a string that
      // never rendered would pass unnoticed.
      append: (...cs) => n.children.push(...cs.map((c) => (typeof c === 'string' ? { tag: '#text', children: [], textContent: c, _class: '' } : c))),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      textContent: undefined,
    };
    return n;
  };
  globalThis.document = { createElement: mk, createElementNS: (_ns, tag) => mk(tag) };
  return mk('div');
}
const walk = (n, out = []) => { out.push(n); for (const c of n.children || []) walk(c, out); return out; };
const byClass = (root, cls) => walk(root).filter((n) => String(n._class || '').split(/\s+/).includes(cls));
const textsIn = (root, cls) => byClass(root, cls).map((n) => n.textContent).filter((t) => t !== undefined);

test('an extra is labelled by its display NAME, never by its key', () => {
  // 🔴 THE TWO-BRANDS TRAP, in the test layer. x_pizza keys extras BY NAME, so on that brand key and
  // name are the same string and a value assertion cannot tell "shows the name" from "shows the key".
  // Only an ID-KEYED fixture separates them — which is why this one is la_musa-shaped, and why the bug
  // (extras rendering `rice_white` to a merchant whose customers read "Arroz Blanco") survived a full
  // read-only slice unnoticed.
  const root = fakeDom();
  const group = { category: { id: 'c1', name: 'Dim Sum' }, items: [] };
  const extras = [{ key: 'rice_white', price: 50, display: { id: 'rice_white', cat: 'Acompañamientos', name: 'Arroz Blanco', price: 50 } }];
  renderDetail(root, group, extras, { editable: true, changed: () => false, onPrice: () => {}, onOpen: () => {} });

  const names = textsIn(root, 'nm');
  assert.ok(names.includes('Arroz Blanco'), `the extra is labelled by its display name (got ${JSON.stringify(names)})`);
  assert.ok(!names.includes('rice_white'), 'and NEVER by its key — that is a slug the merchant never chose');

  // the KEY is still what addresses the price cell: the label changed, the identity did not
  const cells = byClass(root, 'price');
  assert.strictEqual(cells.length, 1, 'one price cell for the one extra');
  assert.strictEqual(cells[0].dataset.k, 'extra::rice_white', 'the cell is keyed by the KEY, not the name');
  const input = cells[0].children.find((c) => c.tag === 'input');
  assert.ok(input, 'the price is editable');
  assert.strictEqual(input.value, '50', 'and shows the unchanged price');

  // typing into it reports the KEY upward, so the edit lands on the right row
  let got = null;
  const root2 = fakeDom();
  renderDetail(root2, group, extras, { editable: true, changed: () => false, onPrice: (s, k, v) => { got = [s, k, v]; }, onOpen: () => {} });
  const inp2 = byClass(root2, 'price')[0].children.find((c) => c.tag === 'input');
  inp2.value = '75';
  inp2.listeners.input[0]();
  assert.deepStrictEqual(got, ['extra', 'rice_white', '75'], 'the handler receives the key, never the display name');
});

test('an item is labelled by its display name, and falls back to the key only when there is none', () => {
  const root = fakeDom();
  const group = {
    category: { id: 'c1', name: 'Dim Sum' },
    items: [
      { key: 'dim_01', price: 200, display: { id: 'dim_01', cat: 'c1', name: 'Dumplings' } },
      { key: 'dim_02', price: 220, display: { id: 'dim_02', cat: 'c1' } },        // no name at all
      { key: 'dim_03', price: 230, display: { id: 'dim_03', cat: 'c1', name: '   ' } },  // blank
    ],
  };
  renderDetail(root, group, [], { editable: true, changed: () => false, onPrice: () => {}, onOpen: () => {} });
  const names = textsIn(root, 'nm');
  assert.ok(names.includes('Dumplings'), 'the named item shows its name');
  assert.ok(names.includes('dim_02'), 'a nameless item falls back to its key rather than rendering blank');
  assert.ok(names.includes('dim_03'), '...and so does a whitespace-only name — a blank row tells a merchant nothing');
});

test('the read-only render is unchanged — no inputs, no openers', () => {
  // The 2b-2a path must survive the editor: called without opts, renderDetail still produces text.
  const root = fakeDom();
  const group = { category: { id: 'c1', name: 'C' }, items: [{ key: 'a', price: 10, display: { id: 'a', cat: 'c1', name: 'A' } }] };
  renderDetail(root, group, [{ key: 'x', price: 5, display: { id: 'x', name: 'X' } }]);
  assert.strictEqual(walk(root).filter((n) => n.tag === 'input').length, 0, 'no price inputs in the read-only render');
  assert.strictEqual(byClass(root, 'thumb').length, 0, 'no opener thumbs');
  assert.strictEqual(byClass(root, 'rowchev').length, 0, 'no chevrons');
  assert.ok(textsIn(root, 'price').includes('L10'), 'prices render as text');
  assert.ok(textsIn(root, 'price').includes('L5'), '...for extras too');
});
