// STRUCTURE S4 (UI) — the DRAWING half, step 1: «Nueva categoría» in the rail (MOCKUP-portal-structure-edit frame E, owner-approved: its
// strings are literal), the new (staged) category's page and dropping it (the S4 addendum's S4-C / S4-D: visually checked, copy PENDING
// the owner — every string it proposes is a ⟦s4.key⟧ placeholder and the SHIP GATE below stays red until it is approved). The REAL
// app.js in jsdom over index.html (drawer-harness.mjs), the REAL la_musa seed, the server's `sections` switch in getEditableCatalog's shape.
// Run: node --test --test-force-exit structure-s4-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editable, settle, page, SRC } from './drawer-harness.mjs';

const { S4_COPY } = await import('./render.js');
const P = (k) => `⟦s4.${k}⟧`;
const ON = () => editable({ sections: true });
const rail = (p) => p.d.getElementById('rail');
const items = (p) => [...rail(p).querySelectorAll('.railitem')];
const railAdd = (p) => rail(p).querySelector('button.railadd');
const box = (p) => rail(p).querySelector('.mk-newcat');
const boxBtn = (p, t) => [...box(p).querySelectorAll('.mk-btns button')].find((b) => b.textContent === t);
const detail = (p) => p.d.getElementById('detail');
async function create(p, name) {
  railAdd(p).click(); await settle(5);
  p.type(box(p).querySelector('input'), name); await settle(2);
  boxBtn(p, 'Crear').click(); await settle(10);
}

test('OFF (sections absent / not true): the rail is today\'s — no «Nueva categoría»', async () => {
  for (const over of [{}, { sections: 'true' }, { sections: false }]) {
    const p = await page({ read: () => editable(over) });
    await p.signIn();
    assert.ok(items(p).length > 0, 'premise: the rail');
    assert.equal(railAdd(p), null, `no action for ${JSON.stringify(over)}`);
  }
});

test('E — «Nueva categoría» at the rail\'s foot opens the inline box (label, counter, «Nombre de la categoría», «Cancelar» · «Crear»); the counter follows in place', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  const a = railAdd(p);
  assert.equal(a.textContent, 'Nueva categoría');
  assert.equal(a, rail(p).lastElementChild, 'at the foot');
  a.click(); await settle(5);
  const b = box(p);
  const inp = b.querySelector('input.mgname-in');
  assert.equal(b.querySelector(`label[for="${inp.id}"]`).textContent, 'Nueva categoría');
  assert.equal(inp.placeholder, 'Nombre de la categoría');
  assert.equal(p.d.activeElement, inp, 'the caret in the box');
  assert.equal(b.querySelector('.mk-cnt').textContent, '0/40');
  assert.deepEqual([...b.querySelectorAll('.mk-btns button')].map((x) => [x.textContent, x.className]), [['Cancelar', 'btn ghost sm'], ['Crear', 'btn accent sm']]);
  p.type(inp, 'Postres'); await settle(2);
  assert.equal(box(p).querySelector('input'), inp, 'the same input (no rebuild under the caret)');
  assert.equal(b.querySelector('.mk-cnt').textContent, '7/40');
  boxBtn(p, 'Cancelar').click(); await settle(5);
  assert.equal(box(p), null); assert.ok(railAdd(p), 'back to the action');
});

test('S4-C — «Crear»: the new category in the rail («Nueva», 0, selected) and its page: the tag, «Nueva subcategoría» off with its reason, the empty state, «Quitar categoría»', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await create(p, 'Postres');
  const it = items(p).find((x) => x.querySelector('b').firstChild.textContent === 'Postres');
  assert.ok(it, '🔴 in the rail'); assert.ok(it.classList.contains('on'), 'selected');
  assert.equal(it.querySelector('b .tag.new').textContent, 'Nueva'); assert.equal(it.querySelector('.rcount').textContent, '0');
  assert.equal(box(p), null, 'the box closed');
  const h = detail(p).querySelector('.dhead');
  assert.equal(h.querySelector('.dtitle').textContent, 'Postres');
  assert.equal(h.querySelector('.tag.new.mk-htag').textContent, 'Nueva');
  const sub = [...h.querySelectorAll('.dright button')].find((x) => x.textContent === 'Nueva subcategoría');
  assert.ok(sub.disabled); assert.equal(sub.title, P('subcatNeedsDish'));
  const e = detail(p).querySelector('.empty.mk-empty');
  assert.equal(e.querySelector('b').textContent, P('emptyTitle')); assert.equal(e.querySelector('span').textContent, P('emptyBody'));
  assert.equal(e.querySelector('.mk-emptyacts button.btn.ptext.mk-quiet-danger').textContent, P('dropCat'));
});

