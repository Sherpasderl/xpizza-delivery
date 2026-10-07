// Stats S2 — the Ventas page, EXECUTED. Run: node --test xpizza-portal/ventas.test.mjs
//
// The REAL app.js and the REAL ventas.js run together (auth stubbed, fetch stubbed), driven through the
// same shell events boot.js fires: portal:auth → portal:signed-in → app.js's getMyRestaurants →
// portal:restaurant. So the owner gate below is proven through the actual provenance chain, not by
// dispatching the event a test would like to have seen.
//
// 🔴 OWNER-ONLY (owner ruling 2026-10-05), BOTH WAYS:
//   • a non-owner (getMyRestaurants → [], or a 403/503) never sees the nav, cannot open the page even by
//     firing the hidden button's listener, and getSalesStats is NEVER called;
//   • an owner sees the nav, and only opening the page calls getSalesStats — for the announced rid.
// 🔴 CSV ALLOWLIST: a file is saved only if its header is EXACTLY the reviewed columns.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIR, installDom, installFetch, loadModules, okJson, errJson, okCsv, settle, textOf, byClass, hasClass, captureDownloads,
} from './ventas-harness.mjs';
import { CSV_HEADERS, todayHN, addDays } from './ventas-logic.js';

const MENU = () => okJson({ source: { restaurant_id: 'x_pizza', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const STATS = () => okJson({ kpis: { sales_cents: 3814600, orders: 158, average_paid_ticket_cents: 24100 }, deltas: { sales_pct: 12.4, orders_pct: 8.2, average_paid_ticket_pct: -1.9 }, comparison: { range: { from: '2026-09-22', to: '2026-09-28' }, kpis: {}, series: [] }, series: [], days: [], missing_days: [] });
const DAILY_HEADER = CSV_HEADERS.daily.join(',');
const ORDERS_HEADER = CSV_HEADERS.orders.join(',');

function routes(over = {}) {
  return (fn, q) => {
    if (over[fn]) return over[fn](q);
    if (fn === 'getMyRestaurants') return okJson({ restaurants: [{ rid: 'x_pizza', name: 'X. Pizza' }] });
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getSalesStats') return q.format === 'csv' ? okCsv(`${q.kind === 'orders' ? ORDERS_HEADER : DAILY_HEADER}\r\n`) : STATS();
    return errJson(404, { error: 'not_found' });
  };
}
async function signIn(uid) {
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle();
}
const statsCalls = (calls) => calls.filter((c) => c.fn === 'getSalesStats');
const gateOpen = (byId) => !hasClass(byId.get('navventas'), 'hidden') && !hasClass(byId.get('navbiz'), 'hidden') && hasClass(byId.get('mnav'), 'show');
const gateShut = (byId) => hasClass(byId.get('navventas'), 'hidden') && hasClass(byId.get('navbiz'), 'hidden') && !hasClass(byId.get('mnav'), 'show');
async function forceOpen(byId) {   // fire the hidden controls' listeners anyway: hiding is not the gate
  for (const id of ['navventas', 'mnventas']) for (const fn of byId.get(id).listeners.click || []) fn({ type: 'click' });
  await settle();
}

test('both modules EVALUATE together and wire the shell (nav + mobile pair)', async () => {
  const byId = installDom();
  installFetch(routes());
  await loadModules();
  for (const id of ['navprod', 'navventas', 'mnprod', 'mnventas']) assert.strictEqual((byId.get(id).listeners.click || []).length, 1, `#${id} has its one click listener`);
  assert.ok(gateShut(byId), 'before anyone signs in, the Ventas nav is hidden');
});

test('🔴 NON-OWNER (owns nothing): no nav, cannot open the page, getSalesStats NEVER called', async () => {
  const byId = installDom();
  const calls = installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
  await loadModules();
  await signIn('staff_uid');
  assert.ok(calls.some((c) => c.fn === 'getMyRestaurants'), 'non-vacuity: the real restaurant lookup ran');
  assert.ok(gateShut(byId), 'the Ventas nav, its group label and the mobile pair stay hidden');
  await forceOpen(byId);
  assert.ok(hasClass(byId.get('viewventas'), 'hidden') && !hasClass(byId.get('viewmenu'), 'hidden'), 'firing the hidden button does not open the page');
  assert.deepStrictEqual(statsCalls(calls), [], '🔴 getSalesStats was never called');
});

test('🔴 NON-OWNER whose lookup is refused (403) or down (503): same — shut, and no stats call', async () => {
  for (const res of [() => errJson(403, { error: 'not_authorized' }), () => errJson(503, { error: 'read_unavailable' })]) {
    const byId = installDom();
    const calls = installFetch(routes({ getMyRestaurants: res }));
    await loadModules();
    await signIn('disp_uid');
    await forceOpen(byId);
    assert.ok(gateShut(byId));
    assert.deepStrictEqual(statsCalls(calls), []);
  }
});

test('🔴 OWNER: the nav appears; getSalesStats is called only on opening, for the announced rid', async () => {
  const byId = installDom();
  const calls = installFetch(routes());
  await loadModules();
  await signIn('owner_uid');
  assert.ok(gateOpen(byId), 'the owner sees Negocio → Ventas (and the mobile pair)');
  assert.deepStrictEqual(statsCalls(calls), [], 'lazy: nothing is fetched until the page is opened');
  byId.get('navventas').click();
  await settle();
  assert.ok(!hasClass(byId.get('viewventas'), 'hidden') && hasClass(byId.get('viewmenu'), 'hidden'), 'the Ventas view replaces the menu view');
  assert.ok(hasClass(byId.get('navventas'), 'on') && !hasClass(byId.get('navprod'), 'on'), 'the active nav item moves');
  assert.strictEqual(byId.get('navventas').getAttribute('aria-current'), 'page');
  const s = statsCalls(calls);
  assert.strictEqual(s.length, 1);
  const t = todayHN(Date.now());
  assert.deepStrictEqual({ rid: s[0].query.restaurantId, from: s[0].query.from, to: s[0].query.to, granularity: s[0].query.granularity, compare: s[0].query.compare },
    { rid: 'x_pizza', from: addDays(t, -6), to: t, granularity: 'day', compare: 'previous' }, 'the default period is "Últimos 7 días" vs. the period before');
  assert.strictEqual(s[0].auth, 'Bearer TK-test', 'the bearer rides in the header');
  assert.ok(!/TK-test/.test(s[0].url), '…never in the URL');
  const text = textOf(byId.get('viewventas'));
  for (const want of ['Ventas', 'Cómo se está vendiendo X. Pizza en el período que elijas.', 'L 38,146', '158', 'L 241', '12.4%', '8.2%', '1.9%', 'vs. período anterior', 'Resumen diario (CSV)', 'Pedidos (CSV)']) {
    assert.ok(text.includes(want), `rendered: ${want}`);
  }
  assert.ok(!text.includes('Datos de ejemplo'), 'the mockup\'s sample-data note is dropped (owner deviation 2)');
  assert.ok(hasClass(byId.get('app'), 'vview'), 'the shell knows Ventas is showing (the menu review bar steps aside)');
  byId.get('navprod').click();
  assert.ok(hasClass(byId.get('viewventas'), 'hidden') && !hasClass(byId.get('viewmenu'), 'hidden'), 'Productos returns to the menu');
  assert.ok(!hasClass(byId.get('app'), 'vview'), '…and the review bar is back under app.js\'s own .show control');
});

test('🔴 sign-out / a different person closes the page, hides the nav, and drops a late answer', async () => {
  const byId = installDom();
  let release;
  const calls = installFetch(routes({ getSalesStats: () => new Promise((r) => { release = () => r(STATS()); }) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  assert.ok(typeof release === 'function', 'non-vacuity: the stats request is in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  assert.ok(gateShut(byId) && hasClass(byId.get('viewventas'), 'hidden'), 'signed out → shut and back on the menu view');
  release();
  await settle();
  assert.strictEqual(byId.get('viewventas').children.length, 0, '🔴 the late answer painted nothing for the ended session');
  // another person who owns nothing signs in on the same browser
  installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
  await signIn('someone_else');
  assert.ok(gateShut(byId), 'the next person (not an owner) does not inherit the nav');
  void calls;
});

test('a 403 not_owner from getSalesStats renders the owner-only message (server is the authority)', async () => {
  const byId = installDom();
  installFetch(routes({ getSalesStats: () => errJson(403, { error: 'not_owner' }) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const text = textOf(byId.get('viewventas'));
  assert.ok(text.includes('Solo el dueño ve las ventas'), text);
  assert.strictEqual(byId.get('viewventas').children.length > 0, true);
});

test('loading and error states use the portal .empty pattern; a stale answer never paints over a newer one', async () => {
  const byId = installDom();
  const pending = [];
  installFetch(routes({ getSalesStats: (q) => new Promise((r) => pending.push({ q, r })) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  assert.ok(textOf(byId.get('viewventas')).includes('Cargando ventas…'), 'loading state');
  const hoy = byClass(byId.get('viewventas'), 'vpre')[0];
  assert.strictEqual(textOf(hoy), 'Hoy');
  hoy.click();
  await settle();
  assert.strictEqual(pending.length, 2);
  assert.strictEqual(pending[1].q.compare, 'previous_week', '"Hoy" compares with the same day last week');
  pending[1].r(errJson(503, { error: 'stats_unavailable' }));
  await settle();
  pending[0].r(STATS());                                       // the OLD 7-day answer arrives last
  await settle();
  const text = textOf(byId.get('viewventas'));
  assert.ok(text.includes('No pudimos cargar las ventas'), 'the newest answer (an outage) is what shows');
  assert.ok(!text.includes('L 38,146'), '🔴 the stale 7-day answer did not paint over it');
});

test('🔴 CSV allowlist: an exact header is saved byte-for-byte; ANY other header is never saved', async () => {
  for (const [label, header, saved] of [
    ['exact daily header', DAILY_HEADER, true],
    ['an extra column', `${DAILY_HEADER},telefono`, false],
    ['a renamed column', DAILY_HEADER.replace('clientes,', 'cliente_nombre,'), false],
    ['a dropped column', CSV_HEADERS.daily.slice(1).join(','), false],
    ['an error page', '<html>', false],
  ]) {
    const byId = installDom();
    const dl = captureDownloads();
    const body = `${header}\r\n2026-10-05,381.46,2,190.73,331.70,49.76,381.46,0.00,0.00,0.00,2,0,0,0,0,0,2,1,live\r\n`;
    const calls = installFetch(routes({ getSalesStats: (q) => (q.format === 'csv' ? okCsv(body, { filename: 'ventas_x_pizza_a_b.csv' }) : STATS()) }));
    await loadModules();
    await signIn('owner_uid');
    byId.get('navventas').click();
    await settle();
    const [daily] = byClass(byId.get('viewventas'), 'btn');
    assert.strictEqual(textOf(daily), 'Resumen diario (CSV)');
    daily.click();
    await settle();
    const csv = statsCalls(calls).filter((c) => c.query.format === 'csv');
    assert.strictEqual(csv.length, 1, `${label}: one export request`);
    assert.strictEqual(csv[0].query.kind, 'daily');
    await dl.read();
    dl.restore();
    if (saved) {
      assert.strictEqual(dl.saved.length, 1, `${label}: saved`);
      assert.deepStrictEqual([...dl.saved[0].bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'a UTF-8 BOM leads the file (Excel accents)');
      assert.ok(dl.saved[0].bytes.subarray(3).equals(Buffer.from(body, 'utf8')), 'then byte-for-byte the server body');
      assert.strictEqual(dl.saved[0].name, 'ventas_x_pizza_a_b.csv', 'the server\'s filename');
      assert.ok(dl.saved[0].clicked, 'and the download was triggered');
    } else {
      assert.strictEqual(dl.saved.length, 0, `🔴 ${label}: NOT saved`);
      assert.ok(textOf(byId.get('viewventas')).includes('No pudimos preparar el archivo'), `${label}: the merchant is told`);
    }
  }
});

test('orders CSV: pages joined into ONE file (header once, every row), cursor threaded; > 31 days refused before any request', async () => {
  const byId = installDom();
  const dl = captureDownloads();
  const p1 = `${ORDERS_HEADER}\r\n2026-10-05,12:00,1,delivery,cash,sale,100.00,86.96,13.04,1x Pizza\r\n`;
  const p2 = `${ORDERS_HEADER}\r\n2026-10-05,13:00,2,pickup,online,sale,50.00,43.48,6.52,1x Pan\r\n`;
  const calls = installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : q.cursor ? okCsv(p2) : okCsv(p1, { next: 'C1', filename: 'pedidos_x.csv' })) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const orders = byClass(byId.get('viewventas'), 'btn')[1];
  assert.strictEqual(textOf(orders), 'Pedidos (CSV)');
  orders.click();
  await settle();
  const csv = statsCalls(calls).filter((c) => c.query.format === 'csv');
  assert.deepStrictEqual(csv.map((c) => [c.query.kind, c.query.cursor || null]), [['orders', null], ['orders', 'C1']]);
  await dl.read();
  assert.strictEqual(dl.saved.length, 1);
  assert.strictEqual(dl.saved[0].text, `\uFEFF${ORDERS_HEADER}\r\n2026-10-05,12:00,1,delivery,cash,sale,100.00,86.96,13.04,1x Pizza\r\n2026-10-05,13:00,2,pickup,online,sale,50.00,43.48,6.52,1x Pan\r\n`);
  assert.strictEqual(dl.saved[0].name, 'pedidos_x.csv');

  // a page whose header drifted mid-export poisons the whole file
  const byId2 = installDom();
  const dl2 = captureDownloads();
  installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : q.cursor ? okCsv(`${ORDERS_HEADER},telefono\r\n`) : okCsv(p1, { next: 'C1' })) }));
  await loadModules();
  await signIn('owner_uid');
  byId2.get('navventas').click();
  await settle();
  byClass(byId2.get('viewventas'), 'btn')[1].click();
  await settle();
  await dl2.read();
  assert.strictEqual(dl2.saved.length, 0, '🔴 a bad second page → nothing saved');

  // > 31 days: "Este mes" can be ≤ 31; "Últimos 30 días" is 30 — use a custom 40-day range
  const byId3 = installDom();
  const calls3 = installFetch(routes());
  await loadModules();
  await signIn('owner_uid');
  byId3.get('navventas').click();
  await settle();
  const custom = byClass(byId3.get('viewventas'), 'vpre').find((b) => textOf(b) === 'Personalizado');
  custom.click();
  await settle();
  const [from, to] = byClass(byId3.get('viewventas'), 'vdate');
  const t = todayHN(Date.now());
  from.value = addDays(t, -39); for (const fn of from.listeners.change) fn();
  to.value = t; for (const fn of to.listeners.change) fn();
  await settle();
  const before = statsCalls(calls3).filter((c) => c.query.format === 'csv').length;
  byClass(byId3.get('viewventas'), 'btn')[1].click();
  await settle();
  assert.strictEqual(statsCalls(calls3).filter((c) => c.query.format === 'csv').length, before, 'no request for an over-long orders export');
  assert.ok(textOf(byId3.get('viewventas')).includes('hasta 31 días por vez'));
  dl.restore(); dl2.restore();
});

test('custom range: invalid input is explained and never requested; a valid one loads that range', async () => {
  const byId = installDom();
  const calls = installFetch(routes());
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  byClass(byId.get('viewventas'), 'vpre').find((b) => textOf(b) === 'Personalizado').click();
  await settle();
  const n0 = statsCalls(calls).length;
  assert.ok(textOf(byId.get('viewventas')).includes('Elegí las fechas'), 'no range yet → a prompt, not a request');
  const [from, to] = byClass(byId.get('viewventas'), 'vdate');
  from.value = '2026-09-10'; for (const fn of from.listeners.change) fn();
  to.value = '2026-09-01'; for (const fn of to.listeners.change) fn();
  await settle();
  assert.strictEqual(statsCalls(calls).length, n0, 'an inverted range is never requested');
  assert.ok(textOf(byId.get('viewventas')).includes('La fecha final es anterior a la inicial.'));
  to.value = '2026-09-20'; for (const fn of to.listeners.change) fn();
  await settle();
  const last = statsCalls(calls).pop();
  assert.deepStrictEqual([last.query.from, last.query.to, last.query.compare], ['2026-09-10', '2026-09-20', 'previous']);
});

test('the compare select overrides the default; "Sin comparar" hides the deltas', async () => {
  const byId = installDom();
  const calls = installFetch(routes({ getSalesStats: (q) => okJson({ kpis: { sales_cents: 100, orders: 1, average_paid_ticket_cents: 100 }, deltas: q.compare === 'none' ? undefined : { sales_pct: 1, orders_pct: 1, average_paid_ticket_pct: 1 }, comparison: q.compare === 'none' ? null : { range: { from: 'a', to: 'b' }, series: [] }, series: [], days: [], missing_days: [] }) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const sel = byClass(byId.get('viewventas'), 'vsel')[0];
  assert.strictEqual(sel.value, 'previous');
  sel.value = 'none'; for (const fn of sel.listeners.change) fn();
  await settle();
  assert.strictEqual(statsCalls(calls).pop().query.compare, 'none');
  assert.strictEqual(byClass(byId.get('viewventas'), 'vdl').length, 0, 'no delta pills without a comparison');
});

// Regression guards for what the REAL-BROWSER run found (structural tests could not see either):
//   • the heatmap's screen-reader labels are position:absolute; without a positioned scroller they escape
//     overflow-x:auto and widen the phone layout viewport (390 → 599px measured in headless Chrome);
//   • a grid item defaults to min-width:auto, so the 640px table blew the 1fr column out (KPI column 640px).
test('mobile containment: the heatmap scroller is positioned, the page can shrink, the review bar steps aside', () => {
  const css = readFileSync(join(DIR, 'styles.css'), 'utf8');
  assert.match(css, /\n\s*\.vscroll\{[^}]*overflow-x:auto[^}]*position:relative[^}]*\}/, '.vscroll contains its absolute sr labels');
  assert.match(css, /\n\s*\.vmain\{min-width:0\}/, '.vmain can shrink below its widest child');
  assert.match(css, /\n\s*\.vview \.rbar\{display:none\}/, 'the menu review bar is hidden only while Ventas shows');
  assert.match(css, /\n\s*button\.nav\{line-height:inherit\}/, 'Productos became a <button>: it keeps the div\'s inherited line-height (pixel-identical Menú nav, measured vs fee7756)');
  assert.match(css, /\n\s*\.vsr\{position:absolute/, 'premise: the sr labels ARE absolutely positioned (else the guard above is moot)');
});

test('🔴 after sign-out, NOTHING from the old session can call getSalesStats: not a forced nav, not a detached control', async () => {
  // Owner A opens Ventas, then signs out; B (owns nothing) signs in on the same browser. The owner proof
  // must not survive the person: a forced click on the hidden nav, and the OLD page's own preset / CSV
  // buttons (detached from the DOM but still holding their listeners), must all be inert.
  const byId = installDom();
  const calls = installFetch(routes());
  await loadModules();
  await signIn('owner_A');
  byId.get('navventas').click();
  await settle();
  const page = byId.get('viewventas');
  const oldPreset = byClass(page, 'vpre').find((b) => textOf(b) === 'Ayer');
  const [oldDaily, oldOrders] = byClass(page, 'btn');
  assert.ok(oldPreset && oldDaily && oldOrders, 'non-vacuity: captured the old session\'s controls');
  const n0 = statsCalls(calls).length;
  assert.ok(n0 >= 1, 'non-vacuity: owner A did load stats');
  const calls2 = installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  await signIn('person_B');
  await forceOpen(byId);
  oldPreset.click(); oldDaily.click(); oldOrders.click();
  await settle();
  assert.deepStrictEqual(statsCalls(calls2), [], '🔴 no stats request of any kind after the owner left');
  assert.ok(hasClass(byId.get('viewventas'), 'hidden') && gateShut(byId));
});

test('a CSV note belongs to its period: refused orders CSV → any period change clears it', async () => {
  const byId = installDom();
  const calls = installFetch(routes());
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const page = byId.get('viewventas');
  const note = () => byClass(page, 'vcsvnote')[0];
  const t = todayHN(Date.now());
  const setCustom = (from, to) => { const [f, tt] = byClass(page, 'vdate'); f.value = from; for (const fn of f.listeners.change) fn(); tt.value = to; for (const fn of tt.listeners.change) fn(); };
  for (const change of ['preset', 'custom']) {
    byClass(page, 'vpre').find((b) => textOf(b) === 'Personalizado').click();
    await settle();
    setCustom(addDays(t, -39), t);
    await settle();
    byClass(page, 'btn')[1].click();
    await settle();
    assert.ok(textOf(note()).includes('hasta 31 días') && !hasClass(note(), 'hidden'), `premise (${change}): the refusal is showing`);
    if (change === 'preset') byClass(page, 'vpre').find((b) => textOf(b) === 'Hoy').click();
    else setCustom(addDays(t, -9), t);
    await settle();
    assert.ok(hasClass(note(), 'hidden') && textOf(note()) === '', `🔴 ${change} change: the stale note is gone`);
  }
  void calls;
});

test('403 not_owner: both CSV buttons are disabled (the server would refuse them too)', async () => {
  const byId = installDom();
  installFetch(routes({ getSalesStats: () => errJson(403, { error: 'not_owner' }) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const [daily, orders] = byClass(byId.get('viewventas'), 'btn');
  assert.ok(daily.disabled && orders.disabled, 'disabled in the refused state');
  const byId2 = installDom();
  installFetch(routes());
  await loadModules();
  await signIn('owner_uid');
  byId2.get('navventas').click();
  await settle();
  const [d2, o2] = byClass(byId2.get('viewventas'), 'btn');
  assert.ok(!d2.disabled && !o2.disabled, 'non-vacuity: enabled for an owner whose stats loaded');
});

test('🔴 an auth change MID-EXPORT stops the export: zero further getSalesStats calls, nothing saved', async () => {
  for (const at of ['between pages', 'during page 1']) {
    const byId = installDom();
    const dl = captureDownloads();
    let releasePage1;
    const p1 = `${ORDERS_HEADER}\r\n2026-10-05,12:00,1,delivery,cash,sale,100.00,86.96,13.04,1x Pizza\r\n`;
    const calls = installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : new Promise((r) => { releasePage1 = () => r(okCsv(p1, { next: 'C1' })); })) }));
    await loadModules();
    await signIn('owner_A');
    byId.get('navventas').click();
    await settle();
    byClass(byId.get('viewventas'), 'btn')[1].click();
    await settle();
    const csvBefore = statsCalls(calls).filter((c) => c.query.format === 'csv').length;
    assert.strictEqual(csvBefore, 1, 'non-vacuity: page 1 is in flight');
    // owner A signs out; B (owns nothing) signs in — then page 1 answers with a cursor for page 2
    const callsB = installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
    document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
    if (at === 'between pages') { releasePage1(); await settle(); await signIn('person_B'); } else { await signIn('person_B'); releasePage1(); }
    await settle(20);
    await dl.read();
    dl.restore();
    assert.deepStrictEqual(statsCalls(callsB), [], `🔴 ${at}: no getSalesStats call of any kind after the switch`);
    assert.strictEqual(dl.saved.length, 0, `${at}: nothing saved`);
    assert.ok(gateShut(byId));
  }
});

test('🔴 a CSV 403 refuses BOTH exports (button AND handler) until ownership is re-established', async () => {
  const byId = installDom();
  const calls = installFetch(routes({ getSalesStats: (q) => (q.format === 'csv' ? errJson(403, { error: 'not_owner' }) : STATS()) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  const [daily, orders] = byClass(byId.get('viewventas'), 'btn');
  assert.ok(!daily.disabled && !orders.disabled, 'premise: the JSON load succeeded and exports are enabled');
  daily.click();
  await settle();
  assert.ok(daily.disabled && orders.disabled, 'the CSV refusal disables both buttons');
  const n = statsCalls(calls).filter((c) => c.query.format === 'csv').length;
  for (const fn of orders.listeners.click) fn();               // a click that reaches the handler anyway
  for (const fn of daily.listeners.click) fn();
  await settle();
  assert.strictEqual(statsCalls(calls).filter((c) => c.query.format === 'csv').length, n, '🔴 the handler itself refuses');
  byClass(byId.get('viewventas'), 'vpre').find((b) => textOf(b) === 'Hoy').click();
  await settle();
  assert.ok(daily.disabled && orders.disabled, 'a period change does not lift the refusal');
  document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: 'x_pizza' } }));   // ownership re-established
  await settle();
  const [d2, o2] = byClass(byId.get('viewventas'), 'btn');
  assert.ok(!d2.disabled && !o2.disabled, '…lifted only when the owned restaurant is announced again');
});

test('🔴 clearing a custom date deactivates the old range at once: prompt, no request, exports off, late answer dropped', async () => {
  const byId = installDom();
  const pending = [];
  const calls = installFetch(routes({ getSalesStats: (q) => (q.format === 'csv' ? okCsv(`${DAILY_HEADER}\r\n`) : new Promise((r) => pending.push({ q, r }))) }));
  await loadModules();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  pending.shift().r(STATS());
  await settle();
  const page = byId.get('viewventas');
  byClass(page, 'vpre').find((b) => textOf(b) === 'Personalizado').click();
  await settle();
  const [from, to] = byClass(page, 'vdate');
  from.value = '2026-09-01'; for (const fn of from.listeners.change) fn();
  to.value = '2026-09-20'; for (const fn of to.listeners.change) fn();
  await settle();
  const inflight = pending.shift();
  assert.deepStrictEqual([inflight.q.from, inflight.q.to], ['2026-09-01', '2026-09-20'], 'premise: the custom range was requested');
  to.value = ''; for (const fn of to.listeners.change) fn();     // the merchant clears the end date
  await settle();
  inflight.r(STATS());                                           // the old range's answer arrives late
  await settle();
  assert.ok(textOf(page).includes('Elegí las fechas'), 'the prompt replaces the old range');
  assert.ok(!textOf(page).includes('L 38,146'), '🔴 the late answer for the cleared range did not paint');
  assert.strictEqual(textOf(byClass(page, 'vrl')[0]), 'Elegir fechas…', 'the range label no longer names the old range');
  const [daily, orders] = byClass(page, 'btn');
  assert.ok(daily.disabled && orders.disabled, 'no range → no exports');
  const n = statsCalls(calls).length;
  for (const fn of daily.listeners.click) fn();
  await settle();
  assert.strictEqual(statsCalls(calls).length, n, 'and the handler requests nothing for the cleared range');
});

test('🔴 a context change INSIDE the token await (the last await before a request) sends nothing — export and load', async () => {
  // page 2 of an orders export: page 1 answered while the owner was still current, then the owner signs
  // out while page 2's token is being fetched. Only the guarded token can see this — every other check
  // has already passed by then.
  const byId = installDom();
  const dl = captureDownloads();
  const p1 = `${ORDERS_HEADER}\r\n2026-10-05,12:00,1,delivery,cash,sale,100.00,86.96,13.04,1x Pizza\r\n`;
  let release1;
  const calls = installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : q.cursor ? okCsv(p1) : new Promise((r) => { release1 = () => r(okCsv(p1, { next: 'C1' })); })) }));
  await loadModules();
  await signIn('owner_A');
  byId.get('navventas').click();
  await settle();
  byClass(byId.get('viewventas'), 'btn')[1].click();
  await settle();
  let open;
  globalThis.__tokenHold = new Promise((r) => { open = r; });
  release1();                                                    // page 1 arrives; page 2's token is now held
  await settle();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  open(); globalThis.__tokenHold = null;
  await settle(20);
  await dl.read(); dl.restore();
  assert.deepStrictEqual(statsCalls(calls).filter((c) => c.query.cursor), [], '🔴 page 2 was never requested');
  assert.strictEqual(dl.saved.length, 0);

  // the JSON load: Ventas opened, its token held, the owner signs out → no stats request leaves
  const byId2 = installDom();
  const calls2 = installFetch(routes());
  await loadModules();
  await signIn('owner_A');
  let open2;
  globalThis.__tokenHold = new Promise((r) => { open2 = r; });
  byId2.get('navventas').click();
  await settle();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  open2(); globalThis.__tokenHold = null;
  await settle(20);
  assert.deepStrictEqual(statsCalls(calls2), [], '🔴 the load whose session ended never asked');
});

test('🔴 a single-page export whose session ended while it was in flight saves NOTHING', async () => {
  const byId = installDom();
  const dl = captureDownloads();
  let release;
  installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : new Promise((r) => { release = () => r(okCsv(`${DAILY_HEADER}\r\n2026-10-05,1.00\r\n`)); })) }));
  await loadModules();
  await signIn('owner_A');
  byId.get('navventas').click();
  await settle();
  byClass(byId.get('viewventas'), 'btn')[0].click();
  await settle();
  assert.ok(typeof release === 'function', 'non-vacuity: the daily CSV is in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  release();
  await settle(20);
  await dl.read(); dl.restore();
  assert.strictEqual(dl.saved.length, 0, '🔴 the ended session\'s file is not handed to whoever is at the screen now');
});

test('🔴 codex S2 r2 — an auth change queued as a MICROTASK between the token and fetch sends NOTHING: JSON, daily CSV, orders page 1 and page 2', async () => {
  const signOutMicrotask = () => { globalThis.__onToken = () => document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } })); };
  // JSON load
  {
    const byId = installDom();
    const calls = installFetch(routes());
    await loadModules();
    await signIn('owner_A');
    signOutMicrotask();
    byId.get('navventas').click();
    await settle();
    assert.strictEqual(globalThis.__onToken, null, 'non-vacuity: the probe fired inside token()');
    assert.deepStrictEqual(statsCalls(calls), [], '🔴 JSON: no getSalesStats after the queued sign-out');
  }
  // daily CSV and orders CSV page 1
  for (const which of [0, 1]) {
    const byId = installDom();
    const calls = installFetch(routes());
    await loadModules();
    await signIn('owner_A');
    byId.get('navventas').click();
    await settle();
    const n0 = statsCalls(calls).length;
    signOutMicrotask();
    byClass(byId.get('viewventas'), 'btn')[which].click();
    await settle();
    assert.strictEqual(globalThis.__onToken, null, 'non-vacuity: fired');
    assert.strictEqual(statsCalls(calls).length, n0, `🔴 ${which ? 'orders' : 'daily'} CSV page 1: withheld`);
  }
  // orders CSV page 2: page 1 answers with a cursor; the sign-out lands inside page 2's token call
  {
    const byId = installDom();
    const dl = captureDownloads();
    const p1 = `${ORDERS_HEADER}\r\n2026-10-05,12:00,1,delivery,cash,sale,100.00,86.96,13.04,1x Pizza\r\n`;
    let release1;
    const calls = installFetch(routes({ getSalesStats: (q) => (q.format !== 'csv' ? STATS() : q.cursor ? okCsv(p1) : new Promise((r) => { release1 = () => r(okCsv(p1, { next: 'C1' })); })) }));
    await loadModules();
    await signIn('owner_A');
    byId.get('navventas').click();
    await settle();
    byClass(byId.get('viewventas'), 'btn')[1].click();
    await settle();
    signOutMicrotask();
    release1();
    await settle(20);
    await dl.read(); dl.restore();
    assert.strictEqual(globalThis.__onToken, null, 'non-vacuity: fired on page 2\'s token');
    assert.deepStrictEqual(statsCalls(calls).filter((c) => c.query.cursor), [], '🔴 orders page 2: withheld');
    assert.strictEqual(dl.saved.length, 0);
  }
});
