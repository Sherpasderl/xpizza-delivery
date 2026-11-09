// S4 «Editar producto» — Nombre · Descripción · Categoría (PLAN-portal-item-edit r6 + addendum S4; MOCKUP-portal-item-edit.html =
// the approved target: every on-screen string below is the mockup's, verbatim). Run: node --test xpizza-portal/item-edit.test.mjs
//
// Phase 1 is the pure half: editor.js's one whole-drawer mutator (editItem) and item-edit-logic.js, the drawer's working copy.
// The drawer edits a COPY; «Guardar» validates and applies the whole edit to the shared draft ONCE; «Cancelar» throws the copy
// away. A photo upload is bound to the drawer session that started it, so a cancelled / replaced / late upload never lands.
//
// Fixtures come from the real writers: a plain source the way the portal loads it, and a GROUP made the way a saved one is —
// the portal's own add-product mutators, then the server's allocateAdditions (catalog/add-product.js), then adopt().
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  createDraft, adopt, draftSource, pendingCount, setItemPrice, setCategoryNames,
  addProduct, setAddition, setRequiredChoice, setChoiceName, setChoicePrice, setGroupLabel,
  editItem, pendingTexts, itemNameProblem,
} from './editor.js';
import * as IE from './item-edit-logic.js';

const AP = createRequire(import.meta.url)('../xpizza-functions/catalog/add-product.js');

// Pizzas has subsections (Clásicas / Especiales); Pastas, Ensaladas none; Bebidas holds one product (the D2 refusal).
const BASE = () => ({
  restaurant_id: 'merch_a',
  schema_version: 1,
  items: [
    { key: 'Pizza Margarita', price: 220, display: { id: 1, cat: 'pz', subcat: 'Clásicas', name: 'Pizza Margarita', price: 220, desc: 'Tomate, mozzarella fresca y albahaca' } },
    { key: 'Pizza Cacio e Pepe', price: 260, display: { id: 2, cat: 'pz', subcat: 'Especiales', name: 'Pizza Cacio e Pepe', price: 260, desc: 'Parmesano, mozzarella y pimienta.' } },
    { key: 'Pizza Pepperoni', price: 240, display: { id: 3, cat: 'pz', subcat: 'Especiales', name: 'Pizza Pepperoni', price: 240 } },
    { key: 'Lasaña', price: 280, display: { id: 4, cat: 'pa', name: 'Lasaña', price: 280 } },
    { key: 'Ravioles', price: 270, display: { id: 5, cat: 'pa', name: 'Ravioles', price: 270 } },
    { key: 'Limonada de hierbabuena', price: 60, display: { id: 6, cat: 'be', name: 'Limonada de hierbabuena', price: 60, desc: 'Con hielo y menta fresca' } },
  ],
  extras: [
    { key: 'Orilla rellena', price: 50, display: { id: 'e1', cat: 'Orilla rellena', name: 'Orilla rellena', price: 50 } },
    { key: 'Pan de ajo', price: 45, display: { id: 'e2', cat: 'Pan de ajo', name: 'Pan de ajo', price: 45 } },
  ],
  structure: {
    schema_version: 2,
    item_order: ['Pizza Margarita', 'Pizza Cacio e Pepe', 'Pizza Pepperoni', 'Lasaña', 'Ravioles', 'Limonada de hierbabuena'],
    categories: [{ id: 'pz', name: 'Pizzas', subcats: ['Clásicas', 'Especiales'] }, { id: 'pa', name: 'Pastas' }, { id: 'be', name: 'Bebidas' }],
    extras_by_category: { pz: ['Orilla rellena'], pa: ['Pan de ajo'] },
    pickup_only_cats: ['pa'],
    weekend_only_cats: ['pa'],
    redeem_eligible_cats: ['pz'],
  },
});

