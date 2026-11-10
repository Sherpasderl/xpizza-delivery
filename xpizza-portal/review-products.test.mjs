// S4 «Editar producto» — the review's «Productos» group (MOCKUP-portal-item-edit frame E; advisor rulings 2026-11-08):
// the review ARRANGES the server's lines and derives nothing. An existing product's name / description / section lines
// (catalog-edit.js `{key, surface:'item', field, old, new}`) leave «Precios» for «Productos»; the section's gate lines
// (pickup_only / weekend_only / redeem_eligible) read as the drawer's consequence lines; a group's option lines fold under
// their product as «Opciones (n)». Every server line is accounted for exactly once. Run: node --test xpizza-portal/review-products.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { reviewModel, renderReview, attestationModel, renderAttestation } from './review.js';

const L = (key, field, old, nw) => ({ key, surface: 'item', field, old, new: nw });
// frame E: Cacio e Pepe renamed, described, moved Pizzas · Especiales → Pastas, price 270 → 285
const FRAME_E = () => ({
  changed: [
    L('Pizza Cacio e Pepe', 'price', 270, 285),
    L('Pizza Cacio e Pepe', 'name', 'Pizza Cacio e Pepe', 'Cacio e Pepe'),
    L('Pizza Cacio e Pepe', 'desc', 'Parmesano, mozzarella y pimienta.', 'Pecorino, mozzarella y pimienta negra.'),
    L('Pizza Cacio e Pepe', 'cat', 'pz', 'pa'),
    L('Pizza Cacio e Pepe', 'subcat', 'Especiales', null),
    L('Pizza Cacio e Pepe', 'pickup_only', false, true),
    L('Pizza Cacio e Pepe', 'weekend_only', false, true),
    L('Pizza Cacio e Pepe', 'redeem_eligible', true, false),
  ],
  added: [], removed: [], renamed: [], largeChangeSet: [],
});
// a group rename: the product's line + one derived line per option
const GROUP = () => ({
  changed: [
    L('Pizza Cuatro Quesos', 'name', 'Pizza Cuatro Quesos', 'Pizza Cuatro Quesos Especial'),
    ...['Personal', 'Mediana', 'Familiar'].map((c) => L(`Pizza Cuatro Quesos - ${c}`, 'name', `Pizza Cuatro Quesos - ${c}`, `Pizza Cuatro Quesos Especial - ${c}`)),
    L('Pizza Cuatro Quesos', 'cat', 'pz', 'pa'),
    ...['Personal', 'Mediana', 'Familiar'].map((c) => L(`Pizza Cuatro Quesos - ${c}`, 'cat', 'pz', 'pa')),
  ],
  added: [], removed: [], renamed: [], largeChangeSet: [],
});
const parentOf = (k) => (/^Pizza Cuatro Quesos - /.test(k) ? 'Pizza Cuatro Quesos' : null);

test('«Productos» — name / description / section lines leave «Precios»: the price row stays, the text lines move', () => {
  const m = reviewModel(FRAME_E());
  assert.deepStrictEqual(m.rows.map((r) => r.field), ['price'], '«Precios» keeps only the price (its +6% chip untouched)');
  assert.strictEqual(m.products.length, 1);
  const p = m.products[0];
  assert.strictEqual(p.key, 'Pizza Cacio e Pepe');
  assert.deepStrictEqual(p.lines.map((l) => l.kind), ['name', 'desc', 'cat']);
  assert.deepStrictEqual(p.lines[0], { kind: 'name', was: 'Pizza Cacio e Pepe', now: 'Cacio e Pepe' });
  assert.deepStrictEqual(p.lines[2], { kind: 'cat', cat: { was: 'pz', now: 'pa' }, subcat: { was: 'Especiales', now: null } });
});

