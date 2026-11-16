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

async function tab({ rids = ['r_a', 'r_b'], keyerFails = false, hold = null, badCsv = false, owned = null } = {}) {
  const win = new JSDOM('<!doctype html><span id="shopname">Pizzería Del Valle</span><main id="host"></main>', { url: 'https://portal.test/', pretendToBeVisual: true }).window;
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? win : win[k], configurable: true, writable: true });
  }
  const serve = await world({ keyerFails });
  const calls = route({ serve }, (fn, q) => {
    if (fn === 'getMyBranches') return okJson(E1(owned || rids));
    if (badCsv && q.format === 'csv') return { ok: true, status: 200, text: async () => 'fecha,otra_cosa\r\n2026-11-01,1\r\n', headers: { get: () => null } };   // a header off the allowlist
    return null;
  });
  const saves = [];   // what the page hands the browser to save: { name, text }
  globalThis.URL.createObjectURL = (blob) => { saves.push({ blob }); return `blob:t${saves.length}`; };   // the module saves through THIS global URL
  globalThis.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function () { const last = saves[saves.length - 1]; if (last) last.name = this.download; };
  const V = await import(`./ventas-tab.js?t=${Date.now()}${Math.random()}`);
  const host = win.document.getElementById('host');
  const T = { hold, onToken: null };
  const token = async () => { if (T.hold) await T.hold; const f = T.onToken; if (f) { T.onToken = null; queueMicrotask(f); } return 'TK-test'; };
  const errors = []; win.addEventListener('error', (e) => errors.push(e.error || e.message));   // a throw inside a click handler
  const ctx = { uid: 'uA', rid: rids[0], name: 'Pizzería Del Valle', token, now: () => NOW };
  V.mountVentasTab(host, ctx);
  await settle(hold ? 10 : 80);
  const q = (s) => host.querySelector(s), qa = (s) => [...host.querySelectorAll(s)];
  const text = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : null);
  // the saved BYTES (Blob.text() would strip a leading BOM — decode with ignoreBOM to see exactly what the browser writes)
  const saved = async () => Promise.all(saves.filter((x) => x.name).map(async (x) => ({ name: x.name, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(await x.blob.arrayBuffer()) })));
  return { win, V, host, calls, q, qa, text, T, saved, serve, ctx, errors, stats: () => calls.filter((c) => /^getSalesStats/.test(c.fn)) };
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
  assert.equal(t.text(t.q('.vd-more')), 'Ver más detalle', 'one quiet row after the products (V3)');
});

test('V1 frame 3 · the period menu: the five presets, the chosen one marked; «Hoy» ⇒ hour buckets and the day in words', async () => {
  const t = await tab();
  t.q('.vd-pill').click(); await settle();
  const opts = t.qa('.vd-menu.vd-show .vd-opt');
  assert.deepEqual(opts.map((o) => t.text(o)), ['Hoy', 'Últimos 7 días', 'Últimos 14 días', 'Últimos 30 días', 'Personalizado'], 'exactly the map\'s presets (Q2), «Personalizado» last (V2)');
  assert.deepEqual(opts.map((o) => o.getAttribute('aria-selected')), ['false', 'false', 'true', 'false', 'false']);
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
  assert.equal(t.text(t.q('.vd-ok')), 'Sin ventas en este períodoProbá con otro período.', 'the calm card, the shipped copy');
  assert.equal(t.q('.vd-card'), null, 'no chart');
  assert.equal(t.q('.vd-prods'), null, 'no products');
});