// A saved group, made by the real writers: portal mutators → server allocateAdditions → adopt.
function withGroup() {
  const d = createDraft(BASE());
  addProduct(d, { ref: 'tmp:cuatroq1', cat: 'pz', subcat: 'Especiales' });
  setAddition(d, 'tmp:cuatroq1', 'name', 'Pizza Cuatro Quesos');
  setAddition(d, 'tmp:cuatroq1', 'desc', 'Mozzarella, gorgonzola, parmesano y provolone');
  setRequiredChoice(d, 'tmp:cuatroq1', true, ['tmp:opt00001', 'tmp:opt00002', 'tmp:opt00003']);
  setGroupLabel(d, 'tmp:cuatroq1', 'Tamaño');
  [['tmp:opt00001', 'Personal', '190'], ['tmp:opt00002', 'Mediana', '290'], ['tmp:opt00003', 'Familiar', '390']]
    .forEach(([r, c, p]) => { setChoiceName(d, r, c); setChoicePrice(d, r, p); });
  const res = AP.allocateAdditions({ incoming: draftSource(d), stored: null, activeItems: BASE().items, keyMode: 'name', hwm: null,
    registryHasKey: () => false, authoring: true });
  const published = createDraft(BASE());
  adopt(published, res.source);
  return createDraft(draftSource(published));   // the group is now part of the loaded (published) document
}
const item = (d, key) => draftSource(d).items.find((r) => r.key === key);
const launcherKey = 'Pizza Cuatro Quesos';

// ── editor.js: editItem — ONE whole-drawer write, all or nothing ─────────────────────────────────────────────────────
test('editItem — name, description, category and subcategory of an EXISTING product land together; the key and display.id never move', () => {
  const d = createDraft(BASE());
  const ok = editItem(d, 'Pizza Cacio e Pepe', { name: '  Cacio   e Pepe ', desc: 'Pecorino y pimienta negra', cat: 'pz', subcat: 'Clásicas' });
  assert.equal(ok, true);
  const r = item(d, 'Pizza Cacio e Pepe');
  assert.equal(r.key, 'Pizza Cacio e Pepe', 'the key is frozen (the server records the rename)');
  assert.equal(r.display.id, 2, 'display.id untouched');
  assert.equal(r.display.name, 'Cacio e Pepe', 'trimmed, inner runs collapsed (the server tidyName)');
  assert.equal(r.display.desc, 'Pecorino y pimienta negra');
  assert.equal(r.display.subcat, 'Clásicas');
});

test('editItem — ANY invalid field refuses the WHOLE edit: nothing is written (no half-saved name next to a price)', () => {
  const d = createDraft(BASE());
  const before = JSON.stringify(draftSource(d));
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe', price: '12abc' }), false, 'an invalid price');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'x'.repeat(61), price: '300' }), false, 'a name over 60');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Pizza "Cacio"', price: '300' }), false, 'a quote in a name');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { desc: 'd'.repeat(201) }), false, 'a description over 200');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'pizza pepperoni' }), false, 'another product\'s name (case / accent folded)');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Pan de ajo' }), false, 'an extra\'s name');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'i_abcdefghjkmn' }), false, 'the opaque id syntax');
  assert.equal(editItem(d, 'Limonada de hierbabuena', { cat: 'pa' }), false, 'it would leave Bebidas empty');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { subcat: 'Clásicas', cat: 'pz', name: '' }), false, 'an empty name');
  assert.equal(JSON.stringify(draftSource(d)), before, 'the draft is byte-identical after every refusal');
});

test('editItem — moving INTO a section with subsections requires one of ITS subsections (no preselect); a move out drops the old one', () => {
  const d = createDraft(BASE());
  assert.equal(editItem(d, 'Lasaña', { cat: 'pz' }), false, 'no subcategory chosen');
  assert.equal(editItem(d, 'Lasaña', { cat: 'pz', subcat: 'Inventada' }), false, 'not one of Pizzas\' subsections');
  assert.equal(editItem(d, 'Lasaña', { cat: 'pz', subcat: 'Especiales' }), true);
  assert.equal(item(d, 'Lasaña').display.subcat, 'Especiales');
  assert.equal(editItem(d, 'Pizza Pepperoni', { cat: 'pa' }), true);
  assert.ok(!('subcat' in item(d, 'Pizza Pepperoni').display), 'the old subsection does not travel to a section without any');
});

test('editItem — a move that empties a SUBSECTION is refused too (Clásicas would lose its only product)', () => {
  const d = createDraft(BASE());
  assert.equal(draftSource(d).items.filter((r) => r.display.subcat === 'Clásicas').length, 1, 'premise: Clásicas holds Margarita only');
  assert.equal(editItem(d, 'Pizza Margarita', { cat: 'pz', subcat: 'Especiales' }), false);
  assert.equal(editItem(d, 'Pizza Margarita', { cat: 'pa' }), false, 'leaving the section entirely empties Clásicas too');
  assert.equal(IE.categoryProblem(d, 'Pizza Margarita', { cat: 'pz', subcat: 'Especiales' }), 'subsection_empty');
  assert.equal(IE.categoryProblem(d, 'Pizza Cacio e Pepe', { cat: 'pz', subcat: 'Clásicas' }), null, 'Especiales keeps Pepperoni');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { cat: 'pz', subcat: 'Clásicas' }), true);
});

