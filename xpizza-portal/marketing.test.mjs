// Portal «Marketing» › Ofertas — the DRAWING half, slice O1 (MOCKUP-portal-marketing v5, owner-approved 11-14), under a REAL DOM: jsdom
// over the shipped index.html with the REAL app.js, ventas.js, shell.js and marketing.js (auth.js stubbed), every marketing reply from
// 3a's REAL cores at the pin (marketing-harness.mjs) — the shell's own calls answered by `extra`. The nav switch (cached-first, the
// background revalidation applied on the next navigation), the list, the empty state, the «Crear campaña» cards, the manager's
// read-only list, the error box, and the SOURCE_GATE: every v5 block the server can't source is ABSENT.
// Run: node --test marketing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, NOW, DAY, OWNER, MGR, RID, K1, K2, K3, backend, form, create, publish } from './marketing-harness.mjs';
import { offerSetStateRaw } from './api.js';
import * as ML from './marketing-logic.js';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'marketing.read', 'marketing.edit'];
const MGR_CAPS = ['catalog.read_editor', 'availability.set', 'location.pause', 'marketing.read'];
const branch = (rid, name, caps) => ({ rid, brand_id: 'tb', role: caps.includes('marketing.edit') ? 'owner' : 'manager', state: 'member', caps, name,
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null });
// the REAL roster (marketing-harness): the owner holds both branches; the manager was granted tb_centro ONLY — E1 says the same
const E1 = (caps = OWNER_CAPS) => ({ brands: [{ brand_id: 'tb', name: 'Tercera' }], branches: caps.includes('marketing.edit') ? [branch('tb_centro', 'Centro', caps), branch('tb_sur', 'Sur', caps)] : [branch('tb_centro', 'Centro', caps)], membership_writes_enabled: false });
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
// the editable catalog the 2×1 picker reads: the SAME dish keys the harness's real catalog mirror publishes on tb_centro (K1 150 · K2 220 ·
// K3 90), so the real core's unknown_dish check passes on what the picker offers
const MENU = () => okJson({ source: { restaurant_id: RID, schema_version: 1, extras: [],
  items: [{ key: K1, price: 150, display: { name: 'Pizza Margarita', cat: 'pizzas', price: 150 } }, { key: K2, price: 220, display: { name: 'Pizza Hawaiana', cat: 'pizzas', price: 220 } }, { key: K3, price: 90, display: { name: 'Refresco', cat: 'bebidas', price: 90 } }],
  structure: { schema_version: 2, item_order: [K1, K2, K3], categories: [{ id: 'pizzas', name: 'Pizzas' }, { id: 'bebidas', name: 'Bebidas' }] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__mkt-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => globalThis.__tok;\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__mkt-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__mkt-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'marketing-ops', 'marketing-builder', 'marketing-detail', 'marketing']) {   // + the ops ledger: module state   // the builder + detail per page too: their state is module-level
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__mkt-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`)
        .replace(/from '\.\/marketing-builder\.js'/g, `from '${url('marketing-builder')}'`)
        .replace(/from '\.\/marketing-detail\.js'/g, `from '${url('marketing-detail')}'`)
        .replace(/from '\.\/marketing-ops\.js'/g, `from '${url('marketing-ops')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

// the page over a REAL backend; `cache` seeds the session's last-known switch ('1' | '0' | null = none)
async function page({ b, caps = OWNER_CAPS, uid = OWNER, cache = '1' } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  globalThis.__tok = `t-${uid}`;
  if (cache !== null) w.sessionStorage.setItem(`sherpa.portal.mkt.${uid}|tb`, cache);
  b.extra.fn = (fn) => {
    if (fn === 'getMyBranches') return okJson(E1(caps));
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return okJson({});
  };
  const mods = await loadAll();
  const d = w.document;
  const reg = () => mods.shell._registered.find((r) => r.id === 'marketing');
  const host = () => reg().main;
  const text = () => host().textContent.replace(/\s+/g, ' ');
  const btn = (label, root = host()) => [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
  const signIn = async () => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(60);
  };
  const open = async () => { reg().nav.click(); await settle(60); };
  return { dom, w, d, mods, reg, host, text, btn, signIn, open, navHidden: () => reg().nav.classList.contains('hidden') };
}
async function world(opts = {}) {
  const ext = { fn: null };
  const b = await backend({ ...opts, extra: (fn, body) => (ext.fn ? ext.fn(fn, body) : null) });
  b.extra = ext;
  return b;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('SOURCE_GATE: the v5 blocks this build can\'t source are named, each with its reason — the list is deliberate', async () => {
  const b = await world();
  const p = await page({ b });
  const ids = p.mods.marketing.SOURCE_GATE.map(([id]) => id);
  assert.deepEqual(ids, ['summary', 'fresh', 'period', 'ventas', 'tope', 'repeat-live', 'delete', 'anuncios', 'how-anuncios', 'sherpa-collections', 'detail-results', 'empty-results']);
  for (const [id, why] of p.mods.marketing.SOURCE_GATE) assert.ok(typeof why === 'string' && why.length > 20, `${id}: a reason`);
  assert.deepEqual(p.mods.marketing.NOT_DRAWN.map(([id]) => id), ['switch-off', 'live-drift']);
});

test('nav: shown only with marketing.read AND the last-known switch ON (session cache, default HIDDEN); a manager without the cap never', async () => {
  const b = await world();
  let p = await page({ b, cache: null });
  await p.signIn();
  assert.ok(p.navHidden(), 'no cached switch: hidden (no merchant finds an empty page)');
  p = await page({ b, cache: '1' });
  await p.signIn();
  assert.ok(!p.navHidden(), 'cached ON + the cap: shown');
  assert.equal(p.reg().nav.textContent.trim(), 'Marketing');
  p = await page({ b, caps: OWNER_CAPS.filter((c) => !c.startsWith('marketing.')), cache: '1' });
  await p.signIn();
  assert.ok(p.navHidden(), 'without marketing.read: hidden');
});

test('nav: the background read refreshes the cached switch after the session opens; the flip lands on the NEXT navigation, never under the user', async () => {
  const b = await world();
  const p = await page({ b, cache: null });
  await p.signIn();
  p.d.dispatchEvent(new p.w.CustomEvent('portal:ready'));
  await settle(80);
  assert.equal(p.w.sessionStorage.getItem(`sherpa.portal.mkt.${OWNER}|tb`), '1', 'the real core says offers_enabled: the cache learns it');
  assert.ok(p.navHidden(), 'nothing moves under the user');
  p.mods.shell.goto('suc');
  assert.ok(!p.navHidden(), 'the next navigation shows it');
  const off = await world({ offers: false });
  const q = await page({ b: off, cache: '1' });
  await q.signIn();
  q.d.dispatchEvent(new q.w.CustomEvent('portal:ready'));
  await settle(80);
  assert.equal(q.w.sessionStorage.getItem(`sherpa.portal.mkt.${OWNER}|tb`), '0', 'switched OFF on the server: the cache learns it');
  q.mods.shell.goto('suc');
  assert.ok(q.navHidden(), '…and the item leaves on the next navigation');
});

test('the Campañas list: one row per offer from the REAL core — icon, name, «N de M sucursales», dot status, «Horario»; the drawn columns minus «Ventas»', async () => {
  const b = await world();
  const live = await publish(b, form({ name: 'Almuerzo: 15 % en todo el menú', pct: 15, start: NOW, end: null, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } }));
  await create(b, form({ name: 'Cena: L 40 en pedidos desde L 300' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  const host = p.host();
  assert.deepEqual([...host.querySelectorAll('.mk5-tab')].map((t) => [t.textContent, t.classList.contains('mk5-on')]), [['Campañas', true], ['Crear campaña', false]]);
  assert.deepEqual([...host.querySelectorAll('.mk5-lh span')].map((s) => s.textContent), ['', 'Campaña', 'Estado', 'Horario', ''], '🔴 no «Ventas» header (SOURCE_GATE ventas)');
  const rows = [...host.querySelectorAll('.mk5-row')].map((r) => ({
    name: r.querySelector('.mk5-c1 .mk5-lnk').textContent, note: (r.querySelector('.mk5-br') || {}).textContent || null,
    st: r.querySelector('.mk5-c2 .mk5-dot').className, word: r.querySelector('.mk5-c2 .mk5-st').textContent, hor: r.querySelector('.mk5-c3').textContent,
    icon: r.querySelector('.mk5-ico svg path, .mk5-ico svg circle') !== null,
  }));
  assert.deepEqual(rows, [
    { name: live.name, note: '1 de 2 sucursales', st: 'mk5-dot mk5-activa', word: 'Activa', hor: 'Lun–Vie · 11:00–14:00', icon: true },
    { name: 'Cena: L 40 en pedidos desde L 300', note: '1 de 2 sucursales', st: 'mk5-dot mk5-borr', word: 'Borrador', hor: 'Sin programar', icon: true }]);
  assert.equal(host.querySelector('.mk5-sect h2').textContent, 'Ofertas');
  assert.equal([...host.querySelectorAll('.mk5-sect h2')].filter((h) => h.textContent === 'Anuncios').length, 0, '🔴 no «Anuncios» section (SOURCE_GATE anuncios)');
  for (const sel of ['.sumline', '.kfigs', '.mx-fresh', '[data-menu="fper"]', '.mk5-c4', '.why', '.vh', '.vc-sect', '.elig'])
    assert.equal(host.querySelector(sel), null, `🔴 ${sel} is ABSENT (SOURCE_GATE)`);
  assert.ok(!/Últimos 30 días|Actualizado|trajeron|Ventas|Eliminar|Subir tope/.test(p.text()), '🔴 no gated word anywhere on the page');
});

test('«Acciones ▾»: the drawn menu ∩ the server\'s moves; one menu open at a time; a click outside closes it', async () => {
  const b = await world();
  await publish(b, form({ name: 'Viva', start: NOW }));
  await create(b, form({ name: 'Borrador uno' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  const rowOf = (name) => [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === name);
  p.btn('Acciones', rowOf('Viva')).click(); await settle();
  assert.deepEqual([...rowOf('Viva').querySelectorAll('.mk5-menu.mk5-open [role="menuitem"]')].map((x) => x.textContent), ['Ver', 'Pausar', 'Editar', 'Terminar']);
  assert.equal(rowOf('Viva').querySelector('[data-act="end"]').className, 'mk5-opt mk5-danger');
  p.btn('Acciones', rowOf('Borrador uno')).click(); await settle();
  assert.equal(p.host().querySelectorAll('.mk5-menu.mk5-open').length, 1, 'one menu at a time');
  assert.deepEqual([...rowOf('Borrador uno').querySelectorAll('.mk5-menu.mk5-open [role="menuitem"]')].map((x) => x.textContent), ['Seguir editando']);
  p.d.body.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true })); await settle();
  assert.equal(p.host().querySelectorAll('.mk5-menu.mk5-open').length, 0, 'a click outside closes it');
});

test('«Estado ▾» counts span the list and filter it; «Todas las sucursales» ▾ narrows to ONE branch read', async () => {
  const b = await world();
  await publish(b, form({ name: 'Ambas', start: NOW, branches: [RID, 'tb_sur'] }));
  await create(b, form({ name: 'Solo centro' }));
  await create(b, form({ name: 'Solo sur', branches: ['tb_sur'] }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  const names = () => [...p.host().querySelectorAll('.mk5-row .mk5-lnk')].map((x) => x.textContent).sort();
  assert.deepEqual(names(), ['Ambas', 'Solo centro', 'Solo sur'], '«Todas las sucursales»: the union, one row per offer');
  p.btn('Estado').click(); await settle();
  const opts = [...p.host().querySelectorAll('.mk5-menu.mk5-open [role="option"]')].map((o) => [o.firstChild.textContent, o.querySelector('.mk5-count').textContent]);
  assert.deepEqual(opts, [['Todas', '3'], ['Activas', '1'], ['Programadas', '0'], ['Pausadas', '0'], ['Terminadas', '0'], ['Borradores', '2']]);
  [...p.host().querySelectorAll('.mk5-menu.mk5-open [role="option"]')].find((o) => o.firstChild.textContent === 'Borradores').click(); await settle();
  assert.deepEqual(names(), ['Solo centro', 'Solo sur']);
  assert.ok(p.host().querySelector('.mk5-pill.mk5-chosen'), 'a chosen value fills the pill');
  p.btn('Todas las sucursales').click(); await settle();
  [...p.host().querySelectorAll('.mk5-menu.mk5-open [role="option"]')].find((o) => o.textContent === 'Sur').click(); await settle(80);
  assert.deepEqual(names(), ['Solo sur'], 'Sur + Borradores');
});

test('the empty state (no offers): one heading + one sentence, then the offer cards; a manager gets the words only — no «Crear campaña», no cards', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  const host = p.host();
  assert.equal(host.querySelector('.lede').textContent, 'Ofertas y anuncios para vender más en la app. Vos elegís qué, cuándo y hasta cuánto.');
  assert.equal(host.querySelector('.mk5-empty h2').textContent, 'Todavía no tenés campañas');
  assert.deepEqual([...host.querySelectorAll('.mk5-empty p')].map((x) => x.textContent), ['Empezá por acá:'], '🔴 the results sentence is ABSENT (SOURCE_GATE empty-results)');
  assert.ok(!/vas a ver cuánto vendiste|pedidos trajo/.test(p.text()));
  assert.equal(host.querySelectorAll('.mk5-card').length, 5, 'the five offer cards');
  assert.equal(host.querySelector('.vh'), null, '🔴 no Anuncio hero (SOURCE_GATE anuncios)');
  const m = await page({ b, caps: MGR_CAPS, uid: MGR });
  await m.signIn(); await m.open();
  assert.deepEqual([...m.host().querySelectorAll('.mk5-tab')].map((t) => t.textContent), ['Campañas'], 'a manager: no «Crear campaña»');
  assert.equal(m.host().querySelectorAll('.mk5-card').length, 0, 'no offer cards');
  assert.equal(m.host().querySelector('.mk5-empty h2').textContent, 'Todavía no tenés campañas');
  assert.equal(m.host().querySelectorAll('.mk5-empty p').length, 0, 'a manager: no «Empezá por acá:» (nothing follows it)');
});

test('«Crear campaña»: the five cards verbatim, then «¿Cómo funcionan?» with the Ofertas paragraph only; no hero, no eligibility, no Campañas de Sherpa', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  p.btn('Crear campaña').click(); await settle();
  const host = p.host();
  assert.equal(host.querySelector('.mk5-osect h2').textContent, 'Creá tu propia oferta');
  assert.deepEqual([...host.querySelectorAll('.mk5-card')].map((c) => [c.dataset.otype, c.dataset.tone, c.querySelector('.mk5-ccat').textContent, c.querySelector('h3').textContent, c.querySelector('.mk5-ben span').textContent]), [
    ['pct', 'mint', 'Descuento', 'Porcentaje en todo el menú', 'Aparecés en la sección Ofertas de la app'],
    ['lps', 'sky', 'Lempiras', 'Lempiras de descuento con mínimo', 'Sube el ticket: el cliente completa el mínimo'],
    ['bogo', 'rose', '2 × 1', 'Comprá 1 y llevate otro gratis', 'Se muestra con una etiqueta en tu menú'],
    ['envio', 'teal', 'Envío', 'Envío gratis', 'Tu restaurante aparece con «Envío gratis»'],
    ['nuevos', 'lav', 'Clientes nuevos', 'Para clientes nuevos', 'Solo la ven clientes que nunca te pidieron']]);
  assert.equal(host.querySelector('.mk5-howbox'), null, 'closed by default');
  p.btn('¿Cómo funcionan?').click(); await settle();
  assert.deepEqual([...host.querySelectorAll('.mk5-howbox p')].map((x) => x.textContent), ['Ofertas. Un descuento que cubre tu restaurante. Aparece en la sección «Ofertas» de la app y con una etiqueta en tu menú, solo en los días y horas que elijás. Sherpa no te cobra.'],
    '🔴 the «Anuncios.» paragraph is ABSENT (SOURCE_GATE how-anuncios)');
  for (const sel of ['.vh', '.elig', '.vc-sect']) assert.equal(host.querySelector(sel), null, `🔴 ${sel} ABSENT`);
  assert.ok(!/Campañas de Sherpa|Anunciá tu restaurante|requisitos/.test(p.text()));
});

test('switched OFF on the server, visited directly: the title + lede only (NOT-DRAWN); a failed read: the OFFLINE box, «Reintentar» recovers', async () => {
  const off = await world({ offers: false });
  const p = await page({ b: off, cache: '1' });
  await p.signIn();
  // the shell's own portal:ready already revalidated the switch at sign-in (OFF ⇒ the item left): the page itself is reached only by a
  // visit that beats that read — mounted here directly, as the shell would
  p.reg().mount(p.reg().main, p.mods.marketing._mktState.navSel); await settle(60);
  assert.equal(p.host().querySelector('h1').textContent, 'Marketing');
  assert.equal(p.host().querySelectorAll('.mk5-tab, .mk5-list, .mk5-card, .mk5-empty').length, 0, 'nothing drawn beyond the title and lede');
  assert.equal(p.w.sessionStorage.getItem(`sherpa.portal.mkt.${OWNER}|tb`), '0', 'the read taught the cache');
  const b = await world();
  await create(b, form({ name: 'X' }));
  const q = await page({ b });
  await q.signIn();
  b.net.down = true;
  await q.open();
  assert.ok(q.host().querySelector('.errbox'), 'the shipped OFFLINE box');
  b.net.down = false;
  q.btn('Reintentar').click(); await settle(80);
  assert.equal(q.host().querySelectorAll('.mk5-row').length, 1, 'recovered');
});


// ═══ O2b · the builder dialog + the review sheet (v5 3 / 3b; PLAN-portal-marketing-O2-r0 rulings) ═════════════════════════════════
const dlg = (p) => p.host().querySelector('.mk5b-dlg');
const rowEl = (p, id) => p.host().querySelector(`.mk5b-row[data-row="${id}"]`);
const rowVal = (p, id) => rowEl(p, id).querySelector('.mk5b-val').textContent;
async function openCard(p, type) {
  p.mods.marketing.clock.now = () => NOW;   // the page's clock = the real core's (marketing-harness NOW)
  p.btn('Crear campaña').click(); await settle();
  p.host().querySelector(`.mk5-card[data-otype="${type}"]`).click(); await settle(60);
}
test('the builder opens from a card, preconfigured: v5\'s rows, the suggested values, the preview, the cost line — the gated parts absent', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  const d = dlg(p);
  assert.ok(d && d.getAttribute('role') === 'dialog');
  assert.equal(d.querySelector('h2').textContent, 'Nueva oferta');
  assert.equal(d.querySelector('.mk5b-type .mk5b-lbl').textContent, 'Porcentaje en todo el menú');
  assert.deepEqual([...d.querySelectorAll('.mk5b-row')].map((r) => [r.dataset.row, r.querySelector('.mk5b-rlbl').textContent]),
    [['br', 'Sucursales'], ['typ', 'Descuento'], ['aud', 'Clientes'], ['sch', 'Horario'], ['caps', 'Límites'], ['name', 'Nombre']], 'no Productos row outside 2×1');
  assert.deepEqual([rowVal(p, 'br'), rowVal(p, 'typ'), rowVal(p, 'aud'), rowVal(p, 'caps'), rowVal(p, 'name')],
    ['Las 2 sucursales', '15 % · hasta L 100 por pedido', 'Todos', 'Sin tope', '15 % en todo el menú · se armó solo']);
  assert.match(rowVal(p, 'sch'), /^Todos los días · todo el día · desde el \d+ [a-z]{3}, sin fecha de fin$/, 'defaults: all days, todo el día, start today, no end');
  assert.deepEqual([d.querySelector('.mk5b-pvchip').textContent, d.querySelector('.mk5b-pvoff').textContent], ['15 % menos', '15 % de descuento en todo el menú, hasta L 100']);
  assert.equal(d.querySelector('.mk5b-pvhd b').textContent, 'Tercera', 'the brand name (E1)');
  assert.equal(d.querySelector('.mk5b-pvmeta').textContent, '2 sucursales', '🔴 no «25–35 min · Envío L 40» (gated)');
  assert.equal(d.querySelector('.mk5b-fine').textContent, 'El descuento lo cubre tu restaurante. Sherpa no te cobra. Hasta L 100 por canje.');
  assert.ok(!d.querySelector('.mk5b-go').disabled && !d.querySelector('.mk5b-block'), 'a valid form: «Revisar y programar» enabled, no block line');
  const text = d.textContent;
  assert.ok(!/condiciones de marketing|se pausa sola|te avisamos|Más pedido|25–35 min|Envío L 40|Mínimo de compra/.test(text), '🔴 Q4 / Q6 / gated words absent (pct has no minimum)');
  rowEl(p, 'aud').querySelector('.mk5b-rowh').click(); await settle();
  assert.deepEqual([...rowEl(p, 'aud').querySelectorAll('.mk5b-oname')].map((x) => x.textContent), ['Todos los clientes', 'Clientes nuevos', 'Clientes que vuelven'], '🔴 Q3: titles only, no sub-lines');
  rowEl(p, 'caps').querySelector('.mk5b-rowh').click(); await settle();
  assert.equal(rowEl(p, 'aud').classList.contains('mk5b-open'), false, 'one row open at a time');
  assert.equal(rowEl(p, 'caps').querySelector('.mk5b-help').textContent, 'La oferta no tiene fin, así que el tope de gasto es por semana y se reinicia cada lunes. Al llegar a un tope, la oferta deja de aplicarse hasta el lunes o hasta que lo subas.');
});

test('«Revisar y programar» → «Revisá tu oferta» (the rows mirror the builder) → «Programar oferta»: the REAL core creates + activates; the toast; the list shows it', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  dlg(p).querySelector('.mk5b-go').click(); await settle();
  const sheet = p.host().querySelector('.mk5r-modal');
  assert.equal(sheet.querySelector('.mk5r-mt').textContent, 'Revisá tu oferta');
  assert.deepEqual([...sheet.querySelectorAll('.mk5r-row')].map((r) => [r.querySelector('.mk5r-sl').textContent, r.querySelector('.mk5r-sv').textContent]).slice(0, 4),
    [['Oferta', 'Lempiras de descuento con mínimo · L 50 · mínimo L 300'], ['Sucursales', 'Las 2'], ['Clientes', 'Todos'], ['Horario', rowVal(p, 'sch')]]);
  assert.ok(!/condiciones de marketing/.test(sheet.textContent), '🔴 Q6: no terms sentence on the review either');
  p.btn('Programar oferta', sheet).click(); await settle(120);
  assert.equal(dlg(p), null, 'the dialog closes');
  assert.equal(p.d.getElementById('opstoast').textContent, 'Oferta programada. Empieza hoy.');
  const names = [...p.host().querySelectorAll('.mk5-row .mk5-lnk')].map((x) => x.textContent);
  assert.ok(names.includes('L 50 en pedidos desde L 300'), 'the list reloaded with it');
  const row = [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === 'L 50 en pedidos desde L 300');
  assert.equal(row.querySelector('.mk5-st').textContent, 'Programada', 'the real core activated it — «hoy» starts a minute from now (a past start is start_past), so it reads Programada until then');
});

test('«Guardar borrador» saves a draft («Borrador guardado»); «Seguir editando» reopens it with its own name; a refusal stays on the sheet, worded', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'envio');
  p.btn('Guardar borrador', dlg(p)).click(); await settle(120);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Borrador guardado');
  const row = [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === 'Envío gratis desde L 350');
  assert.equal(row.querySelector('.mk5-st').textContent, 'Borrador');
  p.btn('Acciones', row).click(); await settle();
  p.btn('Seguir editando', row).click(); await settle(60);
  assert.equal(dlg(p).querySelector('h2').textContent, 'Seguir editando');
  assert.equal(rowVal(p, 'name'), 'Envío gratis desde L 350', 'its own name, not «se armó solo»');
  await b.setSwitch(false, 1);   // the switch goes OFF on the server while the merchant edits
  dlg(p).querySelector('.mk5b-go').click(); await settle();
  p.btn('Programar oferta', p.host().querySelector('.mk5r-modal')).click(); await settle(120);
  assert.ok(dlg(p), 'refused: the dialog stays');
  assert.equal(p.host().querySelector('.mk5r-modal .mk5b-err').textContent, 'Las ofertas no están disponibles en este momento.');
});

test('2×1: «Productos» picks from the menu (the editable catalog), chips with price; the block line until one is picked; the ceiling follows the dearest × gratis', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'bogo');
  const d = dlg(p);
  assert.equal(d.querySelector('.mk5b-block').textContent, 'Para revisar, agregá al menos un producto.');
  assert.ok(d.querySelector('.mk5b-go').disabled);
  rowEl(p, 'prod').querySelector('.mk5b-rowh').click(); await settle();
  p.btn('Agregar producto', rowEl(p, 'prod')).click(); await settle();
  [...rowEl(p, 'prod').querySelectorAll('.mk5b-opt')].find((o) => o.textContent.startsWith('Pizza Hawaiana')).querySelector('input').dispatchEvent(new p.w.Event('change')); await settle();
  assert.deepEqual([...rowEl(p, 'prod').querySelectorAll('.mk5b-item')].map((c) => c.textContent), ['Pizza Hawaiana L 220']);
  assert.equal(rowVal(p, 'prod'), '1 producto');
  assert.equal(dlg(p).querySelector('.mk5b-fine').textContent, 'El descuento lo cubre tu restaurante. Sherpa no te cobra. Hasta L 220 por canje.');
  assert.equal(dlg(p).querySelector('.mk5b-block'), null);
  assert.equal(dlg(p).querySelector('.mk5b-nm span').textContent, 'Pizza Hawaiana', 'the menu-row preview names the chosen dish');
});