test('E — a taken name is refused in place (the folded name), nothing created; an empty name keeps «Crear» off', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  const n0 = items(p).length;
  railAdd(p).click(); await settle(5);
  assert.equal(boxBtn(p, 'Crear').disabled, true, 'an empty name');
  p.type(box(p).querySelector('input'), 'dim sum'); await settle(2);
  boxBtn(p, 'Crear').click(); await settle(5);
  const line = box(p).querySelector('.ferr');
  assert.ok(line, '🔴 the line in place'); assert.equal(line.textContent, P('nameTaken')); assert.equal(line.getAttribute('role'), 'alert');
  assert.equal(items(p).length, n0, 'nothing created');
  p.type(box(p).querySelector('input'), 'Dim Sum 2'); await settle(2);
  assert.equal(box(p).querySelector('.ferr'), null, 'typing clears it');
});

test('S4-D — «Quitar categoría» asks first (E3\'s small confirm); «Cancelar» keeps it; confirming drops it from the rail at once', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  const n0 = items(p).length;
  await create(p, 'Postres');
  detail(p).querySelector('.mk-emptyacts button').click(); await settle(5);
  const m = p.d.querySelector('#xscrim.show .modal');
  assert.ok(m, 'the confirm'); assert.ok(m.classList.contains('sm'));
  assert.equal(m.querySelector('.mt').textContent, P('dropTitle')); assert.equal(m.querySelector('.ms').textContent, P('dropSub'));
  assert.equal(m.querySelector('.mb p').textContent, P('dropBody'));
  const bs = [...m.querySelectorAll('.mf button')];
  assert.deepEqual(bs.map((b) => b.textContent), ['Cancelar', P('dropCat')]);
  assert.equal(p.d.activeElement, bs[0], '«Cancelar» holds focus');
  bs[0].click(); await settle(5);
  assert.equal(items(p).length, n0 + 1, 'kept');
  detail(p).querySelector('.mk-emptyacts button').click(); await settle(5);
  [...p.d.querySelectorAll('#xscrim.show .modal .mf button')][1].click(); await settle(10);
  assert.equal(items(p).length, n0, '🔴 gone from the rail');
  assert.ok(items(p)[0].classList.contains('on'), 'the first category selected');
});

test('S4-C — «Agregar producto» on the new category: the new dish lands in it and promotes it (the rail keeps «Nueva», now 1)', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await create(p, 'Postres');
  const add = [...detail(p).querySelectorAll('.dright button')].find((x) => x.textContent.trim() === 'Agregar producto');
  assert.equal(add.disabled, false, 'on (5f: an addition promotes)');
  add.click(); await settle(10);
  const src = p.src();
  const id = src.structure.categories.find((c) => c.name === 'Postres');
  assert.ok(id, '🔴 promoted into categories'); assert.equal((src.structure.staged_categories || []).length, 0);
  assert.equal(src.items.filter((i) => i.ref && i.display.cat === id.id).length, 1);
  const it = items(p).find((x) => x.querySelector('b').firstChild.textContent === 'Postres');
  assert.equal(it.querySelector('.tag.new').textContent, 'Nueva'); assert.equal(it.querySelector('.rcount').textContent, '1');
});

