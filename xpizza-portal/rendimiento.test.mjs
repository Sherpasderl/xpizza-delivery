// P-1 nav (owner 11-13, map Q4): today's «Ventas» entry becomes ONE «Rendimiento» entry whose page carries text tabs «Ventas ·
// Calificaciones» (MOCKUP-portal-map.html s-rend :853–861; MOCKUP-portal-calificaciones.html Nav A :323–364). Ventas is the first tab and
// the default, its page unchanged under the tabs; another tab registers its own pane (Calificaciones, when its approved view lands; room
// for a third, never drawn here). Old entry points keep landing on Ventas: shell goto('ventas'), and the new aliases goto('rendimiento') /
// goto('calificaciones') (Ventas until that tab is registered).
// The REAL app.js + ventas.js + shell.js over ventas-harness's DOM, driven through boot.js's events. Run: node --test rendimiento.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIR, installDom, installFetch, loadModules, okJson, errJson, okCsv, settle, textOf, findAll, hasClass } from './ventas-harness.mjs';
import { join } from 'node:path';

const MENU = () => okJson({ source: { restaurant_id: 'x_pizza', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const STATS = () => okJson({ kpis: { sales_cents: 3814600, orders: 158, average_paid_ticket_cents: 24100 }, deltas: { sales_pct: 12.4, orders_pct: 8.2, average_paid_ticket_pct: -1.9 }, series: [], top_products: [] });
const routes = (fn, q) => {
  if (fn === 'getMyRestaurants') return okJson({ restaurants: [{ rid: 'x_pizza', name: 'X. Pizza' }] });
  if (fn === 'getEditableCatalog') return MENU();
  if (fn === 'getSalesStats') return q.format === 'csv' ? okCsv('a\r\n') : STATS();
  return errJson(404, { error: 'not_found' });
};
async function signIn() {
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'owner_uid' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle();
}
const TITLE = 'Rendimiento';
const LEDE = 'Cómo le va a tu restaurante: ventas y lo que dicen tus clientes.';
const tabsOf = (view) => findAll(view, (n) => hasClass(n, 'ttab'));
const tabBar = (view) => findAll(view, (n) => hasClass(n, 'ttabs'))[0];
const onTab = (view) => tabsOf(view).filter((t) => hasClass(t, 'on')).map((t) => t.textContent);
const statsCalls = (calls) => calls.filter((c) => c.fn === 'getSalesStats');
async function boot(register) {
  const byId = installDom();
  const calls = installFetch(routes);
  const mods = await loadModules();
  if (register) register(mods.ventas);
  await signIn();
  return { byId, calls, mods, view: byId.get('viewventas') };
}
// a test-only THIRD tab (the room the registry keeps; nothing like it is drawn) — Calificaciones itself is registered by ventas.js
const califTab = (log) => ({ id: 'tercera', label: 'Tercera',
  mount: (el) => { log.push('mount'); const p = document.createElement('p'); p.textContent = 'PANE'; el.append(p); }, unmount: () => log.push('unmount') });

test('index.html: the nav entry (desktop + mobile) reads «Rendimiento»; its ids stay (every module and the nav groups anchor on them)', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8');
  assert.match(html, /<button class="nav hidden" id="navventas" type="button"><svg[^>]*>.*?<\/svg>Rendimiento<\/button>/, '🔴 desktop: «Rendimiento»');
  assert.match(html, /<button class="mn" id="mnventas" type="button">Rendimiento<\/button>/, '🔴 mobile: «Rendimiento»');
  assert.ok(!/>Ventas<\/button>/.test(html), 'no «Ventas» nav entry left');
});

test('the page: «Rendimiento» + the mockup\'s lede + the text tabs, Ventas first, on and current; today\'s Ventas body and CSV actions unchanged under it', async () => {
  const { byId, calls, view } = await boot();
  byId.get('navventas').click(); await settle();
  const h1 = findAll(view, (n) => n.tag === 'h1')[0];
  assert.equal(h1.textContent, TITLE, '🔴 the page title'); assert.equal(h1.id, 'vtitle', 'the view stays labelled by #vtitle');
  assert.ok(textOf(view).includes(LEDE), 'the lede, verbatim');
  assert.ok(!textOf(view).includes('Cómo se está vendiendo'), 'today\'s Ventas lede gives way to the page\'s');
  const bar = tabBar(view);
  assert.equal(bar.tag, 'nav'); assert.equal(bar.attrs['aria-label'], 'Secciones de Rendimiento');
  assert.deepEqual(tabsOf(view).map((t) => t.textContent), ['Ventas', 'Calificaciones'], 'Ventas · Calificaciones (P-1), nothing else');
  assert.deepEqual(onTab(view), ['Ventas']); assert.equal(tabsOf(view)[0].attrs['aria-current'], 'page');
  for (const want of ['L 38,146', '158', 'Resumen diario (CSV)', 'Pedidos (CSV)']) assert.ok(textOf(view).includes(want), `the Ventas tab still renders: ${want}`);
  assert.equal(statsCalls(calls).length, 1, 'one sales read, as today');
});

test('a registered tab: «Ventas · Calificaciones» in that order; switching mounts / unmounts its pane, hides the sales body and reads no sales', async () => {
  const log = [];
  const { byId, calls, view } = await boot((v) => v.registerRendTab(califTab(log)));
  byId.get('navventas').click(); await settle();
  assert.deepEqual(tabsOf(view).map((t) => t.textContent), ['Ventas', 'Calificaciones', 'Tercera'], '🔴 the order the mockup draws, then the room');
  assert.deepEqual(onTab(view), ['Ventas'], 'Ventas opens by default');
  const n = statsCalls(calls).length;
  tabsOf(view)[2].click(); await settle();
  assert.deepEqual(onTab(view), ['Tercera']); assert.equal(tabsOf(view)[2].attrs['aria-current'], 'page'); assert.equal(tabsOf(view)[0].attrs['aria-current'], undefined);
  assert.deepEqual(log, ['mount']);
  const pane = findAll(view, (n) => (n.children || []).some((c) => c.textContent === 'PANE'))[0];
  const salesHidden = () => ['vacts', 'vperiod'].every((c) => hasClass(findAll(view, (n) => hasClass(n, c))[0], 'hidden'));
  assert.ok(!hasClass(pane, 'hidden') && textOf(pane).includes('PANE'), 'the pane shows');
  assert.ok(salesHidden(), '🔴 the sales period and CSV actions step aside');
  assert.equal(statsCalls(calls).length, n, 'no sales read for another tab');
  tabsOf(view)[0].click(); await settle();
  assert.deepEqual(log, ['mount', 'unmount']); assert.deepEqual(onTab(view), ['Ventas']);
  assert.ok(hasClass(pane, 'hidden') && !textOf(pane).includes('PANE') && !salesHidden(), 'back on Ventas: the pane emptied and hidden, the sales controls shown');
  byId.get('navprod').click(); byId.get('navventas').click(); await settle();
  assert.deepEqual(onTab(view), ['Ventas'], 'leaving and coming back opens Ventas again');
});

test('entry points: goto(\'ventas\') and goto(\'rendimiento\') land on the Ventas tab; goto(\'calificaciones\') on Calificaciones (registered by ventas.js)', async () => {
  {
    const { mods, view, byId } = await boot();
    for (const [v, want] of [['ventas', 'Ventas'], ['rendimiento', 'Ventas'], ['calificaciones', 'Calificaciones']]) {
      byId.get('navprod').click();
      mods.shell.goto(v); await settle();
      assert.ok(!hasClass(byId.get('viewventas'), 'hidden'), `${v}: the page shows`);
      assert.deepEqual(onTab(view), [want], `🔴 ${v} → ${want}`);
      assert.ok(hasClass(byId.get('navventas'), 'on'), `${v}: the nav entry is current`);
    }
  }
  {
    const log = [];
    const { mods, view, byId } = await boot((v) => v.registerRendTab(califTab(log)));
    byId.get('navprod').click();
    mods.shell.goto('calificaciones'); await settle();
    assert.deepEqual(onTab(view), ['Calificaciones'], '🔴 the alias opens the Calificaciones tab');
    mods.shell.goto('ventas'); await settle();
    assert.deepEqual(onTab(view), ['Ventas']);
  }
});

test('registerRendTab: refuses a duplicate id, Ventas\' id, a missing label or mount; at most three tabs (room for one more, never drawn here)', async () => {
  const { mods } = await boot();
  const R = mods.ventas.registerRendTab;
  assert.throws(() => R({ id: 'ventas', label: 'X', mount() {} }));
  assert.throws(() => R({ id: 'x', mount() {} }));
  assert.throws(() => R({ id: 'x', label: 'X' }));
  assert.throws(() => R({ id: 'calificaciones', label: 'X', mount() {} }), 'Calificaciones is already registered (by ventas.js)');
  R({ id: 'a', label: 'A', mount() {} });   // the third: the room kept for «Tu nivel»
  assert.throws(() => R({ id: 'a', label: 'A2', mount() {} }), 'a duplicate');
  assert.throws(() => R({ id: 'b', label: 'B', mount() {} }), 'a fourth tab');
});

test('the Calificaciones scope line names the PAGE\'S restaurant: the shell\'s branch label, but never «Todas las sucursales» (a per-restaurant list)', async () => {
  const { byId, mods } = await boot();
  const ctxs = [];
  const real = mods.ventas.registerRendTab;
  byId.get('mscope').textContent = 'Todas las sucursales';
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: 'x_pizza', name: 'Centro' } }));
  await settle();
  mods.shell.goto('calificaciones'); await settle();
  const scope = findAll(byId.get('viewventas'), (n) => hasClass(n, 'calif-scope'))[0];
  assert.ok(scope, 'premise: the Calificaciones view mounted');
  assert.equal(textOf(scope), 'Centro', '🔴 «Todas» never labels a per-restaurant list');
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: 'x_pizza' } }));   // a path without the name
  byId.get('mscope').textContent = 'Centro Sur';
  await settle(); byId.get('navprod').click(); mods.shell.goto('calificaciones'); await settle();
  assert.equal(textOf(findAll(byId.get('viewventas'), (n) => hasClass(n, 'calif-scope'))[0]), 'Centro Sur', 'no name on the event: the shell\'s label');
  assert.ok(real && ctxs);
});
