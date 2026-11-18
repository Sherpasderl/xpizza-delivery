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
import { execFileSync } from 'node:child_process';
import { DIR, NOW, DAY, OWNER, MGR, RID, K1, K2, K3, backend, form, authored, create, publish, rq } from './marketing-harness.mjs';
import { offerSetStateRaw, offerSaveRaw } from './api.js';
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
    for (const name of ['app', 'ventas', 'shell', 'marketing-builder', 'marketing-detail', 'marketing']) {   // the builder + detail per page too: their state is module-level
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__mkt-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`)
        .replace(/from '\.\/marketing-builder\.js'/g, `from '${url('marketing-builder')}'`)
        .replace(/from '\.\/marketing-detail\.js'/g, `from '${url('marketing-detail')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

// the page over a REAL backend; `cache` seeds the session's last-known switch ('1' | '0' | null = none)
// local: the previous page's localStorage entries (a reload keeps them); noStorage: localStorage throws (blocked / private mode)
async function page({ b, caps = OWNER_CAPS, uid = OWNER, cache = '1', local = null, noStorage = false, setItemFails = false } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (local) for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, v);
  if (noStorage) Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError: storage blocked'); }, configurable: true });
  if (setItemFails) {   // localStorage writes fail (quota); sessionStorage is untouched. On the window's Storage (an instance defineProperty would only store an item)
    const orig = w.Storage.prototype.setItem;
    w.Storage.prototype.setItem = function (k, v) { if (this === w.localStorage) throw new Error('QuotaExceededError'); return orig.call(this, k, v); };
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
  // owner 11-17 (MOCKUP-portal-marketing-unknown): the list's background confirmations run on FAKE timers over a VIRTUAL clock — none fires
  // unless a cell fires it; firing one moves the clock to its due time (Codex #129 P2-4: the cells assert the send times, not the arguments)
  const timers = [], clock = { t: 0 };
  if (mods.marketing._confirmTimers) {
    mods.marketing._confirmTimers.now = () => clock.t;
    mods.marketing._confirmTimers.set = (f, ms) => { const t = { f, ms, at: clock.t + ms, on: true }; timers.push(t); return t; };
    mods.marketing._confirmTimers.clear = (t) => { if (t) t.on = false; };
  }
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
  return { dom, w, d, mods, reg, host, text, btn, signIn, open, timers, clock, navHidden: () => reg().nav.classList.contains('hidden') };
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
  assert.deepEqual(ids, ['summary', 'fresh', 'period', 'ventas', 'repeat-live', 'delete', 'anuncios', 'how-anuncios', 'sherpa-collections', 'detail-results', 'empty-results']);
  assert.deepEqual(p.mods.marketing.NOT_IN_V1.map(([id]) => id), ['caps', 'envio'], 'offers v1 (owner 11-15): no caps, no «Envío gratis» — not gated, ABSENT');
  for (const [id, why] of p.mods.marketing.NOT_IN_V1) assert.ok(typeof why === 'string' && why.length > 20, `${id}: a reason`);
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
  assert.deepEqual([...host.querySelectorAll('.mk5-card')].map((c) => c.dataset.otype), ['pct', 'lps', 'bogo'], 'the v1 offer cards (no «Envío gratis», owner 11-15; no nuevos while the audience flag is off, owner 11-16)');
  assert.equal(host.querySelector('.vh'), null, '🔴 no Anuncio hero (SOURCE_GATE anuncios)');
  const m = await page({ b, caps: MGR_CAPS, uid: MGR });
  await m.signIn(); await m.open();
  assert.deepEqual([...m.host().querySelectorAll('.mk5-tab')].map((t) => t.textContent), ['Campañas'], 'a manager: no «Crear campaña»');
  assert.equal(m.host().querySelectorAll('.mk5-card').length, 0, 'no offer cards');
  assert.equal(m.host().querySelector('.mk5-empty h2').textContent, 'Todavía no tenés campañas');
  assert.equal(m.host().querySelectorAll('.mk5-empty p').length, 0, 'a manager: no «Empezá por acá:» (nothing follows it)');
});

