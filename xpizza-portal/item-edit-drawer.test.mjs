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
  // STRUCTURE S1 (MOCKUP-portal-structure-edit v2 frame A): the drawer now ends with «Opciones» (the dish's extras cards)
  assert.deepEqual(labels.filter((l) => l !== 'Foto'), ['Nombre', 'Descripción', 'Categoría', 'Precio', 'Opciones'], 'frame A\'s order (no Subcategoría: Dim Sum has none)');
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

test('F — a product with a required choice: its «Opciones» card (v2 frame A), each derived name with its counter and — kept (Q1 / R1) — its price box', async () => {
  const p = await page();
  await p.signIn();
  const dr = await p.open('noodle_01');
  const f = p.fld('Opciones');
  assert.ok(f, 'the Opciones block');
  // STRUCTURE S1: the S4 block's «precio por opción» / «… · elección requerida» / «Se mueve con su producto» are v2's card header
  assert.equal(f.querySelector('.mk-lrow .mk-cnt').textContent, 'El orden de los grupos se define en Extras');   // mockup v3 (owner 11-11)
  const card = f.querySelector('.mk-grp.mk-req');
  assert.equal(card.querySelector('.mk-gtn').textContent, 'Proteína');
  assert.equal(card.querySelector('.mk-gts').textContent, 'Elección requerida · el cliente elige 1');
  const rows = () => [...f.querySelectorAll('.mk-dopt')];
  assert.deepEqual(rows().map((r) => r.querySelector('.mk-dn').textContent), ['Pad Thai - Sin Proteína', 'Pad Thai - Pollo', 'Pad Thai - Camarones']);
  assert.ok(rows().every((r) => r.querySelector('.dp .mopr input')), 'advisor Q1: each option keeps its price box');
  assert.equal(p.fld('Precio'), undefined, 'a group\'s price lives on its options');
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Pad Thai de la casa con salsa de tamarindo y maní tostado');
  assert.equal(lineOf(f), 'El nombre completo de la opción supera 60 letras', 'F2: the line under the Opciones block');
  assert.equal(lineOf(p.fld('Nombre')), null, 'F2: Nombre itself is not marked');
  assert.ok(card.classList.contains('mk-inv'), 'F2: the required-choice card is marked');
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
  // STRUCTURE S1: the dish's extras cards are open by default; their prices editable as today (R4)
  const ex = p.drawer().querySelector('.mk-ext.mk-open .mopr input');
  assert.ok(ex, 'premise: an extras card, its price editable');
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
  const ex = p.drawer().querySelector('.mk-ext.mk-open .mopr input');   // STRUCTURE S1: the card's price (R4)
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
// AA rulings 11-10: «Corregir» puts focus on the field the server's line names (a derived option name → Nombre, where it is fixed);
// the counters announce nothing (no aria-live: the error line's role=alert + describedby already speak for over-60)
test('AA — «Corregir» focuses the field the server named; a derived option name focuses Nombre', async () => {
  const p = await page({ on: { editCatalog: () => errJson(400, { error: 'name_previously_used', key: 'dimsum_01', field: 'name' }) } });
  await p.signIn();
  await renameAndReview(p, 'dimsum_01', 'Hawaiana');
  panel(p).action.click(); await settle(20);
  assert.equal(p.d.activeElement, p.fld('Nombre').querySelector('input'));
  const q = await page({ on: { editCatalog: () => errJson(400, { error: 'category_not_renderable', key: 'dimsum_01', field: 'cat' }), getEditableCatalog: () => null } });
  await q.signIn();
  await renameAndReview(q, 'dimsum_01', 'Wonton picante');
  panel(q).action.click(); await settle(40);
  assert.equal(q.d.activeElement, q.fld('Categoría').querySelector('select'));
  const r = await page({ on: { editCatalog: () => errJson(400, { error: 'name_taken', key: 'noodle_01', field: 'name', option_key: 'noodle_01_pollo' }) } });
  await r.signIn();
  await renameAndReview(r, 'noodle_01', 'Pad Thai Especial');
  panel(r).action.click(); await settle(20);
  assert.equal(r.d.activeElement, r.fld('Nombre').querySelector('input'), 'a derived option name is fixed in Nombre');
});
test('AA — the counters carry no aria-live (an announcement on every keystroke is noise)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('noodle_01');
  assert.equal(p.drawer().querySelectorAll('.mk-cnt[aria-live]').length, 0);
  assert.ok(p.drawer().querySelectorAll('.mk-cnt').length >= 5, 'premise: the counters are there (name, description, each option)');
});

// ── UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11; PREP-ite-drawer-unsaved.md). Every string is the
// addendum's copy table, verbatim. The real drawer has NO page backdrop; the confirm's own scrim covers the drawer only. ──────────
const HINT = 'Guardá o cancelá los cambios del producto abierto';
const card = (p) => p.drawer().querySelector('.mk-cf');
const cardBtn = (p, t) => [...card(p).querySelectorAll('button')].find((b) => b.textContent.trim() === t);
const headClose = (p) => p.drawer().querySelector('.dwh .dwx');
const priceIn = (p) => p.drawer().querySelector('input[aria-label="Precio"]');
// the WHOLE open copy as the drawer shows it: every control's value (inputs, selects, text, checkboxes), the change marks, «Guardar»'s
// state and title, the «Cambios sin guardar» mark — plus the identity of every control node (a rebuilt copy would make new nodes)
const ctrls = (p) => [...p.drawer().querySelectorAll('.dwb input, .dwb textarea, .dwb select')];
const fieldsNow = (p) => ({ values: ctrls(p).map((c) => [c.getAttribute('aria-label') || c.tagName, c.type === 'checkbox' ? c.checked : c.value]),
  chg: [...p.drawer().querySelectorAll('.dwb .fld')].map((f) => f.classList.contains('chg')),
  save: [p.btn('Guardar').disabled, p.btn('Guardar').title], mark: p.drawer().querySelector('.dwf .mk-dirty').hidden });
// the open COPY itself: the same session object, its work / base / photo flag byte-identical, the same upload binding
const copyOf = (p) => { const s = p.mods.app._openCopy(); return { s, up: s && s.upload, json: s && JSON.stringify({ work: s.work, base: s.base, photoTouched: s.photoTouched, upload: s.upload }) }; };
const sameCopy = (p, c0, L) => {
  const c = copyOf(p);
  assert.ok(c.s && c.s === c0.s, `${L}: the SAME working-copy session`);
  assert.strictEqual(c.json, c0.json, `${L}: its work, base, photo flag and upload state byte-identical`);
  assert.ok(c.up === c0.up, `${L}: the SAME upload binding`);
};
const inertNow = (p) => [...p.d.querySelectorAll('[inert]')];
const tabTrapped = (p) => { const e = new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }); p.d.body.dispatchEvent(e); return e.defaultPrevented; };
const keepAssert = (p, f0, nodes0, draft0, L) => {
  assert.deepStrictEqual(fieldsNow(p), f0, `${L}: every control, mark and «Guardar» exactly as before`);
  const nodes = ctrls(p);
  assert.ok(nodes.length === nodes0.length && nodes.every((n, i) => n === nodes0[i]), `${L}: the SAME control nodes (the copy was not rebuilt)`);
  assert.strictEqual(JSON.stringify(p.src()), draft0, `${L}: the whole draft untouched`);
};
// the confirm, exactly as frame 2 draws it
function assertCard(p, L, { pageScrim = false } = {}) {
  const c = card(p);
  assert.ok(c, `${L}: the in-page confirm is shown`);
  assert.equal(c.getAttribute('role'), 'dialog', `${L}: role dialog`);
  assert.equal(c.getAttribute('aria-modal'), 'true', `${L}: aria-modal`);
  assert.equal(c.querySelector('h3').textContent, '¿Descartar los cambios?', `${L}: the title`);
  assert.equal(c.querySelector('p').textContent, 'Tenés cambios sin guardar en este producto.', `${L}: the line`);
  assert.deepEqual([...c.querySelectorAll('.mk-cfa button')].map((b) => b.textContent), ['Descartar', 'Seguir editando'], `${L}: Descartar · Seguir editando`);
  assert.ok(cardBtn(p, 'Descartar').classList.contains('mk-quiet-danger'), `${L}: «Descartar» is the quiet destructive action`);
  assert.ok(cardBtn(p, 'Seguir editando').classList.contains('accent'), `${L}: «Seguir editando» is the primary`);
  assert.equal(p.d.activeElement, cardBtn(p, 'Seguir editando'), `${L}: «Seguir editando» holds focus (Enter keeps the work)`);
  assert.equal(p.d.querySelector('.dscrim.show'), null, `${L}: no page backdrop is added (the real drawer has none)`);
  assert.equal(p.d.getElementById('scrim').classList.contains('show'), pageScrim, `${L}: the page scrim is exactly as it was (the review panel's own, when open)`);
}

