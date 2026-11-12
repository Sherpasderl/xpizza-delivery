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
runInThisContext(readFileSync(join(DIR, 'exposure-transitions.js'), 'utf8'));   // STRUCTURE S2: the writer, the page's next classic script (index.html order)
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
  // advisor Q8 correction (11-11): v3's line only when the server serves the Extras page (extrasCatalog); absent ⇒ S1's line
  assert.equal(f.querySelector('.mk-lrow .mk-cnt').textContent, 'en el orden que las ve el cliente', 'extrasCatalog absent: the S1 line');
  const card = f.querySelector('.mk-grp.mk-req');
  assert.equal(card.querySelector('.mk-gtn').textContent, 'Proteína');
  assert.equal(card.querySelector('.mk-gts').textContent, 'Elección requerida · el cliente elige 1');
  const rows = () => [...f.querySelectorAll('.mk-dopt')];
  // advisor ruling 11-12 (S1 SBS): built EXACT to v3 — the row names the CHOICE; the full derived name's counter shows only when
  // that name nears (≥ ITEM_NAME_MAX − 10) or passes the limit, as an inline warning; the length rule itself is unchanged
  const shown = (r) => { const c = r.querySelector('.mk-cnt'); return c && !c.hidden ? c.textContent : null; };
  assert.deepEqual(rows().map((r) => r.querySelector('.mk-dn').textContent), ['Sin Proteína', 'Pollo', 'Camarones'], 'the row shows the choice');
  assert.deepEqual(rows().map(shown), [null, null, null], 'a short full name shows no counter');
  assert.ok(rows().every((r) => r.querySelector('.dp .mopr input')), 'advisor Q1: each option keeps its price box');
  assert.equal(p.fld('Precio'), undefined, 'a group\'s price lives on its options');
  const nm = p.fld('Nombre').querySelector('input');
  p.type(nm, 'Pad Thai de la casa con salsa tamarindo y');
  assert.deepEqual(rows().map(shown), ['56/60', null, '53/60'], 'a full name near the limit shows its counter (≥ 50 of 60)');
  assert.ok(rows().every((r) => !r.classList.contains('over')), 'near is a warning, not an error');
  p.type(nm, 'Pad Thai de la casa con salsa de tamarindo y maní tostado');
  assert.equal(lineOf(f), 'El nombre completo de la opción supera 60 letras', 'F2: the line under the Opciones block');
  assert.equal(lineOf(p.fld('Nombre')), null, 'F2: Nombre itself is not marked');
  assert.ok(card.classList.contains('mk-inv'), 'F2: the required-choice card is marked');
  assert.ok(rows().some((r) => r.classList.contains('over')));
  assert.ok(rows().every((r) => shown(r) !== null), 'past the limit every option shows its counter');
  assert.ok(rows().some((r) => r.querySelector('.mk-cnt').classList.contains('over')), 'past the limit the counter is red');
  assert.equal(p.btn('Guardar').title, 'Acortá el nombre para guardar');
  p.type(nm, 'Pad Thai Especial');
  assert.deepEqual(rows().map((r) => r.querySelector('.mk-dn').textContent), ['Sin Proteína', 'Pollo', 'Camarones'], 'the row still names the choice');
  assert.deepEqual(rows().map(shown), [null, null, null], 'back under the limit: no counter');
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
  // advisor Q8 correction (11-11): v3's line only when the server serves the Extras page (extrasCatalog); absent ⇒ S1's line
  assert.equal(f.querySelector('.mk-lrow .mk-cnt').textContent, 'en el orden que las ve el cliente', 'extrasCatalog absent: the S1 line');
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

test('S1 Q8 — «Opciones» says «El orden de los grupos se define en Extras» ONLY when the server serves the Extras page (extrasCatalog true)', async () => {
  for (const [over, line] of [
    [{ extrasAuthoring: true, extrasCatalog: true }, 'El orden de los grupos se define en Extras'],
    [{ extrasCatalog: true }, 'El orden de los grupos se define en Extras'],
    [{ extrasAuthoring: true, extrasCatalog: false }, 'en el orden que las ve el cliente'],
    [{ extrasAuthoring: true, extrasCatalog: 'true' }, 'en el orden que las ve el cliente'],
  ]) {
    const p = await page({ read: () => editable(over) });
    await p.signIn();
    await p.open('noodle_01');   // a required choice: the «Opciones» block shows with the switch on or off
    assert.equal(p.fld('Opciones').querySelector('.mk-lrow .mk-cnt').textContent, line, `Q8 line for ${JSON.stringify(over)}`);
  }
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
// S1 follow-up (advisor 11-12): the review's checklist line is the SERVER's — so this save is 5f's REAL editCatalogCore (extras
// authoring ON) on the posted source, against the seed the page loaded as the published menu (a canned diff would be laxer: it
// carried no checklist line, and the portal used to invent one)
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
{ const pe = req.resolve('./catalog/platform-extras'); if (!req.cache[pe]) req.cache[pe] = { id: pe, filename: pe, loaded: true, exports: { extrasCapabilities: () => ({ authoring: true }) } }; }
// the server's S2 switch (5f catalog/platform-structure), OFF unless a cell turns it on — the P-6 cells run 5f's REAL handler with it on
const S2_SERVER = { on: false };
{ const ps = req.resolve('./catalog/platform-structure'); const real = req('./catalog/platform-structure');
  req.cache[ps] = { id: ps, filename: ps, loaded: true, exports: { structureCapabilities: () => ({ ...real.structureCapabilities(), extrasCatalog: S2_SERVER.on }) } }; }
const realSave = (call) => (async () => {
  const { editCatalogCore } = req('./catalog/edit-catalog-handler');
  const { sourceToBuildInputs } = req('./catalog/source-store');
  const { buildCatalogV2 } = req('./catalog/form-menu-source');
  const live = JSON.parse(JSON.stringify(SRC)), T0 = '1700000000.000000001', T1 = '1700000001.000000001';
  const st = { data: JSON.parse(JSON.stringify(live)), updateTime: T0 };
  const doc = (path) => ({
    get: async () => (path.endsWith('/meta/source') ? { exists: true, data: () => JSON.parse(JSON.stringify(st.data)), updateTime: st.updateTime }
      : path.endsWith('/meta/active_version') ? { exists: true, data: () => ({ version: 'v-live' }) } : { exists: false, data: () => ({}) }),
    set: async (data) => { st.data = data; st.updateTime = T1; return { writeTime: T1 }; },
    update: async (data, pre) => { if (!pre || pre.lastUpdateTime !== st.updateTime) { const e = new Error('FAILED_PRECONDITION'); e.code = 9; throw e; } st.data = data; st.updateTime = T1; return { writeTime: T1 }; },
  });
  const db = { collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
  const i = sourceToBuildInputs(live);
  const b = buildCatalogV2(RID, { formData: i.formData, priceTable: i.priceTable, extrasTable: i.extras });
  const readActiveBuilt = async () => ({ built: { ...b, extras: i.extras }, versionId: 'v-live', extraRecords: b.extras });
  const owner = async () => ({ ok: true, uid: 'u_owner', role: 'owner', actor: 'o@x.hn' });
  // with the S2 switch on, the add-product I/O exactly as 5f's own S2-core flow suite wires it (catalog/s2core-flow.test.js addProductOf) —
  // new extras need it to be allocated; the S1 cells (switch off) keep today's call
  const addProduct = S2_SERVER.on ? { readKeyMode: async () => 'id', hwmRef: () => ({ path: null, get: async () => ({ exists: false, data: () => undefined }) }),
    registryKeysTaken: async () => new Set(), syncKds: async () => ({ pending: false, written: false, reason: 'superseded' }), readReservedKeys: async () => req('./catalog/reserved-keys').reservedKeySet(undefined) } : undefined;
  const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt, ...(addProduct ? { addProduct } : {}) }, { restaurantId: RID, source: call.body.source, baseSourceUpdateTime: T0, ...(call.body.deleted_ids_loaded_base ? { deleted_ids_loaded_base: call.body.deleted_ids_loaded_base } : {}) }, {});
  return r.status === 200 ? okJson(r.body) : errJson(r.status, r.body);
})();
const salsaName = (i) => SRC.extras.filter((x) => x.display.cat === 'Salsas')[i].display.name;
test('S1 r1 #1 — a checklist-only change reaches the REVIEW: its line is shown, it counts, «Publicar» is enabled', async () => {
  const p = await page({ read: ON, on: { editCatalog: realSave } });
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
  // Codex S1 follow-up r1 P2: the «Productos» badge counts the rendered sentences — an extras-only change is «1», never «0»
  const prodGroup = [...p.d.querySelectorAll('#mbody .mgroup')].find((g) => g.querySelector('.mglabel span').textContent === 'Productos');
  assert.equal(prodGroup.querySelector('.mgn').textContent, '1', 'the Productos badge counts the checklist sentence');
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

// ── STRUCTURE S2 — the «Extras» page (PLAN-portal-structure-S2-ui r3 §2 items 1–3; MOCKUP frame X; names TEXT in S2-core) ─────
const XON = () => editable({ extrasAuthoring: true, extrasCatalog: true });
const tabs = (p) => p.d.getElementById('prodtabs');
const tabBtn = (p, label) => [...tabs(p).querySelectorAll('[role=tab]')].find((t) => t.textContent === label);
const xpage = (p) => p.d.getElementById('xsplit');
const railRows = (p) => [...xpage(p).querySelectorAll('.rail .railitem')];
const xrows = (p) => [...xpage(p).querySelectorAll('.detail .irow.mk-xrow')];
const extrasIn = (src, g) => src.extras.filter((e) => e.display.cat === g);
// a row's name: a «Nuevo» row carries it in its field (advisor 11-12), a published row as text
const rowName = (r) => { const i = r.querySelector('.nm input[aria-label="Nombre del extra"]'); return i ? i.value : r.querySelector('.nm').textContent; };

test('S2 X — switch OFF (extrasCatalog absent): no «Menú / Extras» tabs, no Extras page; today\'s Productos', async () => {
  const p = await page({ read: ON });
  await p.signIn();
  assert.ok(tabs(p).classList.contains('hidden'), 'no tab bar without the server’s extrasCatalog');
  assert.ok(xpage(p).classList.contains('hidden'), 'no Extras page');
});

test('S2 X — switch ON: «Menú» selected; «Extras» shows the rail (the ONE order, «en N productos», the count) and the first group\'s detail', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  assert.ok(!tabs(p).classList.contains('hidden'), 'the tab bar shows');
  assert.equal(tabs(p).querySelector('[role=tablist]').getAttribute('role'), 'tablist');
  assert.equal(tabBtn(p, 'Menú').getAttribute('aria-selected'), 'true', '«Menú» is the default tab');
  tabBtn(p, 'Extras').click(); await settle(10);
  assert.equal(tabBtn(p, 'Extras').getAttribute('aria-selected'), 'true');
  assert.ok(!xpage(p).classList.contains('hidden') && p.d.querySelector('#viewmenu > .split:not(#xsplit)').classList.contains('hidden'), 'the Extras page replaces the menu split');
  const src = p.src(); const groups = src.structure.extra_categories;
  assert.deepEqual(railRows(p).map((r) => r.querySelector('.rtext b').textContent), groups, 'the rail: every group in the ONE order');
  const r0 = railRows(p)[0];
  assert.match(r0.querySelector('.rtext span').textContent, /^en \d+ productos?$/, '«en N productos»');
  assert.equal(r0.querySelector('.rcount').textContent, String(extrasIn(src, groups[0]).length), 'its extras');
  assert.ok(r0.classList.contains('on'), 'the first group is selected');
  const head = xpage(p).querySelector('.dhead');
  assert.equal(head.querySelector('.dtitle').textContent, groups[0]);
  assert.equal(head.querySelector('.dtitle').getAttribute('contenteditable'), null, 'S2-core: the group name is TEXT (no rename)');
  assert.match(head.querySelector('.dcount').textContent, /^\d+ extras? · en \d+ productos?$/, '«{n} extras · en {N} productos»');
  const warn = xpage(p).querySelector('.mk-xwarn');
  assert.ok(warn && /^Este grupo se usa en \d+ productos — los cambios aplican a todos\.$/.test(warn.textContent.trim()), 'the shared warning (frame X)');
  assert.equal(xrows(p).length, extrasIn(src, groups[0]).length, 'one row per extra');
  const x0 = extrasIn(src, groups[0])[0];
  const row = xrows(p)[0];
  assert.equal(row.querySelector('.nm').textContent.trim(), x0.display.name);
  assert.equal(row.querySelector('[contenteditable]'), null, 'S2-core: the extra’s name is TEXT');
  assert.equal(row.querySelector('.price input').getAttribute('aria-label'), `Precio de ${x0.display.name}`);
  assert.equal(row.querySelector('button.del').getAttribute('aria-label'), `Quitar ${x0.display.name}`);
});

test('S2 X — a price typed on the Extras page lands in the draft (the guarded setter); the row is marked «Cambios sin publicar»', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  const g = p.src().structure.extra_categories[0];
  const x0 = extrasIn(p.src(), g)[0];
  const inp = xrows(p)[0].querySelector('.price input');
  p.type(inp, String(x0.price + 7)); await settle(10);
  assert.equal(p.src().extras.find((e) => e.key === x0.key).price, x0.price + 7, 'the price is in the draft');
  const row = xrows(p)[0];
  assert.ok(row.querySelector('.price').classList.contains('chg'), 'the changed price is marked');
  assert.equal(row.querySelector('.tag.mk-ftag').textContent, 'Cambios sin publicar');
});

test('S2 X — another group in the rail: its detail; back to «Menú» shows the menu again', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  const groups = p.src().structure.extra_categories;
  railRows(p)[1].click(); await settle(10);
  assert.ok(railRows(p)[1].classList.contains('on'));
  assert.equal(xpage(p).querySelector('.dhead .dtitle').textContent, groups[1]);
  tabBtn(p, 'Menú').click(); await settle(10);
  assert.ok(xpage(p).classList.contains('hidden') && !p.d.querySelector('#viewmenu > .split:not(#xsplit)').classList.contains('hidden'), 'the menu is back');
});

