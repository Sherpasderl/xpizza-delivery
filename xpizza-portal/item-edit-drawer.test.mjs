// S4 «Editar producto» Phase 2 — the drawer under a REAL DOM (MOCKUP-portal-item-edit.html frames A–F, the approved target; S2-DESIGN
// §1 r2): jsdom over the shipped index.html with the REAL app.js, ventas.js and shell.js (auth stubbed). The menu is the REAL la_musa
// seed (the functions' seed-source-store: a sectioned «Bebidas» with Sodas / Cervezas, a product with a required choice «Pad Thai»);
// getEditableCatalog answers in the contract's exact shape. The extras rule is the SERVER's own module, installed as the globals the
// page's classic script provides (S2 §1.6) — never a laxer fake.
// Run: node --test --test-force-exit xpizza-portal/item-edit-drawer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';

const req = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = req('jsdom');
const { buildSourceFromCode } = req('./tools/seed-source-store');
const { rendererContract } = req('./catalog/source-store');
// the page's classic script: the PORTAL'S OWN copy (tools/sync-client.js), run as the browser runs it — it defines ExtrasEligibility
import { runInThisContext } from 'node:vm';
runInThisContext(readFileSync(join(DIR, 'extras-eligibility.js'), 'utf8'));   // once per process, as once per page load
const EE = globalThis.ExtrasEligibility;
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const RID = 'la_musa';
const SRC = buildSourceFromCode(RID);
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'catalog.add_product', 'catalog.reset_draft', 'stats.read',
  'availability.set', 'location.prep', 'location.pause', 'location.hours', 'team.invite', 'team.revoke'];
const E1 = () => ({ brands: [{ brand_id: RID, name: 'La Musa' }], membership_writes_enabled: false,
  branches: [{ rid: RID, brand_id: RID, role: 'owner', state: 'member', caps: OWNER_CAPS, name: 'Centro', identity_version: 2, editable: { prep_default_min: 20 },
    readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null }] });
