// «Ventas» — the tab, slice V1 (PLAN-portal-ventas-draw-r0; MOCKUP-portal-rendimiento-ventas-delta, owner-APPROVED 11-14), under a
// REAL DOM (jsdom): ventas-tab.js mounted on a host, every stats call reaching 5f's REAL cores at the pinned S2 ref through api.js
// (stats-harness.mjs: the real fixtures + the real nightly roll-up), the page's branch list from `extra` (getMyBranches).
// Run: node --test ventas-tab.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DIR, TODAY, NOW, world, route } from './stats-harness.mjs';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const E1 = (rids) => ({ brands: [{ brand_id: 'marca', name: 'Marca' }], branches: rids.map((rid, i) => ({ rid, brand_id: 'marca', name: ['Centro', 'Sur'][i] || rid, state: 'member', role: 'owner', caps: ['stats.read'] })) });

async function tab({ rids = ['r_a', 'r_b'], keyerFails = false, hold = null } = {}) {
  const win = new JSDOM('<!doctype html><span id="shopname">Pizzería Del Valle</span><main id="host"></main>', { url: 'https://portal.test/', pretendToBeVisual: true }).window;
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? win : win[k], configurable: true, writable: true });
  }
  const calls = route({ serve: await world({ keyerFails }) }, (fn) => (fn === 'getMyBranches' ? okJson(E1(rids)) : null));
  const V = await import(`./ventas-tab.js?t=${Date.now()}${Math.random()}`);
  const host = win.document.getElementById('host');
  const token = async () => { if (hold) await hold; return 'TK-test'; };
  V.mountVentasTab(host, { uid: 'uA', rid: rids[0], name: 'Pizzería Del Valle', token, now: () => NOW });
  await settle(hold ? 10 : 80);
  const q = (s) => host.querySelector(s), qa = (s) => [...host.querySelectorAll(s)];
  const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : null);
  return { win, V, host, calls, q, qa, text, stats: () => calls.filter((c) => /^getSalesStats/.test(c.fn)) };
}
const figs = (t) => t.qa('.vd-fig').map((f) => [t.text(f.querySelector('.vd-kl')), t.text(f.querySelector('.vd-kn'))]);

test('V1 frame 0 · «Todas», 14 days: «Ventas» + the shipped lede; the pills; the range; three figures (no deltas); «Ventas por día» + its freshness; the products; ONE call', async () => {
  const t = await tab();
  assert.equal(t.text(t.q('h1')), 'Ventas', 'Nav B: the page IS «Ventas»');
  assert.equal(t.text(t.q('.lede')), 'Cómo se está vendiendo Pizzería Del Valle en el período que elijas.', 'the shipped lede (Q-V1)');
  const pills = t.qa('.vd-pill');
  assert.deepEqual(pills.map((p) => [t.text(p), p.classList.contains('vd-on')]), [['Últimos 14 días', true], ['Todas las sucursales', false]], 'the period pill is filled; the «Todas» pill soft');
  assert.equal(t.text(t.q('.vd-rl')), '30 oct – 12 nov 2026');
  assert.deepEqual(figs(t).map(([l]) => l), ['Ventas', 'Pedidos', 'Ticket promedio']);
  assert.equal(t.qa('.vd-fig .vd-ks').length, 0, 'no deltas on the tab (Q1: «Más detalle» carries them)');
  assert.equal(t.text(t.q('.vd-h2')), 'Ventas por día');
  assert.equal(t.text(t.q('.vd-fresh')), 'Hoy en vivo · actualizado hace un momento', 'a live day: the body\'s own fetch');
  assert.equal(t.qa('.vd-xl span').length, 14, 'fourteen day buckets');
  assert.equal(t.text(t.q('.vd-note')), 'Aún sin calcular: 30 oct, 31 oct · los totales de arriba no los incluyen.', 'the roll-up never computed 30–31 oct: a note, never zeros');
  assert.ok(t.qa('.vd-miss').length === 2, 'two hollow markers on the baseline');
  assert.deepEqual(t.qa('.vd-rowh span').map((x) => t.text(x)), ['Producto', 'Vendidos', 'Ventas'], '«Vendidos», never «Pedidos» (Q3)');
  assert.ok(t.qa('.vd-row:not(.vd-rowh)').length >= 1);
  assert.equal(t.stats().length, 1, 'ONE stats call');
  assert.deepEqual([t.stats()[0].query.restaurantIds, t.stats()[0].query.restaurantId], ['r_a,r_b', undefined], '«Todas» = the server-merged multi read (ONE `restaurantIds` param)');
  assert.equal(t.q('.vd-more'), null, '🔴 «Ver más detalle» ABSENT until V3');
});