// ── STRUCTURE S2 — X2 the remove confirm (MOCKUP frame X2; plan §2 item 4, §5.2) ──────────────────────────────────────────────
const x2 = (p) => p.d.querySelector('#xscrim.show .modal');
async function newExtraOnPage(p, name, price) {
  // the page's own write path: a keyless extra added through the ONE mutator (the inline «Agregar extra» row lands in its own step)
  const g = p.src().structure.extra_categories[0];
  const E = await import('./editor.js');
  assert.equal(E.applyExposureOps(p.mods.app.state.draft, [{ op: 'extra.add', group: g, ref: 'tmp:x2-new-0001', name, price }], { extrasCatalog: true }).ok, true);
  tabBtn(p, 'Extras').click(); await settle(10);   // re-selecting the tab repaints from the live draft, as a user's click does
  return g;
}
test('S2 X2 — the trash opens «¿Quitar {extra} de {grupo}?»: focus on «Cancelar», Tab stays inside, Escape cancels and focus returns to the trash', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  const g = p.src().structure.extra_categories[0];
  const x0 = extrasIn(p.src(), g)[0];
  const trash = xrows(p)[0].querySelector('button.del');
  trash.click(); await settle(5);
  const m = x2(p);
  assert.ok(m, 'the confirm is open');
  assert.equal(m.querySelector('.mt').textContent, `¿Quitar ${x0.display.name} de ${g}?`);
  assert.match(m.querySelector('.ms').textContent, /^Extras · en \d+ productos?$/);
  assert.match(m.querySelector('.eqbody').textContent, /^Desaparece del menú en (los \d+ productos que usan|el producto que usa) este grupo\. Tus pedidos pasados no cambian\.$/);
  const [cancel, quitar] = [...m.querySelectorAll('.mf button')];
  assert.deepEqual([cancel.textContent, quitar.textContent, quitar.className], ['Cancelar', 'Quitar', 'btn ghost mk-quiet-danger']);
  assert.equal(p.d.activeElement, cancel, 'focus on «Cancelar»');
  quitar.focus();
  quitar.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(p.d.activeElement, cancel, 'Tab from the last button wraps to the first (focus stays inside)');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(5);
  assert.equal(x2(p), null, 'Escape closes it');
  assert.equal(p.d.activeElement && p.d.activeElement.getAttribute('aria-label'), `Quitar ${x0.display.name}`, 'focus returns to the trash');
  assert.ok(p.src().extras.some((e) => e.key === x0.key), 'nothing written');
});
test('S2 X2 — «Quitar» on a NEW (unsaved) extra removes it through the one mutator; nothing is claimed; the row is gone', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  await newExtraOnPage(p, 'Arroz frito', 40);
  const row = xrows(p).find((r) => rowName(r).startsWith('Arroz frito'));
  assert.ok(row.querySelector('.tag.new'), 'premise: «Nuevo»');
  row.querySelector('button.del').click(); await settle(5);
  [...x2(p).querySelectorAll('.mf button')][1].click(); await settle(10);
  assert.equal(x2(p), null, 'the confirm closed');
  assert.ok(!p.src().extras.some((e) => e.ref === 'tmp:x2-new-0001'), 'the new extra is gone from the draft');
  assert.ok(!xrows(p).some((r) => rowName(r).startsWith('Arroz frito')), 'and from the page');
  assert.equal(p.src().deleted_ids, undefined, 'a never-published extra claims nothing');
});
test('S2 X2 — the LAST extra of a group cannot be removed: its trash is disabled with «Un grupo necesita al menos un extra»', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  // a group of one: created through the one mutator (the writer refuses removing a group's last extra: extras_group_empty)
  const E = await import('./editor.js');
  assert.equal(E.applyExposureOps(p.mods.app.state.draft, [{ op: 'group.create', group: 'Uno solo', extras: [{ ref: 'tmp:one-0001', name: 'Único', price: 10 }], attach: { mode: 'none' } }], { extrasCatalog: true }).ok, true);
  tabBtn(p, 'Extras').click(); await settle(10);   // re-selecting the tab repaints from the live draft, as a user's click does
  railRows(p).find((r) => r.querySelector('.rtext b').textContent === 'Uno solo').click(); await settle(10);
  const del = xrows(p)[0].querySelector('button.del');
  assert.equal(del.disabled, true, 'the last extra’s trash is disabled');
  assert.equal(del.title, 'Un grupo necesita al menos un extra');
});
test('S2 §3.4 — a draft carrying a removal claim (stored by 5f’s REAL persistDeletionClaim) saves WITH the served baseline; without a claim, none', async () => {
  const { persistDeletionClaim } = req('./catalog/identity-partition');
  const base = { version: 'v-live', generation: 3 };
  const { claim } = persistDeletionClaim({ ids: ['xid_rice_white'], live: base });
  const withClaim = () => { const b = editable({ extrasAuthoring: true, extrasCatalog: true, deletionBase: base }); b.source.deleted_ids = claim; return b; };
  for (const [read, want] of [[withClaim, base], [() => editable({ extrasAuthoring: true, extrasCatalog: true, deletionBase: base }), undefined]]) {
    const p = await page({ read, on: { editCatalog: () => okJson({ token: 'ET', updateTime: 'T2', baseActiveVersionId: 'v-live', sourceHash: 'h', diff: { added: [], removed: [], renamed: [], largeChangeSet: [], changed: [] } }) } });
    await p.signIn();
    const x = p.src().extras[0];
    p.mods.app.state.draft.state.extras.find((e) => e.key === x.key).price += 1;   // any edit, so there is something to save
    p.d.getElementById('review').click(); await settle(80);
    const save = p.calls.filter((c) => c.fn === 'editCatalog').pop();
    assert.ok(save, 'premise: the review saved');
    assert.deepEqual(save.body.deleted_ids_loaded_base, want, want ? 'a claim ⇒ the served baseline rides the save' : 'no claim ⇒ no baseline field');
  }
});