// the S2 §1.1 read: today's body + textEditEnabled (always present) + reservedNames / pendingTexts when served
const editable = (over = {}) => ({ source: JSON.parse(JSON.stringify(SRC)), sourceUpdateTime: '1700000000.000000001', activeVersionId: 'v-live', usesPlatformFactura: false,
  renderedCategories: [...rendererContract(RID).renderedCategories], restaurantName: 'La Musa', publish_via_request: false, groupAuthoring: false, choiceBadges: [],
  textEditEnabled: true, reservedNames: [], ...over });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__ied-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-ied";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__ied-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__ied-under-test.${n}.${tag}.mjs`;
  const files = [auth]; const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__ied-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ read = () => editable(), evaluator = true, on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (evaluator) globalThis.ExtrasEligibility = EE; else delete globalThis.ExtrasEligibility;
  globalThis.__branchesDirect = true;
  globalThis.CSS = { escape: (x) => String(x).replace(/["\\]/g, '\\$&') };   // jsdom has no CSS.escape (Codex S4P2 r1: uncaught «CSS is not defined»)
  const st = { read };
  const calls = installFetch((fn) => {
    if (on[fn]) { const r = on[fn](calls[calls.length - 1]); if (r) return r; }
    if (fn === 'getMyBranches') return okJson(E1());
    if (fn === 'getEditableCatalog') return okJson(st.read());
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async () => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: 'uOwnerIED' } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(80);
  };
  const drawer = () => d.getElementById('drawer');
  const open = async (key) => { mods.app.openDrawer(key); await settle(10); return drawer(); };
  const fld = (label) => [...drawer().querySelectorAll('.dwb > .fld')].find((f) => { const l = f.querySelector('label'); return l && l.firstChild && l.firstChild.textContent.trim() === label; });
  const btn = (label) => [...drawer().querySelectorAll('.dwf button')].find((b) => b.textContent.trim() === label);
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const choose = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const src = () => mods.app.state.draft && JSON.parse(JSON.stringify((mods.app.state.draft.state)));
  return { dom, w, d, mods, st, calls, n, signIn, drawer, open, fld, btn, type, choose, src };
}
const lineOf = (f) => { const e = f && f.querySelector('.ferr.mk-ferr'); return e ? e.textContent.trim() : null; };

test('OFF (textEditEnabled false / absent): an existing product\'s drawer is TODAY\'s — no text fields, no footer, the price writes at once', async () => {
  for (const over of [{ textEditEnabled: false }, { textEditEnabled: undefined }]) {
    const p = await page({ read: () => { const b = editable(over); if (over.textEditEnabled === undefined) delete b.textEditEnabled; return b; } });
    await p.signIn();
    const dr = await p.open('dimsum_01');
    assert.ok(dr.classList.contains('show'), 'premise: the drawer opened');
    assert.equal(dr.querySelector('.dwf'), null, 'no «Cancelar» / «Guardar» footer');
    assert.equal(p.fld('Nombre'), undefined, 'no Nombre field');
    const price = dr.querySelector('input[aria-label="Precio"]');
    p.type(price, '260');
    assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').price, 260, 'today: the price lands in the draft as it is typed');
  }
});

test('A — the drawer, default: Nombre (counter, no maxlength) · Descripción · opcional (counter, maxlength 200) · Categoría · Precio; «Guardar» off', async () => {
  const p = await page();
  await p.signIn();
  const dr = await p.open('dimsum_01');
  assert.equal(dr.getAttribute('aria-label'), 'Editar producto');
  assert.equal(dr.querySelector('.dwt').textContent, 'Sichuan Spicy Wonton');
  const labels = [...dr.querySelectorAll('.dwb > .fld')].map((f) => f.querySelector('label').firstChild.textContent.trim());
  assert.deepEqual(labels.filter((l) => l !== 'Foto'), ['Nombre', 'Descripción', 'Categoría', 'Precio'], 'frame A\'s order (no Subcategoría: Dim Sum has none)');
  const nm = p.fld('Nombre').querySelector('input');
  assert.equal(nm.value, 'Sichuan Spicy Wonton');
  assert.equal(nm.placeholder, 'Nombre del producto');
  assert.equal(nm.hasAttribute('maxlength'), false, 'C2 / advisor Q3: the owner may type past 60');
  assert.equal(p.fld('Nombre').querySelector('.mk-cnt').textContent, '20/60');
  const ds = p.fld('Descripción').querySelector('textarea');
  assert.equal(ds.maxLength, 200);
  assert.equal(ds.placeholder, 'Qué lleva, cómo viene');
  assert.equal(p.fld('Descripción').querySelector('.mk-opt').textContent, ' · opcional');
  const cat = p.fld('Categoría').querySelector('select.mk-sel');
  assert.deepEqual([...cat.options].map((o) => o.textContent), ['Dim Sum', 'Starters', 'House Specials', 'Crudo', 'Noodles', 'Rice', 'Soups & Salads', 'Bebidas'], 'the sections the order page shows');
  assert.equal(cat.value, 'dim_sum');
  const save = p.btn('Guardar');
  assert.ok(save.disabled);
  assert.equal(save.title, 'No hay cambios que guardar');
  assert.ok(save.classList.contains('accent') && p.btn('Cancelar').classList.contains('ghost'));
});

test('B — typing the name: the counter follows, the field takes the change mark, «Guardar» turns on; the SAME input node (no rebuild under the caret)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  const before = JSON.stringify(p.src());
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Wonton picante');
  assert.equal(p.fld('Nombre').querySelector('input'), nm, 'the input the merchant is typing into is never replaced');
  assert.equal(p.fld('Nombre').querySelector('.mk-cnt').textContent, '14/60');
  assert.ok(p.fld('Nombre').classList.contains('chg'));
  assert.equal(p.btn('Guardar').disabled, false);
  assert.equal(p.drawer().querySelector('.dwt').textContent, 'Sichuan Spicy Wonton', 'the header keeps the published name until saved');
  assert.equal(JSON.stringify(p.src()), before, 'nothing reaches the draft while typing');
  p.btn('Guardar').click();
  await settle(10);
  assert.ok(!p.drawer().classList.contains('show'), '«Guardar» closes the drawer');
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').display.name, 'Wonton picante', 'the whole edit in the draft, once');
});

test('C — the name\'s lines, while typing: quotes, empty, over 60 (counter red), duplicate, a served reserved name; «Guardar» off with its hint', async () => {
  const p = await page({ read: () => editable({ reservedNames: ['hawaiana'] }) });
  await p.signIn();
  await p.open('dimsum_01');
  const nm = p.fld('Nombre').querySelector('input');
  const cases = [
    ['Wonton "picante" <nuevo>', 'Quitá las comillas y los signos < >', 'Corregí el nombre para guardar'],
    ['', 'Escribí un nombre', 'Corregí el nombre para guardar'],
    ['Wonton picante de cerdo con aceite de chile de Sichuan y cebollín', 'Hasta 60 letras', 'Acortá el nombre para guardar'],
    ['Pork Belly Buns', 'Ya hay un producto con ese nombre', 'Corregí el nombre para guardar'],
    ['HAWAIANA', 'Ese nombre no está disponible', 'Corregí el nombre para guardar'],
  ];
  for (const [typed, line, hint] of cases) {
    p.type(nm, typed);
    const f = p.fld('Nombre');
    assert.ok(f.classList.contains('invalid'), `«${typed}»`);
    assert.equal(lineOf(f), line, `«${typed}»`);
    assert.equal(f.querySelector('.ferr').getAttribute('role'), 'alert');
    assert.equal(p.btn('Guardar').disabled, true);
    assert.equal(p.btn('Guardar').title, hint);
  }
  p.type(nm, 'Wonton picante de cerdo con aceite de chile de Sichuan y cebollín');
  assert.ok(p.fld('Nombre').querySelector('.mk-cnt').classList.contains('over'), 'C2: the counter turns red past 60');
});

test('C — a description with < > reads «Quitá los signos < >» (G1); quotes are fine', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  const ds = p.fld('Descripción').querySelector('textarea');
  p.type(ds, 'La "clásica"');
  assert.equal(lineOf(p.fld('Descripción')), null);
  p.type(ds, 'Con <b>chile</b>');
  assert.equal(lineOf(p.fld('Descripción')), 'Quitá los signos < >');
  assert.equal(p.btn('Guardar').title, 'Corregí la descripción para guardar');
});