test('editItem — a GROUP renames with its options: every option is «{producto} - {opción}», choices / keys / prices untouched; the move propagates', () => {
  const d = withGroup();
  const before = draftSource(d).items.filter((r) => r.display.variantOf != null).map((r) => ({ key: r.key, choice: r.display.choice, price: r.price, id: r.display.id }));
  assert.equal(before.length, 3, 'premise: the server made three options');
  assert.equal(editItem(d, launcherKey, { name: 'Pizza Cuatro Quesos Especial', cat: 'pa' }), true);
  const opts = draftSource(d).items.filter((r) => r.display.variantOf != null);
  assert.deepEqual(opts.map((r) => r.display.name), ['Personal', 'Mediana', 'Familiar'].map((c) => `Pizza Cuatro Quesos Especial - ${c}`));
  assert.deepEqual(opts.map((r) => ({ key: r.key, choice: r.display.choice, price: r.price, id: r.display.id })), before, 'identities, choices and prices kept');
  assert.ok(opts.every((r) => r.display.cat === 'pa' && !('subcat' in r.display)), 'category and subcategory propagate to every option');
});

test('editItem — a group rename whose LONGEST derived option name passes 60 is refused (option_name_too_long), even with the product name ≤ 60', () => {
  const d = withGroup();
  const name = 'Pizza Cuatro Quesos con Orilla Rellena de Requesón';   // 50 chars; «… - Personal» / «… - Familiar» = 61
  assert.ok([...name].length <= 60 && [...`${name} - Familiar`].length > 60, 'premise');
  assert.equal(itemNameProblem(d, launcherKey, name), 'option_long');
  assert.equal(editItem(d, launcherKey, { name }), false);
});

test('editItem — an option is never edited on its own (it moves with its product); an unsaved addition is not this mutator\'s either', () => {
  const d = withGroup();
  const opt = draftSource(d).items.find((r) => r.display.variantOf != null);
  assert.equal(editItem(d, opt.key, { name: 'x' }), false);
  addProduct(d, { ref: 'tmp:newone01', cat: 'pa' });
  assert.equal(editItem(d, 'tmp:newone01', { name: 'Nueva' }), false, 'setAddition owns an unsaved row');
});

test('editItem — a name / description equal to the loaded one is GRANDFATHERED (the server caps only newly authored values)', () => {
  const src = BASE();
  src.items[3].display.name = 'L'.repeat(70); src.items[3].key = 'L'.repeat(70); src.structure.item_order[3] = 'L'.repeat(70);
  const d = createDraft(src);
  assert.equal(itemNameProblem(d, 'L'.repeat(70), 'L'.repeat(70)), null, 'unchanged long name passes');
  assert.equal(editItem(d, 'L'.repeat(70), { name: 'L'.repeat(70), desc: 'nueva' }), true, 'only the description changed');
});

test('editItem — refused while a section name waits (a rename publishes alone) and while the draft is owned', () => {
  const d = createDraft(BASE());
  setCategoryNames(d, [['pz', 'Pizzas de la casa']]);
  assert.equal(editItem(d, 'Lasaña', { name: 'Lasaña boloñesa' }), false, 'a pending section name holds every content write');
  const owned = createDraft(BASE(), { canEdit: () => false });
  assert.equal(editItem(owned, 'Lasaña', { name: 'Lasaña boloñesa' }), false);
});