test('«Crear campaña»: the v1 cards verbatim (no «Envío gratis»; no «Para clientes nuevos» while the audience flag is off, owner 11-16), then «¿Cómo funcionan?» with the Ofertas paragraph only; no hero, no eligibility, no Campañas de Sherpa', async () => {
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
    ['bogo', 'rose', '2 × 1', 'Comprá 1 y llevate otro gratis', 'Se muestra con una etiqueta en tu menú']]);
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
    [['br', 'Sucursales'], ['typ', 'Descuento'], ['sch', 'Horario'], ['name', 'Nombre']], 'no Productos row outside 2×1; offers v1: no «Límites» row (owner 11-15), no «Clientes» row (the audience flag, owner 11-16 — its Q3 titles: A2)');
  assert.deepEqual([rowVal(p, 'br'), rowVal(p, 'typ'), rowVal(p, 'name')],
    ['Las 2 sucursales', '15 % · hasta L 100 por pedido', '15 % en todo el menú · se armó solo']);   // «Clientes · Todos»: behind the audience flag (A2)
  assert.match(rowVal(p, 'sch'), /^Todos los días · todo el día · desde el \d+ [a-z]{3}, sin fecha de fin$/, 'defaults: all days, todo el día, start today, no end');
  assert.deepEqual([d.querySelector('.mk5b-pvchip').textContent, d.querySelector('.mk5b-pvoff').textContent], ['15 % menos', '15 % de descuento en todo el menú, hasta L 100']);
  assert.equal(d.querySelector('.mk5b-pvhd b').textContent, 'Tercera', 'the brand name (E1)');
  assert.equal(d.querySelector('.mk5b-pvmeta').textContent, '2 sucursales', '🔴 no «25–35 min · Envío L 40» (gated)');
  assert.equal(d.querySelector('.mk5b-fine').textContent, 'El descuento lo cubre tu restaurante. Sherpa no te cobra. Hasta L 100 por canje.');
  assert.ok(!d.querySelector('.mk5b-go').disabled && !d.querySelector('.mk5b-block'), 'a valid form: «Revisar y programar» enabled, no block line');
  const text = d.textContent;
  assert.ok(!/condiciones de marketing|se pausa sola|te avisamos|Más pedido|25–35 min|Envío L 40|Mínimo de compra/.test(text), '🔴 Q4 / Q6 / gated words absent (pct has no minimum)');
  rowEl(p, 'br').querySelector('.mk5b-rowh').click(); await settle();
  assert.ok(rowEl(p, 'br').classList.contains('mk5b-open'), 'premise: «Sucursales» open');
  rowEl(p, 'sch').querySelector('.mk5b-rowh').click(); await settle();
  assert.equal(rowEl(p, 'br').classList.contains('mk5b-open'), false, 'one row open at a time');
  assert.ok(rowEl(p, 'sch').classList.contains('mk5b-open'));
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
  assert.deepEqual([...sheet.querySelectorAll('.mk5r-row')].map((r) => [r.querySelector('.mk5r-sl').textContent, r.querySelector('.mk5r-sv').textContent]).slice(0, 3),
    [['Oferta', 'Lempiras de descuento con mínimo · L 50 · mínimo L 300'], ['Sucursales', 'Las 2'], ['Horario', rowVal(p, 'sch')]]);   // no «Clientes» line: the audience flag (owner 11-16)
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
  await openCard(p, 'lps');
  p.btn('Guardar borrador', dlg(p)).click(); await settle(120);
  assert.equal(p.d.getElementById('opstoast').textContent, 'Borrador guardado');
  const row = [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === 'L 50 en pedidos desde L 300');
  assert.equal(row.querySelector('.mk5-st').textContent, 'Borrador');
  p.btn('Acciones', row).click(); await settle();
  p.btn('Seguir editando', row).click(); await settle(60);
  assert.equal(dlg(p).querySelector('h2').textContent, 'Seguir editando');
  assert.equal(rowVal(p, 'name'), 'L 50 en pedidos desde L 300', 'its own name, not «se armó solo»');
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
// open a setting row only if it is closed (the editor opens on «Horario»; a click on an open header closes it)
async function openRow(p, id) { if (!rowEl(p, id).classList.contains('mk5b-open')) { rowEl(p, id).querySelector('.mk5b-rowh').click(); await settle(); } }
test('Editar on a running offer: v5\'s dialog minus «Límites» (offers v1) — the derived lede, the locked rows (lock, «fijo mientras está activa»), Horario open and editable', async () => {
  const b = await world();
  await publish(b, form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * 86400000, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const d = dlg(p);
  assert.equal(d.querySelector('h2').textContent, 'Editar oferta activa');
  assert.equal(d.querySelector('.mk5b-lede').textContent, 'Mientras está activa podés cambiar el horario. Lo demás queda fijo, para que ningún cliente vea una oferta distinta de la que le prometimos.', 'the advisor\'s derived lede (11-15, from the owner\'s no-caps decision)');
  assert.equal(d.querySelector('.mk5b-type .mk5b-lbl').textContent, 'Almuerzo');
  const locked = [...d.querySelectorAll('.mk5b-lock')].map((r) => [r.dataset.row, r.querySelector('.mk5b-val').textContent, r.querySelector('.mk5b-rowh').getAttribute('aria-label')]);
  assert.deepEqual(locked.map((x) => x[0]), ['br', 'typ', 'aud'], 'Sucursales · Descuento · Clientes locked');
  assert.equal(locked[1][1], '15 % · hasta L 100 por pedido · fijo mientras está activa');
  assert.equal(locked[0][2], 'Sucursales, fijo mientras está activa');
  assert.equal(d.querySelectorAll('.mk5b-lock button').length, 0, 'a locked row does not expand');
  assert.equal(rowEl(p, 'caps'), null, 'no «Límites» row (offers v1)');
  assert.deepEqual([...d.querySelectorAll('.mk5b-row:not(.mk5b-lock)')].map((r) => r.dataset.row), ['sch'], 'the one editable row: Horario');
  assert.ok(rowEl(p, 'sch').classList.contains('mk5b-open'), 'Horario opens first');
  assert.ok([...rowEl(p, 'sch').querySelectorAll('.mk5b-chip')].every((c) => !c.disabled), 'days + franja editable (ruling (a))');
  assert.match(rowEl(p, 'sch').querySelector('.mk5b-ro').textContent, /^Empezó el\d+ nov 2026$/, 'Inicio read-only');
  assert.deepEqual([...d.querySelectorAll('.mk5b-foot .mk5b-fine')].map((x) => x.textContent), ['Para cambiar el descuento, los clientes o las sucursales, terminá esta oferta y creá una nueva (o usá Repetir).', 'Los cambios aplican de inmediato en la app.']);
});

test('Editar: a live day change saves through the REAL core («Cambios guardados»), and the write carries NO caps (offers v1)', async () => {
  const b = await world();
  await publish(b, form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * 86400000, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await openRow(p, 'sch');
  [...rowEl(p, 'sch').querySelectorAll('.mk5b-chip')].find((c) => c.textContent.endsWith('Sáb')).click(); await settle();
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  assert.equal(dlg(p), null, 'the real core SAVES a live day change: the dialog closes');
  assert.equal(p.d.getElementById('opstoast').textContent, 'Cambios guardados');
  const after = Object.values(b.fake.get('marketing_brand/tb/offers')).find((r) => r.name === 'Almuerzo');
  assert.deepEqual([...after.schedule.days].sort(), [1, 2, 3, 4, 5, 6], 'the real core stored the new day');
  assert.equal('caps' in saves(b).at(-1).body.offer, false, 'no caps key on the wire');
});

// ═══ O3 · the detail (v5 5 / 5b / 5c) + the state moves + «Repetir» — every write through 3a's REAL cores ══════════════════════
const LIVE = () => form({ name: 'Almuerzo', pct: 15, max: '100', start: NOW, end: NOW + 20 * DAY, days: [1, 2, 3, 4, 5], window: { from: 660, to: 840 } });
const rowNamed = (p, name) => [...p.host().querySelectorAll('.mk5-row')].find((r) => r.querySelector('.mk5-lnk').textContent === name);
const toastText = (p) => p.d.getElementById('opstoast').textContent;
const stored = (b, name) => Object.values(b.fake.get('marketing_brand/tb/offers')).filter((r) => r.name === name);
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
const offersNamed = (b, name) => Object.values(b.fake.get('marketing_brand/tb/offers') || {}).filter((r) => r.name === name);
const LPS = 'L 50 en pedidos desde L 300';
async function toReview(p) { dlg(p).querySelector('.mk5b-go').click(); await settle(); return p.host().querySelector('.mk5r-modal'); }

const localOf = (p) => Object.fromEntries(Object.keys(p.w.localStorage).map((k) => [k, p.w.localStorage.getItem(k)]));

const saves = (b) => b.calls.filter((c) => c.fn === 'marketingOfferSave');
test('R13 programming an offer IDENTICAL to one already live: 409 duplicate ⇒ the existing offer opens — never an error, never a second offer', async () => {
  const b = await world();
  const p0 = await page({ b });
  await p0.signIn(); await p0.open();
  await openCard(p0, 'lps');
  p0.btn('Programar oferta', await toReview(p0)).click(); await settle(220);
  assert.equal(offersNamed(b, LPS).length, 1, 'premise: one live');
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  assert.equal(offersNamed(b, LPS).length, 1, 'still ONE');
  assert.equal(dlg(p), null, 'the builder closed');
  assert.equal(p.host().querySelector('.mk5d-head h1').textContent, LPS, 'the EXISTING offer\'s detail');
  assert.equal(p.host().querySelector('.mk5b-err'), null, 'no error');
});

test('R14 storage blocked: a lost reply is confirmed ONCE under the same op_id (owner 11-15); a reload mints another op_id — the server\'s 409 duplicate keeps it to ONE live offer', async () => {
  const b = await world();
  let p = await page({ b, noStorage: true });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = ['marketingOfferSave', 'getMarketing'];
  p.btn('Programar oferta', await toReview(p)).click(); await settle(200);
  p = await page({ b, noStorage: true });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 3, 'the call + its ONE confirmation, then the reloaded page\'s call');
  assert.equal(ops[1], ops[0], 'the confirmation: the SAME op_id');
  assert.notEqual(ops[2], ops[0], 'no storage: the reload could not keep the op_id');
  assert.equal(offersNamed(b, LPS).filter((r) => r.state === 'active').length, 1, 'ONE live offer (the backstop)');
  assert.ok(p.host().querySelector('.mk5d-head'), 'the existing offer is shown');
});

test('R4 a write still in flight when its dialog closes never touches the NEXT dialog (bound to its own opening)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) };
  p.btn('Guardar cambios', dlg(p)).click(); await settle(40);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(dlg(p), null, 'premise: A closed mid-write');
  await openCard(p, 'bogo');
  release(); await settle(250);
  const d = dlg(p);
  assert.ok(d, 'B is still open');
  assert.equal(d.querySelector('.mk5b-type .mk5b-lbl').textContent, 'Comprá 1 y llevate otro gratis', 'B keeps its own offer');
  assert.equal(p.mods['marketing-builder']._builderState.offer, null, 'A\'s reply did not become B\'s offer');
  assert.equal(stored(b, 'Almuerzo')[0].schedule.end ?? null, null, 'A\'s write landed on the server');
  assert.notEqual(toastText(p), 'Cambios guardados', 'no toast for a closed dialog');
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

test('R5 Editar: «Sin fecha de fin» — removing the end SAVES through the real core, with no caps on the wire (offers v1)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  assert.equal(dlg(p), null, 'saved');
  const r = stored(b, 'Almuerzo')[0];
  assert.equal(r.schedule.end ?? null, null, 'the end removed');
  assert.equal('caps' in saves(b).at(-1).body.offer, false, 'no caps key on the wire');
});

test('R7 focus: a rerender keeps it on the same control; a sheet takes it, traps Tab, and gives it back on close', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const hdr = rowEl(p, 'br').querySelector('.mk5b-rowh');
  hdr.focus(); hdr.click(); await settle();
  assert.equal(p.d.activeElement.closest('.mk5b-row') && p.d.activeElement.closest('.mk5b-row').dataset.row, 'br', 'still on «Sucursales» after the rerender (not BODY)');
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

// ═══ r6.1 (owner 11-15 «the simple approach»; Codex r6 REVISE #1 closed by simplifying) — an UNKNOWN outcome: the list decides ═══
// Every ambiguous write (a drop, a lost reply, a 5xx, a thrown call) closes its dialog / sheet / detail, re-reads «Campañas» and says
// ML.UNKNOWN_WORD. No client recovery read, no stored operation, a NEW op_id per click, the newest list request wins.
const notice = (p) => p.host().querySelector('[data-notice="unknown"]');
// owner 11-17 (MOCKUP-portal-marketing-unknown, approved as recommended): after the two ambiguous answers the LIST keeps confirming the
// SAME op_id (U1 «Confirmando»), and only the server's answer under that op_id settles it: U2 landed · U3/U3b not landed · U4 can't tell (+ U4b)
const CONFIRMING = 'La conexión tardó. Estamos confirmando que se guardó.';
const CANT = 'Todavía no pudimos confirmar tu cambio. Revisá la oferta en la lista en unos minutos antes de repetirlo.';
const NOT_SAVED = 'No se guardó el cambio. Podés intentarlo de nuevo.';
const noticeWord = (p) => { const n = notice(p); const sp = n && n.querySelector('.mk5-ncol > span'); return sp ? sp.textContent : null; };
const reconf = (p) => { const n = notice(p); return n ? n.querySelector('button.mk5-reconf') : null; };
const pending = (p) => p.timers.filter((t) => t.on);
const reads = (b, from) => b.calls.slice(from).filter((c) => c.fn === 'getMarketing');
async function dropEnd(p) {   // an allowed live edit: «Sin fecha de fin»
  await openRow(p, 'sch');
  rowEl(p, 'sch').querySelector('.mk5b-tog').click(); await settle();
}
test('U1 an edit whose outcome is ambiguous TWICE — the call and its one confirmation (it never reached the server — the client can\'t tell; a CAS may still commit) ⇒ UNKNOWN: the dialog closes, «Campañas» re-reads, the banner — never «No pudimos guardar»', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  b.net.drop = ['marketingOfferSave', 'marketingOfferSave'];
  p.btn('Guardar cambios', dlg(p)).click(); await settle(250);
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev, 'premise: nothing landed (yet)');
  assert.equal(dlg(p), null, 'the dialog closed');
  assert.equal(noticeWord(p), CONFIRMING, 'U1 (owner 11-17): the list keeps confirming — «Confirmando», never a guess');
  assert.deepEqual(pending(p).map((t) => t.ms), [3000], 'the first background confirmation, +3 s');
  assert.ok(!p.text().includes('No pudimos guardar'), 'never «No pudimos guardar» (unchanged rev ≠ not landed)');
  assert.notEqual(toastText(p), 'Cambios guardados');
  assert.ok(rowNamed(p, 'Almuerzo'), 'the list, re-read: the offer as the server has it');
});
test('U2 an edit whose reply AND its confirmation\'s reply are lost after it landed ⇒ UNKNOWN, never success: NO recovery read — the only reads are the list\'s own', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  b.net.lose = ['marketingOfferSave', 'marketingOfferSave'];
  const from = b.calls.length;
  p.btn('Guardar cambios', dlg(p)).click(); await settle(250);
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1, 'premise: it landed on the server');
  assert.notEqual(toastText(p), 'Cambios guardados', 'matching content is never taken as success');
  assert.equal(noticeWord(p), CONFIRMING);
  const after = b.calls.slice(from);
  assert.equal(after[0].fn, 'marketingOfferSave', 'premise: the write first');
  assert.equal(reads(b, from).length, 2, 'exactly the list\'s two branch reads — zero recovery reads between the writes and the navigation');
  assert.equal(after[1].fn, 'marketingOfferSave', 'then its ONE confirmation');
  assert.equal(after[1].body.op_id, after[0].body.op_id, 'the SAME op_id');
  assert.ok(after.slice(2).every((c) => c.fn !== 'marketingOfferSave'), 'never a third send');
});
test('U3 the newest list request wins: an OLDER answer that arrives after a newer one is dropped; no cached row paints while an UNKNOWN is pending, nor under a failed read', async () => {
  const b = await world();
  const sur = authored(form({ name: 'En Sur', branches: ['tb_sur'] }));
  assert.equal((await offerSaveRaw({ rid: 'tb_sur', expectedRev: 0, offer: sur, token: b.token })).status, 200, 'premise: one offer on Sur (the list is not empty, the filters show)');
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(dlg(p), null, 'premise: closed');
  p.btn('Campañas').click(); await settle();
  const reload = () => p.mods['marketing-builder']._builderState.ctx.onChanged();   // the list's own refresh (a write's onChanged)
  let release; b.net.hold = { fn: 'getMarketing', until: new Promise((r) => { release = r; }) };
  reload(); await settle(40);                                                // request 1: its first branch answer computed NOW, then held
  await create(b, form({ name: 'Recién creada' }));
  reload(); await settle(150);                                               // request 2: newer, answers first
  assert.ok(rowNamed(p, 'Recién creada'), 'premise: the newer answer painted');
  release(); await settle(150);                                              // the OLDER answer (without it) lands last
  assert.ok(rowNamed(p, 'Recién creada'), 'the older answer was dropped — the rows are the newer ones');
  // an UNKNOWN: nothing cached paints while its re-read is pending
  const b2 = await world();
  await publish(b2, LIVE());
  const q = await page({ b: b2 });
  await q.signIn(); await q.open();
  await openEdit(q, 'Almuerzo');
  await dropEnd(q);
  let go; b2.net.lose = ['marketingOfferSave', 'marketingOfferSave']; b2.net.hold = { fn: 'getMarketing', until: new Promise((r) => { go = r; }) };
  q.btn('Guardar cambios', dlg(q)).click(); await settle(150);
  assert.equal(dlg(q), null, 'the dialog closed');
  assert.equal(q.host().querySelectorAll('.mk5-row').length, 0, 'no cached row while the UNKNOWN\'s read is pending');
  assert.equal(noticeWord(q), CONFIRMING);
  go(); await settle(150);
  assert.ok(rowNamed(q, 'Almuerzo'), 'the fresh read paints');
  // … and a failed read paints the error box, never the old rows
  await openEdit(q, 'Almuerzo');
  await dropEnd(q);
  b2.net.lose = ['marketingOfferSave', 'marketingOfferSave', 'getMarketing'];
  q.btn('Guardar cambios', dlg(q)).click(); await settle(250);
  assert.equal(q.host().querySelectorAll('.mk5-row').length, 0, 'a failed read: no old rows under the error');
  assert.ok(q.btn('Reintentar'), 'the error box');
  assert.equal(noticeWord(q), CONFIRMING);
});
test('U4 two distinct «Programar oferta» submissions ⇒ two distinct op_ids; an UNCONFIRMED one (both calls ambiguous) ⇒ the list (nothing stored), the next click mints a NEW op_id', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.drop = ['marketingOfferSave', 'marketingOfferSave'];   // the call AND its one confirmation never reach the server
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  assert.equal(dlg(p), null, 'the dialog closed');
  assert.equal(noticeWord(p), CONFIRMING);
  assert.equal(pending(p).length, 1, 'premise: the page holds the attempt (a confirmation scheduled)');
  assert.deepEqual(Object.keys(localOf(p)).filter((k) => /^sherpa\.(op|unsettled)\./.test(k)), [], 'no operation is stored');
  await openCard(p, 'lps');
  assert.equal(p.host().querySelector('.mk5r-modal'), null, 'a fresh dialog — no frozen review');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(250);
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 3, 'the first submission + its one confirmation, then the second submission');
  assert.ok(ops.every((x) => /^op_[A-Za-z0-9_-]{12,}$/.test(x)), 'each carries an op_id');
  assert.equal(ops[1], ops[0], 'the confirmation re-sends the SAME op_id');
  assert.notEqual(ops[2], ops[0], 'two submissions ⇒ two op_ids');
  assert.equal(pending(p).length, 0, 'a NEW write cancels the held attempt: its confirmation can never land it beside the new one');
  assert.equal(offersNamed(b, LPS).filter((r) => r.state === 'active').length, 1, 'ONE live offer');
});
test('U5 op_id_conflict is a CLIENT bug (advisor 11-15): never a refusal word — the fallback at once, NO confirmation; the next click mints a fresh op_id', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  // 3a answers op_id_conflict when an op_id is reused for ANOTHER kind of operation: a «Repetir» first, then a create, same op_id
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'fixed-op-id-0001', configurable: true, writable: true });
  try {
    await openDetail(p, 'Almuerzo');
    (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
    p.btn('Programar', sheet(p)).click(); await settle(250);
    assert.equal(stored(b, 'Almuerzo').filter((r) => r.state === 'active').length, 1, 'premise: the repeat programmed, under op_fixed-op-id-0001');
    p.host().querySelector('.mk5d-back').click(); await settle();
    await openCard(p, 'lps');
    const n0 = saves(b).length;
    p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
    assert.equal(saves(b).length, n0 + 1, 'U5: ONE call — a conflict is never confirmed');
    assert.equal(dlg(p), null, 'U5: the dialog closed');
    assert.equal(noticeWord(p), CANT, 'U5: the fallback at once (U4), never a refusal word');
    assert.equal(reconf(p), null, 'U5: no «Volver a confirmar» — a conflict is never re-sent');
    assert.equal(pending(p).length, 0, 'U5: nothing scheduled');
  } finally { delete globalThis.crypto.randomUUID; }
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(250);
  const last = saves(b).slice(-2).map((c) => c.body.op_id);
  assert.notEqual(last[1], last[0], 'the next click: a fresh op_id');
  assert.equal(offersNamed(b, LPS).filter((r) => r.state === 'active').length, 1, 'programmed');
});
test('U6 «Pausar» from the detail, its outcome UNKNOWN twice (the call + its one confirmation) ⇒ the detail closes, «Campañas» re-reads, the banner', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  b.net.lose = ['marketingOfferSetState', 'marketingOfferSetState'];
  p.btn('Pausar').click(); await settle(250);
  assert.equal(p.host().querySelector('.mk5d-head'), null, 'the detail closed');
  assert.equal(noticeWord(p), CONFIRMING);
  assert.ok(rowNamed(p, 'Almuerzo'), 'the list, re-read');
  assert.ok(!p.text().includes('No pudimos hacer el cambio'), 'never a failure word');
});

