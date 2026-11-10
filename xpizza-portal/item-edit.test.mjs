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
const { validateSource } = createRequire(import.meta.url)('../xpizza-functions/catalog/source-store.js');
// THE ONE eligibility rule (S2 §1.6): the page loads it as a classic script (globals, the avail-key pattern); the tests install
// the SERVER's own module the same way — the real writer, never a laxer fake.
const EE = createRequire(import.meta.url)('../xpizza-functions/catalog/extras-eligibility.js');
Object.assign(globalThis, { projectEligibility: EE.projectEligibility, eligibleSet: EE.eligibleSet });

// Pizzas has subsections (Clásicas / Especiales); Pastas, Ensaladas none; Bebidas holds one product (the D2 refusal).
const BASE = () => ({
  restaurant_id: 'merch_a',
  schema_version: 2,
  items: [
    { key: 'Pizza Margarita', price: 220, display: { id: 1, cat: 'pz', subcat: 'Clásicas', name: 'Pizza Margarita', price: 220, desc: 'Tomate, mozzarella fresca y albahaca' } },
    { key: 'Pizza Cacio e Pepe', price: 260, display: { id: 2, cat: 'pz', subcat: 'Especiales', name: 'Pizza Cacio e Pepe', price: 260, desc: 'Parmesano, mozzarella y pimienta.' } },
    { key: 'Pizza Pepperoni', price: 240, display: { id: 3, cat: 'pz', subcat: 'Especiales', name: 'Pizza Pepperoni', price: 240 } },
    { key: 'Lasaña', price: 280, display: { id: 4, cat: 'pa', name: 'Lasaña', price: 280 } },
    { key: 'Ravioles', price: 270, display: { id: 5, cat: 'pa', name: 'Ravioles', price: 270 } },
    { key: 'Limonada de hierbabuena', price: 60, display: { id: 6, cat: 'be', name: 'Limonada de hierbabuena', price: 60, desc: 'Con hielo y menta fresca' } },
  ],
  extras: [
    { key: 'Orilla de queso', price: 50, display: { id: 'e1', cat: 'Orilla rellena', name: 'Orilla de queso', price: 50 } },
    { key: 'Pan de ajo con queso', price: 45, display: { id: 'e2', cat: 'Pan de ajo', name: 'Pan de ajo con queso', price: 45 } },
  ],
  structure: {
    schema_version: 2,
    item_order: ['Pizza Margarita', 'Pizza Cacio e Pepe', 'Pizza Pepperoni', 'Lasaña', 'Ravioles', 'Limonada de hierbabuena'],
    categories: [{ id: 'pz', name: 'Pizzas', subcats: ['Clásicas', 'Especiales'] }, { id: 'pa', name: 'Pastas' }, { id: 'be', name: 'Bebidas' }],
    // the eligibility AUTHORITY (S2 §1.1): exposure.category_allow, read by the shared evaluator — not extras_by_category
    extra_categories: ['Orilla rellena', 'Pan de ajo'],
    exposure: { category_allow: { pz: ['Orilla rellena'], pa: ['Pan de ajo'] }, item_overrides: {} },
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
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Pan de ajo con queso' }), false, 'an extra\'s name');
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

test('drawer — the holds the mockup draws no title for (advisor Q4): description, subcategory, photo upload', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'desc', 'Con <b>queso</b>');
  assert.equal(IE.view(d, s).save.title, 'Corregí la descripción para guardar', 'markup in the description');
  IE.set(s, 'desc', 'd'.repeat(201));
  assert.equal(IE.view(d, s).save.title, 'Corregí la descripción para guardar', 'over 200');
  const s2 = IE.open(d, 'Lasaña');
  IE.set(s2, 'cat', 'pz');
  assert.equal(IE.view(d, s2).save.title, 'Elegí una subcategoría');
  const s3 = IE.open(d, 'Lasaña');
  IE.set(s3, 'name', 'Lasaña boloñesa');
  IE.uploadBinding(s3).started();
  assert.equal(IE.view(d, s3).save.title, 'Esperá a que termine de subir la foto');
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
  delete src.structure.exposure;
  const d2 = createDraft(src);
  const s2 = IE.open(d2, 'Pizza Pepperoni');   // a move that is NOT refused (Especiales keeps Cacio e Pepe): a refused move shows no note
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
  assert.equal(IE.view(d, s2).errors.subcat, 'No podés dejar la subcategoría vacía. Agregá otro producto primero.', 'the subsection reads «subcategoría» — under Subcategoría (same section, C-2)');
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
  assert.equal(v.errors.options, 'El nombre completo de la opción supera 60 letras', 'mockup F2: the line sits under the Opciones block');
  assert.equal(v.errors.name, null, 'mockup F2: the Nombre field itself is not marked invalid');
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

// ── Phase 2: the S2 contract (S2-DESIGN §1 r2, approved 11-10) ──────────────────────────────────────────────────────────
test('premise — the fixture is a source the SERVER accepts (validateSource), the eligibility authority included', () => {
  assert.doesNotThrow(() => validateSource(BASE(), 'merch_a'));
  assert.doesNotThrow(() => validateSource(draftSource(withGroup()), 'merch_a'));
});

test('C5 live — a served reserved name reads «Ese nombre no está disponible»; the record\'s OWN key never does (a rename back passes)', () => {
  const d = createDraft(BASE());
  const ctx = ['hawaiana', 'pizza cacio e pepe'];   // reservedNames as served: folded by the server's normalizeName
  const s = IE.open(d, 'Pizza Cacio e Pepe', ctx);
  IE.set(s, 'name', '  HAWAIANA ');
  assert.equal(IE.view(d, s).errors.name, 'Ese nombre no está disponible', 'normalized: case and spaces folded');
  IE.set(s, 'name', 'Háwaiana');
  assert.equal(IE.view(d, s).errors.name, 'Ese nombre no está disponible', 'normalized: accents folded');
  IE.set(s, 'name', 'Cacio e Pepe');
  assert.equal(IE.view(d, s).errors.name, null);
  const back = createDraft(BASE());
  editItem(back, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe' });
  const s2 = IE.open(createDraft(draftSource(back)), 'Pizza Cacio e Pepe', ctx);
  IE.set(s2, 'name', 'Pizza Cacio e Pepe');
  assert.equal(IE.view(s2.draft, s2).errors.name, null, 'the product\'s own key is reserved for it alone: the rename back passes');
  const noCtx = IE.open(createDraft(BASE()), 'Pizza Cacio e Pepe');
  IE.set(noCtx, 'name', 'Hawaiana');
  assert.equal(IE.view(noCtx.draft, noCtx).errors.name, null, 'reservedNames absent (degraded): the server decides on «Guardar»');
  IE.set(noCtx, 'name', 'i_abcdefghijk2');
  assert.equal(IE.view(noCtx.draft, noCtx).errors.name, 'Ese nombre no está disponible', 'the opaque syntax, always');
});

test('C5 live, a group — each derived option name is judged with ITS OWN key exempt; another record\'s key is not', () => {
  const d = withGroup();
  const optKeys = IE.view(d, IE.open(d, launcherKey)).options.map((o) => o.key);
  const ctx = [launcherKey, ...optKeys].map((k) => k.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim());
  const renamed = createDraft(draftSource(d));
  editItem(renamed, launcherKey, { name: 'Pizza Cuatro Quesos Especial' });
  const s = IE.open(createDraft(draftSource(renamed)), launcherKey, ctx);
  IE.set(s, 'name', 'Pizza Cuatro Quesos');
  assert.equal(IE.view(s.draft, s).errors.name, null, 'every option takes back its own key: the group rename back passes');
  const other = [...ctx, 'pizza cuatro quesos clasica - personal'];
  const s3 = IE.open(createDraft(draftSource(renamed)), launcherKey, other);
  IE.set(s3, 'name', 'Pizza Cuatro Quesos Clásica');
  assert.equal(IE.view(s3.draft, s3).errors.name, 'Ese nombre no está disponible', 'a derived name held by ANOTHER record is refused');
  assert.equal(editItem(createDraft(draftSource(renamed)), launcherKey, { name: 'Pizza Cuatro Quesos Clásica' }, { reserved: new Set(other) }), false, 'the commit gate judges the same set');
});

test('G1 — a description with < > reads «Quitá los signos < >» (quotes are fine there) and holds «Guardar»', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'desc', 'La "clásica" de Roma');
  assert.equal(IE.view(d, s).errors.desc, null, 'quotes are allowed in a description');
  IE.set(s, 'desc', 'Pecorino <b>romano</b>');
  const v = IE.view(d, s);
  assert.equal(v.errors.desc, 'Quitá los signos < >');
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'Corregí la descripción para guardar');
});

