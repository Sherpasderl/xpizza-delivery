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
import { DIR, NOW, OWNER, MGR, RID, backend, form, create, publish } from './marketing-harness.mjs';
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
const MENU = () => okJson({ source: { restaurant_id: RID, schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__mkt-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => globalThis.__tok;\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__mkt-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__mkt-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell', 'marketing']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__mkt-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
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
  assert.deepEqual(ids, ['summary', 'fresh', 'period', 'ventas', 'tope', 'repeat-live', 'delete', 'anuncios', 'how-anuncios', 'sherpa-collections', 'empty-results']);
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