// ═══ offers v1 (owner 11-15): NO caps, NO «Envío gratis» — 3a 94e6b7ae9 refuses both; the portal never offers or sends them ═══════
const CAP_WORDS = /Límites|[Tt]ope|canjes/;
test('V1-i no write ever carries `caps`: «Programar oferta», «Guardar borrador», «Guardar cambios» and «Repetir» — through the REAL v1 core', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  await publish(b, form({ name: 'Viva', pct: 30, start: NOW, end: NOW + 20 * DAY, days: [6], window: null }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  const from = b.calls.length;   // the page's writes only (the set-up's own saves come before)
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(250);
  await openCard(p, 'pct');
  p.btn('Guardar borrador', dlg(p)).click(); await settle(150);
  await openEdit(p, 'Viva');
  await dropEnd(p);
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  p.btn('Programar', sheet(p)).click(); await settle(250);
  const writes = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSave' || c.fn === 'marketingOfferRepeat');
  assert.equal(writes.length, 4, 'premise: four writes from the page');
  for (const w of writes) {
    assert.equal(JSON.stringify(w.body).includes('"caps"'), false, `${w.fn}: no caps anywhere in the body`);
  }
  assert.equal(toastText(p), 'Campaña programada para el lun 16 nov', 'premise: the last one (the repeat) landed');
  assert.ok(stored(b, 'Viva')[0].schedule.end == null, 'premise: the edit landed');
});
test('V1-ii no cap copy anywhere: no «Límites», «tope» or «canjes» in the cards, the builder of each v1 type, its review, the editor, the list or the detail', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  assert.ok(!CAP_WORDS.test(p.text()), 'the list');
  for (const t of ML.offerTypesShown()) {   // the types v1 offers (nuevos behind the audience flag, owner 11-16)
    await openCard(p, t);
    assert.ok(!CAP_WORDS.test(p.text()), `the cards + the builder (${t})`);
    assert.equal(rowEl(p, 'caps'), null, `${t}: no «Límites» row`);
    dlg(p).querySelector('.mk5b-go').click(); await settle();
    if (p.host().querySelector('.mk5r-modal')) assert.ok(!CAP_WORDS.test(p.host().querySelector('.mk5r-modal').textContent), `${t}: the review`);
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    assert.equal(dlg(p), null, `premise: ${t} closed`);
  }
  p.btn('Campañas').click(); await settle();
  await openEdit(p, 'Almuerzo');
  assert.ok(!CAP_WORDS.test(dlg(p).textContent), 'the editor');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  await openDetail(p, 'Almuerzo');
  const vm = p.btn('Ver más'); if (vm) { vm.click(); await settle(); }
  assert.ok(!CAP_WORDS.test(p.text()), 'the detail (+ «Ver más»)');
});
test('V1-iii the v1 refusals are DEFINITE and generic: the REAL core\'s 400 caps_not_supported and 400 type_not_supported ⇒ «No pudimos guardar la oferta…»', async () => {
  const b = await world();
  const p = await page({ b });
  const offer = authored(form({ name: 'Con tope' }));
  const capped = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: { ...offer, caps: { redemptions: 50, spend_cents: null, weekly: false } }, token: b.token });
  const envio = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: { ...offer, name: 'Envío', type: 'envio', params: {} }, token: b.token });
  for (const [res, reason] of [[capped, 'caps_not_supported'], [envio, 'type_not_supported']]) {
    const c = ML.classifyWrite({ op: 'create' }, res);
    assert.deepEqual([c.outcome, c.status, c.reason], ['refused', 400, reason], `premise: the real core refuses (${reason})`);
    assert.equal(p.mods['marketing-builder'].wordOf(c), 'No pudimos guardar la oferta. Revisá los datos e intentá de nuevo.', `${reason}: the generic word`);
  }
  assert.equal(Object.keys(b.fake.get('marketing_brand/tb/offers') || {}).length, 0, 'nothing was written');
});
test('V1-iv an OLD record that still carries caps (pre-v1) edits CAPS-LESS: «Guardar cambios» saves through the REAL v1 core, with no caps on the wire', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  // the pre-v1 shape the old writer stored (3a e3c5f7366 capsOf: { redemptions, spend_cents, weekly }) — planted, as no v1 writer can make it
  b.fake.put(`marketing_brand/tb/offers/${o.id}/caps`, { redemptions: 100, spend_cents: 300000, weekly: false });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  assert.ok(!CAP_WORDS.test(dlg(p).textContent), 'its caps are never shown');
  await dropEnd(p);
  p.btn('Guardar cambios', dlg(p)).click(); await settle(150);
  assert.equal(dlg(p), null, 'saved: the dialog closes');
  assert.equal(toastText(p), 'Cambios guardados');
  assert.equal('caps' in saves(b).at(-1).body.offer, false, 'no caps key on the wire');
  assert.equal(stored(b, 'Almuerzo')[0].schedule.end ?? null, null, 'the edit landed');
});
test('V1-v no «Envío gratis» option renders: no card, no text on «Crear campaña» or the empty state; the builder refuses to open as envío', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  assert.equal(p.host().querySelector('.mk5-card[data-otype="envio"]'), null, 'the empty state: no envío card');
  assert.ok(!/Envío gratis/.test(p.text()), 'the empty state: no «Envío gratis»');
  p.btn('Crear campaña').click(); await settle();
  assert.equal(p.host().querySelector('.mk5-card[data-otype="envio"]'), null, '«Crear campaña»: no envío card');
  assert.ok(!/Envío gratis|Tu restaurante aparece con/.test(p.text()), '«Crear campaña»: no envío copy');
  p.mods['marketing-builder'].openBuilder(p.host(), { branches: [{ rid: RID, name: 'Centro', address: null }], brandId: 'tb', token: b.token, toast: () => {}, now: () => NOW }, { type: 'envio' });
  assert.equal(dlg(p), null, 'openBuilder({ type: envio }) opens nothing');
});
// the 2×2 grid (advisor (A), 11-15): ONE rule moved, scoped to the offer-card grid; every other card / grid rule is byte-identical
test('V1-vi the 2×2 card grid is SCOPED: only the two .mk5-card grid-column rules (+ the card title\'s line-height, 16b advisor 11-16) changed vs 89120edb2, every other .mk5-card / .mk5-ogrid rule is untouched', () => {
  const rules = (css) => css.split('\n').map((l) => l.trim()).filter((l) => /\.mk5-(card|ogrid)\b/.test(l));
  const before = rules(execFileSync('git', ['show', '89120edb2:xpizza-portal/styles.css'], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 }));
  const after = rules(readFileSync(join(DIR, 'styles.css'), 'utf8'));
  const gone = before.filter((l) => !after.includes(l)), added = after.filter((l) => !before.includes(l));
  assert.deepEqual(gone, ['.mk5-card:nth-child(1),.mk5-card:nth-child(2){grid-column:span 3}', '.mk5-card h3{font-family:var(--disp);font-size:21px;font-weight:800;letter-spacing:-.03em;line-height:1.15;margin-top:6px;text-wrap:balance}', '.mk5-card,.mk5-card:nth-child(1),.mk5-card:nth-child(2){grid-column:auto;padding:20px 18px}']);
  assert.deepEqual(added, ['.mk5-ogrid>.mk5-card{grid-column:span 3}', '.mk5-card h3{font-family:var(--disp);font-size:21px;font-weight:800;letter-spacing:-.03em;line-height:1.22;margin-top:6px;text-wrap:balance}', '.mk5-card,.mk5-ogrid>.mk5-card{grid-column:auto;padding:20px 18px}']);   // 16b: the 2-line title at 390 was «tight» (1.15 < 1.2)
  assert.ok(after.includes('.mk5-ogrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:18px;margin-top:22px}'), 'the 6-column grid itself unchanged');
});