test('«Productos» — the gate lines read as the drawer\'s consequence lines, in the drawer\'s order (frame D = frame E)', () => {
  const p = reviewModel(FRAME_E()).products[0];
  assert.deepStrictEqual(p.consequences, ['Queda solo para recoger', 'Pasa a venderse solo los fines de semana', 'Deja de canjearse con puntos']);
  const back = FRAME_E();
  back.changed = back.changed.filter((c) => /only|eligible/.test(c.field)).map((c) => ({ ...c, old: c.new, new: c.old }));
  assert.deepStrictEqual(reviewModel(back).products[0].consequences, ['Vuelve a entregarse a domicilio', 'Pasa a venderse todos los días', 'Pasa a canjearse con puntos']);
});

test('«Productos» — EVERY server line is accounted for exactly once (shown, or absorbed by the product line it repeats)', () => {
  for (const diff of [FRAME_E(), GROUP()]) {
    const m = reviewModel(diff, { optionParent: parentOf });
    const seen = [
      ...m.rows.map((r) => `${r.key}|${r.field}`),
      ...m.products.flatMap((p) => p.sources.map((c) => `${c.key}|${c.field}`)),
    ].sort();
    assert.deepStrictEqual(seen, diff.changed.map((c) => `${c.key}|${c.field}`).sort());
  }
});

test('«Productos» — a group rename FOLDS its option lines under the product: «Opciones (3)», the derived old → new names', () => {
  const m = reviewModel(GROUP(), { optionParent: parentOf });
  assert.strictEqual(m.products.length, 1, 'one product, not four');
  const p = m.products[0];
  assert.deepStrictEqual(p.options.map((o) => [o.was, o.now]), ['Personal', 'Mediana', 'Familiar'].map((c) => [`Pizza Cuatro Quesos - ${c}`, `Pizza Cuatro Quesos Especial - ${c}`]));
  assert.deepStrictEqual(p.lines.map((l) => l.kind), ['name', 'cat'], 'the options\' section lines repeat the product\'s: absorbed (it moves with them)');
  assert.strictEqual(p.absorbed.length, 3);
});

test('«Productos» — an option line that does NOT repeat its product\'s line is shown under the option, never absorbed', () => {
  const diff = GROUP();
  diff.changed = diff.changed.filter((c) => !(c.field === 'cat' && c.key === 'Pizza Cuatro Quesos'));   // the product's own cat line is absent
  const p = reviewModel(diff, { optionParent: parentOf }).products[0];
  assert.strictEqual(p.absorbed.length, 0);
  assert.deepStrictEqual(p.options.map((o) => o.extra.map((l) => l.kind)), [['cat'], ['cat'], ['cat']]);
});

test('«Productos» — without the caller\'s optionParent an option line is a product of its own (arranged, never hidden)', () => {
  const m = reviewModel(GROUP());
  assert.strictEqual(m.products.length, 4);
});

test('«Productos» — total counts every line that will publish, so the header never understates it', () => {
  const diff = FRAME_E();
  assert.strictEqual(reviewModel(diff).total, diff.changed.length);
  const g = GROUP();
  assert.strictEqual(reviewModel(g, { optionParent: parentOf }).total, g.changed.length);
});

test('«Productos» renders frame E: the group with its count, «Nombre» / «Descripción» / «Categoría» was → now, the consequences, before «Precios»', () => {
  const root = fakeDom();
  renderReview(root, reviewModel(FRAME_E()), {
    products: { nameOf: (k) => k, categoryName: (id) => ({ pz: 'Pizzas', pa: 'Pastas' }[id] || id), sectionOf: () => ({ cat: 'pa', subcat: null }) },
  });
  const labels = byClass(root, 'mglabel').map(textOf);
  assert.deepStrictEqual(labels, ['Productos 3', 'Precios 1'], 'Productos first; its count is the three field lines');
  const rows = byClass(byClass(root, 'mgroup')[0], 'prow');
  assert.deepStrictEqual(rows.map((r) => textOf(byClass(r, 'psub')[0])), ['Nombre', 'Descripción', 'Categoría']);
  assert.strictEqual(textOf(byClass(rows[2], 'pval')[0]), 'Pizzas · Especiales → Pastas');
  assert.ok(rows.every((r) => r._class.split(' ').includes('mk-trow')), 'text rows wrap under the product name (the mockup\'s .prow.mk-trow)');
  const ul = byClass(rows[2], 'mk-cons');
  assert.strictEqual(ul.length, 1, 'the consequences sit inside the section row, as the mockup\'s <ul class="mk-cons">');
  assert.deepStrictEqual(ul[0].children.map((li) => [li.tag, textOf(li)]), [['li', 'Queda solo para recoger'], ['li', 'Pasa a venderse solo los fines de semana'], ['li', 'Deja de canjearse con puntos']]);
  assert.ok(ul[0].children.every((li) => byClass(li, 'mk-cdot').length === 1), 'each sentence carries its dot');
});