test('pendingTexts / pendingCount — a text or category change is pending work (the dirty guard and the bar count it)', () => {
  const d = createDraft(BASE());
  assert.equal(pendingCount(d), 0);
  editItem(d, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe', desc: 'Pecorino', cat: 'pa' });
  assert.deepEqual(pendingTexts(d), [{ key: 'Pizza Cacio e Pepe', fields: ['name', 'desc', 'cat'] }]);
  assert.equal(pendingCount(d), 3, 'one per changed field (Nombre, Descripción, Categoría)');
  setItemPrice(d, 'Pizza Cacio e Pepe', '300');
  assert.equal(pendingCount(d), 4, 'mockup B: «4 cambios sin publicar · 1 producto»');
  editItem(d, 'Pizza Cacio e Pepe', { name: 'Pizza Cacio e Pepe', desc: 'Parmesano, mozzarella y pimienta.', cat: 'pz', subcat: 'Especiales' });
  assert.deepEqual(pendingTexts(d), [], 'typed back to the loaded values: nothing pending');
});

test('pendingTexts — a group rename is ONE product change (its options\' derived names are not counted again)', () => {
  const d = withGroup();
  editItem(d, launcherKey, { name: 'Pizza Cuatro Quesos Especial' });
  assert.deepEqual(pendingTexts(d), [{ key: launcherKey, fields: ['name'] }]);
});

// ── item-edit-logic.js: the drawer's working copy ────────────────────────────────────────────────────────────────────
test('drawer A — opened: the six fields from the draft, counters «18/60» / «33/200», «Guardar» off with «No hay cambios que guardar»', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  const v = IE.view(d, s);
  assert.equal(v.fields.name, 'Pizza Cacio e Pepe');
  assert.equal(v.counters.name, '18/60');
  assert.equal(v.counters.desc, '33/200');
  assert.deepEqual(v.subcats, ['Clásicas', 'Especiales']);
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'No hay cambios que guardar');
  assert.equal(v.consequences, null);
});

test('drawer B — typing changes the COPY only; the shared draft is untouched until «Guardar»', () => {
  const d = createDraft(BASE());
  const before = JSON.stringify(draftSource(d));
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  IE.set(s, 'price', '300');
  assert.equal(JSON.stringify(draftSource(d)), before, 'nothing written while editing');
  const v = IE.view(d, s);
  assert.equal(v.counters.name, '12/60');
  assert.equal(v.save.enabled, true);
  assert.equal(v.save.title, null);
  assert.deepEqual(v.changed, ['name', 'price'], 'the change marks (mockup B: the field takes the changed tint)');
});

test('drawer C — every name error is the mockup\'s line, and each keeps «Guardar» off with its title hint', () => {
  const d = createDraft(BASE());
  const cases = [
    ['', 'Escribí un nombre', 'Corregí el nombre para guardar'],
    ['x'.repeat(63), 'Hasta 60 letras', 'Acortá el nombre para guardar'],
    ['Pizza "Cacio e Pepe" <b>', 'Quitá las comillas y los signos < >', 'Corregí el nombre para guardar'],
    ["Pizza D'Angelo", 'Quitá las comillas y los signos < >', 'Corregí el nombre para guardar'],
    ['Pizza Pepperoni', 'Ya hay un producto con ese nombre', 'Corregí el nombre para guardar'],
    ['i_abcdefghjkmn', 'Ese nombre no está disponible', 'Corregí el nombre para guardar'],
  ];
  for (const [typed, line, title] of cases) {
    const s = IE.open(d, 'Pizza Cacio e Pepe');
    IE.set(s, 'name', typed);
    const v = IE.view(d, s);
    assert.equal(v.errors.name, line, `«${typed}»`);
    assert.equal(v.save.enabled, false, `«${typed}»: Guardar off`);
    assert.equal(v.save.title, title, `«${typed}»: title`);
  }
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'x'.repeat(63));
  assert.equal(IE.view(d, s).counters.name, '63/60', 'the box lets the owner type past 60 to see what to trim');
  IE.set(s, 'desc', 'd'.repeat(201));
  IE.set(s, 'name', 'Cacio e Pepe');
  assert.equal(IE.view(d, s).errors.desc, 'Hasta 200 letras');
  assert.equal(IE.view(d, s).save.enabled, false);
});

test('drawer D — a move lists exactly its consequences, «Al mover a Pastas:» + one line per fact; Subcategoría disappears', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'cat', 'pa');
  const v = IE.view(d, s);
  assert.equal(v.subcats, null, 'Pastas has no subsections: the field is hidden');
  assert.deepEqual(v.consequences, { title: 'Al mover a Pastas:', lines: [
    'Deja de aceptar el extra Orilla rellena',
    'Acepta el extra Pan de ajo',
    'Queda solo para recoger',
    'Pasa a venderse solo los fines de semana',
    'Deja de canjearse con puntos',
  ] });
  assert.equal(v.save.enabled, true);
  // and back: the inverse lines
  const s2 = IE.open(d, 'Lasaña');
  IE.set(s2, 'cat', 'pz');
  IE.set(s2, 'subcat', 'Clásicas');
  assert.deepEqual(IE.view(d, s2).consequences.lines, [
    'Deja de aceptar el extra Pan de ajo', 'Acepta el extra Orilla rellena',
    'Vuelve a entregarse a domicilio', 'Pasa a venderse todos los días', 'Pasa a canjearse con puntos',
  ]);
});

