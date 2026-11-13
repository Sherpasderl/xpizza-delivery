// STRUCTURE S3 (UI) — the DRAWING half, step 2: the required choice's editor in the drawer, built EXACT to MOCKUP-portal-structure-edit
// panel D (owner-approved 11-11: its strings are literal) and the S3 addendum's B2 zero-mark line (visually checked, copy PENDING the
// owner: every string it proposes is a ⟦s3.key⟧ placeholder and the SHIP GATE below stays red until it is approved). The REAL app.js in
// jsdom over index.html (drawer-harness.mjs), the REAL la_musa seed, the server's choiceEdit switch in getEditableCatalog's shape.
// Run: node --test --test-force-exit structure-s3-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editable, settle, page } from './drawer-harness.mjs';

const { S3_COPY } = await import('./item-edit-logic.js');
const P = (k) => `⟦s3.${k}⟧`;
const ON = () => editable({ extrasAuthoring: true, choiceEdit: true });
const PAD = 'noodle_01';
const reqCard = (p) => p.drawer().querySelector('.mk-grp.mk-req');
const pencil = (p) => reqCard(p).querySelector('.mk-gh .mk-gact button[title="Editar grupo"]');
const ge = (p) => reqCard(p).querySelector('.mk-ge');
const rows = (p) => [...ge(p).querySelectorAll(':scope > .mopt')];
const nameOf = (r) => r.querySelector('input.moname').value;
const pill = (r) => r.querySelector('button.recpill');
const trash = (r) => r.querySelector('button.model');
const recline = (p) => ge(p).querySelector('.mk-recline');
const gf = (p, t) => [...reqCard(p).querySelectorAll('.mk-gf button')].find((b) => b.textContent === t);
async function editing(p) { await p.signIn(); await p.open(PAD); pencil(p).click(); await settle(5); }
const groupOf = (src) => { const l = src.items.find((i) => i.key === PAD); const sp = src.structure.variant_items[String(l.display.id)]; return { label: sp.label, members: sp.variantIds.map((v) => src.items.find((i) => String(i.display.id) === String(v) || i.ref === v)) }; };

test('OFF (choiceEdit absent / not true): the required choice\'s card is S1\'s — no pencil, no editor', async () => {
  for (const over of [{ extrasAuthoring: true }, { extrasAuthoring: true, choiceEdit: 'true' }, { extrasAuthoring: true, choiceEdit: false }]) {
    const p = await page({ read: () => editable(over) });
    await p.signIn(); await p.open(PAD);
    assert.ok(reqCard(p), 'premise: the S1 card');
    assert.equal(reqCard(p).querySelector('button[title="Editar grupo"]'), null, `no pencil for ${JSON.stringify(over)}`);
    assert.equal(reqCard(p).querySelector('.mk-ge'), null);
  }
});

test('D — the pencil opens the editor EXACT to panel D: name box, one row per option (name · L price · «Recomendada» · trash), «Agregar opción», the flag, the naming line, «Quitar elección» · «Listo»', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await p.open(PAD);
  const pen = pencil(p);
  assert.equal(pen.getAttribute('aria-label'), 'Editar grupo Proteína');
  pen.click(); await settle(5);
  const card = reqCard(p);
  assert.ok(card.classList.contains('chg') && card.classList.contains('mk-open'), 'the editing card: open, the change ring');
  assert.equal(card.querySelector('.mk-gh button[title="Editar grupo"]'), null, 'panel D\'s header: the chevron only');
  const g = ge(p);
  const lbl = g.querySelector(':scope > label.mgname-lbl'); const nm = g.querySelector(':scope > input.mgname-in');
  assert.equal(lbl.textContent, 'Nombre de la elección'); assert.equal(lbl.htmlFor, nm.id);
  assert.equal(nm.value, 'Proteína'); assert.equal(nm.placeholder, 'Ej. Tamaño, Término, Porción');
  assert.deepEqual(rows(p).map(nameOf), ['Sin Proteína', 'Pollo', 'Camarones']);
  const r0 = rows(p)[0];
  assert.equal(r0.querySelector('input.moname').getAttribute('aria-label'), 'Nombre de la opción');
  assert.equal(r0.querySelector('input.moname').placeholder, 'Nombre de la opción');
  assert.equal(r0.querySelector('.mopr .mc').textContent, 'L');
  const pr = r0.querySelector('.mopr input'); assert.equal(pr.value, '307'); assert.equal(pr.getAttribute('aria-label'), 'Precio'); assert.equal(pr.inputMode, 'numeric');
  assert.equal(pill(r0).textContent, 'Recomendada'); assert.equal(pill(r0).getAttribute('aria-pressed'), 'false', 'live data: zero marks');
  assert.equal(trash(r0).getAttribute('aria-label'), 'Quitar Sin Proteína');
  assert.equal(r0.querySelector('.mk-apponly'), null, 'a live option is sold everywhere');
  assert.deepEqual([...g.children].map((c) => c.className).filter((c) => c !== 'mopt'), ['mgname-lbl', 'mgname-in', 'mgadd', 'mgflag', 'mk-sub'], 'D\'s order; no line while untouched');
  assert.equal(g.querySelector('.mgadd').textContent, 'Agregar opción');
  assert.equal(g.querySelector('.mgflag').textContent, 'Mismo precio para todas');
  assert.equal(g.querySelector('.mk-sub').textContent, 'En el menú cada opción se llama «Pad Thai - Sin Proteína»: el nombre se arma solo y cambia con el producto.');
  assert.ok(gf(p, 'Quitar elección').classList.contains('mk-quiet-danger'));
  assert.ok(gf(p, 'Listo'));
});