test('«Productos» renders a group\'s «Opciones (3)» with the derived names indented beneath', () => {
  const root = fakeDom();
  renderReview(root, reviewModel(GROUP(), { optionParent: parentOf }), { products: { nameOf: (k) => k, categoryName: (id) => id, sectionOf: () => ({ cat: 'pa', subcat: null }) } });
  const optRow = byClass(root, 'prow').find((r) => r.dataset.k === 'item::Pizza Cuatro Quesos::options');
  assert.ok(optRow, 'one «Opciones» row under the product');
  assert.strictEqual(textOf(byClass(optRow, 'psub')[0]), 'Opciones (3)');
  assert.deepStrictEqual(byClass(optRow, 'pval').map(textOf), ['Personal', 'Mediana', 'Familiar'].map((c) => `Pizza Cuatro Quesos - ${c} → Pizza Cuatro Quesos Especial - ${c}`));
});

// ── Phase 2 (S2-DESIGN §1.3, approved 11-10) ──────────────────────────────────────────────────────────────────────────
// The extras consequences: diff.consequences — one { key, kind:'extras', gained, lost } per product, on the LAUNCHER (the union
// over its options). Shape-pinned here until 5f's S2 server emits it (then the real-writer cell below takes it from the diff).
test('«Productos» — S2 §1.3: the server\'s extras consequence reads «Deja de aceptar el extra …» / «Acepta el extra …», before the gate sentences', () => {
  const diff = FRAME_E();
  diff.consequences = [{ key: 'Pizza Cacio e Pepe', kind: 'extras', gained: ['Pan de ajo'], lost: ['Orilla rellena'] }];
  const p = reviewModel(diff).products[0];
  assert.deepStrictEqual(p.consequences, ['Deja de aceptar el extra Orilla rellena', 'Acepta el extra Pan de ajo',
    'Queda solo para recoger', 'Pasa a venderse solo los fines de semana', 'Deja de canjearse con puntos'], 'the drawer\'s frame D order: extras lost, gained, then the gates');
  assert.strictEqual(reviewModel(diff).total, diff.changed.length, 'a consequence is not a line that publishes: the total is unchanged');
  const root = fakeDom();
  renderReview(root, reviewModel(diff), { products: { nameOf: (k) => k, categoryName: (id) => id, sectionOf: () => ({ cat: 'pa', subcat: null }) } });
  const ul = byClass(root, 'mk-cons')[0];
  assert.deepStrictEqual(ul.children.slice(0, 2).map(textOf), ['Deja de aceptar el extra Orilla rellena', 'Acepta el extra Pan de ajo']);
});
test('«Productos» — a consequence for a product with no other line still shows (never dropped); a malformed one is ignored', () => {
  const diff = { changed: [], added: [], removed: [], renamed: [], largeChangeSet: [],
    consequences: [{ key: 'Lasaña', kind: 'extras', gained: [], lost: ['Pan de ajo'] }, { key: 'X', kind: 'nope' }, null, { kind: 'extras' }] };
  const m = reviewModel(diff);
  assert.deepStrictEqual(m.products.map((p) => [p.key, p.consequences]), [['Lasaña', ['Deja de aceptar el extra Pan de ajo']]]);
});