test('D — a move: the note «Al mover a Bebidas:» lists exactly what changes (THE ONE extras rule); Subcategoría appears, no preselect', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.choose(p.fld('Categoría').querySelector('select'), 'bebidas');
  await settle(5);
  const note = p.fld('Categoría').querySelector('.mk-note');
  assert.ok(!note.hidden);
  assert.equal(note.getAttribute('role'), 'status');
  assert.equal(note.querySelector('b').textContent, 'Al mover a Bebidas:');
  assert.deepEqual([...note.querySelectorAll('li')].map((li) => li.textContent), ['Deja de aceptar el extra Acompañamientos', 'Deja de aceptar el extra Salsas', 'Deja de canjearse con puntos'],
    'the extras the shared rule drops, then the seed\'s own rewards rule (Bebidas is not redeemable)');
  assert.ok([...note.querySelectorAll('li')].every((li) => li.querySelector('.mk-cdot')), 'each line carries its dot (.mk-cdot, advisor INTENDED)');
  assert.ok(p.fld('Categoría').classList.contains('chg'));
  const sub = p.fld('Subcategoría').querySelector('select');
  assert.equal(sub.value, '', 'no preselect');
  assert.equal(p.btn('Guardar').disabled, true);
  assert.equal(p.btn('Guardar').title, 'Elegí una subcategoría');
  p.choose(sub, 'Sodas');
  await settle(5);
  assert.equal(p.btn('Guardar').disabled, false);
  p.choose(p.fld('Categoría').querySelector('select'), 'dim_sum');
  await settle(5);
  assert.equal(p.fld('Subcategoría'), undefined, 'back to a section without subsections: the field goes');
  assert.ok(p.fld('Categoría').querySelector('.mk-note').hidden, 'no move, no note');
});