test('U-MARK-AND-BAR — an unsaved edit: «Cambios sin guardar» beside «Guardar»; the whole bar waits (Revisar + Descartar disabled, the hint); live again after «Guardar»', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  const mark = () => p.drawer().querySelector('.dwf .mk-dirty');
  const rev = p.d.getElementById('review'), dis = p.d.getElementById('discard');
  const hint = () => p.d.querySelector('#rbar .mk-rbhint');
  assert.ok(mark() && mark().hidden, 'U-MARK-AND-BAR: premise — a clean copy shows no mark');
  assert.ok(!hint() || hint().hidden, 'U-MARK-AND-BAR: premise — no hint while clean');
  p.type(priceIn(p), '285');
  assert.equal(mark().hidden, false, 'U-MARK-AND-BAR: the mark appears beside «Guardar»');
  assert.equal(mark().textContent, 'Cambios sin guardar', 'U-MARK-AND-BAR: the mark\'s words');
  assert.deepEqual([rev.disabled, dis.disabled], [true, true], 'U-MARK-AND-BAR: «Revisar y publicar» AND «Descartar» wait (the whole bar)');
  assert.deepEqual([rev.title, dis.title], [HINT, HINT], 'U-MARK-AND-BAR: both say what to do');
  assert.ok(hint() && !hint().hidden && hint().textContent === HINT, 'U-MARK-AND-BAR: the hint line in the bar');
  const before = p.n('editCatalog').length;
  rev.click(); dis.click(); await settle(30);
  assert.equal(p.n('editCatalog').length, before, 'U-MARK-AND-BAR: nothing publishes or discards around the open copy');
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').price !== 285, true, 'U-MARK-AND-BAR: the draft does not know 285 until «Guardar»');
  p.btn('Guardar').click(); await settle(30);
  assert.equal(p.src().items.find((i) => i.key === 'dimsum_01').price, 285, 'premise: «Guardar» put it in the draft');
  assert.equal(rev.disabled, false, 'U-MARK-AND-BAR: the bar is live again after «Guardar»');
  assert.ok(!hint() || hint().hidden, 'U-MARK-AND-BAR: the hint goes with it');
});