test('the calendar: Sunday-first, past days inert, a pick moves Inicio and the Horario summary; Esc closes the calendar first, then the sheet, then the dialog', async () => {
  const b = await world();
  await create(b, form({ name: 'Una' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  p.host().querySelector('.mk5b-dpbtn[data-dp="start"]').click(); await settle();
  const pop = p.host().querySelector('.mk5b-dpop');
  assert.deepEqual([...pop.querySelectorAll('.mk5b-dpwk span')].map((x) => x.textContent), ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá']);
  const days = [...pop.querySelectorAll('.mk5b-dpd')];
  const today = days.find((x) => x.querySelector('.mk5b-tdot'));
  assert.ok(today, 'today is dotted');
  assert.ok(days.slice(0, days.indexOf(today)).every((x) => x.disabled), 'days before today are inert');
  const pick = days[days.indexOf(today) + 1] || days[days.length - 1];
  pick.click(); await settle();
  assert.equal(p.host().querySelector('.mk5b-dpop'), null, 'a pick closes the calendar');
  assert.ok(rowVal(p, 'sch').includes(`desde el ${pick.querySelector('.mk5b-dnum').textContent} `), 'the summary follows the new Inicio');
  p.host().querySelector('.mk5b-dpbtn[data-dp="start"]').click(); await settle();
  const esc = () => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
  esc(); await settle();
  assert.ok(!p.host().querySelector('.mk5b-dpop') && dlg(p), 'Esc #1: the calendar only');
  dlg(p).querySelector('.mk5b-go').click(); await settle();
  esc(); await settle();
  assert.ok(!p.host().querySelector('.mk5r-modal') && dlg(p), 'Esc #2: the review sheet only');
  esc(); await settle();
  assert.equal(dlg(p), null, 'Esc #3: the dialog');
});


// ═══ O2c · «Editar oferta activa» (v5 3c, ruling (a): v5 EXACT — the server widening is 3a's) ═════════════════════════════════════
async function openEdit(p, name) {
  p.mods.marketing.clock.now = () => NOW;
  const row = [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === name);
  p.btn('Acciones', row).click(); await settle();
  p.btn('Editar', row).click(); await settle(60);
}
test('Editar on a running offer: v5\'s dialog — the lede, the locked rows (lock, «fijo mientras está activa»), Límites open, Horario editable', async () => {
  const b = await world();
  await publish(b, form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * 86400000, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 }, cap_redemptions: 100, cap_spend: '3000' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const d = dlg(p);
  assert.equal(d.querySelector('h2').textContent, 'Editar oferta activa');
  assert.equal(d.querySelector('.mk5b-lede').textContent, 'Mientras está activa podés subir los topes y cambiar el horario. Lo demás queda fijo, para que ningún cliente vea una oferta distinta de la que le prometimos.');
  assert.equal(d.querySelector('.mk5b-type .mk5b-lbl').textContent, 'Almuerzo');
  const locked = [...d.querySelectorAll('.mk5b-lock')].map((r) => [r.dataset.row, r.querySelector('.mk5b-val').textContent, r.querySelector('.mk5b-rowh').getAttribute('aria-label')]);
  assert.deepEqual(locked.map((x) => x[0]), ['br', 'typ', 'aud'], 'Sucursales · Descuento · Clientes locked');
  assert.equal(locked[1][1], '15 % · hasta L 100 por pedido · fijo mientras está activa');
  assert.equal(locked[0][2], 'Sucursales, fijo mientras está activa');
  assert.equal(d.querySelectorAll('.mk5b-lock button').length, 0, 'a locked row does not expand');
  assert.ok(rowEl(p, 'caps').classList.contains('mk5b-open'), 'Límites opens first');
  assert.equal(rowEl(p, 'caps').querySelector('.mk5b-help').textContent, 'Solo se pueden subir.', '🔴 the counters wait for 5f (gated)');
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  assert.ok([...rowEl(p, 'sch').querySelectorAll('.mk5b-chip')].every((c) => !c.disabled), 'days + franja editable (ruling (a))');
  assert.match(rowEl(p, 'sch').querySelector('.mk5b-ro').textContent, /^Empezó el\d+ nov 2026$/, 'Inicio read-only');
  assert.deepEqual([...d.querySelectorAll('.mk5b-foot .mk5b-fine')].map((x) => x.textContent), ['Para cambiar el descuento, los clientes o las sucursales, terminá esta oferta y creá una nueva (o usá Repetir).', 'Los cambios aplican de inmediato en la app.']);
});

test('Editar: a cap may only go UP — a lower one blocks inline; a higher one saves through the REAL core («Cambios guardados»); a live day change saves too (3a widened)', async () => {
  const b = await world();
  await publish(b, form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * 86400000, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 }, cap_redemptions: 100, cap_spend: '3000' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const capIn = () => rowEl(p, 'caps').querySelectorAll('.mk5b-num')[0];
  capIn().value = '50'; capIn().dispatchEvent(new p.w.Event('change')); await settle();
  assert.equal(rowEl(p, 'caps').querySelector('.mk5b-block').textContent, 'Un tope solo puede subir: poné un valor mayor o igual al actual.');
  assert.ok(dlg(p).querySelector('.mk5b-go').disabled, 'blocked');
  capIn().value = '150'; capIn().dispatchEvent(new p.w.Event('change')); await settle();
  assert.ok(!dlg(p).querySelector('.mk5b-go').disabled);
  p.btn('Guardar cambios', dlg(p)).click(); await settle(120);
  assert.equal(dlg(p), null);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Cambios guardados');
  const saved = Object.values(b.fake.get('marketing_offers/tb')).find((r) => r.name === 'Almuerzo');
  assert.equal(saved.caps.redemptions, 150, 'the real core stored the raised cap');
  await openEdit(p, 'Almuerzo');
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  [...rowEl(p, 'sch').querySelectorAll('.mk5b-chip')].find((c) => c.textContent.endsWith('Sáb')).click(); await settle();
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  assert.equal(dlg(p), null, '3a\'s widened core (REF c5bbce740) SAVES a live day change: the dialog closes');
  assert.equal(p.d.getElementById('opstoast').textContent, 'Cambios guardados');
  const after = Object.values(b.fake.get('marketing_offers/tb')).find((r) => r.name === 'Almuerzo');
  assert.deepEqual([...after.schedule.days].sort(), [1, 2, 3, 4, 5, 6], 'the real core stored the new day');
});

// ═══ O3 · the detail (v5 5 / 5b / 5c) + the state moves + «Repetir» — every write through 3a's REAL cores ══════════════════════
const LIVE = () => form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * DAY, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 }, cap_redemptions: 100, cap_spend: '3000' });
const rowNamed = (p, name) => [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === name);
const toastText = (p) => p.d.getElementById('opstoast').textContent;
const stored = (b, name) => Object.values(b.fake.get('marketing_offers/tb')).filter((r) => r.name === name);
const sheet = (p) => p.host().querySelector('.mk5r-modal');
const detailMenu = async (p) => { p.host().querySelector('.mk5d-more1').click(); await settle(); return [...p.host().querySelectorAll('.mk5d-kebab [role="menuitem"]')]; };
async function openDetail(p, name) {
  p.mods.marketing.clock.now = () => NOW;
  rowNamed(p, name).querySelector('.mk5-lnk').click(); await settle();
}

test('O3 the detail: the name opens it — «Marketing» back, h1, the status · «Oferta» · horario + dates, Editar / Pausar / ⋯; every results block ABSENT; «Ver más» shows «Cómo está armada» only', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  const h = p.host();
  assert.equal(h.querySelector('.mk5-list'), null, 'the detail replaces the list');
  assert.equal(h.querySelector('.mk5d-back').textContent, 'Marketing');
  assert.equal(h.querySelector('h1').textContent, 'Almuerzo');
  assert.equal(h.querySelector('.mk5d-meta').textContent, 'Activa·Oferta·Lun–Vie · 11:00–14:00 · del 16 nov al 6 dic');
  assert.deepEqual([...h.querySelectorAll('.mk5d-acts > .mk5d-btn')].map((x) => x.textContent), ['Editar', 'Pausar']);
  assert.deepEqual((await detailMenu(p)).map((x) => x.textContent), ['Terminar oferta'], '🔴 no «Repetir campaña» on a live offer (SOURCE_GATE repeat-live)');
  for (const sel of ['.mk5d-strip', '.kfigs', '.vcard', '.notyet', '.lim']) assert.equal(h.querySelector(sel), null, `🔴 ${sel} ABSENT (SOURCE_GATE detail-results / tope)`);
  assert.doesNotMatch(p.text(), /trajo|Resultados|Ventas con la oferta|Sucursales/, '🔴 no results words');
  assert.equal(h.querySelector('.mk5d-morebtn').getAttribute('aria-expanded'), 'false');
  h.querySelector('.mk5d-morebtn').click(); await settle();
  assert.deepEqual([...h.querySelectorAll('.mk5d-sec h3')].map((x) => x.textContent), ['Cómo está armada']);
  assert.deepEqual([...h.querySelectorAll('.mk5d-sec .mk5d-r')].map((r) => [r.firstChild.textContent, r.lastChild.textContent]),
    [['Descuento', '15 % · hasta L 100 por pedido'], ['Días y horas', 'Lun–Vie · 11:00–14:00'], ['Fechas', '16 nov – 6 dic 2026'], ['Clientes', 'Todos']]);
  h.querySelector('.mk5d-back').click(); await settle();
  assert.ok(rowNamed(p, 'Almuerzo'), '«Marketing» goes back to the list');
});