test('D — extras by THE ONE rule: a group\'s line is the UNION over its members, each with its own overrides (Codex r2 probe)', () => {
  const g = withGroup();
  const src = draftSource(g);
  const opt = (choice) => src.items.find((r) => r.display && r.display.choice === choice).key;
  src.structure.exposure.item_overrides = { [launcherKey]: { deny: ['*'] }, [opt('Personal')]: { add: ['Pan de ajo'] } };
  assert.doesNotThrow(() => validateSource(src, 'merch_a'), 'premise: a source the server accepts');
  const d = createDraft(src);
  const s = IE.open(d, launcherKey);
  IE.set(s, 'cat', 'pa');
  const lines = IE.view(d, s).consequences.lines.filter((l) => /extra/.test(l));
  assert.deepEqual(lines, ['Deja de aceptar el extra Orilla rellena'],
    'the launcher (deny *) accepts nothing either side; Personal loses Orilla rellena and keeps Pan de ajo — reported on the launcher');
});

test('D — a product that denied every extra of a group accepted none: moving it away says nothing about that group', () => {
  const src = BASE();
  src.structure.exposure.item_overrides = { 'Pizza Cacio e Pepe': { deny: ['Orilla rellena'] } };
  const d = createDraft(src);
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'cat', 'pa');
  assert.deepEqual(IE.view(d, s).consequences.lines.filter((l) => /extra/.test(l)), ['Acepta el extra Pan de ajo']);
});