test('U-REVIEW-ADMISSION — even reached programmatically, a review never starts over a dirty copy (Revisar under the drawer, keyboard)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.type(priceIn(p), '285');
  const rev = p.d.getElementById('review');
  rev.disabled = false;   // the keyboard path, defended in depth: the admission itself refuses
  rev.click(); await settle(30);
  assert.equal(p.n('editCatalog').length, 0, 'U-REVIEW-ADMISSION: no save, no review over a dirty copy');
  const dis = p.d.getElementById('discard');
  dis.disabled = false;   // the bar's «Descartar» refuses at admission too (the whole bar waits)
  dis.click(); await settle(30);
  assert.ok(p.drawer().classList.contains('show') && priceIn(p).value === '285', 'U-REVIEW-ADMISSION: the drawer and its copy are untouched');
});

test('U-CERRAR-CLEAN — «Cerrar» on a clean drawer closes at once, no confirm (nothing asks twice)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  headClose(p).click(); await settle(10);
  assert.equal(p.drawer().classList.contains('show'), false, 'U-CERRAR-CLEAN: closed');
  assert.equal(p.d.querySelector('.mk-cf'), null, 'U-CERRAR-CLEAN: no confirm');
});

test('U-CERRAR-DIRTY — «Cerrar» with unsaved edits asks; «Seguir editando» keeps the copy byte-identical; «Descartar» closes with the draft untouched', async () => {
  const p = await page();
  await p.signIn();
  const draft0 = JSON.stringify(p.src());
  await p.open('dimsum_01');
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Wonton picante'); p.type(priceIn(p), '285');
  const f0 = fieldsNow(p), nodes0 = ctrls(p), c0 = copyOf(p);
  headClose(p).click(); await settle(10);
  assertCard(p, 'U-CERRAR-DIRTY');
  assert.ok(p.drawer().classList.contains('show'), 'U-CERRAR-DIRTY: the drawer stays while asking');
  cardBtn(p, 'Seguir editando').click(); await settle(10);
  assert.equal(card(p), null, 'U-CERRAR-DIRTY: «Seguir editando» dismisses the confirm');
  keepAssert(p, f0, nodes0, draft0, 'U-KEEP-EDITING-BYTE-IDENTICAL (Cerrar)');
  sameCopy(p, c0, 'U-KEEP-EDITING-BYTE-IDENTICAL (Cerrar)');
  assert.equal(p.fld('Nombre').querySelector('input'), nm, 'U-KEEP-EDITING-BYTE-IDENTICAL (Cerrar): the SAME input node (no rebuild)');
  p.btn('Guardar').click(); await settle(30);
  const saved = p.src().items.find((i) => i.key === 'dimsum_01');
  assert.deepStrictEqual([saved.price, saved.display.name], [285, 'Wonton picante'], 'U-KEEP-EDITING-BYTE-IDENTICAL (Cerrar): the kept copy saves exactly the typed edits');
  await p.open('dimsum_01'); p.type(priceIn(p), '286');
  const draftSaved = JSON.stringify(p.src());
  headClose(p).click(); await settle(10);
  cardBtn(p, 'Descartar').click(); await settle(10);
  assert.equal(p.drawer().classList.contains('show'), false, 'U-CERRAR-DIRTY: «Descartar» closes the drawer');
  const draft1 = JSON.stringify(JSON.parse(draft0)); void draft1;
  assert.strictEqual(JSON.stringify(p.src()), draftSaved, 'U-CERRAR-DIRTY: frame 3 — the COMPLETE draft exactly as saved (285); the discarded 286 never reached it');
  assert.equal(p.d.getElementById('review').disabled, false, 'U-CERRAR-DIRTY: the bar is live again');
});