test('O3 «Pausar» → the REAL core pauses (v5\'s toast); 5c\'s strip «Pausada por vos» (no date: SOURCE_GATE paused-date) + «Reanudar» → active again', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  p.btn('Pausar').click(); await settle(120);
  assert.equal(toastText(p), 'Oferta pausada. Reanudala cuando querás.');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner', 'the real core stored the pause');
  const h = p.host();
  assert.equal(h.querySelector('.mk5d-meta .mk5-st').textContent, 'Pausada· vos');
  assert.equal(h.querySelector('.mk5d-strip .mk5d-stxt').textContent, 'Pausada por vos hoy', 'the date is 3a\'s paused_at (today ⇒ «hoy», v5\'s row word)');
  assert.equal(p.btn('Pausar'), undefined, 'no «Pausar» while paused');
  p.btn('Reanudar', h.querySelector('.mk5d-strip')).click(); await settle(120);
  assert.equal(toastText(p), 'Oferta activa de nuevo');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'active');
  assert.equal(h.querySelector('.mk5d-strip'), null);
  assert.equal(h.querySelector('.mk5d-meta .mk5-st').textContent, 'Activa');
});

test('O3 «Terminar oferta» (5b): always confirmed — v5\'s title, sentence, «Después» row (no «Lleva»: SOURCE_GATE); «Volver» keeps it; «Terminar oferta» ends it in the REAL core', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Terminar oferta').click(); await settle();
  const m = sheet(p);
  assert.equal(m.querySelector('.mk5r-mt').textContent, '¿Terminar «Almuerzo»?');
  assert.equal(m.querySelector('.mk5r-ms').textContent, 'La oferta deja de mostrarse ahora. Los resultados quedan guardados.');
  assert.deepEqual([...m.querySelectorAll('.mk5d-r')].map((r) => r.textContent), ['DespuésQueda como «Terminada» y podés repetirla cuando querás'], '🔴 no «Lleva» row');
  assert.deepEqual([...m.querySelectorAll('.mk5r-mf button')].map((x) => x.textContent), ['Volver', 'Terminar oferta'], 'the safe default first');
  p.btn('Volver', m).click(); await settle();
  assert.equal(sheet(p), null);
  assert.equal(stored(b, 'Almuerzo')[0].state, 'active', 'nothing written');
  (await detailMenu(p)).find((x) => x.textContent === 'Terminar oferta').click(); await settle();
  p.btn('Terminar oferta', sheet(p)).click(); await settle(120);
  assert.equal(sheet(p), null);
  assert.equal(toastText(p), 'Oferta terminada. Los resultados quedan guardados.');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'ended');
  assert.equal(p.host().querySelector('.mk5d-meta .mk5-st').textContent, 'Terminada');
  assert.deepEqual([...p.host().querySelectorAll('.mk5d-acts > .mk5d-btn')].map((x) => x.textContent), [], 'no Editar / Pausar once ended');
  assert.deepEqual((await detailMenu(p)).map((x) => x.textContent), ['Repetir campaña']);
});