test('D — without the shared evaluator a move is HELD (never a guessed consequence); nothing else is', () => {
  const saved = { p: globalThis.projectEligibility, e: globalThis.eligibleSet };
  delete globalThis.projectEligibility; delete globalThis.eligibleSet;
  try {
    const d = createDraft(BASE());
    const s = IE.open(d, 'Pizza Cacio e Pepe');
    IE.set(s, 'name', 'Cacio e Pepe');
    assert.equal(IE.view(d, s).save.enabled, true, 'a rename does not need the evaluator');
    IE.set(s, 'cat', 'pa');
    const v = IE.view(d, s);
    assert.equal(v.save.enabled, false);
    assert.equal(v.save.title, 'Elegí otra categoría para guardar');
    assert.ok(!v.consequences.lines.some((l) => /extra/.test(l)));
  } finally { Object.assign(globalThis, { projectEligibility: saved.p, eligibleSet: saved.e }); }
});

test('Q2 — the extras-group prices ride the working copy: «Cancelar» discards them, «Guardar» writes them with the rest, once', () => {
  const d = createDraft(BASE());
  const before = JSON.stringify(draftSource(d));
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s, 'extraPrice', { key: 'Pan de ajo con queso', raw: '55' });
  assert.deepEqual(IE.view(d, s).changed, ['extraPrices']);
  IE.cancel(s);
  assert.equal(JSON.stringify(draftSource(d)), before, '«Cancelar»: the draft is untouched');
  const s2 = IE.open(d, 'Pizza Cacio e Pepe');
  IE.set(s2, 'name', 'Cacio e Pepe');
  IE.set(s2, 'extraPrice', { key: 'Pan de ajo con queso', raw: 'abc' });
  assert.equal(IE.view(d, s2).save.enabled, false, 'an unusable extra price holds the whole save');
  assert.equal(IE.save(d, s2).ok, false);
  assert.equal(JSON.stringify(draftSource(d)), before, 'refused: nothing written');
  IE.set(s2, 'extraPrice', { key: 'Pan de ajo con queso', raw: '55' });
  assert.deepEqual(IE.save(d, s2), { ok: true });
  const src = draftSource(d);
  assert.equal(src.extras.find((x) => x.key === 'Pan de ajo con queso').price, 55);
  assert.equal(src.items.find((x) => x.key === 'Pizza Cacio e Pepe').display.name, 'Cacio e Pepe');
});

test('Q1 — «Mismo precio para todas» sets every option to the cheapest usable price; editing one option turns it off', () => {
  const d = withGroup();
  const s = IE.open(d, launcherKey);
  assert.equal(IE.view(d, s).same, false, 'unequal prices: off');
  IE.set(s, 'samePrice', true);
  let v = IE.view(d, s);
  assert.deepEqual(v.options.map((o) => o.price), ['190', '190', '190']);
  assert.equal(v.same, true);
  IE.set(s, 'optionPrice', { key: v.options[2].key, raw: '400' });
  v = IE.view(d, s);
  assert.equal(v.same, false);
  assert.deepEqual(IE.save(d, s), { ok: true });
  assert.deepEqual(draftSource(d).items.filter((r) => r.display && r.display.choice).map((r) => r.price), [190, 190, 400]);
});