// ═══ owner 11-17 (MOCKUP-portal-marketing-unknown, APPROVED as recommended): the list keeps confirming the SAME op_id ═══════════════
// After the call and its one confirmation are both ambiguous, «Campañas» re-sends the SAME request in the background at +3 s, +10 s, +30 s
// (fake timers here); only an answer the server gives under that op_id settles it — U2 landed (the dialog's own success word), U3 not
// landed with the refusal's own sentence / U3b the generic line (neutral), U4 still can't tell + U4b «Volver a confirmar» (ONE same-op_id
// try) while the page holds the attempt. The list's content never settles anything. Leaving the page, another account or a NEW write cancels.
async function fire(p, ms = 300) {   // → the virtual time the timer was due at
  const t = p.timers.find((x) => x.on);
  assert.ok(t, 'premise: a background confirmation is scheduled');
  t.on = false; p.clock.t = Math.max(p.clock.t, t.at); t.f(); await settle(ms);
  return t.at;
}
async function unconfirmedCreate(p, b, net) {   // «Programar oferta» on the «Lempiras» card, its call + one confirmation ambiguous per `net`
  await openCard(p, 'lps');
  Object.assign(b.net, net);
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  assert.equal(dlg(p), null, 'premise: the dialog closed');
  assert.equal(noticeWord(p), CONFIRMING, 'premise: U1 «Confirmando»');
}
test('S1 U1→U2 LANDED: the call landed, both replies lost; the +3 s re-send (the SAME op_id) gets the replay ⇒ the dialog\'s own success toast, the notice goes, ONE offer', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { lose: ['marketingOfferSave', 'marketingOfferSave'] });
  assert.equal(offersNamed(b, LPS).length, 1, 'premise: it landed on the server');
  assert.equal(reconf(p), null, 'U1: no button while confirming');
  assert.equal(await fire(p), 3000, 'the first re-send, due +3 s after the handoff');
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 3, 'the call, its confirmation, ONE background re-send');
  assert.deepEqual([...new Set(ops)], [ops[0]], 'S1: every re-send carries the SAME op_id');
  assert.equal(notice(p), null, 'S1: landed ⇒ the notice goes');
  assert.match(toastText(p), /^Oferta programada\. Empieza /, 'S1: the same toast as a direct success (U2 = 3e)');
  assert.equal(offersNamed(b, LPS).length, 1, 'S1: ONE offer — the claim replayed it');
  assert.equal(pending(p).length, 0, 'settled: nothing more scheduled');
});
test('S2 U1→U3 NOT LANDED, with the refusal\'s own sentence: the first call was JUDGED (too_many_live, stored in its claim), both replies lost ⇒ the re-send replays the judgement ⇒ «No se guardó la oferta.» + the dialog\'s sentence, NEUTRAL', async () => {
  const b = await world();
  for (let i = 0; i < 10; i += 1) await publish(b, form({ name: `Viva ${i}`, pct: 10 * (1 + (i % 5)), start: NOW, end: NOW + 20 * DAY, days: [i < 5 ? 6 : 0], window: null }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { lose: ['marketingOfferSave', 'marketingOfferSave'] });
  await fire(p);
  assert.equal(noticeWord(p), 'No se guardó la oferta. Ya tenés el máximo de ofertas activas en una sucursal. Terminá una para programar esta.', 'S2: U3, the refusal\'s own sentence (Q3)');
  const n = notice(p);
  assert.ok(n.classList.contains('mk5-notice') && !n.classList.contains('mk5b-err'), 'S2: the NEUTRAL callout (owner Q3), never the error style');
  assert.equal(reconf(p), null, 'S2: settled — no button');
  assert.equal(pending(p).length, 0, 'settled: nothing more scheduled');
  assert.equal(offersNamed(b, LPS).length, 0, 'S2: nothing was saved');
});
test('S3 U1→U3b NOT LANDED, no specific reason: «Pausar» never reached the server (both dropped); another session ENDED the offer meanwhile ⇒ the re-send is refused under the op_id ⇒ «No se guardó el cambio. Podés intentarlo de nuevo.»', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  b.net.drop = ['marketingOfferSetState', 'marketingOfferSetState'];
  p.btn('Pausar').click(); await settle(250);
  assert.equal(noticeWord(p), CONFIRMING, 'premise: U1');
  assert.equal((await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token })).status, 200, 'premise: another session ended it');
  await fire(p);
  assert.equal(noticeWord(p), NOT_SAVED, 'S3: U3b, the generic line');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'ended', 'nothing of ours landed');
  assert.equal(pending(p).length, 0);
});
test('S4 U1→U4→U4b CAN\'T TELL: +3 s, +10 s, +30 s all ambiguous ⇒ the fallback + «Volver a confirmar»; NOTHING more scheduled; the button re-sends the SAME op_id ONCE and lands it', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: Array(5).fill('marketingOfferSave') });
  const at = [];
  for (let i = 0; i < 3; i += 1) { at.push(await fire(p)); if (i < 2) assert.equal(noticeWord(p), CONFIRMING, `still confirming after try ${i + 1}`); }
  assert.deepEqual(at, [3000, 10000, 30000], 'S4: the schedule — due +3 / +10 / +30 s from the handoff (the clock started at 0), then stop');
  assert.equal(noticeWord(p), CANT, 'S4: U4, the approved fallback line');
  assert.equal(pending(p).length, 0, 'S4: stopped — nothing more scheduled');
  const btn = reconf(p);
  assert.ok(btn && btn.textContent === 'Volver a confirmar', 'S4: U4b, the text button');
  assert.equal(saves(b).length, 5, 'premise: the call, its confirmation, three re-sends — all dropped');
  assert.equal(offersNamed(b, LPS).length, 0, 'premise: nothing landed');
  btn.click(); await settle(300);
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 6, 'S4: the button sends ONE more');
  assert.deepEqual([...new Set(ops)], [ops[0]], 'S4: the button re-sends the SAME op_id — never a fresh one');
  assert.equal(offersNamed(b, LPS).length, 1, 'S4: landed exactly once');
  assert.equal(notice(p), null, 'S4: settled ⇒ the notice goes');
  assert.match(toastText(p), /^Oferta programada\. Empieza /, 'S4: the success toast');
});
test('S5 the button\'s one try still ambiguous (the call dropped) ⇒ back to U4b (the button again, nothing scheduled); then an op-judged refusal ⇒ U3', async () => {
  const b = await world();
  for (let i = 0; i < 10; i += 1) await publish(b, form({ name: `Viva ${i}`, pct: 10 * (1 + (i % 5)), start: NOW, end: NOW + 20 * DAY, days: [i < 5 ? 6 : 0], window: null }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: Array(5).fill('marketingOfferSave') });
  for (let i = 0; i < 3; i += 1) await fire(p);
  assert.equal(noticeWord(p), CANT, 'premise: U4');
  b.net.drop = ['marketingOfferSave'];   // Codex #129: the harness's real transport drop, not a synthetic reply
  reconf(p).click(); await settle(300);
  assert.equal(noticeWord(p), CANT, 'S5: a dropped call settles nothing — U4 again');
  assert.ok(reconf(p), 'S5: the button stays (the page still holds the attempt)');
  assert.equal(pending(p).length, 0, 'S5: the button never restarts the schedule');
  reconf(p).click(); await settle(300);   // now it reaches the real core: the branch's live slots are full ⇒ judged too_many_live
  assert.equal(noticeWord(p), 'No se guardó la oferta. Ya tenés el máximo de ofertas activas en una sucursal. Terminá una para programar esta.', 'S5: U3');
  assert.equal(reconf(p), null);
});
test('S6 the LIST\'S CONTENT never settles it: the offer landed (every reply lost) and the re-read SHOWS it — still «Confirmando», then U4; never a success toast', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = Array(5).fill('marketingOfferSave');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  // the named assertion FIRST (a list-settles mutant must die HERE, not at a premise): the re-read is in, the notice is still U1
  assert.equal(noticeWord(p), CONFIRMING, 'S6: a row in the list is not an answer under our op_id');
  assert.ok(rowNamed(p, LPS), 'premise (non-vacuity): the re-read lists the offer that landed');
  for (let i = 0; i < 3; i += 1) await fire(p);
  assert.equal(noticeWord(p), CANT, 'S6: U4 — the list\'s content never settled it');
  assert.ok(!/^Oferta programada/.test(toastText(p) || ''), 'S6: never a success toast from the list');
});
test('S8 the re-send is judged a DUPLICATE (another session programmed the identical offer meanwhile) ⇒ the existing offer opens, as the dialog does — no notice, ONE offer', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: ['marketingOfferSave', 'marketingOfferSave'] });
  const sent = saves(b)[0].body;
  assert.equal((await offerSaveRaw({ rid: RID, expectedRev: 0, offer: sent.offer, program: true, token: b.token })).status, 200, 'premise: another session programmed the identical offer');
  await fire(p, 400);
  assert.equal(notice(p), null, 'S8: no notice');
  assert.equal(p.host().querySelector('.mk5d-head h1').textContent, LPS, 'S8: the EXISTING offer\'s detail');
  assert.equal(offersNamed(b, LPS).length, 1, 'S8: still ONE');
  assert.equal(pending(p).length, 0);
});
test('S9 a re-send answered op_id_conflict by the REAL core (its op_id was claimed by another kind of operation meanwhile) ⇒ U4 at once, NO button, nothing more scheduled', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  const n0 = saves(b).length;   // the seed's own save comes first
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'fixed-op-id-0003', configurable: true, writable: true });
  try { await unconfirmedCreate(p, b, { drop: ['marketingOfferSave', 'marketingOfferSave'] }); } finally { delete globalThis.crypto.randomUUID; }
  assert.equal(saves(b)[n0].body.op_id, 'op_fixed-op-id-0003', 'premise: the held create\'s op_id');
  // the SAME op_id is claimed by a MOVE (the real core, another session) — the held create's re-send now conflicts
  assert.equal((await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'paused_owner', expectedRev: o.rev, opId: 'op_fixed-op-id-0003', token: b.token })).status, 200, 'premise: the move claimed it');
  await fire(p);
  assert.equal(saves(b).length - n0, 3, 'premise: the re-send reached the real core');
  assert.equal(noticeWord(p), CANT, 'S9: U4');
  assert.equal(reconf(p), null, 'S9: no «Volver a confirmar»');
  assert.equal(pending(p).length, 0, 'S9: nothing more scheduled');
});
// ═══ Codex #129 (HIGH r1, REVISE): the held attempt on a flaky phone ═════════════════════════════════════════════════════════════
test('X1 [P1] a re-send whose token refresh STALLS while the merchant leaves the page never reaches the server: the attempt\'s liveness is checked after the token, before fetch', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: ['marketingOfferSave', 'marketingOfferSave'] });
  const tok = globalThis.__tok; let release; globalThis.__tok = new Promise((r) => { release = r; });   // the next token() stalls
  const t = pending(p)[0];
  t.on = false; p.clock.t = t.at; t.f(); await settle(50);   // the +3 s re-send starts — and waits on its token
  const n = saves(b).length;
  p.reg().unmount();                                          // the merchant leaves the page meanwhile
  release(tok); globalThis.__tok = tok; await settle(250);
  assert.equal(saves(b).length, n, 'X1: the cancelled re-send never reached fetch');
  assert.equal(offersNamed(b, LPS).length, 0, 'X1: nothing was created after the page was left');
});
test('X2 [P1] a LATE UNKNOWN from an older write never revives it: A dismissed while its confirmation is out, B submitted and saved, then A comes back UNKNOWN ⇒ A is NOT held (no timer can create it beside B)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  const f0 = globalThis.fetch; let n = 0, gateOpen; const gate = new Promise((r) => { gateOpen = r; });
  globalThis.fetch = async (url, opts) => {   // A's call never reaches the server; A's confirmation waits on the gate, then never reaches it either
    if (String(url).endsWith('/marketingOfferSave')) { n += 1; if (n === 1) throw new TypeError('Failed to fetch'); if (n === 2) { await gate; throw new TypeError('Failed to fetch'); } }
    return f0(url, opts);
  };
  try {
    p.btn('Programar oferta', sh).click(); await settle(80);
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();   // the review sheet, then the builder (as L7)
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    assert.equal(dlg(p), null, 'premise: A dismissed while its confirmation is out');
    assert.equal(n, 2, 'premise: A\'s confirmation is the one out (held on the gate)');
    await openCard(p, 'pct');
    p.btn('Programar oferta', await toReview(p)).click(); await settle(300);   // B: the third save, through the real core
    assert.equal(Object.values(b.fake.get('marketing_brand/tb/offers') || {}).filter((r) => r.type === 'pct').length, 1, 'premise: B saved (the real core)');
    gateOpen(); await settle(300);                                             // A's confirmation finally fails: UNKNOWN, handed over LATE
  } finally { globalThis.fetch = f0; }
  assert.equal(pending(p).length, 0, 'X2: a superseded write is never held — no confirmation is scheduled for A');
  assert.equal(reconf(p), null, 'X2: and no «Volver a confirmar» can re-send it');
  assert.equal(offersNamed(b, LPS).length, 0, 'X2: A was never created beside B');
  assert.equal(notice(p), null, 'X2 (Codex #130): the stale handoff changed NOTHING — no «Confirmando» stranded over the list');
});
test('X6 [Codex #130 P2] a STALE handoff changes nothing: B is held (its call + confirmation dropped), then A\'s late UNKNOWN arrives ⇒ B\'s schedule is intact, B\'s notice stays, A is invisible; B\'s re-send still goes out', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  const f0 = globalThis.fetch; let n = 0, gateOpen; const gate = new Promise((r) => { gateOpen = r; }); const ops = [];   // ops[i]: the (i+1)-th save's op_id
  globalThis.fetch = async (url, opts) => {   // A: the call dropped, its confirmation gated then dropped · B: the call + its confirmation dropped
    if (String(url).endsWith('/marketingOfferSave')) { n += 1; ops.push(JSON.parse(opts.body).op_id); if (n === 1 || n === 3 || n === 4) throw new TypeError('Failed to fetch'); if (n === 2) { await gate; throw new TypeError('Failed to fetch'); } }
    return f0(url, opts);
  };
  let bt;
  try {
    p.btn('Programar oferta', sh).click(); await settle(80);
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
    assert.equal(n, 2, 'premise: A dismissed, its confirmation out');
    await openCard(p, 'pct');
    p.btn('Programar oferta', await toReview(p)).click(); await settle(300);   // B: both ambiguous ⇒ held
    assert.equal(noticeWord(p), CONFIRMING, 'premise: B held (U1)');
    bt = pending(p)[0];
    assert.ok(bt, 'premise: B\'s confirmation scheduled');
    gateOpen(); await settle(300);                                             // A's late UNKNOWN: a stale handoff
  } finally { globalThis.fetch = f0; }
  assert.equal(bt.on, true, 'X6: B\'s schedule is intact — the stale handoff dropped nothing');
  assert.equal(pending(p).length, 1, 'X6: and nothing of A was scheduled');
  assert.equal(noticeWord(p), CONFIRMING, 'X6: B\'s notice stays');
  const before = saves(b).length;
  await fire(p);
  const sent = saves(b).slice(before);
  assert.equal(sent.length, 1, 'X6: B\'s re-send went out');
  assert.notEqual(ops[2], ops[0], 'premise: A and B are two submissions');
  assert.equal(sent[0].body.op_id, ops[2], 'X6: under B\'s op_id (never A\'s)');
  assert.equal(offersNamed(b, LPS).length, 0, 'X6: A is invisible — never created');
});
test('X3 [P2] a MOVE\'s re-send judged a DUPLICATE (an identical offer went live meanwhile) ⇒ that existing offer opens, as the dialog does — never the generic «No se guardó»', async () => {
  const b = await world();
  const x = await publish(b, LIVE());
  const paused = await offerSetStateRaw({ rid: RID, offerId: x.id, to: 'paused_owner', expectedRev: x.rev, token: b.token });
  assert.equal(paused.status, 200, 'premise: X paused');
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  b.net.drop = ['marketingOfferSetState', 'marketingOfferSetState'];
  p.btn('Reanudar').click(); await settle(250);
  assert.equal(noticeWord(p), CONFIRMING, 'premise: U1');
  const y = await publish(b, LIVE());   // another session: the IDENTICAL offer goes live (the real writers)
  await fire(p, 400);
  assert.notEqual(noticeWord(p), NOT_SAVED, 'X3: never the generic line for a duplicate');
  assert.equal(notice(p), null, 'X3: no notice');
  const h = p.host().querySelector('.mk5d-head h1');
  assert.ok(h && h.textContent === 'Almuerzo', 'X3: the existing offer\'s detail opened');
  assert.equal(p.mods.marketing._mktState.detail, y.id, 'X3: it is the IDENTICAL live one (the server\'s offer_id)');
});
test('X4 [P2] the deadlines are measured from the handoff: +3 / +10 / +30 s even when every re-send takes 2 s — the SEND times, not the timer arguments', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: Array(5).fill('marketingOfferSave') });
  const t0 = p.clock.t, sentAt = [];
  const f0 = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (String(url).endsWith('/marketingOfferSave')) { sentAt.push(p.clock.t - t0); p.clock.t += 2000; } return f0(url, opts); };   // each re-send «takes» 2 s
  try { for (let i = 0; i < 3; i += 1) await fire(p); } finally { globalThis.fetch = f0; }
  assert.deepEqual(sentAt, [3000, 10000, 30000], 'X4: sent at +3 / +10 / +30 s after the handoff — the latency never accumulates');
  assert.equal(noticeWord(p), CANT, 'then U4');
});
test('X5 [P2] an OP-JUDGED 400 settles: the offer\'s start passed during the outage ⇒ the re-send is the real core\'s 400 start_past with op:\'judged\' ⇒ U3 with its own sentence — never UNKNOWN forever', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await unconfirmedCreate(p, b, { drop: ['marketingOfferSave', 'marketingOfferSave'] });
  const now0 = b.deps.now; b.deps.now = () => now0() + 3 * DAY;   // the server's clock moves past the offer's start
  try { await fire(p); } finally { b.deps.now = now0; }
  const last = b.calls.filter((c) => c.fn === 'marketingOfferSave').pop();
  assert.ok(last, 'premise: the re-send went out');
  assert.equal(noticeWord(p), 'No se guardó la oferta. La fecha de inicio ya pasó. Elegí una fecha nueva en «Horario».', 'X5: U3, the refusal\'s own sentence');
  assert.equal(pending(p).length, 0, 'X5: settled — nothing more scheduled');
});

test('S7 cancelled: leaving the page, another account, or a NEW write stops the confirmations — nothing more is sent', async () => {
  for (const how of ['leave', 'account', 'write']) {
    const b = await world();
    await publish(b, LIVE());
    const p = await page({ b });
    await p.signIn(); await p.open();
    await unconfirmedCreate(p, b, { drop: ['marketingOfferSave', 'marketingOfferSave'] });
    const t = pending(p)[0];
    assert.ok(t, `${how}: premise: a confirmation is scheduled`);
    if (how === 'leave') p.reg().unmount();
    if (how === 'account') { p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: MGR } })); await settle(); }
    if (how === 'write') { await openDetail(p, 'Almuerzo'); p.btn('Pausar').click(); await settle(250); }
    assert.equal(t.on, false, `${how}: the scheduled confirmation is cleared`);
    const n = saves(b).length;
    t.f(); await settle(200);   // even a timer that slipped through finds the attempt gone
    assert.equal(saves(b).length, n, `${how}: nothing more is sent`);
    assert.equal(offersNamed(b, LPS).length, 0, `${how}: the dropped create never lands`);
  }
});