test('B2 — «Agregar opción» adds a new row (app-only mark, focused name); the touched group shows the quiet line; «Guardar» HOLDS it in the refusal style; one pill tap ends it and «Guardar» saves', async () => {
  const p = await page({ read: ON });
  await editing(p);
  const before = JSON.stringify(p.src());
  ge(p).querySelector('.mgadd').click(); await settle(5);
  const nw = rows(p)[3];
  assert.ok(nw.classList.contains('chg')); assert.equal(nw.querySelector('.mk-apponly').textContent, 'Solo en la app Sherpa');
  assert.equal(p.d.activeElement, nw.querySelector('input.moname'), 'the caret lands in the new name');
  p.type(nw.querySelector('input.moname'), 'Tofu'); p.type(nw.querySelector('.mopr input'), '330'); await settle(5);
  const line = recline(p);
  assert.ok(line, '🔴 the zero-mark line'); assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.textContent, P('recRequired')); assert.ok(!line.classList.contains('ferr'));
  assert.equal(line.previousElementSibling, rows(p)[3], 'directly under the rows'); assert.ok(line.nextElementSibling.classList.contains('mgadd'));
  p.btn('Guardar').click(); await settle(5);
  assert.ok(p.drawer().classList.contains('show'), '🔴 held: the drawer stays');
  assert.ok(recline(p).classList.contains('ferr'), 'the same words in the refusal style');
  assert.equal(JSON.stringify(p.src()), before, 'nothing written');
  pill(rows(p)[1]).click(); await settle(5);
  assert.equal(pill(rows(p)[1]).getAttribute('aria-pressed'), 'true'); assert.ok(pill(rows(p)[1]).classList.contains('recpill-on'));
  assert.equal(recline(p), null, 'one tap ends it');
  p.btn('Guardar').click(); await settle(10);
  const g = groupOf(p.src());
  assert.deepEqual(g.members.map((m) => m.display.choice), ['Sin Proteína', 'Pollo', 'Camarones', 'Tofu']);
  assert.equal(g.members[3].price, 330);
  assert.deepEqual(g.members.filter((m) => (m.display.tags || []).includes('recommended')).map((m) => m.key), ['noodle_01_pollo']);
});

test('typing the name / an option\'s name keeps the SAME input (no rebuild under the caret) and saves the last value', async () => {
  const p = await page({ read: ON });
  await editing(p);
  const nm = ge(p).querySelector('input.mgname-in');
  for (const v of ['Pro', 'Proteína a elegir']) p.type(nm, v);
  const on = rows(p)[1].querySelector('input.moname');
  p.type(on, 'Pollo al wok'); await settle(5);
  assert.equal(ge(p).querySelector('input.mgname-in'), nm, 'the same node'); assert.equal(rows(p)[1].querySelector('input.moname'), on);
  pill(rows(p)[0]).click(); await settle(5);
  p.btn('Guardar').click(); await settle(10);
  const g = groupOf(p.src());
  assert.equal(g.label, 'Proteína a elegir'); assert.equal(g.members[1].display.choice, 'Pollo al wok');
});

test('the trash: a live option is removed (two left ⇒ the trash turns off with the line as its title); a NEW option\'s trash drops it', async () => {
  const p = await page({ read: ON });
  await editing(p);
  ge(p).querySelector('.mgadd').click(); await settle(5);
  trash(rows(p)[3]).click(); await settle(5);
  assert.equal(rows(p).length, 3); assert.equal(recline(p), null, 'the group is as loaded: no line');
  trash(rows(p)[2]).click(); await settle(5);
  assert.deepEqual(rows(p).map(nameOf), ['Sin Proteína', 'Pollo']);
  for (const r of rows(p)) { assert.equal(trash(r).disabled, true, '🔴 two options: no trash'); assert.equal(trash(r).title, P('tooFew')); }
});