test('refusalLine — every field-tagged S2 code lands on its field with the approved line; options carry the F2 placement', () => {
  const L = (body) => { const r = IE.refusalLine({ key: 'Pizza Cacio e Pepe', ...body }); return r && [r.field, r.message]; };
  assert.deepEqual(L({ error: 'name_required', field: 'name' }), ['name', 'Escribí un nombre']);
  assert.deepEqual(L({ error: 'name_too_long', field: 'name' }), ['name', 'Hasta 60 letras']);
  assert.deepEqual(L({ error: 'option_name_too_long', field: 'name', option_key: 'x' }), ['options', 'El nombre completo de la opción supera 60 letras']);
  assert.deepEqual(L({ error: 'desc_too_long', field: 'desc' }), ['desc', 'Hasta 200 letras']);
  assert.deepEqual(L({ error: 'text_unsafe', field: 'name' }), ['name', 'Quitá las comillas y los signos < >']);
  assert.deepEqual(L({ error: 'text_unsafe', field: 'desc' }), ['desc', 'Quitá los signos < >']);
  assert.deepEqual(L({ error: 'name_taken', field: 'name' }), ['name', 'Ya hay un producto con ese nombre']);
  assert.deepEqual(L({ error: 'name_taken', field: 'name', option_key: 'x' }), ['options', 'Ya hay un producto con ese nombre']);
  for (const e of ['name_previously_used', 'rename_id_conflict', 'reserved_key_conflict']) assert.deepEqual(L({ error: e, field: 'name' }), ['name', 'Ese nombre no está disponible'], e);
  assert.deepEqual(L({ error: 'subcat_invalid', field: 'subcat' }), ['subcat', 'Elegí una subcategoría']);
  assert.deepEqual(L({ error: 'section_emptied', field: 'cat' }), ['cat', 'No podés dejar la sección vacía. Agregá otro producto primero.']);
  assert.deepEqual(L({ error: 'subsection_emptied', field: 'subcat' }), ['subcat', 'No podés dejar la subcategoría vacía. Agregá otro producto primero.']);
  assert.deepEqual(L({ error: 'subsection_emptied', field: 'cat' }), ['cat', 'No podés dejar la subcategoría vacía. Agregá otro producto primero.'], 'a cross-section move: the line under Categoría');
  assert.deepEqual(L({ error: 'category_not_renderable', field: 'cat' }), ['cat', 'Esa sección no se muestra en tu página de pedidos']);
  assert.equal(IE.refusalLine({ error: 'category_not_renderable', key: 'k', field: 'cat' }).reread, true, 'C-1: the drawer re-reads the sections');
  assert.equal(IE.refusalLine({ error: 'stale_edit' }), null);
  assert.equal(IE.refusalLine({ error: 'name_taken', field: 'name' }), null, 'no key: not a product refusal');
});

test('a server line shows on its field and holds «Guardar» until the merchant changes THAT field', () => {
  const d = createDraft(BASE());
  const s = IE.open(d, 'Pizza Cacio e Pepe');
  IE.setServerError(s, IE.refusalLine({ error: 'name_previously_used', key: 'Pizza Cacio e Pepe', field: 'name' }));
  IE.set(s, 'desc', 'Pecorino');
  let v = IE.view(d, s);
  assert.equal(v.errors.name, 'Ese nombre no está disponible');
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'Corregí el nombre para guardar');
  IE.set(s, 'name', 'Cacio e Pepe');
  v = IE.view(d, s);
  assert.equal(v.errors.name, null);
  assert.equal(v.save.enabled, true);
  const other = IE.open(d, 'Pizza Margarita');
  IE.setServerError(other, IE.refusalLine({ error: 'name_taken', key: 'Pizza Cacio e Pepe', field: 'name' }));
  assert.equal(other.serverError, null, 'a line for another product never lands here');
});

test('editItem — an unusable extras-group price refuses the WHOLE edit (the commit gate itself, not only the drawer\'s hold)', () => {
  const d = createDraft(BASE());
  const before = JSON.stringify(draftSource(d));
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe', extraPrices: { 'Pan de ajo con queso': 'abc' } }), false);
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe', extraPrices: { 'No existe': '40' } }), false, 'an unknown extra');
  assert.equal(JSON.stringify(draftSource(d)), before, 'nothing written');
  assert.equal(editItem(d, 'Pizza Cacio e Pepe', { name: 'Cacio e Pepe', extraPrices: { 'Pan de ajo con queso': '55' } }), true);
  assert.equal(draftSource(d).extras.find((x) => x.key === 'Pan de ajo con queso').price, 55);
});
test('Codex S4P2 r1 P2-4 (contract C-2) — emptying a subsection: same section → the line under Subcategoría; another section → under Categoría', () => {
  const d = createDraft(BASE());
  const same = IE.open(d, 'Pizza Margarita');   // the only product in Clásicas
  IE.set(same, 'subcat', 'Especiales');
  let v = IE.view(d, same);
  assert.equal(v.errors.subcat, 'No podés dejar la subcategoría vacía. Agregá otro producto primero.');
  assert.equal(v.errors.cat, null, 'Categoría is not the field at fault');
  assert.equal(v.save.enabled, false);
  assert.equal(v.save.title, 'Elegí una subcategoría');
  const cross = IE.open(d, 'Pizza Margarita');
  IE.set(cross, 'cat', 'pa');
  v = IE.view(d, cross);
  assert.equal(v.errors.cat, 'No podés dejar la subcategoría vacía. Agregá otro producto primero.');
  assert.equal(v.errors.subcat, null);
  assert.equal(v.save.title, 'Elegí otra categoría para guardar');
});