test('V1 frame 10 · 503 on «Todas»: «—» figures, the shipped error copy, the «never a partial total» sentence, «Reintentar» + «Ver una sucursal» opens the branch menu', async () => {
  const t = await tab({ keyerFails: true });
  assert.deepEqual(figs(t).map(([, v]) => v), ['—', '—', '—'], 'never a number without its answer');
  const c = t.q('.vd-err');
  assert.equal(c.getAttribute('role'), 'alert');
  assert.deepEqual([...c.querySelectorAll(':scope > b, :scope > span')].map((x) => t.text(x)), ['No pudimos cargar las ventas', 'Es un problema nuestro, no tuyo. Probá de nuevo en un momento.', 'Como una de tus sucursales no respondió, no mostramos un total parcial de «Todas las sucursales».'], 'the shipped copy + the «never a partial total» sentence');
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

// ═══ V2 · «Personalizado» (frame 4): Desde / Hasta on the portal calendar; the body untouched until a valid pair ═══════════════════
const choose = async (t, label) => { t.q('.vd-pill').click(); await settle(); t.qa('.vd-menu.vd-show .vd-opt').find((o) => t.text(o) === label).click(); await settle(60); };
const openCal = async (t, which) => { t.qa('.vd-dpbtn')[which === 'from' ? 0 : 1].click(); await settle(); return t.q('.cal-pop'); };
const dayBtn = (pop, n) => [...pop.querySelectorAll('.cal-d')].find((b) => b.querySelector('.cal-num').textContent === String(n));
test('V2 frame 4 · «Personalizado»: the pill says so, the label states the bounds, Desde / Hasta appear empty — the body below is UNTOUCHED (no request, no dimming)', async () => {
  const t = await tab();
  const before = t.stats().length;
  const figsBefore = figs(t);
  await choose(t, 'Personalizado');
  assert.equal(t.text(t.q('.vd-pill')), 'Personalizado');
  assert.equal(t.text(t.q('.vd-rl')), 'Elegí las fechas · hasta dos años, hasta hoy');
  assert.deepEqual(t.qa('.vd-fld > .vd-flab').map((x) => t.text(x)), ['Desde', 'Hasta']);
  assert.deepEqual(t.qa('.vd-dpv').map((x) => [t.text(x), x.classList.contains('vd-ph')]), [['Elegí una fecha', true], ['Elegí una fecha', true]]);
  assert.equal(t.stats().length, before, 'no request');
  assert.ok(!t.q('.vd-body').classList.contains('vd-dim'), 'no dimming');
  assert.deepEqual(figs(t), figsBefore, 'the body below is untouched');
});
test('V2 the portal calendar: Sunday-first, Spanish, ‹ month ▾ year ▾ ›, today dotted, days after today inert; Hasta: days before Desde inert, the range painted while hovering', async () => {
  const t = await tab();
  await choose(t, 'Personalizado');
  let pop = await openCal(t, 'from');
  assert.equal(pop.getAttribute('role'), 'dialog');
  assert.deepEqual([...pop.querySelectorAll('.cal-wk span')].map((x) => x.textContent), ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá']);
  assert.deepEqual([...pop.querySelectorAll('.cal-select')].map((x) => x.selectedOptions[0].textContent), ['Noviembre', '2026'], 'opens on today\'s month');
  assert.ok(dayBtn(pop, 12).querySelector('.cal-tdot'), 'today is dotted');
  assert.equal(dayBtn(pop, 13).disabled, true, 'max = today');
  assert.equal(dayBtn(pop, 12).disabled, false);
  assert.equal(pop.querySelectorAll('.cal-grid > .cal-lead').length, 0, '1 nov 2026 is a Sunday: no lead cells');
  pop.querySelectorAll('.cal-nav')[0].click(); await settle();
  pop = t.q('.cal-pop');
  assert.deepEqual([...pop.querySelectorAll('.cal-select')].map((x) => x.selectedOptions[0].textContent), ['Octubre', '2026']);
  assert.equal(pop.querySelectorAll('.cal-grid > .cal-lead').length, 4, '1 oct 2026 is a Thursday');
  dayBtn(pop, 1).click(); await settle();
  assert.equal(t.q('.cal-pop'), null, 'a pick closes it');
  assert.equal(t.text(t.qa('.vd-dpv')[0]), 'jue 1 oct 2026');
  pop = await openCal(t, 'to');
  assert.deepEqual([...pop.querySelectorAll('.cal-select')].map((x) => x.selectedOptions[0].textContent), ['Octubre', '2026'], 'Hasta opens on Desde\'s month');
  dayBtn(pop, 31).dispatchEvent(new t.win.MouseEvent('mouseover', { bubbles: true })); await settle();
  pop = t.q('.cal-pop');
  assert.ok(dayBtn(pop, 1).classList.contains('cal-rs') && dayBtn(pop, 31).classList.contains('cal-re') && dayBtn(pop, 15).classList.contains('cal-inr'), 'the range painted while hovering');
});
test('V2 a valid pair: ONE request for it, the pill reads the range («1 – 11 nov»), the label adds the year; the body swaps', async () => {
  const t = await tab();
  await choose(t, 'Personalizado');
  const before = t.stats().length;
  let pop = await openCal(t, 'from');
  dayBtn(pop, 1).click(); await settle();
  assert.equal(t.stats().length, before, 'one date is no request');
  pop = await openCal(t, 'to');
  dayBtn(pop, 11).click(); await settle(120);
  assert.equal(t.stats().length, before + 1, 'ONE request, only once both dates are valid');
  const q = t.stats().at(-1).query;
  assert.deepEqual([q.from, q.to], ['2026-11-01', '2026-11-11']);
  assert.equal(t.text(t.q('.vd-pill')), '1 – 11 nov', 'this year: no year on the pill');
  assert.equal(t.text(t.q('.vd-rl')), '1 – 11 nov 2026');
  assert.equal(t.text(t.q('.vd-h2')), 'Ventas por día');
});
test('V2 a pair longer than two years: the shipped line under the fields, NO request, the body untouched', async () => {
  const t = await tab();
  await choose(t, 'Personalizado');
  const before = t.stats().length;
  const V = t.V;
  V._ventasTabState.custom = { from: '2024-01-01', to: null };   // the calendar's year select reaches back past two years
  V._render();
  let pop = await openCal(t, 'to');   // opens on Desde's month (ene 2024): walk the selects to nov 2026
  const [ms, ys] = pop.querySelectorAll('.cal-select');
  ys.value = '2026'; ys.dispatchEvent(new t.win.Event('change')); await settle();
  t.q('.cal-pop').querySelectorAll('.cal-select')[0].value = '10'; t.q('.cal-pop').querySelectorAll('.cal-select')[0].dispatchEvent(new t.win.Event('change')); await settle();
  void ms;
  dayBtn(t.q('.cal-pop'), 12).click(); await settle(80);   // 12 nov 2026
  assert.equal(t.text(t.q('.vd-cerr')), 'Ese período no es válido · Elegí otras fechas', 'the shipped copy (ventasMessage BadRequest)');
  assert.equal(t.stats().length, before, 'no request');
});

// ═══ V3a · «Más detalle» (frames 11 / 11b): its own page; the figures WITH the comparison; every shipped section ════════════════
const toDetail = async (t) => { t.q('.vd-more').click(); await settle(120); };
const kv = (t, sel) => [...t.host.querySelectorAll(`${sel} .vd-kvr`)].map((r) => [t.text(r.querySelector('.vd-kvl')), t.text(r.querySelector('.vd-kvv'))]);
test('V3a «Ver más detalle» opens a page of its own: «Ventas» back, «Más detalle» + its lede, the SAME pills and range; ONE request with the comparison', async () => {
  const t = await tab();
  const n = t.stats().length;
  await toDetail(t);
  assert.equal(t.text(t.q('.vd-back')), 'Ventas');
  assert.equal(t.text(t.q('h1')), 'Más detalle');
  assert.equal(t.text(t.q('.lede')), 'Lo mismo que ves en Ventas, con más contexto: comparación, canales, pagos, horas, clientes, cancelaciones y tiempos.');
  assert.deepEqual(t.qa('.vd-pill').map((p) => t.text(p)), ['Últimos 14 días', 'Todas las sucursales'], 'the scope travels');
  assert.equal(t.text(t.q('.vd-rl')), '30 oct – 12 nov 2026');
  assert.equal(t.stats().length, n + 1, 'ONE request');
  assert.equal(t.stats().at(-1).query.compare, 'previous', 'with the comparison the tab does not show');
  t.q('.vd-back').click(); await settle(80);
  assert.equal(t.text(t.q('h1')), 'Ventas', 'back to the tab');
  assert.ok(t.q('.vd-card'), 'the tab as it was');
});
test('V3a the figures carry the comparison line (the Inicio idiom): «+35.5 % · L 310 del 30 oct al 5 nov», up in mint, down muted — from the REAL deltas', async () => {
  const t = await tab({ rids: ['r_a'] });
  t.q('.vd-pill').click(); await settle(); t.qa('.vd-menu.vd-show .vd-opt')[1].click(); await settle(100);   // «Últimos 7 días»
  await toDetail(t);
  const ks = t.qa('.vd-fig').map((f) => [t.text(f.querySelector('.vd-kl')), t.text(f.querySelector('.vd-ks')), f.querySelector('.vd-ks').classList.contains('vd-up')]);
  assert.deepEqual(ks[0], ['Ventas', '+35.5 % · L 310 del 30 oct al 5 nov', true]);
  assert.deepEqual(ks[1], ['Pedidos', '+100.0 % · 1 del 30 oct al 5 nov', true]);
  assert.equal(ks[2][2], false, 'a ticket that fell reads muted');
  assert.match(ks[2][1], /^−\d+\.\d % · L \d+ del 30 oct al 5 nov$/, 'a true minus sign');
});
test('V3a every shipped section, one job each, from the REAL answer (one branch): Entrega y recogida · Forma de pago · Horas de más pedidos · Clientes · Cancelaciones · Tiempos · the footnote', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  assert.deepEqual(t.qa('.vd-dsect h2').map((h) => t.text(h)), ['Entrega y recogida', 'Forma de pago', 'Horas de más pedidos', 'Clientes', 'Cancelaciones', 'Tiempos', 'Descargar'], 'every shipped section, «Descargar» last (V3b)');
  assert.ok(t.q('.vd-split'), 'one segmented bar');
  assert.ok(kv(t, '.vd-type').every(([l]) => /^(A domicilio|Para recoger) · \d+ %$/.test(l)), 'the share of ALL sales, «78 %»');
  assert.deepEqual(t.qa('.vd-pay .vd-payl span:first-child').map((x) => t.text(x).split(' · ')[0]), ['Efectivo', 'Tarjeta al entregar', 'En línea']);
  assert.equal(t.qa('.vd-heat .vd-hd').length, 7, 'Lun–Dom');
  assert.match(t.text(t.q('.vd-peak')), /^pico: (lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d{1,2}:00 · \d+ pedidos?$/);
  assert.equal(t.text(t.q('.vd-hcap')), 'Pedidos por día y hora · hora de Honduras · el período sumado.', 'Q-V3b');
  assert.deepEqual(kv(t, '.vd-cust').map(([l]) => l), ['Nuevos', 'Recurrentes']);
  assert.deepEqual(kv(t, '.vd-canc').map(([l]) => l), ['Tasa de cancelación', 'Canceladas', 'Reembolsadas', 'Reembolso pendiente']);
  assert.deepEqual(kv(t, '.vd-times').map(([l]) => l), ['Preparación', 'Entrega']);
  assert.match(t.text(t.q('.vd-foot')), /^Una venta se cuenta cuando el pedido se registra \(efectivo o tarjeta al entregar\) o cuando el pago en línea se confirma, en el día en que se sirve\. Los últimos 7 días se recalculan cada noche\. Actualizado: (en vivo|hoy, \d{1,2}:\d{2} [ap]\. m\.)\.?/, 'the shipped footnote + its stamp (Q-V3c)');
});
test('V3a «Todas»: Clientes says «Por sucursal» (the multi read omits customers) and offers to pick one — the branch menu opens', async () => {
  const t = await tab();
  await toDetail(t);
  assert.equal(t.text(t.q('.vd-cust .vd-softp span')), 'Por sucursal. Elegí una sucursal arriba para ver clientes nuevos y recurrentes.');
  [...t.host.querySelectorAll('.vd-cust .vd-lnk')].find((b) => t.text(b) === 'Elegir sucursal').click(); await settle();
  assert.ok(t.q('.vd-menu.vd-show'), 'the branch menu opens');
});

// ═══ V3b · «Descargar» + the shipped page's safety, carried over before ventas.js hands the page to the tab ════════════════════════
const dl = (t, label) => [...t.host.querySelectorAll('.vd-file')].find((r) => t.text(r.querySelector('.vd-fileb')) === label).querySelector('.vd-lnk');
const csvCalls = (t) => t.stats().filter((c) => c.query.format === 'csv');
test('V3b «Descargar» (one branch): the two shipped exports — the daily CSV saved byte-for-byte behind a BOM, under the server\'s file name', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  assert.deepEqual(t.qa('.vd-dsect h2').map((h) => t.text(h)).at(-1), 'Descargar');
  assert.deepEqual(t.qa('.vd-file').map((r) => [t.text(r.querySelector('.vd-fileb')), t.text(r.querySelector('.vd-filed'))]),
    [['Resumen diario (CSV)', 'Totales por día del período elegido.'], ['Pedidos (CSV)', 'Detalle por pedido · hasta 31 días por descarga.']]);
  dl(t, 'Resumen diario (CSV)').click(); await settle(150);
  const [f] = await t.saved();
  assert.equal(f.name, 'ventas_r_a_2026-10-30_2026-11-12.csv', 'the server\'s file name');
  assert.ok(f.text.startsWith('\uFEFFfecha,ventas_L,'), `a BOM, then the server's exact header (${JSON.stringify(f.text.slice(0, 30))})`);
  dl(t, 'Pedidos (CSV)').click(); await settle(150);
  assert.equal((await t.saved())[1].name, 'pedidos_r_a_2026-10-30_2026-11-12.csv');
});
test('V3b orders over 31 days: refused BEFORE any request, with the shipped sentence', async () => {
  const t = await tab({ rids: ['r_a'] });
  await choose(t, 'Personalizado');
  let pop = await openCal(t, 'from'); pop.querySelectorAll('.cal-nav')[0].click(); await settle(); dayBtn(t.q('.cal-pop'), 1).click(); await settle();
  pop = await openCal(t, 'to'); pop.querySelectorAll('.cal-nav')[1].click(); await settle(); dayBtn(t.q('.cal-pop'), 12).click(); await settle(120);   // 1 oct – 12 nov: 43 days
  await toDetail(t);
  const n = csvCalls(t).length;
  dl(t, 'Pedidos (CSV)').click(); await settle(80);
  assert.equal(csvCalls(t).length, n, 'no request');
  assert.equal(t.text(t.q('.vd-csvnote')), 'El detalle de pedidos se descarga de hasta 31 días por vez. Elegí un período más corto.');
  assert.equal((await t.saved()).length, 0);
});
test('V3b the CSV allowlist: a header off the reviewed list is NEVER saved (the shipped note)', async () => {
  const t = await tab({ rids: ['r_a'], badCsv: true });
  await toDetail(t);
  dl(t, 'Resumen diario (CSV)').click(); await settle(120);
  assert.equal((await t.saved()).length, 0, 'nothing saved');
  assert.equal(t.text(t.q('.vd-csvnote')), 'No pudimos preparar el archivo. Avisanos y lo revisamos.');
});
test('V3b «Todas»: «Descargar» is per branch (the server exports one branch) — «Por sucursal …» + «Elegir sucursal» (Q-V3a)', async () => {
  const t = await tab();
  await toDetail(t);
  assert.equal(t.text(t.q('.vd-dl .vd-softp span')), 'Por sucursal. Elegí una sucursal arriba para descargar.');
  assert.equal(t.qa('.vd-file').length, 0, 'no export on «Todas»');
  [...t.host.querySelectorAll('.vd-dl .vd-lnk')].find((b) => t.text(b) === 'Elegir sucursal').click(); await settle();
  assert.ok(t.q('.vd-menu.vd-show'), 'the branch menu opens');
});
test('V3b 🔴 a sign-out INSIDE the token await (the last await before a request) sends NOTHING — a load and an export', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  let release; t.T.hold = new Promise((r) => { release = r; });
  const n = t.stats().length;
  dl(t, 'Resumen diario (CSV)').click(); await settle(10);
  t.q('.vd-pill').click(); await settle(); t.qa('.vd-menu.vd-show .vd-opt')[0].click(); await settle(10);   // a load, waiting on the token too
  t.win.document.dispatchEvent(new t.win.CustomEvent('portal:auth', { detail: { uid: 'otra' } }));
  release(); await settle(120);
  assert.equal(t.stats().length, n, 'not one request left after the auth change');
  assert.equal((await t.saved()).length, 0, 'nothing saved');
});
test('V3b 🔴 an auth change queued as a MICROTASK between the token and the fetch sends NOTHING (codex S2 r2, carried over)', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  const n = t.stats().length;
  t.T.onToken = () => t.win.document.dispatchEvent(new t.win.CustomEvent('portal:auth', { detail: { uid: null } }));
  dl(t, 'Resumen diario (CSV)').click(); await settle(120);
  assert.equal(t.stats().length, n, 'no request');
  assert.equal((await t.saved()).length, 0);
});
test('V3b a 403 (a branch the account does not own): the shipped owner-only message, and no export is offered', async () => {
  const t = await tab({ rids: ['r_zz'], owned: ['r_zz'] });
  assert.match(t.text(t.q('.vd-err b')), /^(Solo el dueño ve las ventas|No tenés acceso a este local)$/, 'the shipped NotAuthorized copy');
  assert.equal(t.qa('.vd-err button').length, 0, 'nothing to retry: the server is the authority');
  assert.equal(t.q('.vd-more'), null, 'no «Más detalle», so no export is offered');
});