// ── step 2: subsection heads (frame E) and «Nueva subcategoría» (S4-A / S4-B) ──
const pick = async (p, name) => { items(p).find((x) => x.querySelector('b').firstChild.textContent === name).click(); await settle(5); };
const heads = (p) => [...detail(p).querySelectorAll('.mk-subh')].map((h) => [h.querySelector('.mk-sn').textContent, h.querySelector('.mk-n').textContent]);
const subBtn = (p) => [...detail(p).querySelectorAll('.dhead .dright button')].find((x) => x.textContent === 'Nueva subcategoría');
const sheet = (p) => p.d.querySelector('#xsubcat.show .modal');
const sBtn = (p, t) => [...sheet(p).querySelectorAll('.mf button')].find((b) => b.textContent === t);
const rowsIn = (p) => [...sheet(p).querySelectorAll('.mk-pick label.modopt')];

test('E — a category with subcategories lists its products under one head each («{sub}» · its count); OFF: today\'s flat list', async () => {
  const off = await page({ read: () => editable({}) });
  await off.signIn(); await pick(off, 'Bebidas');
  assert.deepEqual(heads(off), [], 'OFF: no heads');
  const p = await page({ read: ON });
  await p.signIn(); await pick(p, 'Bebidas');
  const src = p.src();
  const n = (sub) => src.items.filter((i) => i.display.cat === 'bebidas' && i.display.variantOf == null && i.display.subcat === sub).length;
  assert.deepEqual(heads(p), [['Sodas', String(n('Sodas'))], ['Cervezas', String(n('Cervezas'))]], '🔴 one head per subsection, in its order');
  const h = detail(p).querySelectorAll('.mk-subh')[1];
  let k = 0; for (let x = h.nextElementSibling; x && x.classList.contains('irow'); x = x.nextElementSibling) k += 1;
  assert.equal(k, n('Cervezas'), 'its rows follow its head');
});

test('S4-A — the FIRST subcategory: every product checked and locked, the line; «Crear subcategoría» groups them all', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await pick(p, 'Dim Sum');
  const ids = p.src().items.filter((i) => i.display.cat === 'dim_sum' && i.display.variantOf == null).map((i) => i.key);
  const b = subBtn(p); assert.ok(b, 'the header action'); assert.equal(b.disabled, false);
  b.click(); await settle(5);
  const m = sheet(p);
  assert.equal(m.querySelector('.mh .mt').textContent, 'Nueva subcategoría');
  assert.equal(m.querySelector('.mh .ms').textContent, P('sheetSubFirst'));
  const inp = m.querySelector('input.mgname-in');
  assert.equal(m.querySelector(`label[for="${inp.id}"]`).textContent, P('subName')); assert.equal(inp.placeholder, P('subPh'));
  assert.equal(p.d.activeElement, inp);
  const cnts = [...m.querySelectorAll('.fld .mk-lrow .mk-cnt')].map((x) => x.textContent);
  assert.deepEqual(cnts, ['0/40', `${ids.length} de ${ids.length}`]);
  assert.equal(m.querySelectorAll('.fld .mk-lrow label')[1].textContent, P('products'));
  assert.deepEqual([m.querySelector('.mk-pick .mk-subh .mk-sn').textContent, m.querySelector('.mk-pick .mk-subh .mk-n').textContent], ['Dim Sum', `${ids.length} de ${ids.length}`]);
  assert.equal(rowsIn(p).length, ids.length);
  assert.ok(rowsIn(p).every((r) => r.classList.contains('mk-fixed') && r.querySelector('input').checked && r.querySelector('input').disabled), '🔴 checked and locked');
  assert.equal(m.querySelector('p.mk-sub').textContent, P('firstLine'));
  assert.deepEqual([...m.querySelectorAll('.mf button')].map((x) => x.textContent), ['Cancelar', P('createSub')]);
  p.type(inp, 'Al vapor'); await settle(2);
  assert.equal(m.querySelector('.fld .mk-lrow .mk-cnt').textContent, '8/40');
  sBtn(p, P('createSub')).click(); await settle(10);
  assert.equal(sheet(p), null, 'closed');
  const src = p.src();
  assert.deepEqual(src.structure.categories.find((c) => c.id === 'dim_sum').subcats, ['Al vapor']);
  assert.ok(ids.every((k) => src.items.find((i) => i.key === k).display.subcat === 'Al vapor'), 'every product in it');
  assert.deepEqual(heads(p), [['Al vapor', String(ids.length)]]);
});