test('D2 — the move that would empty a section is refused in the field; «Guardar» off', async () => {
  const p = await page();
  await p.signIn();
  await p.open('beer_01');
  // the last Soda leaving Sodas empties a SUBSECTION; moving it within Bebidas to Cervezas is the same-section case
  const sodas = SRC.items.filter((i) => i.display.cat === 'bebidas' && i.display.subcat === 'Sodas').map((i) => i.key);
  assert.ok(sodas.length > 1, 'premise');
  const p2 = await page({ read: () => { const b = editable(); b.source.items = b.source.items.filter((i) => !(i.display.subcat === 'Sodas' && i.key !== sodas[0])); b.source.structure.item_order = b.source.structure.item_order.filter((k) => b.source.items.some((i) => i.key === k)); return b; } });
  await p2.signIn();
  await p2.open(sodas[0]);
  p2.choose(p2.fld('Subcategoría').querySelector('select'), 'Cervezas');
  await settle(5);
  // contract C-2 (Codex S4P2 r1 P2-4): staying in the section, the line is Subcategoría's
  assert.equal(lineOf(p2.fld('Subcategoría')), 'No podés dejar la subcategoría vacía. Agregá otro producto primero.');
  assert.equal(lineOf(p2.fld('Categoría')), null);
  assert.equal(p2.btn('Guardar').title, 'Elegí una subcategoría');
  // SBS D2: a refused move to ANOTHER section (it has consequences) shows its line, not the consequence note
  p2.choose(p2.fld('Categoría').querySelector('select'), 'dim_sum');
  await settle(5);
  assert.equal(lineOf(p2.fld('Categoría')), 'No podés dejar la subcategoría vacía. Agregá otro producto primero.');
  assert.ok(p2.fld('Categoría').querySelector('.mk-note').hidden, 'SBS D2: the refused move shows no consequence note');
  assert.equal(p2.btn('Guardar').disabled, true);
  assert.equal(p2.btn('Guardar').title, 'Elegí otra categoría para guardar');
});

test('F — a product with a required choice: «Se mueve con su producto», each derived name with its counter and — kept (Q1) — its price box', async () => {
  const p = await page();
  await p.signIn();
  const dr = await p.open('noodle_01');
  const f = p.fld('Opciones');
  assert.ok(f, 'the Opciones block');
  assert.equal(f.querySelector('.mk-lrow .mk-cnt').textContent, 'precio por opción');
  assert.equal(f.querySelector('.modh').firstChild.textContent, 'Proteína · elección requerida');
  assert.equal(f.querySelector('.mk-modhr').textContent, 'Se mueve con su producto');
  const rows = () => [...f.querySelectorAll('.mk-dopt')];
  assert.deepEqual(rows().map((r) => r.querySelector('.mk-dn').textContent), ['Pad Thai - Sin Proteína', 'Pad Thai - Pollo', 'Pad Thai - Camarones']);
  assert.ok(rows().every((r) => r.querySelector('.dp .mopr input')), 'advisor Q1: each option keeps its price box');
  assert.equal(p.fld('Precio'), undefined, 'a group\'s price lives on its options');
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Pad Thai de la casa con salsa de tamarindo y maní tostado');
  assert.equal(lineOf(f), 'El nombre completo de la opción supera 60 letras', 'F2: the line under the Opciones block');
  assert.equal(lineOf(p.fld('Nombre')), null, 'F2: Nombre itself is not marked');
  assert.ok(f.querySelector('.modblock').classList.contains('mk-inv'));
  assert.ok(f.querySelector('.mk-lrow .mk-cnt').classList.contains('mk-cnterr'), 'SBS F2: «precio por opción» turns red with the block');
  assert.ok(rows().some((r) => r.classList.contains('over')));
  assert.equal(p.btn('Guardar').title, 'Acortá el nombre para guardar');
  p.type(nm, 'Pad Thai Especial');
  assert.deepEqual(rows().map((r) => r.querySelector('.mk-dn').textContent), ['Pad Thai Especial - Sin Proteína', 'Pad Thai Especial - Pollo', 'Pad Thai Especial - Camarones']);
  p.type(rows()[1].querySelector('.dp input'), '350');
  p.btn('Guardar').click();
  await settle(10);
  const items = p.src().items;
  assert.equal(items.find((i) => i.key === 'noodle_01').display.name, 'Pad Thai Especial');
  assert.equal(items.find((i) => i.key === 'noodle_01_pollo').display.name, 'Pad Thai Especial - Pollo', 'the options are re-derived with the product');
  assert.equal(items.find((i) => i.key === 'noodle_01_pollo').price, 350, 'and the option price rides the same «Guardar»');
  void dr;
});