test('U-ESC — Escape on the confirm keeps the work (as «Seguir editando»)', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.type(priceIn(p), '285');
  headClose(p).click(); await settle(10);
  card(p).dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(10);
  assert.equal(card(p), null, 'U-ESC: the confirm is gone');
  assert.ok(p.drawer().classList.contains('show') && priceIn(p).value === '285', 'U-ESC: the drawer and the copy stay');
});

test('U-OTHER-ROW-DIRTY — opening another product asks; «Seguir editando» stays on this one byte-identical; «Descartar» opens the other, clean', async () => {
  const p = await page();
  await p.signIn();
  const draft0 = JSON.stringify(p.src());
  await p.open('dimsum_01');
  p.type(priceIn(p), '285');
  const f0 = fieldsNow(p), nodes0 = ctrls(p), c0 = copyOf(p); const pin = priceIn(p);
  await p.open('dimsum_02');
  assertCard(p, 'U-OTHER-ROW-DIRTY');
  assert.equal(p.drawer().querySelector('.dwt').textContent, 'Sichuan Spicy Wonton', 'U-OTHER-ROW-DIRTY: still the first product while asking');
  cardBtn(p, 'Seguir editando').click(); await settle(10);
  keepAssert(p, f0, nodes0, draft0, 'U-KEEP-EDITING-BYTE-IDENTICAL (other row)');
  sameCopy(p, c0, 'U-KEEP-EDITING-BYTE-IDENTICAL (other row)');
  assert.equal(priceIn(p), pin, 'U-KEEP-EDITING-BYTE-IDENTICAL (other row): the SAME input node');
  await p.open('dimsum_02');
  cardBtn(p, 'Descartar').click(); await settle(10);
  assert.notEqual(p.drawer().querySelector('.dwt').textContent, 'Sichuan Spicy Wonton', 'U-OTHER-ROW-DIRTY: «Descartar» opens the other product');
  assert.equal(p.btn('Guardar').disabled, true, 'U-OTHER-ROW-DIRTY: the other product opens clean («Guardar» off)');
  assert.equal(JSON.stringify(p.src()), draft0, 'U-OTHER-ROW-DIRTY: the list is never updated from an unsaved copy');
});

test('U-RELOAD-DIRTY-COPY — the self-update / branch-switch guard counts a dirty copy as pending (canLeave false), focus elsewhere', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  p.d.body.focus(); if (p.d.activeElement && p.d.activeElement.blur) p.d.activeElement.blur();
  assert.equal(p.mods.app.editorCanLeave(), true, 'U-RELOAD-DIRTY-COPY: premise — a clean open drawer, nothing focused, may reload');
  p.type(priceIn(p), '285');
  priceIn(p).blur();
  assert.equal(p.mods.app.editorCanLeave(), false, 'U-RELOAD-DIRTY-COPY: an unsaved copy blocks the reload');
  p.btn('Cancelar').click(); await settle(10);
  assert.equal(p.mods.app.editorCanLeave(), true, 'U-RELOAD-DIRTY-COPY: «Cancelar» releases it');
});


test('U-CANCEL-REPAINT — footer «Cancelar» on a dirty copy: both bar buttons live again and the hint gone (also with a saved draft change)', async () => {
  const p = await page();
  await p.signIn();
  const rev = p.d.getElementById('review'), dis = p.d.getElementById('discard');
  const hint = () => p.d.querySelector('#rbar .mk-rbhint');
  await p.open('dimsum_01');
  p.type(priceIn(p), '285');
  assert.equal(rev.disabled, true, 'premise: the bar waits');
  p.btn('Cancelar').click(); await settle(10);
  assert.deepStrictEqual([rev.disabled, dis.disabled, !hint() || hint().hidden], [false, false, true], 'U-CANCEL-REPAINT: live again after «Cancelar»');
  await p.open('dimsum_01'); p.type(priceIn(p), '260'); p.btn('Guardar').click(); await settle(30);
  await p.open('dimsum_02'); p.type(priceIn(p), '199');
  assert.deepStrictEqual([rev.disabled, dis.disabled], [true, true], 'premise: with a saved change, the bar still waits for the open copy');
  p.btn('Cancelar').click(); await settle(10);
  assert.deepStrictEqual([rev.disabled, dis.disabled, dis.classList.contains('hidden'), !hint() || hint().hidden], [false, false, false, true], 'U-CANCEL-REPAINT (saved change): Revisar and Descartar live, the hint gone');
});