test('S4-B — a FURTHER subcategory: the merchant marks members (current subsection under each name); none marked ⇒ the line in place, nothing written', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await pick(p, 'Bebidas');
  subBtn(p).click(); await settle(5);
  const m = sheet(p);
  assert.equal(m.querySelector('.mh .ms').textContent, P('sheetSub'));
  assert.ok(rowsIn(p).every((r) => !r.querySelector('input').checked && !r.querySelector('input').disabled), 'none marked, all free');
  assert.ok(['Sodas', 'Cervezas'].includes(rowsIn(p)[0].querySelector('.mogsub').textContent), 'its current subsection');
  assert.equal(m.querySelector('.mk-pick .mk-subh .mk-lnk').textContent, 'Marcar todos');
  assert.equal(m.querySelector('p.mk-sub').textContent, P('moveLine'));
  p.type(m.querySelector('input.mgname-in'), 'Jugos'); await settle(2);
  const before = JSON.stringify(p.src());
  sBtn(p, P('createSub')).click(); await settle(5);
  assert.ok(sheet(p), 'stays open');
  assert.ok(sheet(p).querySelector('.mk-pick').classList.contains('mk-inv'));
  assert.equal(sheet(p).querySelector('.mk-pick + .ferr, .fld > .ferr').textContent, P('needOne'));
  assert.equal(JSON.stringify(p.src()), before, 'nothing written');
  const soda = rowsIn(p).find((r) => r.querySelector('.mogsub').textContent === 'Sodas');
  soda.querySelector('input').click(); await settle(5);
  assert.equal(sheet(p).querySelector('.fld .mk-lrow .mk-cnt:not([aria-live])').textContent.startsWith('1 de'), true);
  sBtn(p, P('createSub')).click(); await settle(10);
  const src = p.src();
  assert.deepEqual(src.structure.categories.find((c) => c.id === 'bebidas').subcats.slice(-1), ['Jugos']);
  assert.equal(src.items.filter((i) => i.display.cat === 'bebidas' && i.display.subcat === 'Jugos').length, 1);
});

test('S4-B — marking EVERY product of a subsection would empty it: the approved «sección vacía» line under the list, nothing written', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await pick(p, 'Bebidas');
  subBtn(p).click(); await settle(5);
  p.type(sheet(p).querySelector('input.mgname-in'), 'Jugos'); await settle(2);
  const n = rowsIn(p).filter((x) => x.querySelector('.mogsub').textContent === 'Sodas').length;
  assert.ok(n > 0, 'premise: Sodas has products');
  for (let i = 0; i < n; i++) {   // a mark repaints the sheet: the rows are read again each time
    rowsIn(p).filter((x) => x.querySelector('.mogsub').textContent === 'Sodas' && !x.querySelector('input').checked)[0].querySelector('input').click(); await settle(2);
  }
  const before = JSON.stringify(p.src());
  sBtn(p, P('createSub')).click(); await settle(5);
  assert.equal(sheet(p).querySelector('.fld > .ferr').textContent, 'No podés dejar la sección vacía. Agregá otro producto primero.', '🔴 the approved line');
  assert.equal(JSON.stringify(p.src()), before);
});

// ── step 3: the row menu (frame E2 «Mover a…»; S4-D's draft-only line, toast and the live refusal) ──
const rowOf = (p, name) => [...detail(p).querySelectorAll('.irow')].find((r) => r.querySelector('.nm') && r.querySelector('.nm').firstChild.textContent === name);
const more = (r) => r.querySelector('button.mk-more');
const menu = (p) => detail(p).querySelector('.mk-pop[role="menu"]');
const mItems = (p) => [...menu(p).querySelectorAll('button.mk-popi')];
const mItem = (p, t) => mItems(p).find((b) => b.firstChild.textContent === t);
const dishName = (p, key) => p.src().items.find((i) => i.key === key).display.name;