test('O3 «Repetir campaña» on an ended offer: v5\'s sheet (the portal calendar, the same length, the summary) → the REAL repeat → dates → publish; v5\'s toast; the copy is live', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const end = await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  assert.equal(end.status, 200, 'premise: ended by the real core');
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  const m = sheet(p);
  assert.equal(m.querySelector('.mk5r-mt').textContent, 'Repetir «Almuerzo»');
  assert.equal(m.querySelector('.mk5r-ms').textContent, 'Misma oferta, mismos días y horas, mismas sucursales. Solo elegís las fechas nuevas.');
  assert.deepEqual([...m.querySelectorAll('.mk5b-dpbtn .mk5b-dpv')].map((x) => x.textContent), ['lun 16 nov 2026', 'dom 6 dic 2026'], 'from today, the same length');
  assert.equal(m.querySelector('.mk5b-sum').textContent, 'Lun a Vie · 11:00–14:00 · del 16 nov al 6 dic · todos los clientes · 15 % · hasta L 100 por pedido');
  m.querySelectorAll('.mk5b-dpbtn')[1].click(); await settle();
  [...p.host().querySelectorAll('.mk5b-dpop .mk5b-dpd')].find((x) => x.textContent === '20').click(); await settle();   // it opens on Fin's month
  assert.equal(sheet(p).querySelectorAll('.mk5b-dpv')[1].textContent, 'dom 20 dic 2026', 'the calendar moves Fin');
  p.btn('Programar', sheet(p)).click(); await settle(200);
  assert.equal(sheet(p), null);
  assert.equal(toastText(p), 'Campaña programada para el lun 16 nov');
  const all = stored(b, 'Almuerzo');
  assert.equal(all.length, 2, 'the real repeat made ONE copy');
  const copy = all.find((r) => r.state === 'active');
  assert.ok(copy, 'the copy is published');
  assert.equal(copy.schedule.start, NOW + 60000, '«hoy» = now + 1 min');
  assert.deepEqual(copy.schedule.days, [1, 2, 3, 4, 5]);
  assert.equal(copy.schedule.end, Date.UTC(2026, 11, 21, 6) - 1, 'Fin = the end of 20 dic HN');
});