test('drawer D — a move with no consequence shows NO note; a menu that declares no extras exposure says nothing about extras', () => {
  const src = BASE();
  src.structure.categories.push({ id: 'en', name: 'Ensaladas' });
  src.items.push({ key: 'César', price: 150, display: { id: 7, cat: 'en', name: 'César', price: 150 } },
    { key: 'Caprese', price: 150, display: { id: 8, cat: 'en', name: 'Caprese', price: 150 } });
  src.structure.item_order.push('César', 'Caprese');
  const d = createDraft(src);
  const s = IE.open(d, 'César');
  IE.set(s, 'cat', 'be');
  assert.equal(IE.view(d, s).consequences, null);
  delete src.structure.extras_by_category;
  const d2 = createDraft(src);
  const s2 = IE.open(d2, 'Pizza Margarita');
  IE.set(s2, 'cat', 'pa');
  assert.ok(!IE.view(d2, s2).consequences.lines.some((l) => /extra/.test(l)), 'no exposure declared: no extras line (never a guess)');
});

test('drawer D2 — the move that would empty a section is refused in the field: the mockup\'s line, «Guardar» off', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Limonada de hierbabuena');
  IE.set(s, 'cat', 'pa');
  const v = IE.view(d, s);
  assert.equal(v.errors.cat, 'No podés dejar la sección vacía. Agregá otro producto primero.');
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'Elegí otra categoría para guardar');
  const s2 = IE.open(d, 'Pizza Margarita');
  IE.set(s2, 'subcat', 'Especiales');
  assert.equal(IE.view(d, s2).errors.cat, 'No podés dejar la subcategoría vacía. Agregá otro producto primero.', 'the subsection reads «subcategoría»');
});

test('drawer — moving INTO a section with subsections: no preselect, «Guardar» off until one is chosen', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Lasaña');
  IE.set(s, 'cat', 'pz');
  let v = IE.view(d, s);
  assert.deepEqual(v.subcats, ['Clásicas', 'Especiales']);
  assert.equal(v.fields.subcat, null, 'nothing preselected');
  assert.equal(v.save.enabled, false);
  IE.set(s, 'subcat', 'Especiales');
  v = IE.view(d, s);
  assert.equal(v.save.enabled, true);
  IE.set(s, 'cat', 'pa');
  IE.set(s, 'cat', 'pz');
  assert.equal(IE.view(d, s).fields.subcat, null, 'a category change clears the previous subcategory');
});

test('drawer F — a group previews every derived option name; one over 60 is the mockup\'s F2 line', () => {
  const d = withGroup();
  const s = IE.open(d, launcherKey);
  IE.set(s, 'name', 'Pizza Cuatro Quesos Especial');
  let v = IE.view(d, s);
  assert.deepEqual(v.options.map((o) => o.fullName), ['Personal', 'Mediana', 'Familiar'].map((c) => `Pizza Cuatro Quesos Especial - ${c}`));
  assert.ok(v.options.every((o) => !o.tooLong));
  assert.deepEqual(v.options.map((o) => o.counter), ['39/60', '38/60', '39/60'], 'mockup F: each option name has its own counter');
  IE.set(s, 'name', 'Pizza Cuatro Quesos con Orilla Rellena de Requesón');
  v = IE.view(d, s);
  assert.equal(v.errors.name, 'El nombre completo de la opción supera 60 letras');
  assert.deepEqual(v.options.map((o) => o.tooLong), [true, false, true], 'only the two 8-letter choices pass 60');
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'Acortá el nombre para guardar');
});

test('drawer — «Guardar» commits the whole edit ONCE; a second «Guardar» (double click) writes nothing more', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  IE.set(s, 'price', '300');
  assert.deepEqual(IE.save(d, s), { ok: true });
  const after = JSON.stringify(draftSource(d));
  assert.equal(item(d, 'Pizza Cacio e Pepe').display.name, 'Cacio e Pepe');
  assert.equal(item(d, 'Pizza Cacio e Pepe').price, 300);
  assert.deepEqual(IE.save(d, s), { ok: false, error: 'closed' });
  IE.set(s, 'name', 'Otra cosa');
  assert.equal(JSON.stringify(draftSource(d)), after, 'a closed session neither saves nor edits');
});