test('E2 — each row gets «Más acciones» (before the chevron); its menu lists every section and subsection, the current one inert «actual», a new one «nueva»; OFF: no menu', async () => {
  const off = await page({ read: () => editable({}) });
  await off.signIn(); await pick(off, 'Dim Sum');
  assert.equal(detail(off).querySelector('button.mk-more'), null, 'OFF');
  const p = await page({ read: ON });
  await p.signIn();
  await create(p, 'Postres');
  await pick(p, 'Dim Sum');
  const nm = dishName(p, 'dimsum_01');
  const r = rowOf(p, nm);
  const b = more(r);
  assert.ok(b, '🔴 the menu button'); assert.equal(b.getAttribute('aria-label'), `Más acciones: ${nm}`); assert.equal(b.getAttribute('aria-haspopup'), 'menu');
  assert.ok(b.nextElementSibling && b.nextElementSibling.classList.contains('rowchev'), 'before the chevron');
  b.click(); await settle(5);
  assert.equal(menu(p).querySelector('.mk-pl').textContent, 'Mover a');
  const cur = mItems(p)[0];
  assert.equal(cur.firstChild.textContent, 'Dim Sum'); assert.ok(cur.classList.contains('mk-cur')); assert.equal(cur.getAttribute('aria-disabled'), 'true');
  assert.equal(cur.querySelector('.mk-sub2').textContent, 'actual');
  assert.ok(mItem(p, 'Bebidas · Sodas') && mItem(p, 'Bebidas · Cervezas'), 'a section with subsections: one entry each');
  assert.equal(mItem(p, 'Postres').querySelector('.mk-sub2').textContent, 'nueva');
  assert.equal(p.d.activeElement, mItems(p)[1], 'focus on the first movable entry');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(5);
  assert.equal(menu(p), null, 'Esc closes'); assert.equal(p.d.activeElement, more(rowOf(p, nm)), 'focus back on the button');
});

test('E2 — «Mover a…» moves the dish (the menu closes); a LIVE section\'s last dish is refused with the approved line under the row, nothing written', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await pick(p, 'Crudo');
  const keys = p.src().items.filter((i) => i.display.cat === 'crudo' && i.display.variantOf == null).map((i) => i.key);
  for (const k of keys.slice(0, -1)) { more(rowOf(p, dishName(p, k))).click(); await settle(5); mItem(p, 'Starters').click(); await settle(10); }
  assert.ok(keys.slice(0, -1).every((k) => p.src().items.find((i) => i.key === k).display.cat === 'starters'), 'moved');
  assert.equal(menu(p), null);
  const last = rowOf(p, dishName(p, keys[keys.length - 1]));
  const before = JSON.stringify(p.src());
  more(last).click(); await settle(5); mItem(p, 'Starters').click(); await settle(10);
  const row = rowOf(p, dishName(p, keys[keys.length - 1]));
  const line = row.nextElementSibling;
  assert.ok(line && line.classList.contains('ferr'), '🔴 the line under the row');
  assert.equal(line.textContent, 'No podés dejar la sección vacía. Agregá otro producto primero.');
  assert.equal(JSON.stringify(p.src()), before, 'nothing written');
});

test('S4-D — a dish moved INTO a new section promotes it; its menu then says so (the line); moving it back un-promotes and the toast tells', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await create(p, 'Postres');
  await pick(p, 'Dim Sum');
  const nm = dishName(p, 'dimsum_01');
  more(rowOf(p, nm)).click(); await settle(5); mItem(p, 'Postres').click(); await settle(10);
  const pid = p.src().structure.categories.find((c) => c.name === 'Postres');
  assert.ok(pid, 'promoted');
  await pick(p, 'Postres');
  more(rowOf(p, nm)).click(); await settle(5);
  assert.equal(menu(p).querySelector('.mk-popnote').textContent, P('menuNote'), '🔴 the line in the menu');
  mItem(p, 'Dim Sum').click(); await settle(10);
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').display.cat, 'dim_sum');
  assert.deepEqual((p.src().structure.staged_categories || []).map((c) => c.name), ['Postres'], 'staged again');
  const t = p.d.querySelector('.toast.show');
  assert.ok(t, 'the toast'); assert.equal(t.textContent, P('toastBack'));
});