test('O3 the list\'s row moves: «Pausar» in place (v5\'s toast; the row reads «Pausada · vos»); «Terminar» opens 5b over the list; «Repetir» on an ended row opens the repeat sheet', async () => {
  const b = await world();
  await publish(b, LIVE());
  const old = await publish(b, form({ name: 'Viejo', start: NOW }));
  await offerSetStateRaw({ rid: RID, offerId: old.id, to: 'ended', expectedRev: old.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  p.mods.marketing.clock.now = () => NOW;   // the page's clock = the real core's
  p.btn('Acciones', rowNamed(p, 'Almuerzo')).click(); await settle();
  rowNamed(p, 'Almuerzo').querySelector('[data-act="pause"]').click(); await settle(150);
  assert.equal(toastText(p), 'Oferta pausada. Reanudala cuando querás.');
  assert.ok(p.host().querySelector('.mk5-list'), 'still the list');
  assert.equal(rowNamed(p, 'Almuerzo').querySelector('.mk5-st').textContent, 'Pausada· vos');
  assert.equal(rowNamed(p, 'Almuerzo').querySelector('.mk5-st').title, 'Pausada por vos hoy', 'v5\'s row tooltip, dated by 3a\'s paused_at');
  p.btn('Acciones', rowNamed(p, 'Almuerzo')).click(); await settle();
  rowNamed(p, 'Almuerzo').querySelector('[data-act="end"]').click(); await settle();
  assert.equal(sheet(p).querySelector('.mk5r-mt').textContent, '¿Terminar «Almuerzo»?');
  assert.ok(p.host().querySelector('.mk5-list'), 'over the list');
  p.btn('Volver', sheet(p)).click(); await settle();
  assert.equal(sheet(p), null);
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner', 'nothing written');
  p.btn('Acciones', rowNamed(p, 'Viejo')).click(); await settle();
  rowNamed(p, 'Viejo').querySelector('[data-act="repeat"]').click(); await settle();
  assert.equal(sheet(p).querySelector('.mk5r-mt').textContent, 'Repetir «Viejo»');
});

test('O3 a manager (marketing.read only): the detail reads — no Editar, no Pausar, no ⋯, no strip action', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'paused_owner', expectedRev: o.rev, token: b.token });
  const p = await page({ b, caps: MGR_CAPS, uid: MGR });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  assert.equal(p.host().querySelector('h1').textContent, 'Almuerzo');
  for (const sel of ['.mk5d-acts', '.mk5d-kebab', '.mk5d-strip']) assert.equal(p.host().querySelector(sel), null, `${sel}: none for a reader`);
});