// ═══ Codex r6.1-build REVISE #1 (advisor 11-15): every write path's lost reply is UNKNOWN; a dismissed write still lands in the list ═══
const UNK = CONFIRMING;   // owner 11-17: the list keeps confirming the SAME op_id
const unknownLanded = (p, label) => {
  assert.equal(noticeWord(p), UNK, `${label}: the banner`);
  assert.ok(!/No pudimos guardar|No pudimos hacer el cambio|No pudimos programar/.test(p.text()), `${label}: never a failure word`);
  assert.equal(dlg(p), null, `${label}: no dialog`);
  assert.equal(sheet(p), null, `${label}: no sheet`);
};
test('L1 «Repetir» → «Programar», the reply lost ⇒ ONE confirmation under the SAME op_id: the server replays the copy ⇒ its own toast, no banner, ONE copy', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  b.net.lose = ['marketingOfferRepeat'];
  const from = b.calls.length;
  p.btn('Programar', sheet(p)).click(); await settle(300);
  const reps = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferRepeat');
  assert.equal(reps.length, 2, 'the call + ONE confirmation');
  assert.equal(reps[1].body.op_id, reps[0].body.op_id, 'the confirmation: the SAME op_id');
  assert.equal(stored(b, 'Almuerzo').length, 2, 'the source + ONE copy (the confirmation replayed it)');
  assert.equal(notice(p), null, 'confirmed: no banner');
  assert.equal(sheet(p), null, 'the sheet closed');
  assert.equal(toastText(p), 'Campaña programada para el lun 16 nov', 'the same toast as a direct success');
});
test('L2 «Guardar borrador», the reply lost ⇒ ONE confirmation under the SAME op_id (drafts too, owner 11-15) ⇒ «Borrador guardado», ONE draft', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = ['marketingOfferSave'];
  const from = b.calls.length;
  p.btn('Guardar borrador', dlg(p)).click(); await settle(300);
  const sv = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSave');
  assert.equal(sv.length, 2, 'the call + ONE confirmation');
  assert.ok(/^op_[A-Za-z0-9_-]{12,}$/.test(sv[0].body.op_id), 'a draft create carries an op_id');
  assert.equal(sv[1].body.op_id, sv[0].body.op_id, 'the confirmation: the SAME op_id');
  assert.equal(offersNamed(b, LPS).length, 1, 'ONE draft');
  assert.equal(notice(p), null, 'confirmed: no banner');
  assert.equal(dlg(p), null, 'the dialog closed');
  assert.equal(toastText(p), 'Borrador guardado', 'the same toast as a direct success');
});
test('L3 «Seguir editando» → «Programar oferta» on a draft, both replies lost (the call + its one confirmation) ⇒ UNKNOWN', async () => {
  const b = await world();
  await create(b, form({ name: 'Borrador uno', max: '100' }));   // a complete draft (pct needs its maximum to review)
  const p = await page({ b });
  await p.signIn(); await p.open();
  p.mods.marketing.clock.now = () => NOW;
  p.btn('Acciones', rowNamed(p, 'Borrador uno')).click(); await settle();
  rowNamed(p, 'Borrador uno').querySelector('[data-act="continue"]').click(); await settle(80);
  b.net.lose = ['marketingOfferSave', 'marketingOfferSave'];
  const rv = await toReview(p);
  assert.ok(rv, 'premise: the review opened');
  p.btn('Programar oferta', rv).click(); await settle(250);
  unknownLanded(p, 'draft-program');
  assert.notEqual(toastText(p), 'Oferta programada. Empieza hoy.');
});
test('L4 «Reanudar» on a paused offer, both replies lost ⇒ UNKNOWN', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'paused_owner', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  b.net.lose = ['marketingOfferSetState', 'marketingOfferSetState'];
  p.btn('Reanudar').click(); await settle(250);
  unknownLanded(p, 'resume');
  assert.equal(p.host().querySelector('.mk5d-head'), null, 'the detail closed');
});
test('L5 «Terminar oferta» (the 5b sheet), both replies lost ⇒ UNKNOWN', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Terminar oferta').click(); await settle();
  b.net.lose = ['marketingOfferSetState', 'marketingOfferSetState'];
  p.btn('Terminar oferta', sheet(p)).click(); await settle(250);
  unknownLanded(p, 'end');
});
test('L6 DISMISS then lost (Codex P1-1): «Guardar cambios», Esc while pending, both replies lost ⇒ still UNKNOWN — the banner, NO cached rows during the re-read', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) }; b.net.lose = ['marketingOfferSave', 'marketingOfferSave'];
  p.btn('Guardar cambios', dlg(p)).click(); await settle(40);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(dlg(p), null, 'premise: dismissed mid-write');
  let go; release(); b.net.hold = { fn: 'getMarketing', until: new Promise((r) => { go = r; }) };   // the re-read held: what paints meanwhile?
  await settle(150);
  assert.equal(noticeWord(p), UNK, 'the banner, although the dialog was dismissed');
  assert.equal(p.host().querySelectorAll('.mk5-row').length, 0, 'no cached rows during the re-read');
  go(); await settle(150);
  assert.ok(rowNamed(p, 'Almuerzo'), 'the fresh read paints');
});
test('L7 DISMISS then lost on «Programar oferta» ⇒ the ONE confirmation still runs and lands it: no banner; a dialog opened meanwhile (another opening) is left alone', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) }; b.net.lose = ['marketingOfferSave'];
  p.btn('Programar oferta', sh).click(); await settle(40);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  assert.equal(dlg(p), null, 'premise: dismissed mid-write');
  await openCard(p, 'bogo');
  release(); await settle(300);
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 2, 'the call + ONE confirmation');
  assert.equal(ops[1], ops[0], 'the SAME op_id');
  assert.equal(offersNamed(b, LPS).filter((r) => r.state === 'active').length, 1, 'ONE live offer');
  assert.equal(notice(p), null, 'confirmed: no banner');
  assert.ok(dlg(p), 'the dialog opened meanwhile stays');
  assert.equal(dlg(p).querySelector('.mk5b-type .mk5b-lbl').textContent, 'Comprá 1 y llevate otro gratis', 'untouched');
});
test('L8 a dismissed write whose account changed meanwhile is DROPPED (no banner for another user)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) }; b.net.lose = ['marketingOfferSave', 'marketingOfferSave'];
  p.btn('Guardar cambios', dlg(p)).click(); await settle(40);
  p.d.dispatchEvent(new p.w.CustomEvent('portal:auth', { detail: { uid: MGR } })); await settle();
  release(); await settle(200);
  assert.equal(notice(p), null, 'no banner under another account');
});

// ═══ owner 11-15 «confirm every save» (MOCKUP v5b 3d/3e/3f/1c): an ambiguous CREATE / REPEAT / DRAFT is re-sent ONCE under the SAME
// op_id — 3a's claim (offers-core claimCheck) replays the first answer or lands it now, exactly once. Only a second ambiguous answer
// falls back to the list, in a NEUTRAL notice. Edits and moves (no op_id on the wire yet) keep the fallback directly.
const FALLBACK = CONFIRMING;   // owner 11-17: after the two ambiguous answers the list keeps confirming (U1)
test('C1 «Programar oferta», the reply lost (it LANDED) ⇒ ONE confirmation, SAME op_id ⇒ the replayed offer: the direct-success toast, no banner, ONE offer', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = ['marketingOfferSave'];
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  const ops = saves(b).map((c) => c.body.op_id);
  assert.equal(ops.length, 2, 'the call + ONE confirmation');
  assert.equal(ops[1], ops[0], 'C1: the confirmation re-sends the SAME op_id');
  assert.equal(offersNamed(b, LPS).length, 1, 'C1: ONE offer (the claim replayed it)');
  assert.equal(notice(p), null, 'C1: confirmed ⇒ no fallback');
  assert.equal(dlg(p), null, 'the dialog closed');
  assert.match(toastText(p), /^Oferta programada\. Empieza /, 'C1: the same toast as a direct success');
});
test('C2 «Programar oferta», the call never reached the server ⇒ the confirmation LANDS it, exactly once', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.drop = ['marketingOfferSave'];
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  assert.equal(saves(b).length, 2, 'the call + ONE confirmation');
  assert.equal(offersNamed(b, LPS).filter((r) => r.state === 'active').length, 1, 'C2: landed once, programmed');
  assert.equal(notice(p), null, 'no fallback');
  assert.match(toastText(p), /^Oferta programada\. Empieza /);
});
test('C3 while the confirmation is in flight: «Confirmando…» on the primary, «Volver» disabled, the quiet line (v5b 3d)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  b.net.drop = ['marketingOfferSave'];   // the first call never reaches the server (a drop throws before the hold) …
  let release; b.net.hold = { fn: 'marketingOfferSave', until: new Promise((r) => { release = r; }) };   // … so the hold catches the confirmation
  p.btn('Programar oferta', sh).click(); await settle(100);
  const m = p.host().querySelector('.mk5r-modal');
  assert.ok(m, 'the review stays open while confirming');
  const ok = m.querySelector('.mk5r-ok'), ghost = ok.querySelector('.mk5-ghost');
  assert.equal((m.querySelector('.mk5r-cfm') || {}).textContent, 'La conexión tardó. Estamos confirmando que se guardó.', 'C3: the quiet line');
  assert.equal(ok.disabled, true);
  assert.equal(ghost && ghost.nextElementSibling.textContent, 'Confirmando…', 'C3: the busy label');
  assert.equal(ghost.textContent, 'Programar oferta', 'the idle label kept (invisible) — same size, nothing moves');
  assert.equal(m.querySelector('.mk5r-back').disabled, true, '«Volver» disabled');
  release(); await settle(250);
  assert.equal(p.host().querySelector('.mk5r-modal'), null, 'then confirmed: closed');
  assert.equal(p.host().querySelector('.mk5r-cfm'), null);
});
test('C4 BOTH ambiguous ⇒ NEVER a second resend; the list re-reads with the NEUTRAL fallback notice between the filters and «Ofertas» (v5b 1c)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.drop = ['marketingOfferSave', 'marketingOfferSave'];
  const n0 = saves(b).length;   // the set-up's own save comes before
  p.btn('Programar oferta', await toReview(p)).click(); await settle(400);
  assert.equal(saves(b).length - n0, 2, 'C4: the call + ONE confirmation — never a second resend');
  assert.equal(dlg(p), null, 'the dialog closed');
  const n = notice(p);
  assert.equal(noticeWord(p), FALLBACK, 'C4: «Confirmando» (U1), exact');
  assert.ok(n.classList.contains('mk5-notice') && !n.classList.contains('mk5b-err'), 'C4: neutral, never the error style');
  assert.equal(n.getAttribute('role'), 'status');
  assert.ok(n.previousElementSibling && n.previousElementSibling.classList.contains('mk5-bar'), 'after the filters');
  assert.ok(n.nextElementSibling && n.nextElementSibling.classList.contains('mk5-sect'), 'before «Ofertas»');
  assert.ok(rowNamed(p, 'Almuerzo'), 'the list, re-read');
});
test('C5 the confirmation returns an OP-JUDGED refusal (the first call ran and was judged too_many_live — stored in its op_id claim — its reply lost) ⇒ the dialog stays with the refusal\'s word (v5b 3f)', async () => {
  const b = await world();
  for (let i = 0; i < 10; i += 1) await publish(b, form({ name: `Viva ${i}`, pct: 10 * (1 + (i % 5)), start: NOW, end: NOW + 20 * DAY, days: [i < 5 ? 6 : 0], window: null }));   // the branch's live slots, full
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const sh = await toReview(p);
  b.net.lose = ['marketingOfferSave'];   // the call is JUDGED (409 too_many_live, stored in the claim) — and that reply is lost
  const n0 = saves(b).length;
  p.btn('Programar oferta', sh).click(); await settle(300);
  assert.equal(saves(b).length - n0, 2, 'the call + ONE confirmation');
  const m = p.host().querySelector('.mk5r-modal');
  assert.ok(m, 'C5: the review stays open');
  assert.equal(m.querySelector('.mk5b-err').textContent, 'Ya tenés el máximo de ofertas activas en una sucursal. Terminá una para programar esta.', 'C5: the stored judgement\'s own word');
  assert.equal(notice(p), null, 'no fallback');
  assert.equal(m.querySelector('.mk5r-ok').disabled, false, 'idle again');
});
test('C6 a DEFINITE first answer is never confirmed: ONE call (a direct success, a direct refusal)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(250);
  assert.equal(saves(b).length, 1, 'C6: a 200 ⇒ one call');
  await openCard(p, 'pct');
  await b.setSwitch(false, 1);
  p.btn('Guardar borrador', dlg(p)).click(); await settle(250);
  assert.equal(saves(b).length, 2, 'C6: a 409 ⇒ one call');
});