test('«Listo» folds the editor back to the read card; the edits stay in the drawer\'s copy', async () => {
  const p = await page({ read: ON });
  await editing(p);
  p.type(ge(p).querySelector('input.mgname-in'), 'Proteína elegida'); await settle(5);
  gf(p, 'Listo').click(); await settle(5);
  assert.equal(reqCard(p).querySelector('.mk-ge'), null);
  assert.equal(reqCard(p).querySelector('.mk-gtn').textContent, 'Proteína elegida', 'the read card names the edited choice');
  assert.ok(pencil(p));
  assert.equal(p.btn('Guardar').disabled, false, 'still unsaved');
});

const cf = (p) => p.drawer().querySelector('.mk-cfscrim .mk-cf');
const cfBtn = (p, t) => [...cf(p).querySelectorAll('.mk-cfa button')].find((b) => b.textContent === t);

test('D3 — «Quitar elección» on a MARKED group: the approved card (title, the recommended price sentence), «Cancelar» holds focus; confirming leaves one price, editable', async () => {
  const p = await page({ read: ON });
  await editing(p);
  pill(rows(p)[1]).click(); await settle(5);
  gf(p, 'Quitar elección').click(); await settle(5);
  const c = cf(p);
  assert.equal(c.getAttribute('role'), 'dialog'); assert.equal(c.getAttribute('aria-modal'), 'true');
  assert.equal(c.querySelector('h3').textContent, '¿Quitar la elección Proteína?');
  assert.equal(c.querySelector('p').textContent, 'Pad Thai queda con un solo precio: L 342, el de la opción recomendada. Podés cambiarlo antes de publicar.');
  assert.equal(c.querySelector('.mk-pf'), null, 'a marked group: no list');
  assert.deepEqual([...c.querySelectorAll('.mk-cfa button')].map((b) => b.textContent), ['Cancelar', 'Quitar elección']);
  assert.equal(p.d.activeElement, cfBtn(p, 'Cancelar'));
  assert.ok(cfBtn(p, 'Quitar elección').classList.contains('mk-quiet-danger'));
  cfBtn(p, 'Quitar elección').click(); await settle(5);
  assert.equal(cf(p), null);
  assert.equal(reqCard(p), null, '🔴 the choice is gone from the drawer');
  const pr = p.fld('Precio').querySelector('input[aria-label="Precio"]');
  assert.equal(pr.value, '342', 'the recommended option\'s price, editable');
  p.type(pr, '355'); await settle(5);
  p.btn('Guardar').click(); await settle(10);
  const dish = p.src().items.find((i) => i.key === PAD);
  assert.equal(dish.price, 355); assert.equal(p.src().structure.variant_items[String(dish.display.id)], undefined);
});

test('B2b — «Quitar elección» with ZERO marks: the pick list (radiogroup), the action off with its title until a row is picked; «Cancelar» keeps the choice', async () => {
  const p = await page({ read: ON });
  await editing(p);
  gf(p, 'Quitar elección').click(); await settle(5);
  let c = cf(p);
  assert.equal(c.querySelector('p').textContent, P('removePick'));
  const pf = c.querySelector('.mk-pf');
  assert.equal(pf.getAttribute('role'), 'radiogroup'); assert.equal(pf.getAttribute('aria-label'), P('pickAria'));
  const opt = [...pf.querySelectorAll('label.optrow')];
  assert.deepEqual(opt.map((l) => [l.querySelector('.ogname').textContent, l.querySelector('.mk-rp').textContent]), [['Sin Proteína', 'L 307'], ['Pollo', 'L 342'], ['Camarones', 'L 414']]);
  assert.ok(opt.every((l) => l.querySelector('input[type=radio]').checked === false), 'none picked');
  const go = cfBtn(p, 'Quitar elección');
  assert.equal(go.disabled, true); assert.equal(go.title, P('pickTitle'));
  cfBtn(p, 'Cancelar').click(); await settle(5);
  assert.equal(cf(p), null); assert.ok(ge(p), 'the editor stays');
  gf(p, 'Quitar elección').click(); await settle(5);
  c = cf(p);
  const r2 = [...c.querySelectorAll('label.optrow')][2];
  r2.querySelector('input').click(); await settle(5);
  assert.ok(r2.classList.contains('sel')); assert.equal(cfBtn(p, 'Quitar elección').disabled, false);
  cfBtn(p, 'Quitar elección').click(); await settle(5);
  assert.equal(p.fld('Precio').querySelector('input[aria-label="Precio"]').value, '414', 'the picked price');
});