test('drawer — «Cancelar» discards the copy and keeps EARLIER draft changes', () => {
  const d = createDraft(BASE());
  setItemPrice(d, 'Lasaña', '300');   // an earlier change, outside this drawer
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  IE.cancel(s);
  assert.equal(item(d, 'Pizza Cacio e Pepe').display.name, 'Pizza Cacio e Pepe');
  assert.equal(item(d, 'Lasaña').price, 300, 'the earlier change is kept');
  assert.deepEqual(IE.save(d, s), { ok: false, error: 'closed' });
});

test('drawer — an invalid field refuses «Guardar» and leaves the draft untouched (the drawer never closes on its own)', () => {
  const d = createDraft(BASE());
  const before = JSON.stringify(draftSource(d));
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Pizza Pepperoni');
  assert.deepEqual(IE.save(d, s), { ok: false, error: 'invalid' });
  assert.equal(JSON.stringify(draftSource(d)), before);
  IE.set(s, 'name', 'Cacio e Pepe');
  assert.deepEqual(IE.save(d, s), { ok: true }, 'the same session saves once corrected');
});

test('drawer photo — an upload lands in the COPY of the session that started it; «Guardar» puts it in the draft with the rest', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  assert.equal(IE.view(d, s).save.enabled, true, 'premise: a valid change, «Guardar» on');
  const bind = IE.uploadBinding(s);
  bind.started();
  assert.equal(IE.view(d, s).save.enabled, false, 'an upload in flight holds «Guardar» (it waits for the photo to be usable)');
  assert.equal(bind.apply('pid_abc'), true);
  assert.deepEqual(draftSource(d).photos, undefined, 'not in the draft yet');
  assert.equal(IE.view(d, s).save.enabled, true);
  assert.deepEqual(IE.save(d, s), { ok: true });
  assert.deepEqual(draftSource(d).photos, { 'Pizza Cacio e Pepe': { state: 'pid', pid: 'pid_abc' } });
});

test('drawer photo — a LATE upload from a cancelled drawer, or from a replaced one, never touches the draft or the new drawer', () => {
  const d = createDraft(BASE());
  const s1 = IE.open(d, 'Pizza Cacio e Pepe');
  const late = IE.uploadBinding(s1);
  late.started();
  IE.cancel(s1);
  assert.equal(late.apply('pid_late'), false, 'the cancelled session refuses it');
  assert.equal(draftSource(d).photos, undefined);
  const s2 = IE.open(d, 'Pizza Cacio e Pepe');
  const first = IE.uploadBinding(s2);
  first.started();
  const second = IE.uploadBinding(s2);    // «Cambiar» again: the newer upload replaces the first
  second.started();
  assert.equal(first.apply('pid_first'), false, 'a replaced upload is dropped');
  assert.equal(second.apply('pid_second'), true);
  IE.save(d, s2);
  assert.deepEqual(draftSource(d).photos, { 'Pizza Cacio e Pepe': { state: 'pid', pid: 'pid_second' } });
  assert.equal(late.apply('pid_late'), false, 'and the first drawer\'s upload still never lands');
});

test('drawer photo — a failed upload offers retry / remove: «Guardar» is not held by a failure, and «Quitar» clears it', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  const b = IE.uploadBinding(s);
  b.started();
  b.failed();
  assert.equal(IE.view(d, s).photo.failed, true);
  assert.equal(IE.view(d, s).save.enabled, true, 'the failure is not a hold: the merchant may save the texts and retry later');
  IE.set(s, 'photo', { state: 'removed' });
  assert.equal(IE.view(d, s).photo.failed, false);
});

test('drawer photo — after «Guardar», a late answer from that drawer\'s upload never lands (the session is closed)', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  const b = IE.uploadBinding(s);
  b.started();
  b.failed();                                   // not a hold: the merchant saves the texts
  assert.deepEqual(IE.save(d, s), { ok: true });
  assert.equal(b.apply('pid_late'), false, 'a retried upload answering after the save is refused');
  assert.equal(draftSource(d).photos, undefined);
});

test('drawer — a stale draft (the session opened on a draft that was reloaded) refuses «Guardar» instead of writing over the new load', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'name', 'Cacio e Pepe');
  const d2 = createDraft(BASE());                    // a reload built a new draft object
  assert.deepEqual(IE.save(d2, s), { ok: false, error: 'stale' });
  assert.equal(item(d2, 'Pizza Cacio e Pepe').display.name, 'Pizza Cacio e Pepe');
});