// ═══ Codex r1 (0596ebae9..1df9351c0) — every write survives a lost reply, a closed dialog, a rerender ═════════════════════════════
const offersNamed = (b, name) => Object.values(b.fake.get('marketing_offers/tb') || {}).filter((r) => r.name === name);
const LPS = 'L 50 en pedidos desde L 300';
async function toReview(p) { dlg(p).querySelector('.mk5b-go').click(); await settle(); return p.host().querySelector('.mk5r-modal'); }

const OPS_KEY = 'sherpa.portal.mkt.ops';
const opsStored = (p) => { try { return JSON.parse(p.w.sessionStorage.getItem(OPS_KEY) || 'null'); } catch (_) { return null; } };

test('R1 a create whose reply is LOST: UNKNOWN, and the retry REUSES its op_id — 3a\'s idempotent create answers the SAME offer (one, published)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  b.net.lose = ['marketingOfferSave', 'getMarketing'];   // the reply and its re-read: nothing proves it
  p.btn('Programar oferta', sh).click(); await settle(200);
  const s2 = p.host().querySelector('.mk5r-modal');
  assert.equal(s2.querySelector('.mk5b-err').textContent, 'No sabemos si se guardó. Revisá tu lista antes de intentar de nuevo.', 'UNKNOWN, never a guess');
  assert.ok((opsStored(p) || { ops: [] }).ops.some(([, op]) => op.unknown), 'the pending op survives a reload (sessionStorage)');
  assert.equal(p.btn('Programar oferta', s2).disabled, false, 'idempotent server: the retry is safe by construction');
  p.btn('Programar oferta', s2).click(); await settle(220);
  const ids = b.calls.filter((c) => c.fn === 'marketingOfferSave' && c.body.expected_rev === 0).map((c) => c.body.op_id);
  assert.equal(ids.length, 2, 'two create attempts');
  assert.match(String(ids[0]), /^op_/, 'the create carries its op_id');
  assert.equal(ids[1], ids[0], 'the retry REUSES the op_id');
  assert.equal(offersNamed(b, LPS).length, 1, 'ONE offer');
  assert.equal(offersNamed(b, LPS)[0].state, 'active', 'and it is the one published');
  assert.equal(dlg(p), null);
});