const PLAIN = 'dimsum_01';   // «Sichuan Spicy Wonton»: one price, no choice
const d2Act = (p) => [...p.drawer().querySelectorAll('.mk-adds button.railadd')].find((b) => b.textContent === 'Agregar elección requerida');
const sheet = (p) => p.d.querySelector('#xchoice.show .modal');
const sRows = (p) => [...sheet(p).querySelectorAll('.mk-mgroup > .mopt')];
const sBtn = (p, t) => [...sheet(p).querySelectorAll('.mf button')].find((b) => b.textContent === t);

test('D2 — the dish\'s second action «Agregar elección requerida»: only with choiceEdit, only on a plain dish', async () => {
  const off = await page({ read: () => editable({ extrasAuthoring: true, extrasCatalog: true }) });
  await off.signIn(); await off.open(PLAIN);
  assert.equal(d2Act(off), undefined, 'OFF: no action');
  const p = await page({ read: ON });
  await p.signIn(); await p.open(PAD);
  assert.equal(d2Act(p), undefined, 'a dish with a choice: no action');
  await p.open(PLAIN);
  const a = d2Act(p);
  assert.ok(a, 'a plain dish: the action'); assert.ok(a.classList.contains('mk-railq'), 'the quiet action');
});

test('D2 — the sheet EXACT to the frame: title, subline, the explain line, the name, the options (the first prefilled with the dish\'s price and «Recomendada»), the note; «Agregar elección» off until complete; on add the Precio field gives way to the choice', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await p.open(PLAIN);
  const price = String(p.src().items.find((i) => i.key === PLAIN).price);
  d2Act(p).click(); await settle(5);
  const m = sheet(p);
  assert.ok(m, 'the sheet opened');
  assert.equal(m.querySelector('.mh .mt').textContent, 'Agregar elección requerida');
  assert.equal(m.querySelector('.mh .ms').textContent, 'Para Sichuan Spicy Wonton · hoy tiene un solo precio');
  assert.equal(m.querySelector('.mb .gexplain').textContent, 'Elección requerida. El cliente elige 1. El precio del producto pasa a ser el de la opción elegida.');
  assert.equal(m.querySelector('.mb .gexplain b').textContent, 'Elección requerida.');
  const nm = m.querySelector('input.mgname-in');
  assert.equal(nm.placeholder, 'Ej. Tamaño, Término, Porción');
  assert.equal(m.querySelector(`label[for="${nm.id}"]`).textContent, 'Nombre de la elección');
  assert.equal(m.querySelectorAll('.fld .mk-lrow .mk-cnt')[0].textContent, 'precio por opción');
  assert.equal(sRows(p).length, 2);
  assert.equal(sRows(p)[0].querySelector('.mopr input').value, price, 'the dish\'s price passes to the first option');
  assert.equal(sRows(p)[0].querySelector('.recpill').getAttribute('aria-pressed'), 'true');
  assert.equal(m.querySelector('.mk-note b').textContent, 'El precio actual pasa a la primera opción');
  assert.equal(m.querySelector('.mk-note').lastChild.textContent, `Sichuan Spicy Wonton cuesta L ${price} hoy; esa es la opción recomendada al crear la elección. Ajustá cada precio antes de guardar.`);
  assert.equal(sBtn(p, 'Agregar elección').disabled, true, 'incomplete: off');
  p.type(nm, 'Porción');
  p.type(sRows(p)[0].querySelector('input.moname'), 'Seis');
  p.type(sRows(p)[1].querySelector('input.moname'), 'Doce');
  p.type(sRows(p)[1].querySelector('.mopr input'), '480');
  assert.equal(sBtn(p, 'Agregar elección').disabled, false);
  sBtn(p, 'Agregar elección').click(); await settle(5);
  assert.equal(sheet(p), null, 'closed');
  assert.equal(p.fld('Precio'), undefined, '🔴 the Precio field gave way to the choice');
  const card = reqCard(p);
  assert.equal(card.querySelector('.mk-gtn').textContent, 'Porción');
  assert.deepEqual([...card.querySelectorAll('.mk-dopt .dp')].map((x) => x.textContent), [`L ${price}`, 'L 480']);
  assert.equal(card.querySelectorAll('.mk-dopt .mk-apponly').length, 2, 'both options sell in the app only until published');
  p.btn('Guardar').click(); await settle(10);
  const src = p.src(); const dish = src.items.find((i) => i.key === PLAIN);
  const ids = src.structure.variant_items[String(dish.display.id)].variantIds;
  const mem = ids.map((v) => src.items.find((i) => i.ref === v || String(i.display.id) === String(v)));
  assert.deepEqual(mem.map((x) => [x.display.choice, x.price, (x.display.tags || []).includes('recommended')]), [['Seis', Number(price), true], ['Doce', 480, false]]);
});