test('«Cancelar» / «Cerrar» drop the WHOLE copy — text, section, price and the extras-group prices (Q2): the draft is untouched', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  const before = JSON.stringify(p.src());
  p.type(p.fld('Nombre').querySelector('input'), 'Otro nombre');
  p.type(p.fld('Precio').querySelector('input'), '999');
  const grp = p.drawer().querySelector('.modgrp .mgmain');
  grp.click(); await settle(5);
  const ex = p.drawer().querySelector('.modgrp.open .mopr input');
  assert.ok(ex, 'premise: an extras group opened, its price editable');
  p.type(ex, '77');
  p.btn('Cancelar').click();
  await settle(5);
  assert.ok(!p.drawer().classList.contains('show'));
  assert.equal(JSON.stringify(p.src()), before, '«Cancelar»: nothing written');
  await p.open('dimsum_01');
  assert.equal(p.fld('Nombre').querySelector('input').value, 'Sichuan Spicy Wonton', 'reopened: the published values');
  p.type(p.fld('Nombre').querySelector('input'), 'Otro nombre');
  p.drawer().querySelector('.dwh button').click();
  await settle(5);
  assert.equal(JSON.stringify(p.src()), before, '«Cerrar» is «Cancelar»');
});

test('Q2 — an extras-group price edited in the drawer is committed by «Guardar», together with the rest, in ONE draft change', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.drawer().querySelector('.modgrp .mgmain').click(); await settle(5);
  const ex = p.drawer().querySelector('.modgrp.open .mopr input');
  const label = ex.getAttribute('aria-label').replace(/^Precio de /, '');
  p.type(ex, '77');
  assert.equal(p.btn('Guardar').disabled, false, 'an extras price alone is a change');
  p.btn('Guardar').click();
  await settle(10);
  assert.equal(p.src().extras.find((x) => (x.display && x.display.name) === label || x.key === label).price, 77);
});

test('D — without the shared evaluator loaded, a move is held (never a guessed consequence)', async () => {
  const p = await page({ evaluator: false });
  await p.signIn();
  await p.open('dimsum_01');
  p.choose(p.fld('Categoría').querySelector('select'), 'starters');
  await settle(5);
  assert.equal(p.btn('Guardar').disabled, true);
  assert.equal(p.btn('Guardar').title, 'Elegí otra categoría para guardar');
});

// ── frame B, the list after «Guardar»: the row's tag and the bar's «· N producto» (the P7 «· 1 foto» pattern) ──
const rowOf = (p, name) => [...p.d.querySelectorAll('#detail .irow')].find((r) => { const nm = r.querySelector('.nm'); return nm && nm.firstChild && nm.firstChild.textContent === name; });
test('B — after «Guardar» the row shows the new name with «Nombre sin publicar»; the bar counts it «· 1 producto»', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.type(p.fld('Nombre').querySelector('input'), 'Wonton picante');
  p.btn('Guardar').click();
  await settle(10);
  const row = rowOf(p, 'Wonton picante');
  assert.ok(row, 'the row shows the new name');
  const tag = row.querySelector('.nm .tag.mk-ftag');
  assert.ok(tag, 'the amber tag');
  assert.equal(tag.textContent, 'Nombre sin publicar');
  assert.match(p.d.getElementById('rbtxt').textContent, /^1 cambio sin publicar · 1 producto$/);
});

test('B/E — a multi-field edit reads «Cambios sin publicar»; two products → «· 2 productos»', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.type(p.fld('Nombre').querySelector('input'), 'Wonton picante');
  p.type(p.fld('Descripción').querySelector('textarea'), 'Cerdo y chile');
  p.btn('Guardar').click();
  await settle(10);
  assert.equal(rowOf(p, 'Wonton picante').querySelector('.tag.mk-ftag').textContent, 'Cambios sin publicar');
  await p.open('dimsum_02');
  p.type(p.fld('Descripción').querySelector('textarea'), 'Bao y panceta');
  p.btn('Guardar').click();
  await settle(10);
  assert.equal(rowOf(p, 'Pork Belly Buns').querySelector('.tag.mk-ftag').textContent, 'Cambios sin publicar', 'a description alone is a «Cambios» edit');
  assert.match(p.d.getElementById('rbtxt').textContent, / · 2 productos$/);
});