// the removal switch as getEditableCatalog serves it, over a stamped menu (identity_id: the server's bootstrap stamps every live dish)
const RM = () => {
  const r = editable({ sections: true, productRemoval: true, textEditEnabled: true, deletionBase: { version: 'v-live', generation: 1 },
    liveOrder: { items: [...SRC.structure.item_order], rewards: [...(SRC.structure.redeem_eligible_items || [])] } });
  for (const it of r.source.items) if (it && it.display && typeof it.key === 'string') it.display.identity_id = `d_${it.key}`;
  return r;
};
test('S4-D — «Quitar del menú» on the last dish of a section promoted in this draft: the approved confirm plus the un-promote sentence', async () => {
  const p = await page({ read: RM });
  await p.signIn();
  await create(p, 'Postres');
  await pick(p, 'Dim Sum');
  const nm = dishName(p, 'dimsum_01');
  more(rowOf(p, nm)).click(); await settle(5); mItem(p, 'Postres').click(); await settle(10);
  await pick(p, 'Postres');
  more(rowOf(p, nm)).click(); await settle(5);
  mItems(p).find((b) => b.classList.contains('danger')).click(); await settle(5);
  const m = p.d.querySelector('#xscrim.show .modal, #xscrim.show .mk-sheet');
  assert.ok(m, 'the approved R2 confirm');
  const ps = [...m.querySelectorAll('p')].map((x) => x.textContent);
  assert.equal(ps[ps.length - 1], P('unpromoteLine'), '🔴 the un-promote sentence after the approved body');
});
test('3(b) — «Quitar del menú» on a LIVE section\'s last dish: the approved line under the row, no confirm, nothing written', async () => {
  const p = await page({ read: RM });
  await p.signIn(); await pick(p, 'Crudo');
  const keys = p.src().items.filter((i) => i.display.cat === 'crudo' && i.display.variantOf == null).map((i) => i.key);
  for (const k of keys.slice(0, -1)) { more(rowOf(p, dishName(p, k))).click(); await settle(5); mItem(p, 'Starters').click(); await settle(10); }
  const nm = dishName(p, keys[keys.length - 1]);
  const before = JSON.stringify(p.src());
  more(rowOf(p, nm)).click(); await settle(5);
  mItems(p).find((b) => b.classList.contains('danger')).click(); await settle(5);
  assert.equal(p.d.querySelector('#xscrim.show'), null, 'no confirm');
  assert.equal(rowOf(p, nm).nextElementSibling.textContent, 'No podés dejar la sección vacía. Agregá otro producto primero.');
  assert.equal(JSON.stringify(p.src()), before);
});

test('copy: frame E\'s approved strings are literal; the addendum\'s proposed ones are ⟦s4.key⟧ placeholders', () => {
  assert.deepEqual(Object.keys(S4_COPY).sort(), ['createSub', 'dropBody', 'dropCat', 'dropSub', 'dropTitle', 'emptyBody', 'emptyTitle', 'firstLine', 'menuNote', 'moveLine', 'nameTaken', 'needOne', 'products', 'sheetSub', 'sheetSubFirst', 'subCaps', 'subName', 'subNameTaken', 'subPh', 'subcatNeedsDish', 'toastBack', 'unpromoteLine']);
});

// THE SHIP GATE: red while ANY S4 string is a placeholder — the branch cannot ride a train before the owner approves the addendum's copy
test('SHIP GATE: no placeholder ships — every S4 string is owner-approved text', () => {
  const pending = Object.entries(S4_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});
