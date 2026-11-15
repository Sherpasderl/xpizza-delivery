// Stats S2 — the Ventas page's GATE, EXECUTED. Run: node --test xpizza-portal/ventas.test.mjs
//
// Since «Ventas» V3b (PLAN-portal-ventas-draw-r0) ventas.js is the gate only and hands #viewventas to ventas-tab.js; the tab is STUBBED
// here (it records its mounts) — its own behaviour, and every page cell this file used to hold, lives in ventas-tab.test.mjs against
// the REAL stats cores. Retired here → carried there: the 403 owner-only message («V3b a 403 …»), loading / error states («V1 frame
// 7 / 10»), the CSV allowlist / orders paging / > 31 days / a CSV note per period / 403 refusing both exports («V3b …»), the custom
// range («V2 …»), an auth change mid-export / inside the token await / as a microtask («V3b 🔴 …»). The compare select and the old
// heatmap scroller are gone by design (the approved delta: the comparison lives in «Más detalle»; the heat grid is new).
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
import { test } from 'node:test';
import assert from 'node:assert';
import {
  installDom, installFetch, loadModules, okJson, errJson, okCsv, settle, hasClass,
} from './ventas-harness.mjs';
import { CSV_HEADERS } from './ventas-logic.js';

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

// the tab, stubbed: what the gate hands it (the owner proof), and when
const TAB_STUB = 'data:text/javascript,' + encodeURIComponent('export const mountVentasTab = (h, c) => { (globalThis.__tab ||= { mounts: [], unmounts: 0 }).mounts.push({ host: h && h.id, uid: c.uid, rid: c.rid, name: c.name, token: typeof c.token }); }; export const unmountVentasTab = () => { (globalThis.__tab ||= { mounts: [], unmounts: 0 }).unmounts += 1; };');
const load = () => { globalThis.__tab = { mounts: [], unmounts: 0 }; return loadModules(['app', 'ventas', 'shell'], { ventas: (src) => src.replace("from './ventas-tab.js'", `from '${TAB_STUB}'`) }); };
const tab = () => globalThis.__tab;

test('both modules EVALUATE together and wire the shell (nav + mobile pair)', async () => {
  const byId = installDom();
  installFetch(routes());
  await load();
  // PORTAL-UI 1a: two each — ventas.js's own (first, registered at import) and shell.js's, which hides the branch screens
  for (const id of ['navprod', 'navventas', 'mnprod', 'mnventas']) assert.strictEqual((byId.get(id).listeners.click || []).length, 2, `#${id} has ventas.js's and shell.js's click listener`);
  assert.ok(gateShut(byId), 'before anyone signs in, the Ventas nav is hidden');
});

test('🔴 NON-OWNER (owns nothing): no nav, cannot open the page — the tab is NEVER mounted, getSalesStats never called', async () => {
  const byId = installDom();
  const calls = installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
  await load();
  await signIn('staff_uid');
  assert.ok(calls.some((c) => c.fn === 'getMyBranches'), 'non-vacuity: the real restaurant lookup ran (PORTAL-UI 1a: discovery is getMyBranches)');
  assert.ok(gateShut(byId), 'the Ventas nav, its group label and the mobile pair stay hidden');
  await forceOpen(byId);
  assert.ok(hasClass(byId.get('viewventas'), 'hidden') && !hasClass(byId.get('viewmenu'), 'hidden'), 'firing the hidden button does not open the page');
  assert.deepStrictEqual(tab().mounts, [], '🔴 the tab was never mounted');
  assert.deepStrictEqual(statsCalls(calls), [], '🔴 getSalesStats was never called');
});

test('🔴 NON-OWNER whose lookup is refused (403) or down (503): same — shut, nothing mounted', async () => {
  for (const res of [() => errJson(403, { error: 'not_authorized' }), () => errJson(503, { error: 'read_unavailable' })]) {
    const byId = installDom();
    installFetch(routes({ getMyRestaurants: res }));
    await load();
    await signIn('disp_uid');
    await forceOpen(byId);
    assert.ok(gateShut(byId));
    assert.deepStrictEqual(tab().mounts, []);
  }
});

test('🔴 OWNER: the nav appears; the tab is mounted only on opening, on #viewventas, for the announced restaurant (the owner proof)', async () => {
  const byId = installDom();
  installFetch(routes());
  await load();
  await signIn('owner_uid');
  assert.ok(gateOpen(byId), 'the owner sees Negocio → Ventas (and the mobile pair)');
  assert.deepStrictEqual(tab().mounts, [], 'lazy: nothing until the page is opened');
  byId.get('navventas').click();
  await settle();
  assert.ok(!hasClass(byId.get('viewventas'), 'hidden') && hasClass(byId.get('viewmenu'), 'hidden'), 'the Ventas view replaces the menu view');
  assert.ok(hasClass(byId.get('navventas'), 'on') && !hasClass(byId.get('navprod'), 'on'), 'the active nav item moves');
  assert.strictEqual(byId.get('navventas').getAttribute('aria-current'), 'page');
  assert.deepStrictEqual(tab().mounts, [{ host: 'viewventas', uid: 'owner_uid', rid: 'x_pizza', name: 'X. Pizza', token: 'function' }], 'ONE mount, the announced rid and name');
  assert.ok(hasClass(byId.get('app'), 'vview'), 'the shell knows Ventas is showing (the menu review bar steps aside)');
  byId.get('navprod').click();
  assert.ok(hasClass(byId.get('viewventas'), 'hidden') && !hasClass(byId.get('viewmenu'), 'hidden'), 'Productos returns to the menu');
  assert.ok(tab().unmounts >= 1, 'leaving unmounts the tab');
  assert.ok(!hasClass(byId.get('app'), 'vview'), '…and the review bar is back under app.js\'s own .show control');
});

test('🔴 sign-out / a different person closes the page, hides the nav, empties the view; the next person inherits nothing', async () => {
  const byId = installDom();
  installFetch(routes());
  await load();
  await signIn('owner_uid');
  byId.get('navventas').click();
  await settle();
  assert.strictEqual(tab().mounts.length, 1, 'premise: mounted');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  assert.ok(gateShut(byId) && hasClass(byId.get('viewventas'), 'hidden'), 'signed out → shut and back on the menu view');
  assert.ok(tab().unmounts >= 1, 'the tab is unmounted');
  assert.strictEqual(byId.get('viewventas').children.length, 0, 'the view is emptied');
  installFetch(routes({ getMyRestaurants: () => okJson({ restaurants: [] }) }));
  await signIn('someone_else');
  assert.ok(gateShut(byId), 'the next person (not an owner) does not inherit the nav');
  await forceOpen(byId);
  assert.strictEqual(tab().mounts.length, 1, '🔴 a forced nav after the owner left mounts nothing');
});