test('after a reload the SAVED text edits keep their tags (pendingTexts, S2 §1.1) — the client cannot see them on its own', async () => {
  const p = await page({ read: () => { const b = editable({ pendingTexts: [{ key: 'dimsum_01', fields: ['name'] }, { key: 'dimsum_02', fields: ['desc', 'cat'] }] }); return b; } });
  await p.signIn();
  const t1 = rowOf(p, 'Sichuan Spicy Wonton').querySelector('.tag.mk-ftag'), t2 = rowOf(p, 'Pork Belly Buns').querySelector('.tag.mk-ftag');
  assert.ok(t1 && t2, 'the saved edits are tagged after the reload');
  assert.equal(t1.textContent, 'Nombre sin publicar');
  assert.equal(t2.textContent, 'Cambios sin publicar');
  assert.equal(rowOf(p, 'Shrimp Dumplings').querySelector('.tag.mk-ftag'), null, 'only the products the server names');
});

test('OFF — no tags and no «· producto» suffix without the switch (today\'s list)', async () => {
  const p = await page({ read: () => editable({ textEditEnabled: false, pendingTexts: [{ key: 'dimsum_01', fields: ['name'] }] }) });
  await p.signIn();
  assert.equal(p.d.querySelector('#detail .tag.mk-ftag'), null);
});