// ═══ 3a 9462baf40 (advisor 11-15): an EDIT and a MOVE carry an op_id too — the same one confirmation under the SAME body. A judgement
// refusal (overlap / duplicate / too_many_live) replays as stored; any other refusal is judged afresh; op_id_conflict ⇒ the fallback.
const sameBody = (a, b2, label) => assert.deepEqual(b2.body, a.body, label);
test('E1 «Guardar cambios», the reply lost (it LANDED) ⇒ ONE confirmation with the SAME body (op_id + the old expected_rev) ⇒ the replay: «Cambios guardados», ONE edit', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  b.net.lose = ['marketingOfferSave'];
  const n0 = saves(b).length;
  p.btn('Guardar cambios', dlg(p)).click(); await settle(300);
  const sv = saves(b).slice(n0);
  assert.equal(sv.length, 2, 'the call + ONE confirmation');
  assert.ok(/^op_[A-Za-z0-9_-]{16,}$/.test(sv[0].body.op_id), 'E1: an edit carries an op_id');
  sameBody(sv[0], sv[1], 'E1: the confirmation is the SAME request (op_id, offer_id, expected_rev, offer)');
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1, 'ONE edit — the confirmation replayed it');
  assert.equal(notice(p), null, 'E1: confirmed ⇒ no fallback');
  assert.equal(dlg(p), null);
  assert.equal(toastText(p), 'Cambios guardados', 'the direct-success toast');
});
test('E2 «Guardar cambios», the call never reached the server ⇒ the confirmation LANDS it, exactly once', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  b.net.drop = ['marketingOfferSave'];
  p.btn('Guardar cambios', dlg(p)).click(); await settle(300);
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1, 'E2: landed once');
  assert.equal(toastText(p), 'Cambios guardados');
  assert.equal(notice(p), null);
});
test('E3 a NON-judgement refusal is judged afresh: the call never landed, another edit landed meanwhile ⇒ the confirmation is refused (superseded) ⇒ the dialog stays with its word', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  await dropEnd(p);
  b.net.drop = ['marketingOfferSave'];
  const f0 = globalThis.fetch; let n = 0;
  globalThis.fetch = async (url, opts) => {   // just before the confirmation: ANOTHER session's edit lands (the real writer)
    if (String(url).endsWith('/marketingOfferSave') && ++n === 2) { globalThis.fetch = f0; const other = authored({ ...LIVE(), name: 'Almuerzo', end: NOW + 25 * DAY });
      assert.equal((await offerSaveRaw({ rid: RID, offerId: o.id, expectedRev: o.rev, offer: other, token: b.token })).status, 200, 'premise: the other edit landed'); }
    return f0(url, opts);
  };
  try { p.btn('Guardar cambios', dlg(p)).click(); await settle(300); } finally { globalThis.fetch = f0; }
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1, 'only the other edit landed');
  assert.ok(dlg(p), 'E3: the dialog stays');
  assert.equal(dlg(p).querySelector('.mk5b-err').textContent, 'Esta oferta cambió mientras la editabas. Cerrá y abrila de nuevo.', 'E3: the stale word');
  assert.equal(notice(p), null, 'no fallback');
});
test('E4 «Pausar» from the detail, the reply lost ⇒ ONE confirmation with the SAME body (op_id, offer_id, to, expected_rev) ⇒ the replay: its toast, ONE move', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  b.net.lose = ['marketingOfferSetState'];
  const from = b.calls.length;
  p.btn('Pausar').click(); await settle(300);
  const mv = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState');
  assert.equal(mv.length, 2, 'the call + ONE confirmation');
  assert.equal(mv[0].body.to, 'paused_owner', 'premise');
  assert.ok(/^op_[A-Za-z0-9_-]{16,}$/.test(mv[0].body.op_id), 'E4: a move carries an op_id');
  sameBody(mv[0], mv[1], 'E4: the confirmation is the SAME request (op_id, offer_id, to, expected_rev)');
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1, 'ONE move');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner');
  assert.equal(notice(p), null, 'E4: confirmed ⇒ no fallback');
  assert.equal(toastText(p), 'Oferta pausada. Reanudala cuando querás.');
});
test('E5 a JUDGEMENT refusal replays as stored: «Reanudar» refused (too_many_live), its reply lost, the blocker gone meanwhile ⇒ the confirmation answers the SAME 409 ⇒ the detail stays with its word', async () => {
  const b = await world();
  const a = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: a.id, to: 'paused_owner', expectedRev: a.rev, token: b.token });
  const others = [];
  for (let i = 0; i < 10; i += 1) others.push(await publish(b, form({ name: `Viva ${i}`, pct: 10 * (1 + (i % 5)), start: NOW, end: NOW + 20 * DAY, days: [i < 5 ? 6 : 0], window: null })));
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  let release; b.net.hold = { fn: 'marketingOfferSetState', until: new Promise((r) => { release = r; }) };
  const from = b.calls.length;
  p.btn('Reanudar').click(); await settle(60);   // the real core judged it (too_many_live) and stored the refusal in its claim
  const x = others[0];
  assert.equal((await offerSetStateRaw({ rid: RID, offerId: x.id, to: 'ended', expectedRev: x.rev, token: b.token })).status, 200, 'premise: the blocker is gone');
  b.net.lose = ['marketingOfferSetState'];
  release(); await settle(300);
  const mv = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState' && c.body.offer_id === a.id);
  assert.equal(mv.length, 2, 'the call + ONE confirmation');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner', 'E5: never resumed (the stored judgement answered)');
  assert.ok(p.host().querySelector('.mk5d-head'), 'E5: the detail stays');
  assert.equal(p.host().querySelector('.mk5b-err span').textContent, 'No pudimos hacer el cambio. Volvé a la lista e intentá de nuevo.', 'E5: the detail\'s refusal word');
  assert.equal(notice(p), null, 'no fallback');
});
test('E6 «Terminar oferta» (5b) while its confirmation is in flight: «Confirmando…» + the quiet line in the sheet; then the replay closes it', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Terminar oferta').click(); await settle();
  b.net.drop = ['marketingOfferSetState'];
  let release; b.net.hold = { fn: 'marketingOfferSetState', until: new Promise((r) => { release = r; }) };
  p.btn('Terminar oferta', sheet(p)).click(); await settle(100);
  const m = sheet(p), ok = m.querySelector('.mk5r-ok'), ghost = ok.querySelector('.mk5-ghost');
  assert.equal((m.querySelector('.mk5r-cfm') || {}).textContent, 'La conexión tardó. Estamos confirmando que se guardó.', 'E6: the quiet line');
  assert.equal(ghost && ghost.nextElementSibling.textContent, 'Confirmando…', 'E6: the busy label');
  assert.equal(ghost.textContent, 'Terminar oferta');
  assert.equal(m.querySelector('.mk5r-back').disabled, true);
  release(); await settle(300);
  assert.equal(stored(b, 'Almuerzo')[0].state, 'ended', 'landed once');
  assert.equal(stored(b, 'Almuerzo')[0].rev, o.rev + 1);
  assert.equal(toastText(p), 'Oferta terminada. Los resultados quedan guardados.');
});
test('E7 op_id_conflict on a MOVE ⇒ the fallback at once (a client bug, never a refusal word), no confirmation', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  // the op_id is already claimed by an EDIT of this offer (the real core) ⇒ a move under it is op_id_conflict
  const edited = authored({ ...LIVE(), end: NOW + 25 * DAY });
  assert.equal((await offerSaveRaw({ rid: RID, offerId: o.id, expectedRev: o.rev, offer: edited, opId: 'op_fixed-op-id-0002', token: b.token })).status, 200, 'premise: the edit claimed it');
  const p = await page({ b });
  await p.signIn(); await p.open();
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'fixed-op-id-0002', configurable: true, writable: true });
  try {
    await openDetail(p, 'Almuerzo');
    const from = b.calls.length;
    p.btn('Pausar').click(); await settle(300);
    assert.equal(b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState').length, 1, 'E7: ONE call — never confirmed');
    assert.equal(noticeWord(p), CANT, 'E7: the fallback at once (U4)');
    assert.equal(reconf(p), null, 'E7: no «Volver a confirmar»');
    assert.equal(pending(p).length, 0, 'E7: nothing scheduled');
    assert.ok(!p.text().includes('No pudimos hacer el cambio'), 'never a refusal word');
  } finally { delete globalThis.crypto.randomUUID; }
});