// The REAL writer: the server's catalogDiff over the real la_musa seed, the draft edited by the portal's own editItem.
test('«Productos» — from the REAL catalogDiff: a group renamed and moved — one product, «Opciones (3)», every server line accounted once', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(new URL('../xpizza-functions/package.json', import.meta.url));
  const { buildSourceFromCode } = req('./tools/seed-source-store');
  const { sourceToBuildInputs } = req('./catalog/source-store');
  const { buildCatalogV2 } = req('./catalog/form-menu-source');
  const { catalogDiff } = req('./catalog/catalog-edit');
  const { createDraft, editItem, draftSource } = await import('./editor.js');
  const build = (src) => { const i = sourceToBuildInputs(src); return buildCatalogV2('la_musa', { formData: i.formData, priceTable: i.priceTable }); };
  const live = buildSourceFromCode('la_musa');
  const d = createDraft(JSON.parse(JSON.stringify(live)));
  assert.equal(editItem(d, 'noodle_01', { name: 'Pad Thai Especial', cat: 'rice' }), true, 'premise: the portal\'s own writer accepts the edit');
  const diff = catalogDiff(build(live), build(draftSource(d)));
  const opts = draftSource(d).items.filter((i) => i.display && i.display.variantOf === 'noodle_01').map((i) => i.key);
  const parentOf = (k) => (opts.includes(k) ? 'noodle_01' : null);
  const m = reviewModel(diff, { optionParent: parentOf, optionIndex: (k) => opts.indexOf(k) });
  assert.deepStrictEqual(m.products.map((p) => p.key), ['noodle_01'], 'one product, its options folded');
  const p = m.products[0];
  assert.deepStrictEqual(p.lines.map((l) => l.kind), ['name', 'cat']);
  assert.deepStrictEqual(p.options.map((o) => o.now), opts.map((k) => draftSource(d).items.find((i) => i.key === k).display.name));
  const seen = [...m.rows.map((r) => `${r.key}|${r.field}`), ...m.products.flatMap((x) => x.sources.map((c) => `${c.key}|${c.field}`))].sort();
  assert.deepStrictEqual(seen, diff.changed.map((c) => `${c.key}|${c.field}`).sort(), 'every server line exactly once');
});

// the review tests' shim (only what review.js touches)
function fakeDom() {
  const mk = (tag) => {
    const n = {
      tag, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, textContent: undefined,
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: { add: (c) => { n._class = `${n._class} ${c}`.trim(); } },
      append: (...cs) => n.children.push(...cs.map((c) => (typeof c === 'string' ? { tag: '#text', children: [], textContent: c, _class: '' } : c))),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
    };
    return n;
  };
  globalThis.document = { createElement: mk, createElementNS: (_ns, tag) => mk(tag) };
  return mk('div');
}
function walk(n, out = []) { out.push(n); for (const c of n.children || []) walk(c, out); return out; }
function byClass(root, cls) { return walk(root).filter((n) => String(n._class || '').split(/\s+/).includes(cls)); }
function textOf(n) { return walk(n).map((x) => x.textContent).filter((t) => t !== undefined).join(' '); }

// SBS 11-10 (frame E): the «Precios» row names the product by its CURRENT name, its section beneath — with the products lookup
// (the text-edit switch on); without it, today's row exactly (the key, no sub line).
test('«Precios» (frame E) — the price row reads the current name and the section; without the lookup, today\'s row', () => {
  const diff = FRAME_E();
  const root = fakeDom();
  renderReview(root, reviewModel(diff), { products: { nameOf: (k) => (k === 'Pizza Cacio e Pepe' ? 'Cacio e Pepe' : k), categoryName: (id) => ({ pz: 'Pizzas', pa: 'Pastas' }[id] || id), sectionOf: () => ({ cat: 'pa', subcat: null }) } });
  const price = byClass(byClass(root, 'mgroup')[1], 'prow')[0];
  assert.strictEqual(textOf(byClass(price, 'pname')[0]), 'Cacio e Pepe');
  assert.strictEqual(textOf(byClass(price, 'psub')[0]), 'Pastas');
  const today = fakeDom();
  renderReview(today, reviewModel(diff), {});
  const p0 = byClass(byClass(today, 'mgroup')[1], 'prow')[0];
  assert.strictEqual(textOf(byClass(p0, 'pname')[0]), 'Pizza Cacio e Pepe');
  assert.strictEqual(byClass(p0, 'psub').length, 0, 'no sub line without the lookup');
});