// ── the review-time refusals of an EXISTING product (advisor ruling 11-10): the drawer's approved line as the panel title,
// «Es en «{producto}». Tus otros cambios siguen en el borrador.», «Corregir» → that product's drawer with the line under the field ──
const panel = (p) => { const b = p.d.querySelector('#mbody .conflict'); return b && { title: b.querySelector('h3').textContent, detail: b.querySelector('p').textContent, action: b.querySelector('button') }; };
async function renameAndReview(p, key, name) {
  await p.open(key);
  p.type(p.fld('Nombre').querySelector('input'), name);
  p.btn('Guardar').click();
  await settle(10);
  p.d.getElementById('review').click();
  await settle(60);
}
test('review refusal on an existing product — the approved line, the detail with the loaded name, «Corregir» reopens it at Nombre', async () => {
  const p = await page({ on: { editCatalog: () => errJson(400, { error: 'name_previously_used', key: 'dimsum_01', field: 'name' }) } });
  await p.signIn();
  await renameAndReview(p, 'dimsum_01', 'Hawaiana');
  const pn = panel(p);
  assert.ok(pn, 'the refusal panel');
  assert.equal(pn.title, 'Ese nombre no está disponible');
  assert.equal(pn.detail, 'Es en «Sichuan Spicy Wonton». Tus otros cambios siguen en el borrador.');
  assert.equal(pn.action.textContent, 'Corregir');
  pn.action.click();
  await settle(20);
  assert.ok(p.drawer().classList.contains('show'), 'the product\'s drawer');
  assert.equal(p.fld('Nombre').querySelector('input').value, 'Hawaiana', 'the draft\'s value, to correct');
  assert.equal(lineOf(p.fld('Nombre')), 'Ese nombre no está disponible', 'the line under the field the server named');
  assert.equal(p.btn('Guardar').disabled, true);
  p.type(p.fld('Nombre').querySelector('input'), 'Wonton picante');
  assert.equal(lineOf(p.fld('Nombre')), null, 'changing that field clears the server\'s line');
  assert.equal(p.btn('Guardar').disabled, false);
});
test('review refusal on a derived option name — the line sits on the Opciones block (frame F2 placement)', async () => {
  const p = await page({ on: { editCatalog: () => errJson(400, { error: 'name_taken', key: 'noodle_01', field: 'name', option_key: 'noodle_01_pollo' }) } });
  await p.signIn();
  await renameAndReview(p, 'noodle_01', 'Pad Thai Especial');
  assert.equal(panel(p).title, 'Ya hay un producto con ese nombre');
  panel(p).action.click();
  await settle(20);
  assert.equal(lineOf(p.fld('Opciones')), 'Ya hay un producto con ese nombre');
  assert.equal(lineOf(p.fld('Nombre')), null);
});
test('category_not_renderable — «Esa sección no se muestra en tu página de pedidos» under Categoría, and the sections are re-read', async () => {
  let reads = 0;
  const p = await page({ on: { editCatalog: () => errJson(400, { error: 'category_not_renderable', key: 'dimsum_01', field: 'cat' }),
    getEditableCatalog: () => { reads += 1; return null; } } });
  await p.signIn();
  await renameAndReview(p, 'dimsum_01', 'Wonton picante');
  const before = reads;
  assert.equal(panel(p).title, 'Esa sección no se muestra en tu página de pedidos');
  panel(p).action.click();
  await settle(40);
  assert.equal(lineOf(p.fld('Categoría')), 'Esa sección no se muestra en tu página de pedidos');
  assert.ok(reads > before, 'C-1: the drawer re-reads the sections');
  assert.equal(p.fld('Nombre').querySelector('input').value, 'Wonton picante', 'the re-read never replaces the merchant\'s draft');
});
test('reserved_key_conflict at PUBLISH — the same panel on the named product', async () => {
  const p = await page({ on: {
    editCatalog: () => okJson({ token: 'ET', updateTime: 'T2', baseActiveVersionId: 'v-live', sourceHash: 'h',
      diff: { added: [], removed: [], renamed: [], largeChangeSet: [], changed: [{ key: 'dimsum_01', surface: 'item', field: 'name', old: 'Sichuan Spicy Wonton', new: 'Hawaiana' }] } }),
    publishEdited: () => errJson(409, { error: 'reserved_key_conflict', key: 'dimsum_01', name: 'Hawaiana', field: 'name' }),
  } });
  await p.signIn();
  await renameAndReview(p, 'dimsum_01', 'Hawaiana');
  const pub = p.d.getElementById('pubbtn');
  assert.ok(pub && !pub.disabled, 'premise: the review is up and publishable');
  pub.click();
  await settle(60);
  assert.equal(panel(p).title, 'Ese nombre no está disponible');
  assert.equal(panel(p).detail, 'Es en «Sichuan Spicy Wonton». Tus otros cambios siguen en el borrador.');
});
test('stale CAS (S4 addendum) — a drawer edit then a stale save: today\'s «Tu borrador cambió» panel, never the product panel; the edit stays in the draft', async () => {
  const p = await page({ on: { editCatalog: () => errJson(409, { error: 'stale_edit', detail: 'base moved' }) } });
  await p.signIn();
  await renameAndReview(p, 'dimsum_01', 'Wonton picante');
  assert.equal(panel(p).title, 'Tu borrador cambió');
  assert.equal(panel(p).action.textContent, 'Recargar y reaplicar');
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').display.name, 'Wonton picante', 'nothing is lost before the merchant decides');
});
test('fiscal brand (frame E) — the review seal after a rename + a price: the drawn sentence, the price under the new name, «Nombre en factura»', async () => {
  const p = await page({ read: () => editable({ usesPlatformFactura: true }), on: {
    editCatalog: () => okJson({ token: 'ET', updateTime: 'T2', baseActiveVersionId: 'v-live', sourceHash: 'h',
      diff: { added: [], removed: [], renamed: [], largeChangeSet: [], changed: [{ key: 'dimsum_01', surface: 'item', field: 'price', old: 249, new: 259 },
        { key: 'dimsum_01', surface: 'item', field: 'name', old: 'Sichuan Spicy Wonton', new: 'Wonton picante' }] } }) } });
  await p.signIn();
  await p.open('dimsum_01');
  p.type(p.fld('Nombre').querySelector('input'), 'Wonton picante');
  p.type(p.fld('Precio').querySelector('input'), '259');
  p.btn('Guardar').click(); await settle(10);
  p.d.getElementById('review').click(); await settle(60);
  const seal = p.d.querySelector('#mbody .seal, .seal');
  assert.ok(seal, 'the seal');
  assert.equal(seal.querySelector('.sealbody p').textContent, 'Como propietario, autorizás esta publicación. Cambia un precio y el nombre de un producto: los dos aparecen en la factura.');
  assert.deepEqual([...seal.querySelectorAll('.seachg .sn')].map((n) => n.textContent), ['Wonton picante', 'Nombre en factura']);
  assert.equal(seal.querySelector('.at').textContent.replace(/\s+/g, ' ').trim(), 'Autorizo esta edición en la factura fiscal.');
});