// ═══ Codex narrow HIGH on ae0e65663..ef174ebb7 (REVISE, 3 P2s — advisor 11-15) ═══════════════════════════════════════════════════
// before the confirmation goes out, ANOTHER session's move lands on the offer we just wrote (the real writers): the replay answers it as NOW
function beforeConfirm(fn, act) {
  const f0 = globalThis.fetch; let n = 0;
  globalThis.fetch = async (url, opts) => { if (String(url).endsWith(`/${fn}`) && ++n === 2) { globalThis.fetch = f0; await act(); } return f0(url, opts); };
  return () => { globalThis.fetch = f0; };
}
const moveRaw = async (b, rec, to) => assert.equal((await offerSetStateRaw({ rid: RID, offerId: rec.id, to, expectedRev: rec.rev, token: b.token })).status, 200, `premise: another session moved it to ${to}`);
const recOf = (b, pred) => { const [id, r] = Object.entries(b.fake.get('marketing_brand/tb/offers')).find(([, x]) => pred(x)); return { ...r, id }; };
test('F1a «Programar oferta»: our create LANDED (reply lost), another session PAUSED it before the confirmation ⇒ the replay is CONFIRMED: the RETURNED state\'s toast (Codex #93 F3), never «Quedó como borrador», never the fallback', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  b.net.lose = ['marketingOfferSave'];
  const undo = beforeConfirm('marketingOfferSave', () => moveRaw(b, recOf(b, (x) => x.name === LPS), 'paused_owner'));
  try { p.btn('Programar oferta', await toReview(p)).click(); await settle(300); } finally { undo(); }
  assert.equal(offersNamed(b, LPS)[0].state, 'paused_owner', 'premise: paused by the other session');
  assert.ok(!p.text().includes('Quedó como borrador'), 'F1a: never the invented «Quedó como borrador»');
  assert.equal(notice(p), null, 'no fallback');
  assert.equal(dlg(p), null, 'F1a: the dialog closed');
  assert.equal(toastText(p), 'Oferta pausada. Reanudala cuando querás.', 'F1a: confirmed — the toast says what the returned offer IS (paused), not «Oferta programada…»');
});
test('F1b «Programar oferta» on a continued DRAFT: our edit LANDED (reply lost), another session ENDED it before the confirmation ⇒ CONFIRMED (never the fallback), the RETURNED state\'s toast (Codex #93 F3)', async () => {
  const b = await world();
  await create(b, form({ name: 'Borrador uno', max: '100' }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  p.mods.marketing.clock.now = () => NOW;
  p.btn('Acciones', rowNamed(p, 'Borrador uno')).click(); await settle();
  rowNamed(p, 'Borrador uno').querySelector('[data-act="continue"]').click(); await settle(80);
  b.net.lose = ['marketingOfferSave'];
  const rv = await toReview(p);
  const undo = beforeConfirm('marketingOfferSave', () => moveRaw(b, recOf(b, (x) => x.name === 'Borrador uno'), 'ended'));
  try { p.btn('Programar oferta', rv).click(); await settle(300); } finally { undo(); }
  assert.equal(stored(b, 'Borrador uno')[0].state, 'ended', 'premise: ended by the other session');
  assert.equal(notice(p), null, 'F1b: confirmed ⇒ no fallback');
  assert.equal(dlg(p), null, 'the dialog closed');
  assert.equal(toastText(p), 'Oferta terminada. Los resultados quedan guardados.', 'F1b: confirmed — the toast says what the returned offer IS (ended)');
});
test('F1c «Repetir» → «Programar»: the copy LANDED (reply lost), another session PAUSED it before the confirmation ⇒ CONFIRMED: the RETURNED state\'s toast (Codex #93 F3), never «Quedó como borrador»', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  b.net.lose = ['marketingOfferRepeat'];
  const undo = beforeConfirm('marketingOfferRepeat', () => moveRaw(b, recOf(b, (x) => x.name === 'Almuerzo' && x.state === 'active'), 'paused_owner'));
  try { p.btn('Programar', sheet(p)).click(); await settle(300); } finally { undo(); }
  assert.equal(stored(b, 'Almuerzo').filter((r) => r.state === 'paused_owner').length, 1, 'premise: the copy, paused by the other session');
  assert.ok(!p.text().includes('Quedó como borrador'), 'F1c: never the invented «Quedó como borrador»');
  assert.equal(notice(p), null, 'no fallback');
  assert.equal(toastText(p), 'Oferta pausada. Reanudala cuando querás.', 'F1c: confirmed — the toast says what the returned copy IS (paused), not «Campaña programada…»');
});
test('F2 the REAL core\'s 429 too_many_pending (the brand\'s op claims are full) is DEFINITE: nothing written, ONE call — never confirmed', async () => {
  const b = await world();
  const d = await create(b, form({ name: 'Llena', max: '100' }));
  let rev = d.rev;
  for (let i = 0; i < 200; i += 1) {   // 200 live claims through the REAL writer: edits of one draft, each under its own op_id
    const res = await offerSaveRaw({ rid: RID, offerId: d.id, expectedRev: rev, offer: authored(form({ name: 'Llena', max: String(100 + (i % 2)) })), opId: `op_fill_${String(i).padStart(12, '0')}`, token: b.token });
    assert.equal(res.status, 200, 'premise: a claimed edit'); rev = res.body.offer.rev;
  }
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const n0 = saves(b).length;
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  const last = saves(b).slice(n0);
  assert.equal(offersNamed(b, LPS).length, 0, 'premise: nothing written (the 429 aborts the brand txn)');
  assert.equal(last.length, 1, 'F2: ONE call — a definite 429 is never confirmed');
  assert.ok(p.host().querySelector('.mk5r-modal .mk5b-err'), 'F2: the dialog stays with a refusal word');
  assert.equal(notice(p), null, 'never the fallback');
});
test('F3 a STALE move\'s reply (its view left) never clears a NEWER move\'s «Confirmando…»', async () => {
  const b = await world();
  await publish(b, LIVE());
  await publish(b, form({ name: 'Cena', pct: 30, start: NOW, end: NOW + 20 * DAY, days: [6], window: null }));
  const p = await page({ b });
  await p.signIn(); await p.open();
  const D = () => p.mods['marketing-detail']._detailState;
  await openDetail(p, 'Almuerzo');
  let r1; b.net.drop = ['marketingOfferSetState']; b.net.hold = { fn: 'marketingOfferSetState', until: new Promise((r) => { r1 = r; }) };
  p.btn('Pausar').click(); await settle(80);   // the first call dropped; its confirmation held in flight
  assert.equal(D().confirming, true, 'premise: Almuerzo confirming');
  p.host().querySelector('.mk5d-back').click(); await settle(120);
  await openDetail(p, 'Cena');
  let r2; b.net.drop = ['marketingOfferSetState']; b.net.hold = { fn: 'marketingOfferSetState', until: new Promise((r) => { r2 = r; }) };
  p.btn('Pausar').click(); await settle(80);
  assert.equal(D().confirming, true, 'premise: Cena confirming');
  r1(); await settle(150);   // the OLD view's confirmation answers now
  assert.equal(D().confirming, true, 'F3: Cena still confirming — the stale reply left it alone');
  r2(); await settle(200);
  assert.equal(D().confirming, false, 'then Cena\'s own answer settles it');
});

// ═══ slot 11-15 defects (advisor rulings): build EXACT to the mockup; text never crammed at 390 (16b) ═══════════════════════════
// the mockup's own symbols (MOCKUP-portal-marketing v5 #i-tag / #i-users / #i-box), as the builder + editor rows draw them
const I_TAG = 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', I_USERS = 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', I_BOX = 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8';
const rowIconPaths = (p, id) => [...rowEl(p, id).querySelectorAll('.mk5b-ico path')].map((x) => x.getAttribute('d'));
test('D1 the row icons are the mockup\'s: Descuento = tag, Clientes = group, Productos = box — in the builder AND the editor', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  ML.FLAGS.audience = true;   // the builder's «Clientes» row lives behind the audience flag (owner 11-16)
  try { await openCard(p, 'bogo'); } finally { ML.FLAGS.audience = false; }
  assert.ok(rowIconPaths(p, 'typ').includes(I_TAG), 'builder: Descuento row = #i-tag');
  assert.ok(rowIconPaths(p, 'aud').includes(I_USERS), 'builder: Clientes row = #i-users');
  assert.ok(rowIconPaths(p, 'prod').includes(I_BOX), 'builder: Productos row = #i-box');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
  p.btn('Campañas').click(); await settle();
  await openEdit(p, 'Almuerzo');
  assert.ok(rowIconPaths(p, 'typ').includes(I_TAG), 'editor: the locked Descuento row = #i-tag');
  assert.ok(rowIconPaths(p, 'aud').includes(I_USERS), 'editor: the locked Clientes row = #i-users');
});
test('D2 a date never breaks across lines: each «27 nov» in the Horario summary is ONE unbreakable token; the help line wraps balanced (16b)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openEdit(p, 'Almuerzo');
  const val = rowEl(p, 'sch').querySelector('.mk5b-val');
  const toks = [...val.querySelectorAll('.mk5b-nw')].map((x) => x.textContent);
  assert.ok(toks.length >= 2 && toks.every((t) => /^\d{1,2} [a-z]{3}( \d{4})?$/.test(t)), `every date is its own no-wrap token (${JSON.stringify(toks)})`);
  assert.match(val.textContent, /del \d+ [a-z]{3} al \d+ [a-z]{3}/, 'the text itself is unchanged');
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  assert.match(css, /\.mk5b-nw\{white-space:nowrap\}/, 'the token rule');
  assert.match(css, /\.mk5b-albl span\{[^}]*text-wrap:balance/, '«Queda activa hasta que la pausés o la termines» wraps balanced (no orphan «termines»; pretty still left it, slot 11-15)');
});
// (iii) A — advisor 11-15 (derived from owner rule 16c: one line per list item): at phone width the NAME gets the row's full width
// (line 1) and the status joins the horario on line 2; the desktop row is untouched. jsdom has no layout: this pins the RULES; the
// 390 «a 40-character name stays on one line» is proven by the SBS fit probe (a 40-character draft in the Ofertas backend) at the slot.
test('D3 phone list row: the name spans the full width (line 1), status + horario share line 2; the desktop row rules are byte-identical', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  const before = execFileSync('git', ['show', 'HEAD:xpizza-portal/styles.css'], { cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26 });
  const desk = (t) => t.split('\n').filter((l) => /^  \.mk5-(row|lh|c1|c2|c3)\{/.test(l));
  assert.deepEqual(desk(css), desk(before), 'the desktop rules (2-space indent) are unchanged');
  const phone = css.split('\n').filter((l) => /^    \.mk5-(row|c1|c2|c3)(::before)?\{/.test(l)).map((l) => l.trim());
  assert.ok(phone.includes('.mk5-row{grid-template-columns:30px auto minmax(0,1fr);gap:4px 8px;padding:14px 0;min-height:0}'), 'phone grid: icon | status | horario');
  assert.ok(phone.some((l) => /^\.mk5-c1\{grid-column:2\/-1;/.test(l)), 'the name spans the full width');
  assert.ok(phone.some((l) => /^\.mk5-c2\{grid-column:2;grid-row:2;/.test(l)), 'the status on line 2');
  assert.ok(phone.some((l) => /^\.mk5-c3\{grid-column:3;grid-row:2;/.test(l)), 'the horario beside it on line 2');
});

// ═══ Codex #93 F2: on the ONE confirmation, only an answer the server gives AT / AFTER its op_id claim check settles (3a 9462baf40: the
// replay, a stored judgement, a fresh post-claim refusal). A refusal the server can give BEFORE it looks at the op_id — the switch, the
// token, the access — says nothing about the first call, which may have LANDED: the operation stays UNKNOWN (the fallback), never «refused».
async function landsThenBefore(b, fn, change) {   // the first call LANDS in the real core and its reply is lost; `change` runs just before the confirmation
  b.net.lose = [fn];
  const f0 = globalThis.fetch; let n = 0;
  globalThis.fetch = async (url, opts) => { if (String(url).endsWith(`/${fn}`) && ++n === 2) { globalThis.fetch = f0; await change(); } return f0(url, opts); };
  return () => { globalThis.fetch = f0; };
}
const F2_CHANGES = {
  offers_disabled: async (b) => b.setSwitch(false, 1),
  invalid_credentials: async (b) => { b.deps.verifyIdToken = async () => { throw new Error('auth/id-token-revoked'); }; },
  not_authorized: async (b) => { const R = rq('./access/roster'); assert.equal((await R.mutateRoster({ db: b.fake, now: () => 2 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'transfer_owner', uid: MGR, profile: { name: 'Gerente', email: 'g@tb.hn' } })).ok, true, 'premise: the ownership moved (the real roster writer)'); },
};
for (const [code, change] of Object.entries(F2_CHANGES)) {
  test(`J1 «Programar oferta» LANDED, its reply lost; the confirmation is refused BEFORE the claim check (${code}) ⇒ UNKNOWN: the dialog closes, never the refusal's word; the offer IS live`, async () => {
    const b = await world();
    const p = await page({ b });
    await p.signIn(); await p.open();
    await openCard(p, 'lps');
    const sh = await toReview(p);
    const undo = await landsThenBefore(b, 'marketingOfferSave', () => change(b));
    try { p.btn('Programar oferta', sh).click(); await settle(400); } finally { undo(); }
    const sv = saves(b);
    assert.equal(sv.length, 2, 'the call + ONE confirmation');
    const direct = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: sv[1].body.offer, opId: sv[1].body.op_id, program: true, token: b.token });
    assert.equal(direct.body.error, code, `premise: the real core now answers ${code} before its claim check`);
    const st = Object.values(b.fake.get('marketing_brand/tb/offers') || {});
    assert.equal(st.length, 1, 'premise: the first call LANDED — one offer on the server');
    assert.equal(st[0].state, 'active', 'premise: it is live');
    assert.equal(p.host().querySelector('.mk5r-modal'), null, `F2 ${code}: UNKNOWN ⇒ the review closed, never a refusal on the sheet`);
    assert.ok(!/no están disponibles|No pudimos guardar|permiso|sesión/i.test(p.text()), `F2 ${code}: no refusal word anywhere (${p.text().slice(0, 160)})`);
  });
}
test('J2 «Pausar» from the detail LANDED, its reply lost; the confirmation is refused BEFORE the claim check (offers_disabled) ⇒ UNKNOWN: the detail closes, never «No pudimos hacer el cambio»; the offer IS paused', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  const undo = await landsThenBefore(b, 'marketingOfferSetState', () => b.setSwitch(false, 1));
  const from = b.calls.length;
  try { p.btn('Pausar').click(); await settle(300); } finally { undo(); }
  assert.equal(b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState').length, 2, 'the call + ONE confirmation');
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner', 'premise: the first call LANDED — paused on the server');
  assert.equal(p.host().querySelector('.mk5d-head'), null, 'F2: UNKNOWN ⇒ the detail closed');
  assert.ok(!p.text().includes('No pudimos hacer el cambio'), 'F2: never a failure word');
});

// ═══ Codex #93 F3: a replay answers the offer as it is NOW — ANOTHER session may have moved it between our landed call and its one
// confirmation. The toast follows the RETURNED record, in the approved words only (DETAIL_TOAST · programmedToast · the repeat's toast).
async function otherMoves(b, pick, to) {   // another session's move, through the real core
  const [id, rec] = Object.entries(b.fake.get('marketing_brand/tb/offers')).find(([, r]) => pick(r));
  const res = await offerSetStateRaw({ rid: RID, offerId: id, to, expectedRev: rec.rev, token: b.token });
  assert.equal(res.status, 200, `premise: the other session's move to ${to} landed (${JSON.stringify(res.body)})`);
}
const PAUSED = 'Oferta pausada. Reanudala cuando querás.', RESUMED = 'Oferta activa de nuevo', ENDED = 'Oferta terminada. Los resultados quedan guardados.';
test('K1 «Pausar» landed, reply lost; another session resumes it (rev 3) before the confirmation ⇒ the replay says ACTIVE ⇒ «Oferta activa de nuevo», never «Oferta pausada…»', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  const undo = await landsThenBefore(b, 'marketingOfferSetState', () => otherMoves(b, (r) => r.name === 'Almuerzo', 'active'));
  try { p.btn('Pausar').click(); await settle(300); } finally { undo(); }
  assert.deepEqual([stored(b, 'Almuerzo')[0].state, stored(b, 'Almuerzo')[0].rev], ['active', 4], 'premise: paused by us, resumed by the other session');
  assert.equal(toastText(p), RESUMED, 'K1: the toast follows the RETURNED state');
});
test('K2 «Reanudar» landed, reply lost; another session pauses it again before the confirmation ⇒ «Oferta pausada…», never «Oferta activa de nuevo»', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'paused_owner', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  const undo = await landsThenBefore(b, 'marketingOfferSetState', () => otherMoves(b, (r) => r.name === 'Almuerzo', 'paused_owner'));
  try { p.btn('Reanudar').click(); await settle(300); } finally { undo(); }
  assert.equal(stored(b, 'Almuerzo')[0].state, 'paused_owner', 'premise: paused again by the other session');
  assert.equal(toastText(p), PAUSED, 'K2: the toast follows the RETURNED state');
});
for (const [to, word] of [['paused_owner', PAUSED], ['ended', ENDED]]) {
  test(`K3 «Programar oferta» landed, reply lost; another session moves it to ${to} before the confirmation ⇒ «${word.slice(0, 15)}…», never «Oferta programada…»`, async () => {
    const b = await world();
    const p = await page({ b });
    await p.signIn(); await p.open();
    await openCard(p, 'lps');
    const sh = await toReview(p);
    const undo = await landsThenBefore(b, 'marketingOfferSave', () => otherMoves(b, (r) => r.type === 'lps', to));
    try { p.btn('Programar oferta', sh).click(); await settle(400); } finally { undo(); }
    assert.equal(Object.values(b.fake.get('marketing_brand/tb/offers'))[0].state, to, `premise: ${to} by the other session`);
    assert.equal(toastText(p), word, 'K3: the toast follows the RETURNED state');
  });
}
test('K4 «Repetir» → «Programar» landed, reply lost; another session ends the copy before the confirmation ⇒ «Oferta terminada…», never «Campaña programada…»', async () => {
  const b = await world();
  const o = await publish(b, LIVE());
  await offerSetStateRaw({ rid: RID, offerId: o.id, to: 'ended', expectedRev: o.rev, token: b.token });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Almuerzo');
  (await detailMenu(p)).find((x) => x.textContent === 'Repetir campaña').click(); await settle();
  const undo = await landsThenBefore(b, 'marketingOfferRepeat', () => otherMoves(b, (r) => r.name === 'Almuerzo' && r.state === 'active', 'ended'));
  try { p.btn('Programar', sheet(p)).click(); await settle(300); } finally { undo(); }
  assert.deepEqual(stored(b, 'Almuerzo').map((r) => r.state), ['ended', 'ended'], 'premise: the copy landed, then the other session ended it');
  assert.equal(toastText(p), ENDED, 'K4: the toast follows the RETURNED state');
});