test('U-FOCUS — the confirm holds focus: Tab / Shift+Tab stay inside, the background is inert, Esc anywhere returns the caret and selection to the last edited field', async () => {
  const p = await page();
  await p.signIn();
  await p.open('dimsum_01');
  const pr = priceIn(p);
  pr.focus(); p.type(pr, '2850'); pr.setSelectionRange(1, 3);
  headClose(p).focus(); headClose(p).click(); await settle(10);
  const keep = cardBtn(p, 'Seguir editando'), drop = cardBtn(p, 'Descartar');
  assert.equal(p.d.activeElement, keep, 'U-FOCUS: «Seguir editando» holds focus');
  const tab = (shift) => p.d.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
  tab(false); assert.equal(p.d.activeElement, drop, 'U-FOCUS: Tab moves inside the card');
  tab(false); assert.equal(p.d.activeElement, keep, 'U-FOCUS: Tab wraps inside the card');
  tab(true); assert.equal(p.d.activeElement, drop, 'U-FOCUS: Shift+Tab stays inside the card');
  assert.ok(p.drawer().querySelector('.dwb').hasAttribute('inert') && p.drawer().querySelector('.dwf').hasAttribute('inert'), 'U-FOCUS: the drawer behind the card is inert');
  assert.ok(p.d.getElementById('rbar').closest('[inert]'), 'U-FOCUS: the page behind is inert');
  p.d.body.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle(10);
  assert.equal(card(p), null, 'U-FOCUS: Esc anywhere = «Seguir editando»');
  assert.equal(p.d.activeElement, pr, 'U-FOCUS: the caret returns to the last edited field, not the close button');
  assert.deepStrictEqual([pr.selectionStart, pr.selectionEnd, pr.value], [1, 3, '2850'], 'U-FOCUS: with its selection');
  assert.ok(!p.drawer().querySelector('.dwb').hasAttribute('inert') && !p.d.getElementById('rbar').closest('[inert]'), 'U-FOCUS: the background is live again');
});

test('U-RECOVERY-RELOAD — «Recargar y reaplicar» with an open dirty copy asks; «Seguir editando» keeps the copy and the recovery panel; «Descartar» reloads', async () => {
  const p = await page({ on: { editCatalog: () => errJson(409, { error: 'stale_edit', detail: 'base moved' }) } });
  await p.signIn();
  await p.open('dimsum_01'); p.type(priceIn(p), '260'); p.btn('Guardar').click(); await settle(30);
  p.d.getElementById('review').click(); await settle(60);
  const reload = () => [...p.d.querySelectorAll('#mbody button')].find((b) => b.textContent.trim() === 'Recargar y reaplicar');
  assert.ok(reload(), 'premise: the stale_edit recovery panel offers «Recargar y reaplicar»');
  await p.open('dimsum_02'); p.type(priceIn(p), '285');
  const f0 = fieldsNow(p), nodes0 = ctrls(p), draft0 = JSON.stringify(p.src()), loads = p.n('getEditableCatalog').length;
  reload().click(); await settle(30);
  assertCard(p, 'U-RECOVERY-RELOAD', { pageScrim: true });
  cardBtn(p, 'Seguir editando').click(); await settle(30);
  keepAssert(p, f0, nodes0, draft0, 'U-RECOVERY-RELOAD');
  assert.ok(p.d.getElementById('scrim').classList.contains('show') && reload(), 'U-RECOVERY-RELOAD: the recovery panel stays');
  assert.equal(p.n('getEditableCatalog').length, loads, 'U-RECOVERY-RELOAD: nothing reloaded');
  reload().click(); await settle(30);
  cardBtn(p, 'Descartar').click(); await settle(80);
  assert.equal(p.n('getEditableCatalog').length, loads + 1, 'U-RECOVERY-RELOAD: «Descartar» proceeds with the reload');
});

test('U-RESET-TO-LIVE — «Volver al menú publicado» (the callout and the recovery action) with an open dirty copy asks first', async () => {
  const p = await page({ read: () => editable({ draft_unpublishable: { code: 'existing_item_changed', detail: 'x' } }) });
  await p.signIn();
  const calloutBtn = () => [...p.d.querySelectorAll('#detail button')].find((b) => b.textContent.trim() === 'Volver al menú publicado');
  assert.ok(calloutBtn(), 'premise: the unpublishable-draft callout offers the reset');
  await p.open('dimsum_01'); p.type(priceIn(p), '285');
  calloutBtn().click(); await settle(20);
  assertCard(p, 'U-RESET-TO-LIVE');
  cardBtn(p, 'Seguir editando').click(); await settle(10);
  assert.equal(p.n('resetDraftToLive').length, 0, 'U-RESET-TO-LIVE: «Seguir editando» resets nothing');
  calloutBtn().click(); await settle(20);
  cardBtn(p, 'Descartar').click(); await settle(60);
  assert.equal(p.n('resetDraftToLive').length, 1, 'U-RESET-TO-LIVE: «Descartar» proceeds with the reset');
});

test('U-RESET-RECOVERY — the recovery panel\'s «Volver al menú publicado» with an open dirty copy asks first', async () => {
  const p = await page({ on: { editCatalog: () => errJson(409, { error: 'existing_item_changed', detail: 'x' }) } });
  await p.signIn();
  await p.open('dimsum_01'); p.type(priceIn(p), '260'); p.btn('Guardar').click(); await settle(30);
  p.d.getElementById('review').click(); await settle(60);
  const reset = () => [...p.d.querySelectorAll('#mbody button')].find((b) => b.textContent.trim() === 'Volver al menú publicado');
  assert.ok(reset(), 'premise: the recovery panel offers the reset');
  await p.open('dimsum_02'); p.type(priceIn(p), '285');
  reset().click(); await settle(20);
  assertCard(p, 'U-RESET-RECOVERY', { pageScrim: true });
  cardBtn(p, 'Seguir editando').click(); await settle(10);
  assert.equal(p.n('resetDraftToLive').length, 0, 'U-RESET-RECOVERY: «Seguir editando» resets nothing');
});