test('V1 frame 3 · the period menu: the four presets (no «Personalizado» until V2), the chosen one marked; «Hoy» ⇒ hour buckets and the day in words', async () => {
  const t = await tab();
  t.q('.vd-pill').click(); await settle();
  const opts = t.qa('.vd-menu.vd-show .vd-opt');
  assert.deepEqual(opts.map((o) => t.text(o)), ['Hoy', 'Últimos 7 días', 'Últimos 14 días', 'Últimos 30 días'], '🔴 «Personalizado» ABSENT until V2');
  assert.deepEqual(opts.map((o) => o.getAttribute('aria-selected')), ['false', 'false', 'true', 'false']);
  assert.ok(opts[2].querySelector('.vd-seldot'), 'the chosen mark is a real element');
  opts[0].click(); await settle(100);
  assert.equal(t.text(t.q('.vd-pill')), 'Hoy');
  assert.equal(t.text(t.q('.vd-rl')), 'jueves 12 de noviembre');
  assert.equal(t.text(t.q('.vd-h2')), 'Ventas por hora');
  assert.ok(t.qa('.vd-xl span').some((s) => s.classList.contains('vd-xfut')), 'hours after now: muted, empty positions');
  assert.equal(t.qa('.vd-menu.vd-show').length, 0, 'the menu closed');
});

test('V1 frame 6 · one branch: the branch pill fills with its name; the single-branch read', async () => {
  const t = await tab();
  t.qa('.vd-pill')[1].click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt').find((o) => t.text(o) === 'Centro').click(); await settle(100);
  const p = t.qa('.vd-pill')[1];
  assert.deepEqual([t.text(p), p.classList.contains('vd-on')], ['Centro', true]);
  assert.equal(t.stats().at(-1).fn, 'getSalesStats', 'one branch = the single read');
  assert.equal(t.stats().at(-1).query.restaurantId, 'r_a');
});

test('V1 one branch only: no branch pill at all (nothing to choose)', async () => {
  const t = await tab({ rids: ['r_a'] });
  assert.equal(t.qa('.vd-pill').length, 1, 'only the period pill');
  assert.equal(t.stats()[0].query.restaurantId, 'r_a', 'the single read');
});

test('V1 frame 7 · loading, uncached: the real frame with reserved heights — figure skeletons, the chart card\'s title + a freshness skeleton, five product rows', async () => {
  let release; const hold = new Promise((r) => { release = r; });
  const t = await tab({ hold });
  assert.equal(t.qa('.vd-fig .vd-skn').length, 3, 'three figure skeletons');
  assert.equal(t.text(t.q('.vd-h2')), 'Ventas por día', 'what is known paints as text');
  assert.ok(t.q('.vd-fresh .vd-sk'), 'the freshness waits');
  assert.equal(t.qa('.vd-row:not(.vd-rowh)').length, 5, 'five reserved rows');
  assert.equal(t.qa('.vd-yl').length, 0, 'no axis values before the server\'s scale');
  release(); await settle(100);
  assert.equal(t.qa('.vd-sk').length, 0, 'the body landed');
});

test('V1 frame 8 · the honest empty: L 0 · 0 · «—», one calm card with the shipped copy; no chart, no products', async () => {
  const t = await tab({ rids: ['r_b'] });
  t.q('.vd-pill').click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt')[0].click(); await settle(100);   // «Hoy»: r_b sold nothing today
  assert.deepEqual(figs(t), [['Ventas', 'L 0'], ['Pedidos', '0'], ['Ticket promedio', '—']], 'no average without orders');
  assert.equal(t.text(t.q('.vd-ok')), 'Sin ventas en este períodoProbá con otro período.');
  assert.equal(t.q('.vd-card'), null, 'no chart');
  assert.equal(t.q('.vd-prods'), null, 'no products');
});

test('V1 frame 10 · 503 on «Todas»: «—» figures, the shipped error copy, the «never a partial total» sentence, «Reintentar» + «Ver una sucursal» opens the branch menu', async () => {
  const t = await tab({ keyerFails: true });
  assert.deepEqual(figs(t).map(([, v]) => v), ['—', '—', '—'], 'never a number without its answer');
  const c = t.q('.vd-err');
  assert.equal(c.getAttribute('role'), 'alert');
  assert.deepEqual([...c.querySelectorAll(':scope > b, :scope > span')].map((x) => t.text(x)), ['No pudimos cargar las ventas', 'Es un problema nuestro, no tuyo. Probá de nuevo en un momento.', 'Como una de tus sucursales no respondió, no mostramos un total parcial de «Todas las sucursales».']);
  [...c.querySelectorAll('button')].find((b) => t.text(b) === 'Ver una sucursal').click(); await settle();
  assert.ok(t.q('.vd-menu.vd-show'), 'the branch menu opens');
  assert.equal(t.text(t.q('.vd-menu.vd-show .vd-opt')), 'Todas las sucursales');
});

test('V1 frame 7b · a period change keeps the current body, DIMMED, until the answer lands (no flash, no reflow)', async () => {
  const t = await tab();
  t.q('.vd-pill').click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt')[1].click();   // «Últimos 7 días»
  assert.ok(t.q('.vd-body').classList.contains('vd-dim'), 'dimmed at once');
  assert.equal(t.qa('.vd-xl span').length, 14, 'the previous body stays');
  assert.equal(t.text(t.q('.vd-rl')), '6 – 12 nov 2026', 'the range label says the new period at once');
  await settle(100);
  assert.ok(!t.q('.vd-body').classList.contains('vd-dim'));
  assert.equal(t.qa('.vd-xl span').length, 7, 'swapped in place');
});