// ═══ Codex r1 (dfa77abd7..c27397ed6): one cell per finding ═════════════════════════════════════════════════════════════════════════
const rendKeys = (t) => Object.keys(t.win.sessionStorage).filter((k) => k.startsWith('sherpa.portal.rend.'));
test('R1 P1 🔴 a 401/403 while a CACHED body is showing: the sales leave the screen, the cache is cleared, exports refused — never the cached figures under a refusal', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);   // the detail body (14 d, with the comparison) is now cached
  await choose(t, 'Últimos 7 días');
  assert.ok(rendKeys(t).length >= 2, 'precondition: bodies cached');
  t.serve.revoke('r_a');   // the REAL authorizer now refuses this owner
  await choose(t, 'Últimos 14 días'); await settle(100);   // the cache paints the 14-day body first, then the server says 403
  assert.deepEqual(figs(t).map(([, v]) => v), ['—', '—', '—'], 'no cached figure stays under a refusal');
  assert.match(t.text(t.q('.vd-err b')), /^(Solo el dueño ve las ventas|No tenés acceso a este local)$/, 'the shipped owner-only copy');
  assert.equal(t.q('.vd-heat'), null, 'no cached section stays');
  assert.ok(t.qa('.vd-file .vd-lnk').every((b) => b.disabled), 'no export is offered enabled');
  assert.equal(t.V._ventasTabState.refused.has('r_a'), true, 'the export handler refuses too (the refused scope: r_a)');
  assert.deepEqual(rendKeys(t), [], 'the protected bodies leave the session cache');
});
test('R2 P2 a cancelled export (the period changed mid-export) releases «Preparando…»: the exports work again for the new period', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  let release; t.T.hold = new Promise((r) => { release = r; });
  dl(t, 'Resumen diario (CSV)').click(); await settle(10);
  assert.equal(t.text(dl(t, 'Resumen diario (CSV)')), 'Preparando…', 'precondition: the export is running');
  t.q('.vd-pill').click(); await settle(); t.qa('.vd-menu.vd-show .vd-opt')[1].click(); await settle(10);   // «Últimos 7 días»: the export is cancelled
  assert.deepEqual(t.qa('.vd-file .vd-lnk').map((b) => [t.text(b), b.disabled]), [['Descargar', false], ['Descargar', false]], 'a cancelled export holds nothing');
  t.T.hold = null; release(); await settle(150);
  assert.equal((await t.saved()).length, 0, 'the cancelled export saved nothing');
  dl(t, 'Resumen diario (CSV)').click(); await settle(150);
  assert.deepEqual((await t.saved()).map((f) => f.name), ['ventas_r_a_2026-11-06_2026-11-12.csv'], 'a new export, of the new period');
});
test('R3 P2 a zero-sales period keeps its CSV exports (independent of totals, as on the shipped page): the tab offers «Ver más detalle», «Descargar» saves', async () => {
  const t = await tab({ rids: ['r_b'] });
  await choose(t, 'Hoy'); await settle(60);   // r_b sold nothing today
  assert.equal(t.text(t.q('.vd-ok b')), 'Sin ventas en este período', 'precondition: the honest empty');
  assert.ok(t.q('.vd-more'), 'the way to «Más detalle» stays');
  await toDetail(t);
  assert.deepEqual(t.qa('.vd-file .vd-lnk').map((b) => b.disabled), [false, false], 'both exports offered');
  dl(t, 'Resumen diario (CSV)').click(); await settle(150);
  assert.deepEqual((await t.saved()).map((f) => f.name), ['ventas_r_b_2026-11-12_2026-11-12.csv']);
});
test('R4 P2 a period the roll-up never computed (every day in missing_days) is UNAVAILABLE, not zero: no «L 0», no «Sin ventas», the missing-data disclosure', async () => {
  const t = await tab({ rids: ['r_a'] });
  await choose(t, 'Personalizado');
  let pop = await openCal(t, 'from'); pop.querySelectorAll('.cal-nav')[0].click(); await settle(); dayBtn(t.q('.cal-pop'), 30).click(); await settle();
  pop = await openCal(t, 'to'); dayBtn(pop, 31).click(); await settle(150);   // 30 – 31 oct: before the roll-up's first day
  assert.deepEqual([t.stats().at(-1).query.from, t.stats().at(-1).query.to], ['2026-10-30', '2026-10-31']);
  assert.deepEqual(figs(t).map(([, v]) => v), ['—', '—', '—'], 'unavailable ≠ zero');
  assert.ok(!/Sin ventas/.test(t.text(t.q('.vd-body'))), 'never «Sin ventas» for days nobody computed');
  assert.match(t.text(t.q('.vd-body')), /Aún sin calcular: 30 oct, 31 oct/, 'the missing-data disclosure');
});
test('R5 P2 branch discovery is bound to its mount: a period change before it lands loads ONCE; an unmount before it sends sends nothing', async () => {
  let release; const hold = new Promise((r) => { release = r; });
  const t = await tab({ rids: ['r_a'], hold });
  t.q('.vd-pill').click(); await settle(); t.qa('.vd-menu.vd-show .vd-opt')[1].click(); await settle(10);   // «Últimos 7 días» while discovery waits
  t.T.hold = null; release(); await settle(150);
  assert.deepEqual(t.stats().map((c) => c.query.from), ['2026-11-06'], 'ONE load: the period the owner chose — never a second one from the late discovery');
  let r2; t.T.hold = new Promise((r) => { r2 = r; });
  const n = t.calls.filter((c) => c.fn === 'getMyBranches').length;
  t.V.mountVentasTab(t.host, t.ctx); await settle(10);
  t.V.unmountVentasTab();
  t.T.hold = null; r2(); await settle(100);
  assert.equal(t.calls.filter((c) => c.fn === 'getMyBranches').length, n, 'an unmounted page discovers nothing');
});
test('R6 P2 «Personalizado» chosen BEFORE the first answer: no crash — the pill, Desde / Hasta and the reserved frame paint; the answer still lands', async () => {
  let release; const hold = new Promise((r) => { release = r; });
  const t = await tab({ rids: ['r_a'], hold });
  t.q('.vd-pill').click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt').find((o) => t.text(o) === 'Personalizado').click(); await settle(10);
  assert.deepEqual(t.errors.map(String), [], 'no throw');
  assert.equal(t.text(t.q('.vd-pill')), 'Personalizado');
  assert.equal(t.qa('.vd-dpbtn').length, 2, 'Desde / Hasta');
  assert.equal(t.qa('.vd-fig .vd-skn').length, 3, 'the reserved frame');
  t.T.hold = null; release(); await settle(150);
  assert.deepEqual(t.errors.map(String), [], 'no throw when the answer lands');
});
// ═══ Codex r2: the two reproductions (verbatim scenarios) + the in-flight export across a refusal ═════════════════════════════════
// hold one class of request: `before` ⇒ held BEFORE the server sees it (it is judged after a later revoke); else served, then held
function holdFetch(match, { before = false } = {}) {
  const original = globalThis.fetch; let release, arrived;
  const held = new Promise((r) => { release = r; }), started = new Promise((r) => { arrived = r; });
  globalThis.fetch = async (u, o) => {
    if (!match(new URL(u).searchParams)) return original(u, o);
    if (before) { arrived(); await held; return original(u, o); }
    const res = await original(u, o); arrived(); await held; return res;
  };
  return { release: () => release(), started, restore: () => { globalThis.fetch = original; } };
}
test('R7 P1 🔴 an OLDER successful answer landing after a 403 never refills the cleared cache — the protected figures never come back', async () => {
  const t = await tab({ rids: ['r_a'] });
  const h = holdFetch((q) => q.get('from') === '2026-11-06' && q.get('format') !== 'csv');   // the 7-day answer: served (owner then), held
  await choose(t, 'Últimos 7 días'); await h.started;
  t.serve.revoke('r_a');
  await choose(t, 'Últimos 14 días'); await settle(80);   // the server now refuses: deny()
  assert.equal(t.V._ventasTabState.status, 'denied', 'precondition: refused');
  assert.deepEqual(rendKeys(t), [], 'precondition: the cache cleared');
  h.release(); await settle(100);
  assert.deepEqual(rendKeys(t), [], 'late successful response must not repopulate denied cache');
  h.restore();
  await choose(t, 'Últimos 7 días'); await settle(100);
  assert.deepEqual(figs(t).map(([, v]) => v), ['—', '—', '—'], 'protected figures must not reappear after denial');
});
test('R7b P1 🔴 an export already answered when the refusal lands is NOT saved (an export is bound to the same ticket)', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  t.q('.vd-back').click(); await settle(80);
  const st = holdFetch((q) => q.get('format') !== 'csv' && q.get('compare') === 'previous', { before: true });   // the detail read: judged later
  const csv = holdFetch((q) => q.get('format') === 'csv');   // the export: served while still the owner, held
  t.q('.vd-more').click(); await settle(30);   // the cached detail paints at once, exports offered; its revalidate is held
  dl(t, 'Resumen diario (CSV)').click(); await csv.started;
  t.serve.revoke('r_a');
  st.release(); await settle(80);   // the detail read: 403 ⇒ deny()
  assert.equal(t.V._ventasTabState.status, 'denied', 'precondition: refused');
  csv.release(); await settle(120);
  assert.equal((await t.saved()).length, 0, 'a file of protected sales is never saved after the refusal');
  csv.restore(); st.restore();
});
test('R8 P2 a 403 on «Todas» refuses only THAT scope: a branch the owner still has loads and exports', async () => {
  const t = await tab();
  t.serve.revoke('r_a');
  await choose(t, 'Últimos 7 días'); await settle(80);
  assert.equal(t.V._ventasTabState.status, 'denied', 'precondition: «Todas» refused');
  t.qa('.vd-pill')[1].click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt').find((o) => t.text(o) === 'Sur').click(); await settle(100);
  assert.equal(t.V._ventasTabState.status, 'ok', 'precondition: Sur loads');
  await toDetail(t);
  assert.deepEqual(t.qa('.vd-file .vd-lnk').map((b) => b.disabled), [false, false], 'authorized branch exports should recover');
  dl(t, 'Resumen diario (CSV)').click(); await settle(150);
  assert.deepEqual((await t.saved()).map((f) => f.name), ['ventas_r_b_2026-11-06_2026-11-12.csv'], 'and they work');
});
test('R8b P2 a successful authorised load lifts the refusal: the owner gets the branch back ⇒ its exports work again', async () => {
  const t = await tab({ rids: ['r_a'] });
  await toDetail(t);
  t.serve.revoke('r_a');
  await choose(t, 'Últimos 7 días'); await settle(80);
  assert.equal(t.V._ventasTabState.status, 'denied', 'precondition: refused');
  t.serve.grant('r_a');
  await choose(t, 'Últimos 14 días'); await settle(100);
  assert.equal(t.V._ventasTabState.status, 'ok', 'precondition: served again');
  assert.deepEqual(t.qa('.vd-file .vd-lnk').map((b) => b.disabled), [false, false], 'a successful authorised load lifts the refusal');
});
test('V2b «Personalizado» without a pair, then a branch switch and «Más detalle»: still nothing requested, no dimming, no throw (the load guard)', async () => {
  const t = await tab();
  await choose(t, 'Personalizado');
  const before = t.stats().length;
  const figsBefore = figs(t);
  t.qa('.vd-pill')[1].click(); await settle();
  t.qa('.vd-menu.vd-show .vd-opt').find((o) => t.text(o) === 'Sur').click(); await settle(60);
  assert.deepEqual(figs(t), figsBefore, 'a switch without a valid pair leaves the body untouched');
  assert.notEqual(t.V._ventasTabState.status, 'error', 'and never turns it into an error');
  assert.equal(t.stats().length, before, 'a branch switch without a valid pair requests nothing');
  assert.ok(!t.q('.vd-body').classList.contains('vd-dim'), 'and dims nothing');
  await toDetail(t); await settle(60);
  assert.equal(t.stats().length, before, '«Más detalle» without a valid pair requests nothing');
  assert.deepEqual(t.errors.map(String), [], 'no throw');
});