test('U-CONFIRM-AUTH-CLEANUP — an auth event while the confirm is open tears it down: nothing left inert, no key trap (same person and another person)', async () => {
  for (const uid of ['uOwnerIED', 'uSomeoneElse']) {
    const p = await page();
    await p.signIn();
    const inert0 = inertNow(p);
    await p.open('dimsum_01'); p.type(priceIn(p), '285');
    headClose(p).click(); await settle(10);
    assert.ok(card(p) && tabTrapped(p), `premise (${uid}): the confirm is open and holds Tab`);
    p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid } }));
    await settle(30);
    assert.equal(p.d.querySelector('.mk-cf'), null, `U-CONFIRM-AUTH-CLEANUP (${uid}): the confirm is gone`);
    assert.deepStrictEqual(inertNow(p), inert0, `U-CONFIRM-AUTH-CLEANUP (${uid}): nothing the confirm made inert stays inert`);
    assert.equal(tabTrapped(p), false, `U-CONFIRM-AUTH-CLEANUP (${uid}): Tab is no longer trapped`);
  }
});

// ── STRUCTURE S1 — the drawer's «Opciones» cards (MOCKUP-portal-structure-edit v2 frame A / A2 / A3; PLAN-portal-structure-S1-ui r3) ──
const ON = () => editable({ extrasAuthoring: true });
const cardOf = (p, cat) => [...p.drawer().querySelectorAll('.mk-grp.mk-ext')].find((c) => c.querySelector('.mk-gtn').textContent === cat);
const rowsOfCard = (c) => [...c.querySelectorAll('.mk-xopt')];

test('S1 A — «Opciones»: «Sin extras», one open card per extras group the dish offers (checklist + today\'s editable prices); no dead control', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('dimsum_01');   // Dim Sum offers Acompañamientos + Salsas
  const f = p.fld('Opciones');
  assert.equal(f.querySelector('.mk-lrow .mk-cnt').textContent, 'El orden de los grupos se define en Extras');   // mockup v3 (owner 11-11)
  const sw = f.querySelector('.mk-opcsw');
  assert.equal(sw.querySelector('.mk-opcb').textContent, 'Sin extras');
  assert.equal(sw.querySelector('.mk-opcs').textContent, 'Apagalo si este producto no lleva extras');
  const tog = sw.querySelector('button.tog');
  assert.equal(tog.getAttribute('role'), 'switch'); assert.equal(tog.getAttribute('aria-checked'), 'false'); assert.equal(tog.disabled, false);
  assert.deepEqual([...f.querySelectorAll('.mk-grp.mk-ext .mk-gtn')].map((b) => b.textContent), ['Acompañamientos', 'Salsas']);
  const salsas = cardOf(p, 'Salsas');
  assert.match(salsas.querySelector('.mk-gts').textContent, /^Extras · opcionales · en \d+ productos$/);
  assert.equal(salsas.querySelector('.mk-gsumt').firstChild.textContent, 'Todos activos en este producto');
  assert.equal(salsas.querySelector('.mk-apponly').hidden, true);
  assert.equal(salsas.querySelector('.mk-lnk').textContent, 'Ninguno');
  const rows = rowsOfCard(salsas);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.querySelector('input[type=checkbox]').checked));
  assert.ok(rows.every((r) => r.querySelector('.mopr input').disabled === false), 'R4: the prices stay editable');
  const txt = p.drawer().textContent;
  for (const absent of ['Editar en Extras', 'Quitar de este producto', 'Agregar grupo de extras', 'Agregar elección requerida']) assert.ok(!txt.includes(absent), `no ${absent} before S2 / S3`);
  assert.equal(p.drawer().querySelector('.mk-grip'), null, 'R2: no grip, ever');
});