// ── STRUCTURE S2 — X3 «Crear grupo» on the page (MOCKUP x4b; plan §2 items 5 / 5b, §3.5) ──────────────────────────────────────
const x3 = (p) => p.d.querySelector('#xcreate.show .modal');
const openX3 = async (p) => { xpage(p).querySelector('.rail .railadd').click(); await settle(5); return x3(p); };
test('S2 X3 — «Crear grupo» at the rail’s foot opens the sheet: focus in «Nombre del grupo»; «Crear grupo» off until a name + one complete extra', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  const m = await openX3(p);
  assert.ok(m, 'the sheet is open');
  assert.equal(m.querySelector('.mt').textContent, 'Crear grupo');
  assert.equal(p.d.activeElement && p.d.activeElement.id, 'xcg-name', 'focus in the name');
  const go = () => [...x3(p).querySelectorAll('.mf button')].find((b) => b.textContent === 'Crear grupo');
  assert.equal(go().disabled, true);
  p.type(x3(p).querySelector('#xcg-name'), 'Toppings'); await settle(5);
  p.type(x3(p).querySelector('.mopt .moname'), 'Maní'); await settle(5);
  const priceIn = x3(p).querySelector('.mopt .mopr input'); priceIn.focus();   // a user types into a focused field
  p.type(priceIn, '15'); await settle(5);
  assert.equal(go().disabled, false, 'a name and one complete extra');
  assert.equal(p.d.activeElement && p.d.activeElement.getAttribute('aria-label'), 'Precio', 'focus stays in the field being typed (re-render keeps it)');
});
test('S2 X3 — «Crear grupo» creates the group through the ONE mutator: it is selected in the rail; its extra is «Nuevo»; the bar counts it', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  await openX3(p);
  p.type(x3(p).querySelector('#xcg-name'), 'Toppings'); await settle(5);
  p.type(x3(p).querySelector('.mopt .moname'), 'Maní'); await settle(5);
  p.type(x3(p).querySelector('.mopt .mopr input'), '15'); await settle(5);
  [...x3(p).querySelectorAll('.mf button')].find((b) => b.textContent === 'Crear grupo').click(); await settle(10);
  assert.equal(x3(p), null, 'the sheet closed');
  assert.ok(p.src().structure.extra_categories.includes('Toppings'), 'the group is in the draft');
  const on = railRows(p).find((r) => r.classList.contains('on'));
  assert.equal(on && on.querySelector('.rtext b').textContent, 'Toppings', 'the new group is selected');
  assert.ok(xrows(p)[0].querySelector('.tag.new'), 'its extra is «Nuevo»');
});
test('S2 X3 — dismissing a DIRTY sheet asks «¿Descartar los cambios?»: «Seguir editando» keeps every input; «Descartar» closes it; a clean sheet just closes', async () => {
  const p = await page({ read: XON });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  await openX3(p);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(5);
  assert.equal(x3(p), null, 'a clean sheet closes at once');
  assert.ok(p.d.activeElement && p.d.activeElement.classList.contains('railadd'), 'focus returns to «Crear grupo»');
  await openX3(p);
  p.type(x3(p).querySelector('#xcg-name'), 'Toppings'); await settle(5);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(5);
  const cf = p.d.querySelector('#xscrim.show .modal');
  assert.ok(cf && cf.querySelector('.mt').textContent === '¿Descartar los cambios?', 'the portal’s discard confirm');
  const [drop, keep] = [...cf.querySelectorAll('.mf button')];
  assert.deepEqual([drop.textContent, keep.textContent], ['Descartar', 'Seguir editando'], 'the drawer confirm\u2019s order');
  assert.equal(p.d.activeElement, keep, 'focus on «Seguir editando»');
  keep.click(); await settle(5);
  assert.equal(x3(p).querySelector('#xcg-name').value, 'Toppings', '«Seguir editando» keeps the input exactly');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(5);
  [...p.d.querySelector('#xscrim.show .modal').querySelectorAll('.mf button')][0].click(); await settle(5);
  assert.equal(x3(p), null, '«Descartar» closes the sheet');
  assert.ok(!p.src().structure.extra_categories.includes('Toppings'), 'nothing was written');
});