// ── the fiscal seal's product-NAME part (frame E; OWNER-approved copy 11-10). Only display.name reaches the factura (S2 §1.3):
// a rename on a fiscal brand says so; a description / section change adds nothing. The publish gate is unchanged. ──
const sealOf = (diff, opts = {}) => {
  const root = fakeDom();
  renderAttestation(root, attestationModel(diff, { usesPlatformFactura: true, ...(opts.ctx || {}) }), () => {}, opts.render || {});
  const seal = byClass(root, 'seal')[0];
  return { head: textOf(byClass(seal, 'sealh')[0]), p: byClass(seal, 'sealbody')[0].children.filter((c) => c.tag === 'p').map(textOf),
    rows: byClass(seal, 'seachg').map((c) => [textOf(byClass(c, 'sn')[0]), textOf(byClass(c, 'sv')[0])]), ack: textOf(byClass(seal, 'at')[0]).replace(/\s+/g, ' ') };
};
const nm = (key, was, now) => L(key, 'name', was, now);
const NOW = { products: { nameOf: (k) => ({ 'Pizza Cacio e Pepe': 'Cacio e Pepe', 'Lasaña': 'Lasaña de la casa' }[k] || k) } };
test('seal (frame E) — 1 price + 1 name: the drawn copy exactly, the price under the current name, then «Nombre en factura»', () => {
  const s = sealOf({ changed: [L('Pizza Cacio e Pepe', 'price', 270, 285), nm('Pizza Cacio e Pepe', 'Pizza Cacio e Pepe', 'Cacio e Pepe')], added: [], removed: [], renamed: [], largeChangeSet: [] }, { render: NOW });
  assert.match(s.head, /Esta publicación requiere tu autorización como propietario/);
  assert.deepStrictEqual(s.p, ['Como propietario, autorizás esta publicación. Cambia un precio y el nombre de un producto: los dos aparecen en la factura.']);
  assert.deepStrictEqual(s.rows.map((r) => r[0]), ['Cacio e Pepe', 'Nombre en factura']);
  assert.match(s.rows[1][1], /Pizza Cacio e Pepe\s*→\s*Cacio e Pepe/);
  assert.strictEqual(s.ack, 'Autorizo esta edición en la factura fiscal.');
});
test('seal — names only: singular and plural', () => {
  const one = sealOf({ changed: [nm('Pizza Cacio e Pepe', 'Pizza Cacio e Pepe', 'Cacio e Pepe')], added: [], removed: [], renamed: [], largeChangeSet: [] });
  assert.deepStrictEqual(one.p, ['Como propietario, autorizás esta publicación. Cambia el nombre de un producto: aparece en la factura.']);
  assert.deepStrictEqual(one.rows.map((r) => r[0]), ['Nombre en factura']);
  const two = sealOf({ changed: [nm('Pizza Cacio e Pepe', 'Pizza Cacio e Pepe', 'Cacio e Pepe'), nm('Lasaña', 'Lasaña', 'Lasaña de la casa')], added: [], removed: [], renamed: [], largeChangeSet: [] });
  assert.deepStrictEqual(two.p, ['Como propietario, autorizás esta publicación. Cambia el nombre de 2 productos: aparecen en la factura.']);
  assert.deepStrictEqual(two.rows.map((r) => r[0]), ['Nombre en factura', 'Nombre en factura']);
  assert.strictEqual(two.ack, 'Autorizo esta edición en la factura fiscal.');
});
test('seal — N prices + M names (not 1+1): «Cambia N precios y el nombre de M productos: aparecen en la factura.», singular forms where 1', () => {
  const base = { added: [], removed: [], renamed: [], largeChangeSet: [] };
  const a = sealOf({ ...base, changed: [L('A', 'price', 100, 110), L('B', 'price', 100, 110), nm('A', 'A', 'A2')] });
  assert.deepStrictEqual(a.p, ['Como propietario, autorizás esta publicación. Cambia 2 precios y el nombre de un producto: aparecen en la factura.']);
  const b = sealOf({ ...base, changed: [L('A', 'price', 100, 110), nm('A', 'A', 'A2'), nm('B', 'B', 'B2')] });
  assert.deepStrictEqual(b.p, ['Como propietario, autorizás esta publicación. Cambia un precio y el nombre de 2 productos: aparecen en la factura.']);
  assert.deepStrictEqual(b.rows.map((r) => r[0]), ['A', 'Nombre en factura', 'Nombre en factura'], 'the name rows after the price rows');
});
test('seal — a description / section change adds NOTHING (it never reaches the factura): today\'s price seal exactly', () => {
  const diff = { changed: [L('Pizza Cacio e Pepe', 'price', 270, 285), L('Pizza Cacio e Pepe', 'desc', 'a', 'b'), L('Pizza Cacio e Pepe', 'cat', 'pz', 'pa')], added: [], removed: [], renamed: [], largeChangeSet: [] };
  const s = sealOf(diff);
  assert.match(s.head, /Estos precios se imprimen en tu factura fiscal/);
  assert.ok(!s.rows.some((r) => r[0] === 'Nombre en factura'));
  assert.strictEqual(s.ack, 'Autorizo este cambio de precio en la factura fiscal.');
});
test('seal — a group rename: ONE «Nombre en factura» row for the product (its options\' derived names are folded under it)', () => {
  const s = sealOf(GROUP(), { ctx: { optionParent: parentOf } });
  assert.deepStrictEqual(s.rows.map((r) => r[0]), ['Nombre en factura']);
  assert.match(s.rows[0][1], /Pizza Cuatro Quesos\s*→\s*Pizza Cuatro Quesos Especial/);
  assert.deepStrictEqual(s.p, ['Como propietario, autorizás esta publicación. Cambia el nombre de un producto: aparece en la factura.']);
});
test('«Productos» (frame E) — the rows head with the PUBLISHED name (the name line\'s old value), while «Precios» reads the current one', () => {
  const root = fakeDom();
  renderReview(root, reviewModel(FRAME_E()), { products: { nameOf: (k) => (k === 'Pizza Cacio e Pepe' ? 'Cacio e Pepe' : k), categoryName: (id) => id, sectionOf: () => ({ cat: 'pa', subcat: null }) } });
  const prows = byClass(byClass(root, 'mgroup')[0], 'prow');
  assert.deepStrictEqual(prows.map((r) => textOf(byClass(r, 'pname')[0])), ['Pizza Cacio e Pepe', 'Pizza Cacio e Pepe', 'Pizza Cacio e Pepe']);
  assert.strictEqual(textOf(byClass(byClass(byClass(root, 'mgroup')[1], 'prow')[0], 'pname')[0]), 'Cacio e Pepe');
});
test('the review prints prices «L 285» (a space after the L, as the mockup and every other Sherpa surface) — rows and seal alike', () => {
  const root = fakeDom();
  renderReview(root, reviewModel(FRAME_E()), {});
  const price = byClass(byClass(root, 'mgroup')[1], 'prow')[0];
  assert.deepStrictEqual([textOf(byClass(price, 'was')[0]), textOf(byClass(price, 'now')[0])], ['L 270', 'L 285']);
  const s = sealOf({ changed: [L('Pizza Cacio e Pepe', 'price', 270, 285)], added: [], removed: [], renamed: [], largeChangeSet: [] });
  assert.match(s.rows[0][1], /L 270\s*→\s*L 285/);
});