test('R1 a lost create retried from a REOPENED dialog with a changed form: the same op_id, the same record — saved with the new form, then published', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = ['marketingOfferSave', 'getMarketing'];
  p.btn('Programar oferta', await toReview(p)).click(); await settle(200);
  const esc = () => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  esc(); await settle(); esc(); await settle();
  assert.equal(dlg(p), null, 'premise: closed');
  await openCard(p, 'lps');
  rowEl(p, 'aud').querySelector('.mk5b-rowh').click(); await settle();
  [...rowEl(p, 'aud').querySelectorAll('.mk5b-oname')].find((x) => x.textContent === 'Clientes nuevos').closest('label, button, .mk5b-opt').click(); await settle();
  p.btn('Programar oferta', await toReview(p)).click(); await settle(250);
  const ids = b.calls.filter((c) => c.fn === 'marketingOfferSave' && c.body.expected_rev === 0).map((c) => c.body.op_id);
  assert.equal(ids[1], ids[0], 'the reopened dialog retries the SAME operation');
  const all = offersNamed(b, LPS);
  assert.equal(all.length, 1, 'ONE offer');
  assert.equal(all[0].audience, 'new', 'the merchant\'s changed form was saved onto it');
  assert.equal(all[0].state, 'active');
});

test('R2 a repeat whose reply is LOST: UNKNOWN; the retry reuses the op_id and 3a answers the SAME copy — one copy, programmed', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  b.net.lose = ['marketingOfferRepeat', 'getMarketing'];
  p.btn('Programar', sheet(p)).click(); await settle(220);
  assert.equal(sheet(p).querySelector('.mk5b-err').textContent, 'No sabemos si se guardó. Revisá tu lista antes de intentar de nuevo.');
  assert.equal(p.btn('Programar', sheet(p)).disabled, false, 'the retry is safe');
  p.btn('Volver', sheet(p)).click(); await settle();
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  p.btn('Programar', sheet(p)).click(); await settle(250);
  const ids = b.calls.filter((c) => c.fn === 'marketingOfferRepeat').map((c) => c.body.op_id);
  assert.equal(ids.length, 2);
  assert.equal(ids[1], ids[0], 'the reopened sheet retries the SAME operation');
  assert.equal(stored(b, 'Almuerzo').length, 2, 'the original + ONE copy');
  assert.equal(stored(b, 'Almuerzo').filter((r) => r.state === 'active').length, 1, 'the copy is programmed');
  assert.equal(toastText(p), 'Campaña programada para el lun 16 nov');
});

test('R3 an edit whose reply is LOST: recovery has what it needs (sent / prev) — «Cambios guardados», never a stuck «busy»', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const capIn = () => rowEl(p, 'caps').querySelectorAll('.mk5b-num')[0];
  capIn().value = '150'; capIn().dispatchEvent(new p.w.Event('change')); await settle();
  b.net.lose = ['marketingOfferSave'];
  p.btn('Guardar cambios', dlg(p)).click(); await settle(200);
  assert.equal(dlg(p), null, 'recovered as saved: the dialog closes');
  assert.equal(toastText(p), 'Cambios guardados');
  assert.equal(stored(b, 'Almuerzo')[0].caps.redemptions, 150);
});

test('R4 a write still in flight when its dialog closes never touches the NEXT dialog (bound to its own opening)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) };
  p.btn('Programar oferta', sh).click(); await settle(40);
  const esc = () => p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  esc(); await settle(); esc(); await settle();
  assert.equal(dlg(p), null, 'premise: A closed mid-write');
  await openCard(p, 'envio');
  release(); await settle(250);
  const d = dlg(p);
  assert.ok(d, 'B is still open');
  assert.equal(d.querySelector('.mk5b-type .mk5b-lbl').textContent, 'Envío gratis', 'B keeps its own offer');
  assert.equal(p.mods['marketing-builder']._builderState.offer, null, 'A\'s reply did not become B\'s offer');
  assert.equal(offersNamed(b, LPS)[0].state, 'draft', 'A stopped at its save: not published behind the merchant\'s back');
  assert.notEqual(toastText(p), 'Oferta programada. Empieza hoy.');
});

