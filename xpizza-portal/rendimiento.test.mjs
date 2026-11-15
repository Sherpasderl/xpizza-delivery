// Nav B (owner 11-14, advisor ruling — supersedes P-1's «Rendimiento» tab strip of 11-13): «Ventas», «Calificaciones» and «Tu nivel» are
// THREE nav entries. The Rendimiento entry, its text tabs and their registry are retired (ventas.js is back at REND_BASE byte-for-byte:
// portalui-guards). «Calificaciones» is its own registered view (calificaciones-view.js) right after «Ventas», its header from
// MOCKUP-portal-calificaciones-color.html, its body the approved Calificaciones view. An old goto('rendimiento') lands on Ventas.
// The REAL app.js + ventas.js + shell.js + calificaciones-view.js over ventas-harness's DOM. Run: node --test rendimiento.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIR, installDom, installFetch, loadModules, okJson, errJson, okCsv, settle, textOf, findAll, hasClass } from './ventas-harness.mjs';
import { join } from 'node:path';

const MENU = () => okJson({ source: { restaurant_id: 'x_pizza', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const STATS = () => okJson({ kpis: { sales_cents: 3814600, orders: 158, average_paid_ticket_cents: 24100 }, deltas: { sales_pct: 12.4, orders_pct: 8.2, average_paid_ticket_pct: -1.9 }, series: [], top_products: [] });
const COMMENTS = () => okJson({ comments: [], next_cursor: null, stats: null });
const routes = (fn, q) => {
  if (fn === 'getMyRestaurants') return okJson({ restaurants: [{ rid: 'x_pizza', name: 'X. Pizza' }] });
  if (fn === 'getEditableCatalog') return MENU();
  if (fn === 'getSalesStats') return q.format === 'csv' ? okCsv('a\r\n') : STATS();
  if (fn === 'getMerchantRatingComments') return COMMENTS();
  return errJson(404, { error: 'not_found' });
};
async function boot() {
  const byId = installDom();
  const calls = installFetch(routes);
  const mods = await loadModules(['app', 'ventas', 'shell', 'calificaciones-view']);
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'owner_uid' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle();
  return { byId, calls, mods, view: byId.get('viewventas') };
}
const calif = (mods) => mods.shell._registered.find((r) => r.id === 'calificaciones');

test('index.html: the nav entry (desktop + mobile) reads «Ventas» again; «Rendimiento» appears nowhere in the page', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.match(html, /<button class="nav hidden" id="navventas" type="button"><svg[^>]*>.*?<\/svg>Ventas<\/button>/, '🔴 desktop: «Ventas»');
  assert.match(html, /<button class="mn" id="mnventas" type="button">Ventas<\/button>/, '🔴 mobile: «Ventas»');
  assert.ok(!/Rendimiento/.test(html), 'no «Rendimiento» left in index.html');
});

test('the nav carries NO «Rendimiento» label; «Calificaciones» is its own entry right after «Ventas» (desktop + mobile), in the Negocio group', async () => {
  const { byId, mods } = await boot();
  const r = calif(mods);
  assert.ok(r, '🔴 «Calificaciones» is a registered view');
  assert.equal(r.group, 'Negocio');
  assert.equal(r.label, 'Calificaciones');
  // registerView places a group's FIRST registered view right after the group's anchor (GROUPS.Negocio = navventas / mnventas), each
  // later one after the previous: so «Calificaciones» must be the first Negocio view boot.js imports
  const bootSrc = readFileSync(join(DIR, 'boot.js'), 'utf8');
  const at = (m) => bootSrc.indexOf(`import './${m}.js'`);
  assert.ok(at('calificaciones-view') > 0, 'boot.js imports it');
  for (const other of ['team', 'merit', 'marketing']) if (at(other) > 0) assert.ok(at('calificaciones-view') < at(other), `🔴 before ${other}.js: right after «Ventas»`);
  assert.equal(mods.shell._registered.filter((x) => x.group === 'Negocio')[0].id, 'calificaciones', 'the first Negocio view');
  const labels = [byId.get('navventas'), byId.get('mnventas'), ...mods.shell._registered.flatMap((x) => [x.nav, x.mn])].map((n) => textOf(n)).join('|');
  assert.ok(!/Rendimiento/.test(labels), '🔴 no «Rendimiento» label in the nav');
});

test('the Ventas page is the shipped one: «Ventas», no text tabs, its body and CSV actions; goto(\'rendimiento\') lands on it', async () => {
  const { byId, calls, view, mods } = await boot();
  byId.get('navventas').click(); await settle();
  assert.equal(findAll(view, (n) => n.tag === 'h1')[0].textContent, 'Ventas', '🔴 the page title');
  assert.equal(findAll(view, (n) => hasClass(n, 'ttabs')).length, 0, '🔴 no tab strip');
  for (const want of ['L 38,146', '158', 'Resumen diario (CSV)', 'Pedidos (CSV)']) assert.ok(textOf(view).includes(want), `the Ventas body: ${want}`);
  byId.get('navprod').click(); await settle();
  mods.shell.goto('rendimiento'); await settle();
  assert.ok(!hasClass(view, 'hidden'), 'an old «rendimiento» link lands on Ventas');
  assert.ok(calls.some((c) => c.fn === 'getSalesStats'));
});

test('«Calificaciones» opens its own page: the Nav B header, then the approved view for the PAGE\'s restaurant', async () => {
  const { calls, mods } = await boot();
  mods.shell.goto('calificaciones'); await settle();
  const r = calif(mods);
  assert.ok(!hasClass(r.main, 'hidden'), 'its page shows');
  assert.equal(findAll(r.main, (n) => n.tag === 'h1')[0].textContent, 'Calificaciones', '🔴 the header (MOCKUP-portal-calificaciones-color)');
  assert.ok(textOf(r.main).includes('Lo que dicen tus clientes sobre sus pedidos.'), '🔴 its lede');
  const read = calls.find((c) => c.fn === 'getMerchantRatingComments');
  assert.ok(read, 'the approved view reads the comments');
  assert.equal(read.query.rid, 'x_pizza', 'for the page\'s restaurant (the owner proof), never «Todas»');
});