test('D2 — «Cancelar» records nothing; the trash is off at two options; «Agregar opción» adds a row', async () => {
  const p = await page({ read: ON });
  await p.signIn(); await p.open(PLAIN);
  d2Act(p).click(); await settle(5);
  assert.ok(sRows(p).every((r) => r.querySelector('.model').disabled), 'two rows: no trash');
  sheet(p).querySelector('.mgadd').click(); await settle(5);
  assert.equal(sRows(p).length, 3); assert.equal(p.d.activeElement, sRows(p)[2].querySelector('input.moname'));
  assert.ok(sRows(p).every((r) => !r.querySelector('.model').disabled));
  sBtn(p, 'Cancelar').click(); await settle(5);
  assert.equal(sheet(p), null);
  assert.equal(p.btn('Guardar').disabled, true, 'nothing recorded');
  assert.ok(p.fld('Precio'), 'the dish keeps its one price');
});

// B7 — the «Agregar producto» drawer: with choiceEdit ON a new group's FIRST option is «Recomendada» from the start, with the quiet line;
// a pill is a radio (one tap moves the mark; the marked one stays); deleting the marked row moves it to the new first. OFF: today's.
async function newSized(p) {
  const btn = [...p.d.getElementById('detail').querySelectorAll('button')].find((x) => x.textContent.trim() === 'Agregar producto');
  assert.ok(btn, 'premise: «Agregar producto» in the open section');
  btn.click(); await settle(10);
  const on = p.drawer().querySelector('input[aria-label="El cliente elige 1 opción"]');
  assert.ok(on, 'premise: the new-product drawer\'s «El cliente elige 1 opción»');
  on.click(); await settle(5);
  return p.drawer().querySelector('.modgrp .mgbody');
}
const pills = (gb) => [...gb.querySelectorAll('.mopt .recpill')].map((b) => b.getAttribute('aria-pressed'));
test('B7 — a new dish\'s group: option 1 pre-marked + the quiet line; a pill is a radio; deleting the marked row moves the mark; OFF unchanged', async () => {
  const p = await page({ read: () => editable({ extrasAuthoring: true, choiceEdit: true, groupAuthoring: true }) });
  await p.signIn();
  let gb = await newSized(p);
  assert.deepEqual(pills(gb), ['true', 'false'], '🔴 option 1 marked from the start');
  const line = gb.querySelector('.mk-recline');
  assert.equal(line.textContent, P('b7Line')); assert.equal(line.getAttribute('role'), 'status');
  assert.ok(line.nextElementSibling.classList.contains('mgadd'), 'under the rows, before «Agregar opción»');
  gb.querySelectorAll('.mopt .recpill')[1].click(); await settle(5);
  gb = p.drawer().querySelector('.modgrp .mgbody');
  assert.deepEqual(pills(gb), ['false', 'true'], 'one tap moves the mark');
  gb.querySelectorAll('.mopt .recpill')[1].click(); await settle(5);
  gb = p.drawer().querySelector('.modgrp .mgbody');
  assert.deepEqual(pills(gb), ['false', 'true'], 'the marked pill stays marked');
  gb.querySelectorAll('.mopt .model')[1].click(); await settle(5);
  gb = p.drawer().querySelector('.modgrp .mgbody');
  assert.deepEqual(pills(gb), ['true'], 'the mark follows the first row: never zero');
  const off = await page({ read: () => editable({ extrasAuthoring: true, groupAuthoring: true, choiceBadges: ['recommended'] }) });
  await off.signIn();
  const gbo = await newSized(off);
  assert.deepEqual(pills(gbo), ['false', 'false'], 'OFF: today, unmarked'); assert.equal(gbo.querySelector('.mk-recline'), null);
});

test('copy: panel D\'s approved strings are literal; the addendum\'s proposed lines are ⟦s3.key⟧ placeholders', () => {
  assert.deepEqual(Object.keys(S3_COPY).sort(), ['b7Line', 'pickAria', 'pickTitle', 'recRemoved', 'recRequired', 'removePick', 'tooFew']);
});

// THE SHIP GATE: red while ANY S3 string is a placeholder — the branch cannot ride a train before the owner approves the addendum's copy
test('SHIP GATE: no placeholder ships — every S3 string is owner-approved text', () => {
  const pending = Object.entries(S3_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});