test('R6 the end calendar compares DAYS: a draft starting today 12:01 HN may end today', async () => {
  const b = await world();
  await create(b, form({ name: 'Hoy mismo', start: NOW + 60000, end: NOW + 5 * DAY }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  p.mods.marketing.clock.now = () => NOW;
  p.btn('Acciones', rowNamed(p, 'Hoy mismo')).click(); await settle();
  rowNamed(p, 'Hoy mismo').querySelector('[data-act="continue"]').click(); await settle(80);
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  p.host().querySelector('.mk5b-dpbtn[data-dp="end"]').click(); await settle();
  const today = [...p.host().querySelectorAll('.mk5b-dpop .mk5b-dpd')].find((x) => x.querySelector('.mk5b-dnum').textContent === '16');
  assert.equal(today.disabled, false, 'today is a valid end (23:59:59.999 HN is after 12:01)');
  assert.equal([...p.host().querySelectorAll('.mk5b-dpop .mk5b-dpd')].find((x) => x.querySelector('.mk5b-dnum').textContent === '15').disabled, true, 'yesterday is not');
});

test('R5 Editar: «Sin fecha de fin» keeps the offer\'s weekly flag (a server-locked field) — removing the end SAVES through the real core', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  rowEl(p, 'sch').querySelector('.mk5b-tog').click(); await settle();
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  assert.equal(dlg(p), null, 'saved');
  const r = stored(b, 'Almuerzo')[0];
  assert.equal(r.schedule.end ?? null, null, 'the end removed');
  assert.equal(r.caps.weekly, false, 'weekly untouched');
});

test('R7 focus: a rerender keeps it on the same control; a sheet takes it, traps Tab, and gives it back on close', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const hdr = rowEl(p, 'aud').querySelector('.mk5b-rowh');
  hdr.focus(); hdr.click(); await settle();
  assert.equal(p.d.activeElement.closest('.mk5b-row') && p.d.activeElement.closest('.mk5b-row').dataset.row, 'aud', 'still on «Clientes» after the rerender (not BODY)');
  const go = dlg(p).querySelector('.mk5b-go');
  go.focus(); go.click(); await settle();
  const m = p.host().querySelector('.mk5r-modal');
  assert.ok(m.contains(p.d.activeElement), 'the sheet takes focus');
  const f = [...m.querySelectorAll('button:not([disabled])')];
  f[f.length - 1].focus();
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(p.d.activeElement, f[0], 'Tab past the last control wraps to the first (trapped)');
  f[0].focus();
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(p.d.activeElement, f[f.length - 1], 'Shift+Tab wraps back');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.ok(p.d.activeElement.classList.contains('mk5b-go'), 'closing gives focus back to «Revisar y programar»');
});

test('R7 focus on the detail: the end sheet takes focus, traps it, and returns it to «Más acciones» on «Volver»', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  const k = p.host().querySelector('.mk5d-more1'); k.focus(); k.click(); await settle();
  p.host().querySelector('.mk5d-kebab [data-act="end"]').click(); await settle();
  const m = sheet(p);
  assert.ok(m.contains(p.d.activeElement), 'the end sheet takes focus');
  const f = [...m.querySelectorAll('button:not([disabled])')];
  f[f.length - 1].focus();
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(p.d.activeElement, f[0], 'trapped');
  p.btn('Volver', m).click(); await settle();
  assert.ok(p.d.activeElement.classList.contains('mk5d-more1'), 'focus back on «Más acciones»');
});

// ═══ Codex r2 (1df9351c0..d2197fac7) — a known-id UNKNOWN blocks until a read reconciles; a detached sheet lets go of Tab ════════
test('R8 an edit whose reply AND re-read are lost: «Guardar cambios» stays off; the offer stays unsettled until a successful read reconciles it', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const capIn = () => rowEl(p, 'caps').querySelectorAll('.mk5b-num')[0];
  capIn().value = '150'; capIn().dispatchEvent(new p.w.Event('change')); await settle();
  b.net.lose = ['marketingOfferSave', 'getMarketing', 'getMarketing', 'getMarketing'];   // the reply, its re-read, the list's two reads
  p.btn('Guardar cambios', dlg(p)).click(); await settle(250);
  assert.equal(dlg(p).querySelector('.mk5b-err').textContent, 'No sabemos si se guardó. Revisá tu lista antes de intentar de nuevo.');
  assert.ok(dlg(p).querySelector('.mk5b-go').disabled, 'no resubmit before reconciliation');
  const id = stored(b, 'Almuerzo')[0] && Object.keys(b.fake.get('marketing_offers/tb'))[0];
  assert.ok(p.mods['marketing-ops']._opsState.unsettled.has(id), 'the offer is unsettled (survives the dialog)');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  p.btn('Reintentar').click(); await settle(150);
  assert.equal(p.mods['marketing-ops']._opsState.unsettled.has(id), false, 'a successful read reconciled it');
  await openEdit(p, 'Almuerzo');
  assert.equal(capIn().value, '150', 'the editor opens from the reconciled read (the edit had landed)');
  assert.ok(!dlg(p).querySelector('.mk5b-go').disabled);
});

test('R9 a detached detail sheet lets go of Tab (the page lost its host under it)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Terminar oferta').click(); await settle();
  assert.ok(sheet(p), 'premise: the end sheet is open');
  b.net.down = true;
  p.mods['marketing-detail']._detailState.ctx.onChanged(); await settle(120);   // a stale reply's refresh fails: the page redraws its error
  assert.equal(sheet(p), null, 'premise: the sheet left the page');
  const e = new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  p.d.dispatchEvent(e);
  assert.equal(e.defaultPrevented, false, 'Tab is not trapped by a sheet no one can see');
  assert.equal(p.mods['marketing-detail']._detailState.sheet, null, 'the detached sheet is dropped');
});

test('O3 «Pausada por vos el …»: the date is 3a\'s paused_at — an earlier day reads «el 9 nov» on the strip and the row tooltip', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const keep = b.deps.now;
  b.deps.now = () => NOW - 7 * DAY;   // the owner paused it a week ago (Mon 9 nov)
  const r = await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'paused_owner', expectedRev: o.rev, token: b.token });
  b.deps.now = keep;
  assert.equal(r.status, 200, 'premise: paused by the real core');
  const p = await page({ b });
  await p.signIn(); await p.open();
  assert.equal(rowNamed(p, 'Almuerzo').querySelector('.mk5-st').title, 'Pausada por vos el 9 nov', 'the row tooltip');
  await openDetail(p, 'Almuerzo');
  assert.equal(p.host().querySelector('.mk5d-strip .mk5d-stxt').textContent, 'Pausada por vos el 9 nov', 'v5 5c, exact');
});