// ═══ F4 (owner 11-16, offers v1): the audience choice is HIDDEN behind ONE flag (ML.FLAGS.audience) — the price path applies «Todos los
// clientes» only (3a: any other audience ⇒ 400 audience_not_supported). The flag-on path stays live: it renders v5's audience control.
const AUD_ROW = (p) => p.host().querySelector('.mk5b-row[data-row="aud"]');
const reviewLabels = (p) => [...p.host().querySelectorAll('.mk5r-modal .mk5r-row, .mk5r-modal [class*="mk5r-r"]')].map((x) => x.textContent);
test('A1 the audience flag OFF (v1): no «Para clientes nuevos» card (3 cards, the third starting the second row), no «Clientes» row in the builder or the review; a NEW nuevos offer never opens; the write says audience «all»', async () => {
  assert.equal(ML.FLAGS.audience, false, 'v1 ships with the flag OFF');
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  assert.deepEqual([...p.host().querySelectorAll('.mk5-card')].map((c) => c.dataset.otype), ['pct', 'lps', 'bogo'], 'the empty state: three cards');
  p.btn('Crear campaña').click(); await settle();
  assert.deepEqual([...p.host().querySelectorAll('.mk5-card')].map((c) => c.dataset.otype), ['pct', 'lps', 'bogo'], '«Crear campaña»: three cards');
  assert.ok(!/Para clientes nuevos|Solo la ven clientes que nunca te pidieron/.test(p.text()), 'no nuevos copy');
  for (const t of ['pct', 'lps', 'bogo']) {
    await openCard(p, t);
    assert.equal(AUD_ROW(p), null, `${t}: no «Clientes» row in the builder`);
    if (t === 'bogo') { p.mods['marketing-builder'].closeBuilder(); await settle(); continue; }   // 2×1 reaches the review only once a product is picked
    const sh = await toReview(p);
    assert.ok(sh && !/Clientes/.test(sh.textContent), `${t}: no «Clientes» line in «Revisá tu oferta»`);
    p.btn('Volver', sh).click(); await settle();
    p.mods['marketing-builder'].closeBuilder(); await settle();
  }
  p.mods['marketing-builder'].openBuilder(p.host(), { branches: [{ rid: RID, name: 'Centro', address: null }], brandId: 'tb', token: b.token, toast: () => {}, now: () => NOW }, { type: 'nuevos' });
  assert.equal(dlg(p), null, 'openBuilder({ type: nuevos }) opens nothing');
  await openCard(p, 'lps');
  p.btn('Programar oferta', await toReview(p)).click(); await settle(300);
  assert.equal(saves(b).at(-1).body.offer.audience, 'all', 'the write: audience «all»');
});
test('A2 the audience flag ON (the restore path, live): v5\'s «Clientes» row (Todos los clientes · Clientes nuevos · Clientes que vuelven), the review line, and the four cards in the 2×2 grid', async () => {
  ML.FLAGS.audience = true;
  try {
    const b = await world();
    const p = await page({ b });
    await p.signIn(); await p.open();
    p.btn('Crear campaña').click(); await settle();
    assert.deepEqual([...p.host().querySelectorAll('.mk5-card')].map((c) => [c.dataset.otype, c.querySelector('h3').textContent]),
      [['pct', 'Porcentaje en todo el menú'], ['lps', 'Lempiras de descuento con mínimo'], ['bogo', 'Comprá 1 y llevate otro gratis'], ['nuevos', 'Para clientes nuevos']], 'the four cards');
    await openCard(p, 'pct');
    const r = AUD_ROW(p);
    assert.ok(r, 'the «Clientes» row');
    assert.deepEqual([r.querySelector('.mk5b-rlbl').textContent, r.querySelector('.mk5b-val').textContent], ['Clientes', 'Todos'], 'v5: «Clientes» · «Todos»');
    r.querySelector('.mk5b-rowh').click(); await settle();
    assert.deepEqual([...AUD_ROW(p).querySelectorAll('.mk5b-opt .mk5b-oname')].map((x) => x.textContent), ['Todos los clientes', 'Clientes nuevos', 'Clientes que vuelven'], 'v5: the three audiences (titles only, Q3)');
    const sh = await toReview(p);
    assert.ok(/Clientes/.test(sh.textContent), '«Revisá tu oferta» lists «Clientes»');
  } finally { ML.FLAGS.audience = false; }
});
// 3a's OF pin 20325d019 (advisor 11-16) refuses every audience but 'all': a 400 on a save (offer-model validateAuthored), a 409 when a
// STORED new / returning offer would go live (offers-core :399, AFTER its claim check at :388 ⇒ op-judged). Both from the REAL core.
const AUD_REF = '20325d0190e419d506b7bca5781ad132a4bed635';
test('A3a the REAL core (3a 20325d019): «Clientes nuevos» → «Programar oferta» ⇒ 400 audience_not_supported, DEFINITE — ONE call, the dialog stays with the generic word', async () => {
  ML.FLAGS.audience = true;   // the only way the UI can author it (the restore path)
  try {
    const b = await world({ ref: AUD_REF });
    const p = await page({ b });
    await p.signIn(); await p.open();
    await openCard(p, 'pct');
    rowEl(p, 'aud').querySelector('.mk5b-rowh').click(); await settle();
    [...rowEl(p, 'aud').querySelectorAll('.mk5b-opt')].find((x) => x.textContent.startsWith('Clientes nuevos')).querySelector('input').dispatchEvent(new p.w.Event('change')); await settle();
    const sh = await toReview(p);
    p.btn('Programar oferta', sh).click(); await settle(300);
    const sv = saves(b);
    assert.equal(sv.length, 1, 'A3a: definite ⇒ ONE call, never confirmed');
    assert.equal(sv[0].body.offer.audience, 'new', 'premise: the UI sent audience «new»');
    const direct = await offerSaveRaw({ rid: RID, expectedRev: 0, offer: sv[0].body.offer, token: b.token });
    assert.deepEqual([direct.status, direct.body.error, direct.body.reason], [400, 'bad_request', 'audience_not_supported'], 'premise: the real core at 20325d019');
    const m = p.host().querySelector('.mk5r-modal');
    assert.ok(m, 'A3a: the review stays');
    assert.equal(m.querySelector('.mk5b-err').textContent, 'No pudimos guardar la oferta. Revisá los datos e intentá de nuevo.', 'A3a: the generic refusal word');
    assert.equal(notice(p), null, 'never the fallback');
  } finally { ML.FLAGS.audience = false; }
});
test('A3b the REAL core (3a 20325d019): «Reanudar» on a STORED «returning» offer ⇒ 409 audience_not_supported, DEFINITE (op-judged, after the claim check) — ONE call, the detail stays with its word', async () => {
  const b = await world({ ref: AUD_REF });
  const id = 'o_' + 'e'.repeat(12);   // 3a's own fixture (offers-core.test 6a'): a stored non-'all' offer — no v1 writer can make one
  await b.fake.ref(`marketing_brand/tb/offers/${id}`).set({ v: 1, name: 'Vuelve', type: 'pct', params: { pct: 15 }, audience: 'returning', branches: ['tb_centro'], created_by: OWNER, created_at: NOW, updated_at: NOW,
    rev: 2, state: 'paused_owner', paused_at: NOW, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Vuelve');
  const from = b.calls.length;
  p.btn('Reanudar').click(); await settle(300);
  const mv = b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState');
  assert.equal(mv.length, 1, 'A3b: definite ⇒ ONE call, never confirmed');
  const direct = await offerSetStateRaw({ rid: RID, offerId: id, to: 'active', expectedRev: 2, token: b.token });
  assert.deepEqual([direct.status, direct.body.error], [409, 'audience_not_supported'], 'premise: the real core at 20325d019');
  assert.ok(p.host().querySelector('.mk5d-head'), 'A3b: the detail stays');
  assert.equal(p.host().querySelector('.mk5b-err span').textContent, 'No pudimos hacer el cambio. Volvé a la lista e intentá de nuevo.', 'A3b: the detail\'s refusal word');
  assert.equal(notice(p), null, 'never the fallback');
});
test('T1 16b (advisor 11-16): the Horario row header reads the same words, split in two parts — days · hours, then the dates — each its own line on a phone (no mid-phrase wrap); the builder and «Editar» both', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  const segs = (r) => [...r.querySelectorAll('.mk5b-val > .mk5b-vseg')].map((x) => x.textContent);
  const nr = p.host().querySelector('.mk5b-row[data-row="sch"]');
  assert.equal(segs(nr).length, 2, 'the builder: two parts');
  assert.equal(segs(nr).join(''), nr.querySelector('.mk5b-val').textContent, 'nothing else in the value');
  assert.match(segs(nr)[1], /^ · desde el \d{1,2} \w{3}, sin fecha de fin$/, 'part 2: the separator (hidden on a phone) + the dates');
  p.mods['marketing-builder'].closeBuilder(); await settle();
  p.btn('Campañas').click(); await settle();
  await openEdit(p, 'Almuerzo');
  const er = p.host().querySelector('.mk5b-row[data-row="sch"]');
  assert.equal(segs(er)[0], 'Lun a Vie · 11:00–14:00', '«Editar» part 1: days · hours');
  assert.match(segs(er)[1], /^ · del \d{1,2} \w{3} al \d{1,2} \w{3}$/, '«Editar» part 2: the separator + the dates');
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  assert.ok(css.includes('@media(max-width:920px){.mk5b-vseg{display:block}.mk5b-vsep{display:none}}'), 'a phone: one line per part, the separator hidden');
});
test('K5 «Guardar borrador» landed, reply lost; another session PUBLISHES the draft before the confirmation ⇒ the replay says ACTIVE ⇒ the programmed wording, never «Borrador guardado» (Codex #93 r2 F3)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  const undo = await landsThenBefore(b, 'marketingOfferSave', () => otherMoves(b, (r) => r.state === 'draft', 'active'));
  try { p.btn('Guardar borrador', dlg(p)).click(); await settle(400); } finally { undo(); }
  assert.equal(Object.values(b.fake.get('marketing_brand/tb/offers'))[0].state, 'active', 'premise: our draft landed, then the other session published it');
  assert.match(toastText(p), /^Oferta programada\. Empieza /, 'K5: the toast follows the RETURNED state (active)');
});
test('A3c the same 409 on the ONE confirmation (the first reply lost) is op-judged — after the claim check ⇒ it SETTLES as a refusal, never UNKNOWN', async () => {
  const b = await world({ ref: AUD_REF });
  const id = 'o_' + 'e'.repeat(12);
  await b.fake.ref(`marketing_brand/tb/offers/${id}`).set({ v: 1, name: 'Vuelve', type: 'pct', params: { pct: 15 }, audience: 'returning', branches: ['tb_centro'], created_by: OWNER, created_at: NOW, updated_at: NOW,
    rev: 2, state: 'paused_owner', paused_at: NOW, schedule: { start: NOW + DAY, end: NOW + 30 * DAY, days: [5, 6], window: { from: 1260, to: 0 } } });
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openDetail(p, 'Vuelve');
  b.net.lose = ['marketingOfferSetState'];
  const from = b.calls.length;
  p.btn('Reanudar').click(); await settle(300);
  assert.equal(b.calls.slice(from).filter((c) => c.fn === 'marketingOfferSetState').length, 2, 'the call + ONE confirmation');
  assert.ok(p.host().querySelector('.mk5d-head'), 'A3c: settled as a refusal — the detail stays');
  assert.equal(notice(p), null, 'A3c: never the fallback');
});
// slot 11-16 re-shoot: two 16b rows still red at 390 — the «Queda activa…» help line (text-wrap on an INLINE span does nothing) and the
// auto «Nombre» value wrapping mid-phrase. COMPUTED over the REAL builder DOM with the SHIPPED stylesheet injected (jsdom has no media queries:
// the phone split is asserted as the two parts + the existing ≤ 920 px rule, as T1).
const withSheet = (p) => { const st = p.d.createElement('style'); st.textContent = readFileSync(join(DIR, 'styles.css'), 'utf8'); p.d.head.append(st); };
test('T2 16b: «Queda activa hasta que la pausés o la termines» is a BLOCK, so its text-wrap:balance takes effect (computed, the real «Editar» row)', async () => {
  const b = await world();
  await publish(b, LIVE());
  const p = await page({ b });
  await p.signIn(); await p.open();
  withSheet(p);
  await openEdit(p, 'Almuerzo');
  const sp = [...p.host().querySelectorAll('.mk5b-albl span')].find((x) => x.textContent === 'Queda activa hasta que la pausés o la termines');
  assert.ok(sp, 'premise: the help line rendered');
  const cs = p.w.getComputedStyle(sp);
  assert.equal(cs.display, 'block', 'T2: a block container — text-wrap applies');
});
test('T3 16b: the auto «Nombre» value reads the same words in two parts — the name | «· se armó solo» — one line each on a phone (no mid-phrase wrap)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'lps');
  const r = p.host().querySelector('.mk5b-row[data-row="name"]');
  const segs = [...r.querySelectorAll('.mk5b-val > .mk5b-vseg')].map((x) => x.textContent);
  assert.deepEqual(segs, ['L 50 en pedidos desde L 300', ' · se armó solo'], 'T3: two parts (the separator hidden on a phone)');
  assert.equal(r.querySelector('.mk5b-val').textContent, 'L 50 en pedidos desde L 300 · se armó solo', 'the same words as before');
  assert.ok(readFileSync(join(DIR, 'styles.css'), 'utf8').includes('@media(max-width:920px){.mk5b-vseg{display:block}.mk5b-vsep{display:none}}'), 'a phone: one line per part');
});
test('T4 16b (advisor 11-16, post-RC SBS): the «Revisá tu oferta» Horario reads the builder\'s two parts — days · hours, then the dates — one line each on a phone (was «sin fecha / de fin» at 390)', async () => {
  const b = await world();
  const p = await page({ b });
  await p.signIn(); await p.open();
  await openCard(p, 'pct');
  const built = [...p.host().querySelectorAll('.mk5b-row[data-row="sch"] .mk5b-val > .mk5b-vseg')].map((x) => x.textContent);
  assert.equal(built.length, 2, 'premise: the builder row has its two parts (T1)');
  dlg(p).querySelector('.mk5b-go').click(); await settle();
  const r = [...p.host().querySelectorAll('.mk5r-modal .mk5r-row')].find((x) => x.querySelector('.mk5r-sl').textContent === 'Horario');
  assert.ok(r, 'premise: the review sheet has its Horario line');
  const segs = [...r.querySelectorAll('.mk5r-sv > .mk5b-vseg')].map((x) => x.textContent);
  assert.deepEqual(segs, built, 'T4: the review value is the SAME two parts as the builder row (the separator hidden on a phone)');
  assert.match(segs[1], /^ · desde el \d{1,2} \w{3}, sin fecha de fin$/, 'part 2 starts at the segment point, never mid-phrase');
  assert.equal(r.querySelector('.mk5r-sv').textContent, rowVal(p, 'sch'), 'the same words as before');
});