test('S1 — uncheck → «N de M activos» + «Solo en la app Sherpa»; Guardar writes the exclusion; with the drawer CLOSED a reload / branch switch is still held; revert → clean', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('dimsum_01');
  const salsas = cardOf(p, 'Salsas');
  const cb = rowsOfCard(salsas)[1].querySelector('input[type=checkbox]');
  cb.checked = false; cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  assert.equal(salsas.querySelector('.mk-gsumt').firstChild.textContent, '7 de 8 activos en este producto');
  assert.equal(salsas.querySelector('.mk-apponly').hidden, false);
  assert.equal(salsas.querySelector('.mk-apponly').textContent, 'Solo en la app Sherpa');
  assert.equal(salsas.querySelector('.mk-lnk').textContent, 'Marcar todos');
  assert.ok(rowsOfCard(salsas)[1].classList.contains('mk-xoff'));
  assert.equal(p.drawer().querySelector('.mk-dirty').hidden, false, '«Cambios sin guardar»');
  p.btn('Guardar').click(); await settle(10);
  assert.ok(!p.drawer().classList.contains('show'), 'the drawer closed');
  const key = SRC.extras.filter((x) => x.display.cat === 'Salsas')[1].key;
  assert.deepEqual(p.src().structure.exposure.item_overrides.dimsum_01.deny_extras, [key]);
  p.d.body.focus();
  assert.equal(p.mods.shell.canLeave(), false, 'Codex plan r1 #1: a saved checklist edit still holds the reload / branch-switch guard');
  await p.open('dimsum_01');
  const back = rowsOfCard(cardOf(p, 'Salsas'))[1].querySelector('input[type=checkbox]');
  assert.equal(back.checked, false, 'reopened: the same');
  back.checked = true; back.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  p.btn('Guardar').click(); await settle(10);
  assert.equal(p.src().structure.exposure.item_overrides.dimsum_01, undefined, '[] deletes the field and the emptied override');
  assert.equal(p.mods.shell.canLeave(), true, 'reverted → clean');
});

test('S1 A2 — «Sin extras» on: the extras cards grey out and their checks lock; the required choice stays; Guardar stamps the whole group', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('noodle_01');
  p.drawer().querySelector('.mk-opcsw button.tog').click(); await settle(5);
  const f = p.fld('Opciones');
  assert.ok(f.querySelector('.mk-opc').classList.contains('mk-off'));
  assert.equal(f.querySelector('.mk-opcs').textContent, 'Este producto no ofrece ningún extra');
  assert.equal(f.querySelector('.mk-opcsw button.tog').getAttribute('aria-checked'), 'true');
  assert.ok([...f.querySelectorAll('.mk-ext input[type=checkbox]')].every((c) => c.disabled));
  assert.ok(f.querySelector('.mk-grp.mk-req'), 'the required choice stays');
  p.btn('Guardar').click(); await settle(10);
  for (const k of ['noodle_01', 'noodle_01_sin', 'noodle_01_pollo', 'noodle_01_camaron']) assert.equal(p.src().items.find((i) => i.key === k).display.extras_policy, 'none', k);
});

test('S1 A3 — a card folds on its own (one line: what it is and how many); folding is never a change', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('dimsum_01');
  cardOf(p, 'Salsas').querySelector('.mk-gt').click(); await settle(5);
  const c = cardOf(p, 'Salsas');
  assert.ok(!c.classList.contains('mk-open'));
  assert.equal(c.querySelector('.mk-gb'), null);
  assert.match(c.querySelector('.mk-gts').textContent, /^Extras · opcionales · 8 opciones · en \d+ productos$/);
  assert.equal(c.querySelector('.mk-gt').getAttribute('aria-expanded'), 'false');
  assert.ok(cardOf(p, 'Acompañamientos').classList.contains('mk-open'), 'the other card keeps its own state');
  assert.equal(p.btn('Guardar').disabled, true); assert.equal(p.drawer().querySelector('.mk-dirty').hidden, true);
});

test('S1 R5 — the server switch OFF (absent): the checklist and «Sin extras» are dark, the prices still save (no regression)', async () => {
  const p = await page();   // editable() carries no extrasAuthoring
  await p.signIn();
  await p.open('dimsum_01');
  const f = p.fld('Opciones');
  assert.equal(f.querySelector('.mk-opcsw button.tog').disabled, true);
  assert.ok([...f.querySelectorAll('.mk-ext input[type=checkbox]')].every((c) => c.disabled));
  assert.ok([...f.querySelectorAll('.mk-ext .mk-lnk')].every((b) => b.disabled));
  const pi = rowsOfCard(cardOf(p, 'Salsas'))[0].querySelector('.mopr input');
  p.type(pi, '41');
  p.btn('Guardar').click(); await settle(10);
  assert.equal(p.src().extras.find((x) => x.key === SRC.extras.filter((y) => y.display.cat === 'Salsas')[0].key).price, 41);
});

test('S1 — a checklist edit counts as unsaved: closing asks first, «Cancelar» drops it', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('dimsum_01');
  const before = JSON.stringify(p.src());
  cardOf(p, 'Salsas').querySelector('.mk-lnk').click(); await settle(5);   // «Ninguno»
  assert.ok(rowsOfCard(cardOf(p, 'Salsas')).every((r) => r.classList.contains('mk-xoff')));
  p.drawer().querySelector('.dwh button').click(); await settle(5);
  assert.ok(p.drawer().querySelector('.mk-cfscrim'), 'the unsaved-edits confirm');
  [...p.drawer().querySelectorAll('.mk-cf button')].find((b) => b.textContent.trim() === 'Seguir editando').click(); await settle(5);
  p.btn('Cancelar').click(); await settle(5);
  assert.equal(JSON.stringify(p.src()), before, '«Cancelar»: nothing written');
});