// ── STRUCTURE S2 — «Agregar extra», the detail's inline new row (plan r3 §2 item 3, §3.5 row 2; MOCKUP frame X: the button in
// .dhead .dright, the committed row .irow.mk-xrow.mk-added «Nuevo»; the input row reuses X3's row copy — no new strings) ─────────
const addBtn = (p) => xpage(p).querySelector('.detail .dhead .dright button.btn');
const newRow = (p) => xpage(p).querySelector('.detail .irow.mk-xnew');
const key = (p, target, k) => target.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
async function openAdd(p) {
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  assert.equal(addBtn(p).textContent, 'Agregar extra');
  addBtn(p).click(); await settle(5);
  return newRow(p);
}
test('S2 X+ — «Agregar extra» appends ONE inline row at the list’s foot: focus in «Nombre del extra»; the draft untouched; a second press adds no second row', async () => {
  const p = await page({ read: XON });
  const r = await openAdd(p);
  assert.ok(r, 'the inline row is drawn');
  const rows = [...xpage(p).querySelectorAll('.detail .irow')];
  assert.equal(rows[rows.length - 1], r, 'at the list’s foot');
  const nm = r.querySelector('input[aria-label="Nombre del extra"]');
  assert.equal(p.d.activeElement, nm, 'focus in the name');
  assert.equal(nm.placeholder, 'Nombre del extra');
  const pr = r.querySelector('.price input');
  assert.deepEqual([pr.getAttribute('aria-label'), pr.placeholder], ['Precio', 'Sin precio']);
  assert.equal(r.querySelector('button.del').getAttribute('aria-label'), 'Quitar extra');
  assert.equal(p.d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar', 'nothing is pending yet: the draft is untouched');
  addBtn(p).click(); await settle(5);
  assert.equal(xpage(p).querySelectorAll('.detail .irow.mk-xnew').length, 1, 'still ONE inline row');
  assert.equal(p.d.activeElement, newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'focus back in its name');
});
test('S2 X+ — Enter in a COMPLETE row commits ONE extra.add: the extra is «Nuevo» in the list and the draft; the bar counts it; focus on «Agregar extra»', async () => {
  const p = await page({ read: XON });
  const r = await openAdd(p);
  const g = p.src().structure.extra_categories[0];
  const n0 = extrasIn(p.src(), g).length;
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Arroz frito'); await settle(5);
  const pr = newRow(p).querySelector('.price input'); pr.focus();
  p.type(pr, '40'); await settle(5);
  key(p, newRow(p).querySelector('.price input'), 'Enter'); await settle(10);
  assert.equal(newRow(p), null, 'the inline row is gone');
  const added = extrasIn(p.src(), g);
  assert.equal(added.length, n0 + 1, 'the extra is in the draft');
  assert.deepEqual([added[added.length - 1].display.name, added[added.length - 1].price, typeof added[added.length - 1].key], ['Arroz frito', 40, 'undefined'], 'a keyless new extra');
  const last = xrows(p)[xrows(p).length - 1];
  assert.ok(last.querySelector('.tag.new') && rowName(last) === 'Arroz frito', 'the row is «Nuevo»');
  assert.equal(p.d.getElementById('rbtxt').textContent, '1 cambio sin publicar', 'the bar counts it');
  assert.equal(p.d.activeElement, addBtn(p), 'focus on «Agregar extra», ready for the next one');
});
test('S2 X+ — a started row shows X3’s lines and Enter does not commit it; focus LEAVING a complete row commits it, an incomplete one stays', async () => {
  const p = await page({ read: XON });
  const r = await openAdd(p);
  const g = p.src().structure.extra_categories[0];
  const n0 = extrasIn(p.src(), g).length;
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Maní'); await settle(5);
  const pr = newRow(p).querySelector('.price input'); pr.focus();
  p.type(pr, '0'); await settle(5);
  assert.ok(xpage(p).textContent.includes('El precio debe ser al menos L 1.'), 'X3’s price line');
  key(p, newRow(p).querySelector('.price input'), 'Enter'); await settle(10);
  assert.equal(extrasIn(p.src(), g).length, n0, 'an incomplete row is never committed');
  railRows(p)[0].focus(); await settle(10);
  assert.ok(newRow(p), 'focus leaving an INCOMPLETE row keeps it');
  assert.equal(extrasIn(p.src(), g).length, n0);
  const pr2 = newRow(p).querySelector('.price input'); pr2.focus();
  p.type(pr2, '15'); await settle(5);
  railRows(p)[0].focus(); await settle(10);
  assert.equal(newRow(p), null, 'focus leaving a COMPLETE row commits it');
  assert.equal(extrasIn(p.src(), g).length, n0 + 1, 'committed through the ONE mutator');
});
test('S2 X+ — Escape in the row, or its trash, drops it: nothing written, focus back on «Agregar extra»', async () => {
  const p = await page({ read: XON });
  let r = await openAdd(p);
  const g = p.src().structure.extra_categories[0];
  const n0 = extrasIn(p.src(), g).length;
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Maní'); await settle(5);
  key(p, newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'Escape'); await settle(5);
  assert.equal(newRow(p), null, 'Escape drops it');
  assert.equal(p.d.activeElement, addBtn(p), 'focus back on «Agregar extra»');
  addBtn(p).click(); await settle(5);
  r = newRow(p);
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Maní'); await settle(5);
  newRow(p).querySelector('button.del').click(); await settle(5);
  assert.equal(newRow(p), null, 'the trash drops it');
  assert.equal(p.d.activeElement, addBtn(p));
  assert.equal(extrasIn(p.src(), g).length, n0, 'nothing written');
});
test('S2 X+ — leaving with a DIRTY row (another group, «Menú») asks «¿Descartar los cambios?»: «Seguir editando» keeps it; «Descartar» drops it and leaves; a clean row just goes', async () => {
  const p = await page({ read: XON });
  let r = await openAdd(p);
  const groups = p.src().structure.extra_categories;
  railRows(p)[1].click(); await settle(10);
  assert.equal(newRow(p), null, 'a clean row just goes');
  assert.equal(xpage(p).querySelector('.dhead .dtitle').textContent, groups[1]);
  addBtn(p).click(); await settle(5);
  r = newRow(p);
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Maní'); await settle(5);
  railRows(p)[0].click(); await settle(10);
  let cf = p.d.querySelector('#xscrim.show .modal');
  assert.ok(cf && cf.querySelector('.mt').textContent === '¿Descartar los cambios?', 'the portal’s discard confirm');
  const [, keep] = [...cf.querySelectorAll('.mf button')];
  keep.click(); await settle(5);
  assert.equal(newRow(p).querySelector('input[aria-label="Nombre del extra"]').value, 'Maní', '«Seguir editando» keeps the input');
  assert.equal(p.d.activeElement, newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'focus back on the last edited field');
  assert.equal(xpage(p).querySelector('.dhead .dtitle').textContent, groups[1], 'still on the same group');
  tabBtn(p, 'Menú').click(); await settle(10);
  cf = p.d.querySelector('#xscrim.show .modal');
  assert.ok(cf, 'the «Menú» tab asks too');
  cf.querySelectorAll('.mf button')[0].click(); await settle(10);
  assert.ok(xpage(p).classList.contains('hidden'), '«Descartar» leaves');
  tabBtn(p, 'Extras').click(); await settle(10);
  assert.equal(newRow(p), null, 'the row is gone');
  assert.ok(!extrasIn(p.src(), groups[1]).some((e) => e.display.name === 'Maní'), 'nothing written');
});

// ── STRUCTURE S2 — X4 / X4b, the ONE group order on the Extras rail (plan r3 §2 item 8; MOCKUP x4 / x4b) ─────────────────────
const rrows = (p) => [...xpage(p).querySelectorAll('.rail .rrow')];
const gripOf = (p, g) => rrows(p).find((r) => r.querySelector('.railitem').dataset.group === g).querySelector(':scope > button.rgrip');
const pairOf = (p, g) => rrows(p).find((r) => r.querySelector('.railitem').dataset.group === g).querySelector('.mk-updown');
const pairBtn = (p, g, label) => [...pairOf(p, g).querySelectorAll('button')].find((b) => b.textContent === label);
async function onExtras(p) { await p.signIn(); tabBtn(p, 'Extras').click(); await settle(10); return p.src().structure.extra_categories.slice(); }
test('S2 X4b — each rail row is a .rrow: the select button and the grip are SIBLINGS (no button inside a button); the grip «Mover {G}», collapsed, «Arrastrá para ordenar»', async () => {
  const p = await page({ read: XON });
  const groups = await onExtras(p);
  assert.equal(rrows(p).length, groups.length);
  assert.equal(xpage(p).querySelectorAll('.rail button button').length, 0, 'no button inside a button');
  for (const g of groups) {
    const grip = gripOf(p, g);
    assert.deepEqual([grip.getAttribute('aria-label'), grip.getAttribute('aria-expanded'), grip.title], [`Mover ${g}`, 'false', 'Arrastrá para ordenar']);
  }
  assert.equal(xpage(p).querySelector('.mk-updown'), null, 'the pair is hidden until a grip is activated');
});
test('S2 X4b — the grip reveals «Subir» / «Bajar» (aria-expanded): at the top «Subir» is disabled and a press there writes nothing; Escape or the grip again closes them, focus back on the grip', async () => {
  const p = await page({ read: XON });
  const groups = await onExtras(p);
  gripOf(p, groups[0]).click(); await settle(5);
  assert.equal(gripOf(p, groups[0]).getAttribute('aria-expanded'), 'true');
  assert.equal(pairOf(p, groups[0]).getAttribute('aria-label'), `Mover ${groups[0]}`);
  assert.deepEqual([...pairOf(p, groups[0]).querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-disabled'), b.disabled]), [['Subir', 'true', false], ['Bajar', null, false]], 'at the top «Subir» is disabled');
  pairBtn(p, groups[0], 'Subir').focus();
  pairBtn(p, groups[0], 'Subir').click(); await settle(5);
  assert.deepEqual(p.src().structure.extra_categories, groups, 'a boundary press writes nothing');
  assert.equal(p.d.activeElement, pairBtn(p, groups[0], 'Subir'), 'the end-state «Subir» keeps focus (aria-disabled, never a jump)');
  assert.equal(p.d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar', 'and dirties nothing');
  key(p, pairBtn(p, groups[0], 'Bajar'), 'Escape'); await settle(5);
  assert.equal(pairOf(p, groups[0]), null, 'Escape closes them');
  assert.equal(p.d.activeElement, gripOf(p, groups[0]), 'focus back on the grip');
  gripOf(p, groups[0]).click(); await settle(5);
  gripOf(p, groups[0]).click(); await settle(5);
  assert.equal(pairOf(p, groups[0]), null, 'the grip again closes them');
  assert.equal(p.d.activeElement, gripOf(p, groups[0]));
});
test('S2 X4b — «Bajar» moves the group one place through ONE group.order: the pair stays on the moved row, focus stays on the moved group’s «Bajar»; announced; the bar «1 cambio sin publicar · 1 grupo»', async () => {
  const p = await page({ read: XON });
  const groups = await onExtras(p);
  const g = groups[0];
  gripOf(p, g).click(); await settle(5);
  pairBtn(p, g, 'Bajar').click(); await settle(10);
  assert.deepEqual(p.src().structure.extra_categories, [groups[1], g, ...groups.slice(2)], 'one place down');
  assert.equal(rrows(p)[1].querySelector('.railitem').dataset.group, g, 'the rail follows');
  assert.ok(pairOf(p, g), 'the pair stays open on the moved row');
  assert.equal(p.d.activeElement, pairBtn(p, g, 'Bajar'), 'focus stays on the moved group');
  assert.equal(p.d.getElementById('xlive').textContent, `${g} · 2.º lugar`, 'announced politely');
  assert.equal(p.d.getElementById('rbtxt').textContent, '1 cambio sin publicar · 1 grupo', 'the bar counts the group');
  pairBtn(p, g, 'Subir').click(); await settle(10);
  assert.deepEqual(p.src().structure.extra_categories, groups, 'back up: the original order');
  assert.equal(p.d.activeElement, pairBtn(p, g, 'Subir'), 'at the top focus STAYS on the pressed «Subir» (now aria-disabled)');
  assert.equal(pairBtn(p, g, 'Subir').getAttribute('aria-disabled'), 'true');
  pairBtn(p, g, 'Subir').click(); await settle(10);
  assert.deepEqual(p.src().structure.extra_categories, groups, 'an aria-disabled press writes nothing');
  assert.equal(p.d.getElementById('rbtxt').textContent, 'Revisá si hay algo sin publicar', 'and dirties nothing');
  assert.equal(p.d.activeElement, pairBtn(p, g, 'Subir'), 'focus still on «Subir»');
});
test('S2 X4 — the keyboard on the grip: ArrowDown / ArrowUp move the group one place (the same op), focus stays on its grip', async () => {
  const p = await page({ read: XON });
  const groups = await onExtras(p);
  const g = groups[1];
  gripOf(p, g).focus();
  key(p, gripOf(p, g), 'ArrowDown'); await settle(10);
  assert.equal(p.src().structure.extra_categories.indexOf(g), 2, 'ArrowDown moves it one place');
  assert.equal(p.d.activeElement, gripOf(p, g), 'focus stays on its grip');
  key(p, gripOf(p, g), 'ArrowUp'); key(p, gripOf(p, g), 'ArrowUp'); await settle(10);
  assert.equal(p.src().structure.extra_categories[0], g);
  key(p, gripOf(p, g), 'ArrowUp'); await settle(10);
  assert.equal(p.src().structure.extra_categories[0], g, 'at the top: nothing');
});
test('S2 X4 — the drag (rows laid out by a stubbed box — jsdom has no layout; the real drag is the SBS): the lift, ONE drop line, the drop → ONE group.order', async () => {
  const p = await page({ read: XON });
  const groups = await onExtras(p);
  const lay = () => rrows(p).forEach((r, i) => { r.getBoundingClientRect = () => ({ top: i * 50, height: 50, bottom: i * 50 + 50, left: 0, right: 200, width: 200 }); });
  lay();
  const last = groups[groups.length - 1];
  const grip = gripOf(p, last);
  const ev = (type, y) => grip.dispatchEvent(new p.w.MouseEvent(type, { bubbles: true, clientY: y, clientX: 10, button: 0 }));
  ev('pointerdown', (groups.length - 1) * 50 + 25);
  ev('pointermove', 100); ev('pointermove', 130); await settle(2);   // two moves: the line MOVES, it is never a second one
  assert.ok(rrows(p).find((r) => r.querySelector('.railitem').dataset.group === last).querySelector('.railitem').classList.contains('mk-drag'), 'the dragged group lifts');
  assert.equal(xpage(p).querySelectorAll('.rail .mk-dropline').length, 1, 'ONE drop line');
  ev('pointermove', 5); await settle(2);
  ev('pointerup', 5); await settle(10);
  assert.deepEqual(p.src().structure.extra_categories, [last, ...groups.slice(0, -1)], 'dropped at the first place');
  assert.equal(xpage(p).querySelector('.mk-dropline'), null, 'the line goes with the drop');
  assert.equal(xpage(p).querySelector('.mk-updown'), null, 'a drag is not a click: the pair stays closed');
});

// ── STRUCTURE S2 — B «Agregar grupo de extras» (plan r3 §2 item 6, §3.5; MOCKUP frame B: .mk-adds > .railadd; the sheet on the review
// modal's .modal/.mh/.mb/.mf; rows .optrow; «Ya está en este producto»; «¿No está el grupo? Crealo en Extras») ─────────────────────
const bAction = (p) => p.drawer().querySelector('.mk-adds .railadd');
const bSheet = (p) => p.d.querySelector('#xattach.show .modal');
const bRows = (p) => [...bSheet(p).querySelectorAll('.optrow')];
const bRow = (p, g) => bRows(p).find((r) => r.querySelector('.ogname').firstChild.textContent === g);
const bGo = (p) => [...bSheet(p).querySelectorAll('.mf button')].pop();
async function openB(p, key = 'dimsum_01') {
  await p.signIn(); await p.open(key);
  bAction(p).click(); await settle(5);
  return bSheet(p);
}
test('S2 B — the dish action «Agregar grupo de extras» sits under the cards, ONLY with the server’s extrasCatalog (no «Agregar elección requerida»: S3)', async () => {
  const p = await page({ read: XON });
  await p.signIn(); await p.open('dimsum_01');
  assert.equal(bAction(p) && bAction(p).textContent, 'Agregar grupo de extras');
  assert.equal(p.drawer().querySelectorAll('.mk-adds .railadd').length, 1, 'no S3 action');
  const q = await page({ read: ON });
  await q.signIn(); await q.open('dimsum_01');
  assert.equal(q.drawer().querySelector('.mk-adds'), null, 'no dish action without extrasCatalog');
});
test('S2 B — the sheet: «Agregar grupo de extras» · «Para {plato} · elegí los grupos que ya tenés»; EXISTING groups in the ONE order, extras joined «·», «en N productos»; the dish’s own checked + inert «Ya está en este producto»; «Agregar grupos» off at 0; «Agregar 1 grupo» / «Agregar N grupos»; « · {sección}» only for ONE section', async () => {
  const p = await page({ read: XON });
  const m = await openB(p);
  assert.ok(m, 'the sheet is open');
  assert.equal(m.querySelector('.mt').textContent, 'Agregar grupo de extras');
  assert.equal(m.querySelector('.ms').textContent, `Para ${p.drawer().querySelector('.dwt').textContent} · elegí los grupos que ya tenés`);
  assert.equal(m.querySelector('.attach-note').textContent, 'Grupos de extras existentes');
  const src = p.src();
  const names = bRows(p).map((r) => r.querySelector('.ogname').firstChild.textContent);
  const haves = bRows(p).filter((r) => r.classList.contains('have')).map((r) => r.querySelector('.ogname').firstChild.textContent);
  const ec = src.structure.extra_categories;
  assert.deepEqual(names, [...ec.filter((g) => !haves.includes(g)), ...ec.filter((g) => haves.includes(g))], 'the groups to pick in the ONE order, the dish\u2019s own at the foot (frame B)');
  for (const r of bRows(p)) {
    const g = r.querySelector('.ogname').firstChild.textContent, cb = r.querySelector('input[type=checkbox]');
    const have = r.classList.contains('have');
    assert.deepEqual([cb.checked, cb.disabled], [have, have], `${g}: the dish’s own is checked and inert`);
    assert.equal(r.querySelector('.ogsub').textContent, have ? 'Ya está en este producto' : src.extras.filter((e) => e.display.cat === g).map((e) => e.display.name).join(' · '), `${g}: its line`);
    assert.match(r.querySelector('.mk-ogn').textContent, /^en \d+ productos?( \u00b7 .+)?$/, `${g}: «en N productos»`);
  }
  assert.ok(bRows(p).some((r) => r.classList.contains('have')) && bRows(p).some((r) => !r.classList.contains('have')), 'non-vacuity: both kinds');
  assert.deepEqual([bGo(p).textContent, bGo(p).disabled], ['Agregar grupos', true], 'off at 0, without a number');
  const free = bRows(p).filter((r) => !r.classList.contains('have'));
  for (const [i, want] of [[0, 'Agregar 1 grupo'], [1, 'Agregar 2 grupos']]) {
    if (!free[i]) break;
    const c = bRows(p).find((r) => r.querySelector('.ogname').firstChild.textContent === free[i].querySelector('.ogname').firstChild.textContent).querySelector('input');
    c.checked = true; c.dispatchEvent(new p.w.Event('change', { bubbles: true })); await settle(5);
    assert.deepEqual([bGo(p).textContent, bGo(p).disabled], [want, false], `${want}`);
  }
  // «· {sección}» (advisor 11-12): Proteínas is used by ONE section (rice) ⇒ its name; Salsas spans many ⇒ none (the logic cell pins
  // the rule against an independent oracle; this pins the DOM)
  const rice = src.structure.categories.find((c) => String(c.id) === 'rice').name;
  assert.equal(bRow(p, 'Proteínas').querySelector('.mk-ogn').textContent, `en 1 producto \u00b7 ${rice}`, 'one section ⇒ « · {sección}»');
  assert.match(bRow(p, 'Salsas').querySelector('.mk-ogn').textContent, /^en \d+ productos$/, 'mixed sections ⇒ none');
  assert.equal(p.d.activeElement, bRows(p).find((r) => !r.classList.contains('have')).querySelector('input'), 'focus on the first group to pick');
  assert.equal(m.querySelector('.mk-nogroup .mk-lnk').textContent, 'Crealo en Extras');
});
test('S2 B — «Agregar 1 grupo» records the attach in the COPY (never the draft): the card appears in the drawer, focus back on the action; «Guardar» commits it', async () => {
  const p = await page({ read: XON });
  await openB(p);
  const g = bRows(p).find((r) => !r.classList.contains('have')).querySelector('.ogname').firstChild.textContent;
  const before = JSON.stringify(p.src());
  const cb = bRow(p, g).querySelector('input'); cb.checked = true; cb.dispatchEvent(new p.w.Event('change', { bubbles: true })); await settle(5);
  assert.deepEqual([bGo(p).textContent, bGo(p).disabled], ['Agregar 1 grupo', false]);
  bGo(p).click(); await settle(10);
  assert.equal(bSheet(p), null, 'the sheet closed');
  assert.ok(cardOf(p, g), 'the group’s card is in the drawer');
  assert.equal(JSON.stringify(p.src()), before, 'the draft is untouched until «Guardar»');
  assert.equal(p.d.activeElement, bAction(p), 'focus back on «Agregar grupo de extras»');
  p.btn('Guardar').click(); await settle(10);
  const ov = p.src().structure.exposure.item_overrides.dimsum_01;
  assert.ok(ov && JSON.stringify(ov).includes(g), '«Guardar» commits the attach');
});
test('S2 B — «Cancelar», Escape and the backdrop close the sheet: nothing recorded; focus back on the action; Tab stays inside', async () => {
  const p = await page({ read: XON });
  for (const how of ['cancel', 'escape', 'scrim']) {
    if (!bSheet(p)) { if (!p.drawer().querySelector('.mk-adds')) { await p.signIn(); await p.open('dimsum_01'); } bAction(p).click(); await settle(5); }
    const g = bRows(p).find((r) => !r.classList.contains('have')).querySelector('.ogname').firstChild.textContent;
    const cb = bRow(p, g).querySelector('input'); cb.checked = true; cb.dispatchEvent(new p.w.Event('change', { bubbles: true })); await settle(5);
    const live = [...bSheet(p).querySelectorAll('button, input')].filter((x) => !x.disabled);
    const last = live[live.length - 1];
    last.focus(); key(p, last, 'Tab'); await settle(2);
    // a synthetic Tab never moves focus by itself: the TRAP must move it — from the last control it wraps to the first
    assert.equal(p.d.activeElement, live[0], `${how}: Tab stays inside (the last wraps to the first)`);
    if (how === 'cancel') [...bSheet(p).querySelectorAll('.mf button')][0].click();
    else if (how === 'escape') key(p, p.d.activeElement, 'Escape');
    else p.d.getElementById('xattach').dispatchEvent(new p.w.MouseEvent('click', { bubbles: true }));
    await settle(5);
    assert.equal(bSheet(p), null, `${how}: closed`);
    assert.equal(cardOf(p, g), undefined, `${how}: nothing recorded`);
    assert.equal(p.d.activeElement, bAction(p), `${how}: focus back on the action`);
  }
});
test('S2 B — the action is off with the writer’s line when the COPY refuses it: «Sin extras» on → «Tiene «Sin extras»»', async () => {
  const p = await page({ read: XON });
  await p.signIn(); await p.open('dimsum_01');
  p.drawer().querySelector('button[aria-label="Sin extras"]').click(); await settle(10);
  assert.equal(bAction(p).disabled, true, 'the refused action is off');
  assert.equal(p.drawer().querySelector('.mk-adds .ferr').textContent, 'Tiene «Sin extras»');
});
test('S2 B — «Crealo en Extras»: a clean drawer → the sheet and the drawer close, the Extras tab opens with «Crear grupo»; a dirty copy asks the drawer’s confirm first', async () => {
  const p = await page({ read: XON });
  await openB(p);
  bSheet(p).querySelector('.mk-nogroup .mk-lnk').click(); await settle(10);
  assert.equal(bSheet(p), null, 'the sheet closed');
  assert.ok(!p.drawer().classList.contains('show'), 'the drawer closed');
  assert.ok(!xpage(p).classList.contains('hidden'), 'the Extras tab');
  assert.ok(p.d.querySelector('#xcreate.show .modal'), '«Crear grupo» is open');
  assert.equal(p.d.activeElement && p.d.activeElement.id, 'xcg-name');
  const q = await page({ read: XON });
  await q.signIn(); await q.open('dimsum_01');
  q.drawer().querySelector('button[aria-label="Sin extras"]').click(); await settle(10);   // a dirty copy
  q.drawer().querySelector('button[aria-label="Sin extras"]').click(); await settle(10);
  const cb0 = q.drawer().querySelector('.mk-xopt input[type=checkbox]'); cb0.checked = !cb0.checked; cb0.dispatchEvent(new q.w.Event('change', { bubbles: true })); await settle(10);
  bAction(q).click(); await settle(5);
  bSheet(q).querySelector('.mk-nogroup .mk-lnk').click(); await settle(10);
  assert.equal(bSheet(q), null);
  const cf = q.drawer().querySelector('.mk-cf');
  assert.ok(cf && cf.querySelector('h3').textContent === '¿Descartar los cambios?', 'the drawer’s confirm first');
  assert.ok(xpage(q).classList.contains('hidden'), 'still on the menu');
});

// ── STRUCTURE S2 — the drawer's S2 parts (plan r3 §2 item 7; MOCKUP frame A): «Editar en Extras» in an extras card's header,
// «Quitar de este producto» at its foot (detach.item into the COPY), the card's prices read-only text (.mk-mp) — ONLY with the
// server's Extras page (without it the prices stay editable: no gap) ───────────────────────────────────────────────────────────
const gol = (c) => c.querySelector('.mk-gh .mk-gact .mk-lnk.mk-gol');
const quitar = (c) => c.querySelector('.mk-gfoot .mk-lnk.danger');
test('S2 A — with extrasCatalog: «Editar en Extras» before the chevron, «Quitar de este producto» at the foot, the prices read-only «L {n}»; without it: today’s editable prices, no S2 control', async () => {
  const p = await page({ read: XON });
  await p.signIn(); await p.open('dimsum_01');
  const c = cardOf(p, 'Salsas');
  assert.ok(gol(c), '«Editar en Extras»');
  assert.deepEqual([gol(c).textContent, gol(c).getAttribute('aria-label'), gol(c).nextElementSibling.classList.contains('mk-chev')], ['Editar en Extras', 'Editar Salsas en Extras', true]);
  assert.equal(quitar(c) && quitar(c).textContent, 'Quitar de este producto');
  assert.equal(c.querySelectorAll('.mk-xopt input[type=text]').length, 0, 'no price input on an extras card');
  const xs = extrasIn(p.src(), 'Salsas');
  assert.deepEqual(rowsOfCard(c).map((r) => r.querySelector('.mk-mp').textContent), xs.map((x) => `L ${x.price}`), 'the prices, read-only');
  const q = await page({ read: ON });
  await q.signIn(); await q.open('dimsum_01');
  const c2 = cardOf(q, 'Salsas');
  assert.equal(gol(c2) || quitar(c2) || c2.querySelector('.mk-mp'), null, 'no S2 control without extrasCatalog');
  assert.equal(c2.querySelectorAll('.mk-xopt input[type=text]').length, rowsOfCard(c2).length, 'today’s editable prices stay (no gap)');
});
test('S2 A — «Quitar de este producto» detaches the group in the COPY: the card goes, the draft is untouched, B lists it again; «Guardar» commits it', async () => {
  const p = await page({ read: XON });
  await p.signIn(); await p.open('dimsum_01');
  const before = JSON.stringify(p.src());
  quitar(cardOf(p, 'Salsas')).click(); await settle(10);
  assert.equal(cardOf(p, 'Salsas'), undefined, 'the card is gone');
  assert.equal(JSON.stringify(p.src()), before, 'the draft is untouched until «Guardar»');
  assert.equal(p.d.activeElement, bAction(p), 'focus on «Agregar grupo de extras»');
  bAction(p).click(); await settle(5);
  assert.ok(!bRow(p, 'Salsas').classList.contains('have'), 'B offers it again');
  [...bSheet(p).querySelectorAll('.mf button')][0].click(); await settle(5);
  p.btn('Guardar').click(); await settle(10);
  const ov = p.src().structure.exposure.item_overrides.dimsum_01;
  assert.ok(ov && JSON.stringify(ov).includes('Salsas'), '«Guardar» commits the detach');
});
test('S2 A — «Quitar de este producto» off with the writer’s line when an option has its own rule (5f XT-REFUSALS fixture)', async () => {
  const src = JSON.parse(JSON.stringify(SRC)); src.structure.exposure.item_overrides.noodle_01_pollo = { deny: ['Salsas'] };
  const p = await page({ read: () => editable({ extrasAuthoring: true, extrasCatalog: true, source: src }) });
  await p.signIn(); await p.open('noodle_01');
  const c = cardOf(p, 'Acompañamientos') || [...p.drawer().querySelectorAll('.mk-grp.mk-ext')][0];
  assert.ok(c, 'non-vacuity: a card');
  assert.equal(quitar(c).disabled, true, 'the refused «Quitar» is off');
  assert.equal(c.querySelector('.mk-gfoot .ferr').textContent, 'Sus opciones tienen reglas propias');
});
test('S2 A — «Editar en Extras»: a clean copy → the drawer closes, the Extras tab with THAT group selected and focused; a dirty copy asks the drawer’s confirm first', async () => {
  const p = await page({ read: XON });
  await p.signIn(); await p.open('dimsum_01');
  gol(cardOf(p, 'Salsas')).click(); await settle(10);
  assert.ok(!p.drawer().classList.contains('show'), 'the drawer closed');
  assert.ok(!xpage(p).classList.contains('hidden'), 'the Extras tab');
  const on = railRows(p).find((r) => r.classList.contains('on'));
  assert.equal(on && on.dataset.group, 'Salsas', 'that group selected');
  assert.equal(p.d.activeElement, on, 'and focused');
  const q = await page({ read: XON });
  await q.signIn(); await q.open('dimsum_01');
  const cb0 = q.drawer().querySelector('.mk-xopt input[type=checkbox]'); cb0.checked = !cb0.checked; cb0.dispatchEvent(new q.w.Event('change', { bubbles: true })); await settle(10);
  gol(cardOf(q, 'Salsas')).click(); await settle(10);
  const cf = q.drawer().querySelector('.mk-cf');
  assert.ok(cf && cf.querySelector('h3').textContent === '¿Descartar los cambios?', 'the drawer’s confirm first');
  assert.ok(xpage(q).classList.contains('hidden'), 'still on the menu');
});
test('S2 X — a «Nuevo» row’s name is the inline row’s field (typing renames it in the draft); a published row’s name stays text', async () => {
  const p = await page({ read: XON });
  const r = await openAdd(p);
  p.type(r.querySelector('input[aria-label="Nombre del extra"]'), 'Arroz frito'); await settle(5);
  const pr = newRow(p).querySelector('.price input'); pr.focus(); p.type(pr, '40'); await settle(5);
  key(p, newRow(p).querySelector('.price input'), 'Enter'); await settle(10);
  const added = xrows(p)[xrows(p).length - 1];
  const nm = added.querySelector('input[aria-label="Nombre del extra"]');
  assert.ok(nm && nm.value === 'Arroz frito', 'the «Nuevo» row carries the name field');
  nm.focus(); p.type(nm, 'Arroz con huevo'); await settle(10);
  const g = p.src().structure.extra_categories[0];
  assert.ok(extrasIn(p.src(), g).some((x) => typeof x.key !== 'string' && x.display.name === 'Arroz con huevo'), 'the rename is in the draft');
  assert.equal(p.d.activeElement && p.d.activeElement.getAttribute('aria-label'), 'Nombre del extra', 'focus stays in the field while typing');
  assert.equal(xrows(p)[0].querySelector('input[aria-label="Nombre del extra"]'), null, 'a published row’s name is text');
});

// ── STRUCTURE S2 §5.2 — FIX-EXTRA: an extra's refusal lands on the Extras tab, its group, its row, the server's line under it ─────
test('S2 §5.2 — FIX-EXTRA «Corregir el nombre»: the Extras tab, the new extra’s group selected, focus in its NAME, the server’s line under it; the draft byte-identical', async () => {
  let ref = null;
  const p = await page({ read: XON, on: { editCatalog: (call) => { ref = (call.body.source.extras.find((e) => typeof e.key !== 'string') || {}).ref; return errJson(409, { error: 'name_taken', ref, field: 'name' }); } } });
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  railRows(p)[1].click(); await settle(10);
  const g = p.src().structure.extra_categories[1];
  addBtn(p).click(); await settle(5);
  p.type(newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'Salsa nueva'); await settle(5);
  const pr = newRow(p).querySelector('.price input'); pr.focus(); p.type(pr, '20'); await settle(5);
  key(p, newRow(p).querySelector('.price input'), 'Enter'); await settle(10);
  railRows(p)[0].click(); await settle(10);   // another group selected: FIX-EXTRA must SWITCH to the extra's own group
  tabBtn(p, 'Menú').click(); await settle(10);   // the merchant left the page; FIX-EXTRA must bring them back
  const before = JSON.stringify(p.src());
  p.d.getElementById('review').click(); await settle(60);
  const pn = panel(p);
  assert.ok(pn && pn.title === 'Ese nombre ya está en tu menú', `the extra's panel (${pn && pn.title})`);
  assert.equal(pn.detail, 'Elegí otro nombre para el extra nuevo.');
  pn.action.click(); await settle(30);
  assert.ok(!xpage(p).classList.contains('hidden'), 'the Extras tab');
  assert.equal(railRows(p).find((r) => r.classList.contains('on')).dataset.group, g, 'the new extra’s group');
  const row = xrows(p).find((r) => rowName(r) === 'Salsa nueva');
  const nm = row.querySelector('input[aria-label="Nombre del extra"]');
  assert.equal(p.d.activeElement, nm, 'focus in its name');
  assert.equal(row.nextElementSibling && row.nextElementSibling.textContent, 'Elegí otro nombre para el extra nuevo.', 'the server’s line under the row');
  assert.equal(JSON.stringify(p.src()), before, 'the draft byte-identical');
  assert.ok(ref && ref.startsWith('tmp:'), 'premise: the refusal named the new extra by its ref');
});
test('S2 §5.2 — FIX-EXTRA «Agregar un extra» (extras_group_empty): with the server’s `group` → that group, its «Agregar extra» row open; without it → the Extras tab as it was', async () => {
  const groupName = () => XON().source.structure.extra_categories[2];
  const p = await page({ read: XON, on: { editCatalog: () => errJson(409, { error: 'extras_group_empty', field: 'extras', group: groupName() }) } });
  await p.signIn(); await p.open('dimsum_01');
  quitar(cardOf(p, 'Salsas')).click(); await settle(10);   // any change, so «Revisar y publicar» saves
  p.btn('Guardar').click(); await settle(10);
  p.d.getElementById('review').click(); await settle(60);
  assert.equal(panel(p).action.textContent, 'Agregar un extra');
  panel(p).action.click(); await settle(30);
  assert.equal(railRows(p).find((r) => r.classList.contains('on')).dataset.group, groupName(), '(a) the group the server named');
  assert.ok(newRow(p), '(a) its «Agregar extra» row open');
  assert.equal(p.d.activeElement && p.d.activeElement.getAttribute('aria-label'), 'Nombre del extra');
  const q = await page({ read: XON, on: { editCatalog: () => errJson(409, { error: 'extras_group_empty', field: 'extras' }) } });
  await q.signIn(); await q.open('dimsum_01');
  quitar(cardOf(q, 'Salsas')).click(); await settle(10);
  q.btn('Guardar').click(); await settle(10);
  q.d.getElementById('review').click(); await settle(60);
  panel(q).action.click(); await settle(30);
  assert.ok(!xpage(q).classList.contains('hidden'), '(b) the Extras tab');
  assert.equal(newRow(q), null, '(b) no row opened (the server named no group)');
});

// ── STRUCTURE S2 §5.2 — REVIEW-DELETIONS (frame X2b): the recovery sheet when the published menu moved under a removal claim ─────────
// The served draft carries a STORED claim in the server's stored shape ({ ids, base_version, base_generation }); the identity ids are
// named from certified rows only on the emulator (s2-portal-claim) — here an id no row carries is «Un extra que ya no está en el menú».
const CLAIMED = () => { const r = XON(); r.source.deleted_ids = { ids: ['xid_gone'], base_version: 'v-live', base_generation: 1 }; r.deletionBase = { version: 'v-live', generation: 1 }; return r; };
const okSave = (call) => okJson({ updateTime: '1700000001.000000001', diff: { changed: [], added: [], removed: [], renamed: [], largeChangeSet: [] }, token: 't', source: call.body.source });
const x2b = (p) => p.d.querySelector('#xscrim.show .modal');
test('S2 §5.2 — REVIEW-DELETIONS: a deletion refusal → the re-read (the FRESH base) → «El menú publicado cambió» with the FULL list → «Confirmar y seguir» resends ONCE acknowledged with the fresh base', async () => {
  let edits = 0, reread = 0;
  const p = await page({ read: CLAIMED, on: {
    editCatalog: (call) => (++edits === 1 ? errJson(409, { error: 'deleted_ids_base_moved' }) : okSave(call)),
    getEditableCatalog: () => (reread++ ? okJson({ ...CLAIMED(), deletionBase: { version: 'v-new', generation: 2 }, deletionClaim: { ids: ['xid_other'] } }) : null),   // the fresh claim WITHOUT the draft's own id: the list must merge both
  } });
  await p.signIn();
  p.d.getElementById('review').click(); await settle(80);
  const m = x2b(p);
  assert.ok(m, 'the recovery sheet');
  assert.deepEqual([m.querySelector('.mt').textContent, m.querySelector('.eqbody').textContent], ['El menú publicado cambió', 'Antes de seguir, confirmá lo que se quita:']);
  const rows = [...m.querySelectorAll('.mk-dels .brow')];
  assert.deepEqual(rows.map((r) => [r.querySelector('.bchip').textContent, r.querySelector('.bnm').textContent]),
    [['Quitado', 'Un extra que ya no está en el menú'], ['Quitado', 'Un extra que ya no está en el menú']], 'the FULL list: the fresh claim ∪ the draft’s');
  const [cancel, go] = [...m.querySelectorAll('.mf button')];
  assert.deepEqual([cancel.textContent, go.textContent], ['Cancelar', 'Confirmar y seguir']);
  assert.equal(p.d.activeElement, go, 'focus on «Confirmar y seguir»');
  go.click(); await settle(80);
  const sent = p.n('editCatalog');
  assert.equal(sent.length, 2, 'ONE resend');
  assert.equal(sent[1].body.deleted_ids_reviewed, true, 'acknowledged');
  assert.deepEqual(sent[1].body.deleted_ids_loaded_base, { version: 'v-new', generation: 2 }, 'with the FRESH base');
  assert.equal(sent[0].body.deleted_ids_reviewed, undefined, 'the first save carried no acknowledgement');
  assert.ok(p.d.getElementById('scrim').classList.contains('show'), 'back to the review, from the server’s fresh diff');
  p.d.getElementById('pubback').click(); await settle(20);
  p.d.getElementById('review').click(); await settle(80);
  assert.equal(p.n('editCatalog')[2].body.deleted_ids_reviewed, undefined, 'the acknowledgement was ONE resend, never sticky');
});
test('S2 §5.2 — REVIEW-DELETIONS: «Cancelar» keeps the draft and sends nothing; a SECOND refusal shows the sheet again (no silent resend); an unreadable re-read holds «Confirmar y seguir»', async () => {
  const p = await page({ read: CLAIMED, on: { editCatalog: () => errJson(409, { error: 'deleted_ids_unbound' }) } });
  await p.signIn();
  const before = JSON.stringify(p.src && p.src());
  p.d.getElementById('review').click(); await settle(80);
  [...x2b(p).querySelectorAll('.mf button')][0].click(); await settle(20);
  assert.equal(x2b(p), null, 'closed');
  assert.equal(p.n('editCatalog').length, 1, 'nothing resent');
  assert.equal(JSON.stringify(p.src && p.src()), before, 'the draft kept');
  p.d.getElementById('review').click(); await settle(80);
  [...x2b(p).querySelectorAll('.mf button')][1].click(); await settle(80);
  assert.equal(p.n('editCatalog').length, 3, 'the confirmed resend went out once');
  assert.ok(x2b(p), 'refused again → the SAME sheet again, never a loop');
  const q = await page({ read: CLAIMED, on: { editCatalog: () => errJson(409, { error: 'deleted_ids_base_moved' }), getEditableCatalog: (() => { let n = 0; return () => (n++ ? errJson(503, { error: 'source_unavailable' }) : null); })() } });
  await q.signIn();
  q.d.getElementById('review').click(); await settle(80);
  assert.ok(x2b(q).textContent.includes('No pudimos leer el menú publicado. Recargá la página.'), 'the re-read failed: said');
  assert.equal([...x2b(q).querySelectorAll('.mf button')][1].disabled, true, '«Confirmar y seguir» held');
});

// ── STRUCTURE S2 P-6 — extraRefs: after a save, a NEW extra's view state follows it to its allocated key (5f's REAL handler) ──────────
async function probeOnPage(p, price) {
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  addBtn(p).click(); await settle(5);
  p.type(newRow(p).querySelector('input[aria-label="Nombre del extra"]'), '  Probe   extra  '); await settle(5);
  const pr = newRow(p).querySelector('.price input'); pr.focus(); p.type(pr, String(price)); await settle(5);
  key(p, newRow(p).querySelector('.price input'), 'Enter'); await settle(10);
  return xrows(p).find((r) => r.querySelector('.tag.new') && rowName(r) === 'Probe extra');
}
test('S2 P-6 — the owner\u2019s save adopts the server\u2019s keys: the SAME row (same price), now keyed through extraRefs, still «Nuevo»', async () => {
  S2_SERVER.on = true;
  try {
    const p = await page({ read: XON, on: { editCatalog: realSave } });
    const row = await probeOnPage(p, 33);
    assert.ok(row, 'premise: the new row');
    assert.match(row.querySelector('.price input').dataset.k, /"ref":"tmp:/, 'premise: keyed by its ref before the save');
    p.d.getElementById('review').click(); await settle(80);
    assert.ok(p.d.getElementById('scrim').classList.contains('show') && !panel(p), `premise: the review, no refusal panel (${panel(p) && panel(p).title})`);
    p.d.getElementById('pubback').click(); await settle(20);
    const after = xrows(p).find((r) => r.querySelector('.price input') && r.querySelector('.price input').value === '33' && r.querySelector('.tag.new'));
    assert.ok(after, 'the same row, same price, still «Nuevo»');
    const k = JSON.parse(after.querySelector('.price input').dataset.k);
    const ext = p.src().extras.find((e) => e.key === k.key);
    assert.ok(typeof k.key === 'string' && ext && ext.display.name === 'Probe extra', `adopted through extraRefs (Probe extra) — ${JSON.stringify(k)}`);
  } finally { S2_SERVER.on = false; }
});
test('S2 P-6 — the manager\u2019s send: focus stays in the SAME row\u2019s price across the adoption (its restore key re-keyed by extraRefs); without the map the view state is dropped, nothing mis-keyed', async () => {
  S2_SERVER.on = true;
  try {
    const p = await page({ read: () => editable({ extrasAuthoring: true, extrasCatalog: true, publish_via_request: true }), on: { editCatalog: realSave, catalogRequestPublish: () => okJson({ ok: true, counts: { changed: 0, added: 1, removed: 0, large: 0 } }) } });
    const row = await probeOnPage(p, 34);
    row.querySelector('.price input').focus();
    p.d.getElementById('review').click(); await settle(80);
    const ae = p.d.activeElement;
    assert.ok(ae && ae.matches && ae.matches('#xdetail .price input'), 'focus kept in a price field');
    const k = JSON.parse(ae.dataset.k);
    assert.ok(typeof k.key === 'string' && p.src().extras.find((e) => e.key === k.key).display.name === 'Probe extra', 'the SAME row, now keyed');
    assert.equal(ae.value, '34');
    assert.equal(addBtn(p).disabled, false, 'the Extras page is editable again after the send (it kept its write-time disabled controls before)');
    // a stubbed answer WITHOUT extraRefs: 5f's real handler with the map removed (never laxer) — nothing is re-keyed by a guess
    const noMap = (call) => realSave(call).then(async (r) => { const b = await r.json(); if (!r.ok) return errJson(r.status, b); delete b.extraRefs; return okJson(b); });
    const q = await page({ read: () => editable({ extrasAuthoring: true, extrasCatalog: true, publish_via_request: true }), on: { editCatalog: noMap, catalogRequestPublish: () => okJson({ ok: true, counts: { changed: 0, added: 1, removed: 0, large: 0 } }) } });
    const row2 = await probeOnPage(q, 35);
    row2.querySelector('.price input').focus();
    q.d.getElementById('review').click(); await settle(80);
    assert.equal(panel(q), null, 'premise: the save went through (no refusal panel)');
    assert.ok(q.src().extras.some((e) => typeof e.key === 'string' && e.display.name === 'Probe extra'), 'premise: the adopted source keyed the new extra');
    const ae2 = q.d.activeElement;
    assert.ok(!(ae2 && ae2.matches && ae2.matches('#xdetail .price input')), 'an unmapped ref is dropped, nothing mis-keyed (no focus guessed onto a row)');
  } finally { S2_SERVER.on = false; }
});

// ── STRUCTURE S2 §3.5 — the remaining leave paths consult localDirty() first: the review, the tenant switch, the reload ──────────────
async function dirtyRow(p) {
  await p.signIn();
  tabBtn(p, 'Extras').click(); await settle(10);
  addBtn(p).click(); await settle(5);
  p.type(newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'Maní'); await settle(5);   // started, not complete
}
test('S2 §3.5 — «Revisar y publicar» with a DIRTY inline row asks «¿Descartar los cambios?» first: «Seguir editando» sends nothing and keeps it; «Descartar» drops it, then reviews; a COMPLETE row commits first', async () => {
  const p = await page({ read: XON, on: { editCatalog: (call) => okJson({ updateTime: '1700000001.000000001', diff: { changed: [], added: [], removed: [], renamed: [], largeChangeSet: [] }, token: 't', source: call.body.source }) } });
  await dirtyRow(p);
  p.d.getElementById('review').click(); await settle(20);
  let cf = p.d.querySelector('#xscrim.show .modal');
  assert.ok(cf && cf.querySelector('.mt').textContent === '¿Descartar los cambios?', 'the portal’s discard confirm first');
  [...cf.querySelectorAll('.mf button')][1].click(); await settle(10);
  assert.equal(p.n('editCatalog').length, 0, '«Seguir editando»: nothing sent');
  assert.equal(newRow(p).querySelector('input[aria-label="Nombre del extra"]').value, 'Maní', 'the row kept');
  p.d.getElementById('review').click(); await settle(20);
  [...p.d.querySelector('#xscrim.show .modal').querySelectorAll('.mf button')][0].click(); await settle(80);
  assert.equal(p.n('editCatalog').length, 1, '«Descartar»: then the review');
  assert.ok(!p.n('editCatalog')[0].body.source.extras.some((e) => e.display.name === 'Maní'), 'the dropped row is not in the save');
  const q = await page({ read: XON, on: { editCatalog: (call) => okJson({ updateTime: '1700000001.000000001', diff: { changed: [], added: [], removed: [], renamed: [], largeChangeSet: [] }, token: 't', source: call.body.source }) } });
  await dirtyRow(q);
  const pr = newRow(q).querySelector('.price input'); pr.focus(); q.type(pr, '15'); await settle(5);
  q.d.getElementById('review').click(); await settle(80);
  assert.equal(q.d.querySelector('#xscrim.show .modal'), null, 'a COMPLETE row asks nothing');
  assert.ok(q.n('editCatalog')[0].body.source.extras.some((e) => e.display.name === 'Maní'), 'it was committed first, then saved');
});
test('S2 §3.5 — the branch switch and the self-update (shell.js / SherpaClient: editorCanLeave) and the reload (beforeunload) hold while a local edit or a pending change exists, never when clean', async () => {
  const p = await page({ read: XON });
  await dirtyRow(p);
  p.d.activeElement && p.d.activeElement.blur && p.d.activeElement.blur();   // focus alone also holds the self-update: take it away, so the DIRTY ROW is what holds
  assert.equal(p.mods.app.editorCanLeave(), false, 'a dirty inline row holds the branch switch / the self-update (the shell\u2019s own gate)');
  const unload = () => { const e = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(unload(), true, 'a dirty inline row holds the reload');
  key(p, newRow(p).querySelector('input[aria-label="Nombre del extra"]'), 'Escape'); await settle(10);
  assert.equal(unload(), false, 'clean: the reload is free');
  p.d.activeElement && p.d.activeElement.blur && p.d.activeElement.blur();
  assert.equal(p.mods.app.editorCanLeave(), true, 'clean: the switch is free');
  const x0 = xrows(p)[0].querySelector('.price input'); x0.focus(); p.type(x0, '99'); await settle(10);
  assert.equal(unload(), true, 'a pending (unsaved) change holds the reload too');
});