// Codex S4P2 r1 P1-1: with THE ONE rule loaded (the shipped page's classic script, S2 §1.6 — a hard prerequisite), a cross-category
// move works end to end: the note, «Guardar», the draft (the product AND the section change), the row's tag
test('P1-1 — the eligibility rule loaded: a cross-category move saves end to end (note, «Guardar», draft, tag)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.choose(p.fld('Categoría').querySelector('select'), 'starters');
  await settle(5);
  assert.ok(p.fld('Categoría').querySelector('.mk-note').hidden, 'Dim Sum → Starters changes nothing (same extras, both redeemable): no note, as the mockup');
  assert.equal(p.btn('Guardar').disabled, false, '«Guardar» is free (no held move)');
  p.btn('Guardar').click(); await settle(15);
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').display.cat, 'starters', 'the draft carries the move');
  assert.ok(!p.drawer().classList.contains('show'));
});
test('S2 §1.6 — the page loads THE ONE rule as a classic script BEFORE the modules (boot.js) that read it; the copy is the server\'s, byte for byte', () => {
  const i = HTML.indexOf('<script src="extras-eligibility.js"></script>'), b = HTML.indexOf('src="./boot.js"');
  assert.ok(i > -1, 'the classic <script>');
  assert.ok(b > -1 && i < b, 'before boot.js');
  assert.ok(Buffer.compare(readFileSync(join(DIR, 'extras-eligibility.js')), readFileSync(join(DIR, '..', 'xpizza-functions', 'catalog', 'extras-eligibility.js'))) === 0, 'byte-identical to the server module (tools/sync-client.js)');
  assert.equal(typeof EE.projectEligibility, 'function', 'the shipped file defines the ExtrasEligibility global the drawer reads');
});
// AA review (advisor 11-10): every new field is labelled; an error line is TIED to its control (aria-invalid + aria-describedby) and
// untied when it clears; the tab order is the visual order (no positive tabindex)
test('AA — labels, error ties and tab order in the edit drawer', async () => {
  const p = await page({ read: () => editable({ reservedNames: ['hawaiana'] }) });
  await p.signIn();
  await p.open('noodle_01');
  const dr = p.drawer();
  const nm = p.fld('Nombre').querySelector('input');
  assert.equal(dr.querySelector(`label[for="${nm.id}"]`).firstChild.textContent, 'Nombre');
  const ds = p.fld('Descripción').querySelector('textarea');
  assert.ok(dr.querySelector(`label[for="${ds.id}"]`), 'Descripción is labelled');
  assert.equal(p.fld('Categoría').querySelector('select').getAttribute('aria-label'), 'Categoría');
  assert.ok([...dr.querySelectorAll('.mk-dopt input')].every((i) => /^Precio de /.test(i.getAttribute('aria-label') || '')), 'each option price is labelled');
  assert.equal([...dr.querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0).length, 0, 'no positive tabindex: the tab order is the DOM order');
  p.type(nm, 'Hawaiana');
  const line = p.fld('Nombre').querySelector('.ferr');
  assert.ok(line.id, 'the error line has an id');
  assert.equal(nm.getAttribute('aria-invalid'), 'true');
  assert.equal(nm.getAttribute('aria-describedby'), line.id, 'the control is described by its error line');
  p.type(nm, 'Pad Thai Especial');
  assert.equal(nm.hasAttribute('aria-invalid'), false, 'cleared with the line');
  assert.equal(nm.hasAttribute('aria-describedby'), false);
  p.type(nm, 'Pad Thai de la casa con salsa de tamarindo y maní tostado');
  const ob = p.fld('Opciones');
  const oline = ob.querySelector('.ferr');
  assert.ok([...ob.querySelectorAll('.mk-dopt input')].every((i) => i.getAttribute('aria-describedby') === oline.id), 'F2: the option price boxes are described by the block line');
});