// ── STRUCTURE S1 — Codex build r1 (advisor: fix all 9, RED-first) ───────────────────────────────────────────────────────
const EMPTY_DIFF = { added: [], removed: [], renamed: [], largeChangeSet: [], changed: [] };
const salsaName = (i) => SRC.extras.filter((x) => x.display.cat === 'Salsas')[i].display.name;
test('S1 r1 #1 — a checklist-only change reaches the REVIEW: its line is shown, it counts, «Publicar» is enabled', async () => {
  const p = await page({ read: ON, on: { editCatalog: () => okJson({ token: 'ET', updateTime: 'T2', baseActiveVersionId: 'v-live', sourceHash: 'h', diff: EMPTY_DIFF }) } });
  await p.signIn();
  await p.open('dimsum_01');
  const cb = rowsOfCard(cardOf(p, 'Salsas'))[1].querySelector('input[type=checkbox]');
  cb.checked = false; cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  p.btn('Guardar').click(); await settle(10);
  p.d.getElementById('review').click(); await settle(80);
  const body = p.d.getElementById('mbody').textContent;
  assert.ok(body.includes(`Sin ${salsaName(1)} (solo en la app Sherpa)`), `the review says what changes (${body.slice(0, 160)})`);
  assert.ok(!body.includes('No hay cambios sin publicar'));
  assert.equal(p.d.getElementById('pubbtn').disabled, false, 'it counts: «Publicar» is enabled');
});

test('S1 r1 #2 — a FOLDED required-choice card: no error, Guardar off while clean, the name rule still holds, save and reopen work', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('noodle_01');
  p.drawer().querySelector('.mk-grp.mk-req .mk-gt').click(); await settle(5);
  assert.ok(!p.drawer().querySelector('.mk-grp.mk-req').classList.contains('mk-open'), 'premise: folded');
  assert.equal(p.btn('Guardar').disabled, true, 'a clean copy: Guardar off');
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Pad Thai de la casa con salsa de tamarindo y maní tostado');
  assert.equal(p.btn('Guardar').title, 'Acortá el nombre para guardar', 'the derived-name rule still judges the folded options');
  p.type(nm, 'Pad Thai Especial');
  assert.equal(p.drawer().querySelector('.mk-dirty').hidden, false, 'the dirty mark follows');
  assert.equal(p.btn('Guardar').disabled, false);
  p.btn('Guardar').click(); await settle(10);
  assert.equal(p.src().items.find((i) => i.key === 'noodle_01_pollo').display.name, 'Pad Thai Especial - Pollo');
  await p.open('noodle_01');
  assert.ok(p.drawer().querySelector('.mk-grp.mk-req'), 'reopened');
});

test('S1 r1 #3 — under «Sin extras» the prices and the fold stay usable (only the checklist is locked)', async () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  assert.ok(!/\.mk-[^{]*\{[^}]*pointer-events\s*:\s*none/.test(css), 'no S1 rule blocks the pointer');
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('dimsum_01');
  p.drawer().querySelector('.mk-opcsw button.tog').click(); await settle(5);
  const pi = rowsOfCard(cardOf(p, 'Salsas'))[0].querySelector('.mopr input');
  assert.equal(pi.disabled, false, 'the price stays editable (R4)');
  p.type(pi, '43');
  cardOf(p, 'Acompañamientos').querySelector('.mk-gt').click(); await settle(5);
  assert.ok(!cardOf(p, 'Acompañamientos').classList.contains('mk-open'), 'the fold still works');
  p.btn('Guardar').click(); await settle(10);
  assert.equal(p.src().extras.find((x) => x.display.name === salsaName(0)).price, 43);
});

test('S1 r1 #8 — without the shared evaluator «Opciones» says «No pudimos cargar los extras.»; other fields still save', async () => {
  const p = await page({ read: ON, evaluator: false });
  await p.signIn();
  await p.open('dimsum_01');
  const f = p.fld('Opciones');
  assert.ok(f, 'the block stays');
  assert.equal(f.querySelector('.mk-opcgap').textContent, 'No pudimos cargar los extras.');
  p.type(p.fld('Nombre').querySelector('input'), 'Wonton picante');
  assert.equal(p.btn('Guardar').disabled, false, 'the hold is scoped to the extras fields');
});

test('S1 r1 #9 — the required choice\'s helper line is table H\'s, with the dish\'s real names, following the name as it is typed', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  await p.open('noodle_01');
  const line = () => p.drawer().querySelector('.mk-grp.mk-req .mk-gsub').textContent;
  assert.equal(line(), 'En el menú cada opción se llama «Pad Thai - Sin Proteína», «… - Pollo»: el nombre se arma solo.');
  p.type(p.fld('Nombre').querySelector('input'), 'Pad Thai Especial');
  assert.equal(line(), 'En el menú cada opción se llama «Pad Thai Especial - Sin Proteína», «… - Pollo»: el nombre se arma solo.');
});
