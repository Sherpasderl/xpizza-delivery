// «Inicio» — the portal home (PLAN-portal-inicio-r0, APPROVED 11-13; MOCKUP-portal-map.html v3 s-inicio / s-inicio-ok). Built exact to
// the frames, with ONLY the sourced elements (rule 8): the date, the branch pill, the three per-branch figures with «el {día} pasado»
// (getSalesStats, compare previous_week), «Para revisar» = a paused branch + «Reanudar» (getMyBranches control → the ONE pause control),
// 1b «Todo en orden» over those kinds, and «Editar producto». Everything else waits (S1–S4, Marketing, hours editing, «Ayuda»).
// The figures come from the REAL chain (stats-portal-composition's): orders ← stats-fixtures (the real createOrder writers), the
// nightly rollup ← stats-job.runStatsRollup, the answer ← stats-api.getSalesStatsCore behind the real authorizeCatalogEdit.
// Run: node --test inicio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom, loadModules, okJson, errJson, settle, textOf } from './ventas-harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as IL from './inicio-logic.js';
import { clock12 } from './portal-time.js';

// 5f's S2 server (getSalesStats over several branches, merged there): its functions tree at a PINNED ref, read-only (the S4_REF
// pattern) — switch to the repo copy once S2 rides the same train
export const S2_REF = 'd601ce505';
// a peer's functions tree at a PINNED ref, as `git archive` writes it, in a temp dir (node_modules linked), removed at exit — the
// s4Snapshot pattern of real-backend.mjs (feat/portal-structure-s3-ui); ASSEMBLY: fold into that helper when both branches meet
function refTree(ref) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'portal-s2ref-'));
  // the functions tree + the two order forms its seed reads (catalog/form-menu-source.js)
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', '--format=tar', ref, 'xpizza-functions', 'xpizza-orders/index.html', 'la-musa-orders/index.html'], { cwd: repo, maxBuffer: 1 << 28 }) });
  symlinkSync(join(repo, 'xpizza-functions', 'node_modules'), join(dir, 'xpizza-functions', 'node_modules'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return createRequire(join(dir, 'xpizza-functions', 'package.json'));
}
const freq = refTree(S2_REF);
const T = freq('./stats/stats-time');
const J = freq('./stats/stats-job');
const A = freq('./stats/stats-api');
const F = freq('./stats/stats-fixtures');
const { makeRtdb } = freq('./stats/stats-rtdb-fake');
const { makeDb } = freq('./catalog/firestore-fake');
const { makeCustomerKeyer } = freq('./stats/stats-identity');
const { authorizeCatalogEdit } = freq('./catalog/catalog-edit-auth');

const P = (k) => `⟦inicio.${k}⟧`;
const HN = 6 * 3600e3;
const hn = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) + HN;   // a Honduras wall clock → epoch ms

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('the greeting follows the Honduras clock: «Buenas tardes» as drawn; morning / night are ⟦inicio.*⟧ until approved; never a name', () => {
  assert.equal(IL.greeting(hn(2026, 11, 12, 15)), 'Buenas tardes', '🔴 the drawn greeting, no name (Q-I2)');
  assert.equal(IL.greeting(hn(2026, 11, 12, 12)), 'Buenas tardes');
  assert.equal(IL.greeting(hn(2026, 11, 12, 18, 59)), 'Buenas tardes');
  assert.equal(IL.greeting(hn(2026, 11, 12, 19)), P('goodEvening'));
  assert.equal(IL.greeting(hn(2026, 11, 12, 4, 59)), P('goodEvening'));
  assert.equal(IL.greeting(hn(2026, 11, 12, 5)), P('goodMorning'));
  assert.equal(IL.greeting(hn(2026, 11, 12, 11, 59)), P('goodMorning'));
});
test('the date line, Honduras time, exact to the frame', () => {
  assert.equal(IL.dateLine(hn(2026, 11, 12, 15)), 'Resumen de hoy · jueves 12 de noviembre', '🔴 «Resumen de hoy · jueves 12 de noviembre»');
  assert.equal(IL.dateLine(hn(2026, 11, 13, 0, 30)), 'Resumen de hoy · viernes 13 de noviembre');
  assert.equal(IL.dateLine(Date.UTC(2026, 10, 13, 5, 59)), 'Resumen de hoy · jueves 12 de noviembre', '05:59 UTC is still Thursday in Honduras');
});
test('the pause time: THE portal clock, the customer app\'s 12-hour «p. m.» form (advisor 11-13; the frame\'s «pm»)', () => {
  assert.equal(clock12(hn(2026, 11, 12, 15, 10)), '3:10 p. m.', '🔴 the one clock');
  assert.equal(clock12(hn(2026, 11, 12, 0, 5)), '12:05 a. m.');
  assert.equal(clock12(hn(2026, 11, 12, 12, 0)), '12:00 p. m.');
  assert.equal(clock12(hn(2026, 11, 12, 9, 7)), '9:07 a. m.');
  assert.equal(IL.when(hn(2026, 11, 12, 15, 10)), 'desde las 3:10 p. m.', 'Inicio reads it');
});
test('«N pendientes» counts the rows drawn; one is singular', () => {
  assert.equal(IL.pendLabel(4), '4 pendientes');
  assert.equal(IL.pendLabel(1), '1 pendiente');
});

const CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, name, extra = {}) => ({ rid, brand_id: 'marca_v', role: 'owner', state: 'member', caps: CAPS, name,
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const PAUSED = (since) => ({ state: 'paused', paused_until: null, pause_reason: 'Cocina llena', pause_since: since });

test('«Para revisar» = a paused branch in scope (with since-when); «Reanudar» only with location.pause; open / other-scope branches never', () => {
  const since = hn(2026, 11, 12, 15, 10);
  const bs = [branch('r_a', 'Centro', { control: PAUSED(since) }), branch('r_b', 'Los Próceres'), branch('r_c', 'El Trapiche', { control: PAUSED(null), caps: ['stats.read'] })];
  assert.deepEqual(IL.reviewRows(bs, null), [
    { kind: 'pause', rid: 'r_a', text: 'Sucursal Centro está en pausa', when: 'desde las 3:10 p. m.', resume: true },
    { kind: 'pause', rid: 'r_c', text: 'Sucursal El Trapiche está en pausa', when: '', resume: false },
  ], '🔴 one row per paused branch; «Reanudar» only where the member may resume');
  assert.deepEqual(IL.reviewRows(bs, 'r_b'), [], 'the pill scopes the list');
  assert.deepEqual(IL.reviewRows(bs, 'r_a').map((r) => r.rid), ['r_a']);
});

test('«cambios sin publicar» (S3: the SERVER\'s count, branches[i].pending_count): a row only for a number > 0; null (stale) / 0 / absent → no row, never a guess', () => {
  const bs = [branch('r_a', 'Centro', { pending_count: 2 }), branch('r_b', 'Los Próceres', { pending_count: null }), branch('r_c', 'El Trapiche', { pending_count: 0 }), branch('r_d', 'Norte', { pending_count: 1 })];
  assert.deepEqual(IL.reviewRows(bs, 'r_a'), [{ kind: 'menu', rid: 'r_a', text: 'Tenés 2 cambios sin publicar en el menú' }], '🔴 the drawn row from the server count');
  assert.deepEqual(IL.reviewRows(bs, 'r_b'), [], 'stale (null): absent');
  assert.deepEqual(IL.reviewRows(bs, 'r_c'), [], 'zero: absent');
  assert.deepEqual(IL.reviewRows(bs, 'r_d'), [{ kind: 'menu', rid: 'r_d', text: 'Tenés 1 cambio sin publicar en el menú' }], 'one: singular');
  const both = IL.reviewRows([branch('r_a', 'Centro', { pending_count: 3, control: PAUSED(null) })], 'r_a');
  assert.deepEqual(both.map((r) => r.kind), ['pause', 'menu'], 'the frame\'s order: the pause first');
});

// ── the real stats chain (a Thursday; last Thursday is the comparison) ───────────────────────────────────────────────
const TODAY = '2026-11-12';
const NOW = T.dayStartMs(TODAY) + 15 * 3600000;   // 15:00 Honduras
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const keyer = makeCustomerKeyer('s'.repeat(40));
async function statsWorld() {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-11-05', 19), phone: '88880001', totalCents: 31000, items: [{ name: 'Pepperoni 12″', qty: 2, unit: 155 }] }), at('2026-11-05', 19, 20)), at('2026-11-05', 19, 40)));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880009', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at(TODAY, 13), phone: '88880002', totalCents: 27000, items: [{ name: 'Carnívora 18″', qty: 1, unit: 270 }] }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at(TODAY, 12), phone: '88880003', totalCents: 99900 }));   // another branch: never in r_a's figures
  const fsdb = makeDb();
  const rtdb = makeRtdb(orders);
  await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-11-01', to: '2026-11-11', commit: true });
  const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
  const MEMBERS = new Map([['brands/r_a', legacy('r_a')], ['brands/r_b', legacy('r_b')], ['brand_members/r_a/owners/uA', { granted_at: 1, granted_by: 'x' }], ['brand_members/r_b/owners/uA', { granted_at: 1, granted_by: 'x' }]]);
  const memberDb = { ref: (p) => ({ once: async () => { const v = MEMBERS.has(p) ? MEMBERS.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
  const liveCache = A.makeLiveCache();
  return async (query, authz) => {
    const req = { method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' ? authz : undefined) };
    return A.getSalesStatsCore({ authorize: (rid) => authorizeCatalogEdit({ db: memberDb, verifyIdToken: async (t) => { if (t !== 'TK-test') throw new Error('bad'); return { uid: 'uA' }; } }, req, rid),
      fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW, liveCache }, req);
  };
}

test('the figures model from the REAL answer: Ventas / Pedidos with «el jueves pasado», Ticket promedio without one', async () => {
  const serve = await statsWorld();
  const out = await serve({ restaurantId: 'r_a', ...IL.statsQuery(TODAY) }, 'Bearer TK-test');
  assert.equal(out.status, 200, `premise: the real core accepts the home's query ${JSON.stringify(out.body).slice(0, 120)}`);
  const k = out.body.kpis, c = out.body.comparison.kpis;
  assert.ok(k.orders > 0 && c.orders > 0, 'non-vacuity: today and last Thursday both have sales');
  assert.deepEqual(IL.figures(out.body, TODAY), {
    sales: { value: IL.money(k.sales_cents), vs: `${IL.money(c.sales_cents)} el jueves pasado` },
    orders: { value: String(k.orders), vs: `${c.orders} el jueves pasado` },
    ticket: { value: IL.money(k.average_paid_ticket_cents) },
  }, '🔴 the server\'s own numbers, «el jueves pasado» = the same weekday last week');
  assert.deepEqual(IL.statsQuery(TODAY), { from: TODAY, to: TODAY, granularity: 'day', compare: 'previous_week' });
});

// ── the page, through the REAL shell (+ app.js / ventas.js), with inicio.js loaded as index.html loads it ────────────
function storage() {
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
const MENU = () => okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const pinClock = (s) => s.replace(/Date\.now\(\)/g, String(NOW));
const all = (n) => (n && n.children ? n.children : []).flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : []));
const cls = (root, c) => all(root).filter((n) => String(n._class || '').split(/\s+/).includes(c));
const btnText = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n) === t);
const has = (n, c) => String(n._class).split(/\s+/).includes(c);
async function page(branches, { withInicio = true, pause = null, statsFail = false } = {}) {
  storage();
  const byId = installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  const serve = await statsWorld();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    const query = Object.fromEntries(u.searchParams);
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ fn, query, body });
    if (fn === 'getSalesStats') {
      if (statsFail) return errJson(503, { error: 'unavailable' });
      const out = await serve(query, (opts && opts.headers && opts.headers.Authorization) || '');
      return { ok: out.status === 200, status: out.status, json: async () => out.body, text: async () => JSON.stringify(out.body), headers: { get: () => null } };
    }
    if (fn === 'setBranchPause') return pause ? pause(body) : errJson(404, {});
    if (fn === 'getMyBranches') return okJson({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches });
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  };
  const mods = await loadModules(withInicio ? ['app', 'ventas', 'shell', 'inicio'] : ['app', 'ventas', 'shell'], { inicio: pinClock });
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uA' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(40);
  return { byId, calls, mods, view: byId.get('viewinicio'), stats: () => calls.filter((c) => c.fn === 'getSalesStats') };
}

test('LANDING: with inicio.js loaded (index.html), the portal opens on Inicio — first in the nav, current; Productos hidden', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  assert.ok(!has(p.view, 'hidden'), '🔴 Inicio is the landing page (owner 11-13)');
  assert.ok(has(p.byId.get('viewmenu'), 'hidden'), 'Productos waits behind it');
  assert.ok(has(p.byId.get('navinicio'), 'on') && p.byId.get('navinicio').getAttribute('aria-current') === 'page', 'the nav item is current');
  assert.ok(!has(p.byId.get('navinicio'), 'hidden') && !has(p.byId.get('mninicio'), 'hidden'), 'offered on desktop and phone');
  assert.ok(!has(p.byId.get('navprod'), 'on'), 'Productos is not current');
});
test('without inicio.js (any suite that does not load it) the shell is today\'s: Productos lands, no Inicio item', async () => {
  const p = await page([branch('r_a', 'Centro')], { withInicio: false });
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden'), '🔴 no home registered → today\'s landing');
  assert.ok(has(p.byId.get('navinicio'), 'hidden'), 'no Inicio item');
});
test('s-inicio — the greeting, the date, the pill, the three REAL figures; one getSalesStats for the branch (compare previous_week)', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  assert.equal(textOf(p.view.querySelector('h1')), 'Buenas tardes');
  assert.equal(textOf(p.view.querySelector('.in-lede')), 'Resumen de hoy · jueves 12 de noviembre');
  const pill = p.view.querySelector('.in-pill');
  assert.equal(textOf(pill), 'Centro', 'one branch: its name');
  const reqs = p.stats();
  assert.equal(reqs.length, 1, '🔴 one read for the scope');
  assert.deepEqual([reqs[0].query.restaurantId, reqs[0].query.from, reqs[0].query.to, reqs[0].query.compare], ['r_a', TODAY, TODAY, 'previous_week'], '🔴 today vs the same weekday last week');
  const serve = await statsWorld();
  const truth = IL.figures((await serve({ restaurantId: 'r_a', ...IL.statsQuery(TODAY) }, 'Bearer TK-test')).body, TODAY);
  const figs = cls(p.view, 'in-fig').map((f) => [textOf(f.querySelector('.in-fl')), textOf(f.querySelector('.in-fn')), f.querySelector('.in-fs') ? textOf(f.querySelector('.in-fs')) : null]);
  assert.deepEqual(figs, [['Ventas', truth.sales.value, truth.sales.vs], ['Pedidos', truth.orders.value, truth.orders.vs], ['Ticket promedio', truth.ticket.value, null]],
    '🔴 the page draws the server\'s figures, labels as drawn');
});
test('1b — nothing paused: «Todo en orden · No hay nada pendiente en tus sucursales.», no count; «Editar producto» is the one quick action', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  const ok = p.view.querySelector('.in-ok');
  assert.ok(ok, '🔴 the calm empty state');
  assert.equal(textOf(ok.querySelector('b')), 'Todo en orden');
  assert.equal(textOf(all(ok).find((n) => n.tag === 'span' && !has(n, 'in-okico'))), 'No hay nada pendiente en tus sucursales.');
  assert.equal(cls(p.view, 'in-cnt').length, 0, 'no «N pendientes» on an empty list');
  assert.deepEqual(cls(p.view, 'in-quick').map(textOf), ['Editar producto'], '🔴 only the sourced quick action (Crear oferta / Editar horario / Ayuda wait)');
});
test('a paused branch: «Sucursal Centro está en pausa desde las 3:10 pm» + «Reanudar» → the REAL pause request; the row goes and 1b shows', async () => {
  const since = NOW - 3600e3 + 10 * 60e3;   // 14:10
  const p = await page([branch('r_a', 'Centro', { control: PAUSED(since) })], { pause: (b) => okJson({ ok: true, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null } }) });
  const row = p.view.querySelector('.in-row');
  assert.ok(row, '🔴 the pause row');
  assert.equal(textOf(row.querySelector('.in-rt')), `Sucursal Centro está en pausa ${IL.when(since)}`);
  assert.equal(IL.when(since), 'desde las 2:10 p. m.');
  assert.equal(textOf(cls(p.view, 'in-cnt')[0]), '1 pendiente');
  btnText(p.view, 'Reanudar').click(); await settle(20);
  const sent = p.calls.filter((c) => c.fn === 'setBranchPause');
  assert.equal(sent.length, 1, '🔴 one request'); assert.deepEqual([sent[0].body.op, sent[0].query.restaurantId || sent[0].body.rid || sent[0].query.rid], ['resume', 'r_a']);
  assert.equal(p.view.querySelector('.in-row'), null, '🔴 the row is gone (acts in place)');
  assert.ok(p.view.querySelector('.in-ok'), 'and 1b shows');
});
test('the menu row: «Tenés 2 cambios sin publicar en el menú» + «Revisar» → Productos; counted in «N pendientes»', async () => {
  const p = await page([branch('r_a', 'Centro', { pending_count: 2 })]);
  const row = p.view.querySelector('.in-row');
  assert.ok(row, '🔴 the row'); assert.equal(textOf(row.querySelector('.in-rt')), 'Tenés 2 cambios sin publicar en el menú');
  assert.equal(textOf(cls(p.view, 'in-cnt')[0]), '1 pendiente');
  btnText(p.view, 'Revisar').click(); await settle(5);
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden') && has(p.view, 'hidden'), '🔴 «Revisar» opens Productos');
});
test('«Editar producto» opens Productos; Rendimiento hides Inicio; coming back re-reads NOTHING (cached-first)', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  btnText(p.view, 'Editar producto').click(); await settle(5);
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden') && has(p.view, 'hidden'), '🔴 Productos');
  p.byId.get('navventas').click(); await settle(5);
  assert.ok(has(p.view, 'hidden'), 'Rendimiento hides Inicio');
  p.byId.get('navinicio').click(); await settle(5);
  assert.ok(!has(p.view, 'hidden'), 'back on Inicio');
  assert.equal(p.stats().filter((c) => c.query.restaurantId === 'r_a' && c.query.compare === 'previous_week').length, 1, '🔴 cached: no second read inside the session');
});
test('several branches: «Todas las sucursales» is the default (ann 2) — ONE merged read (S2 restaurantIds), the REAL merged figures; the list spans every branch', async () => {
  const p = await page([branch('r_a', 'Centro'), branch('r_b', 'Los Próceres', { control: PAUSED(null) })]);
  const opts = all(cls(p.view, 'in-menu')[0]).filter((n) => n.tag === 'button').map(textOf);
  assert.deepEqual(opts, ['Todas las sucursales', 'Centro', 'Los Próceres'], 'the frame\'s options');
  assert.equal(textOf(p.view.querySelector('.in-pill')), 'Todas las sucursales', '🔴 the drawn default');
  const reqs = p.stats();
  assert.equal(reqs.length, 1, 'one read');
  assert.deepEqual([reqs[0].query.restaurantIds, reqs[0].query.restaurantId, reqs[0].query.compare], ['r_a,r_b', undefined, 'previous_week'], '🔴 the merged form, never restaurantId with it');
  const serve = await statsWorld();
  const out = await serve({ restaurantIds: 'r_a,r_b', ...IL.statsQuery(TODAY) }, 'Bearer TK-test');
  assert.equal(out.status, 200, 'premise: the real S2 core merges');
  assert.equal(out.body.customers, undefined, 'premise: no customers in the merged form');
  const truth = IL.figures(out.body, TODAY);
  const figs = cls(p.view, 'in-fig').map((f) => textOf(f.querySelector('.in-fn')));
  assert.deepEqual(figs, [truth.sales.value, truth.orders.value, truth.ticket.value], '🔴 the server\'s merged figures (its one avgPaidTicket)');
  assert.deepEqual(cls(p.view, 'in-row').map((r) => textOf(r.querySelector('.in-rt'))), ['Sucursal Los Próceres está en pausa'], 'the list covers every branch under «Todas»');
});
test('picking one branch reads THAT branch alone; its list is its own', async () => {
  const p = await page([branch('r_a', 'Centro'), branch('r_b', 'Los Próceres', { control: PAUSED(null) })]);
  all(cls(p.view, 'in-menu')[0]).filter((n) => n.tag === 'button')[1].click(); await settle(20);
  assert.equal(textOf(p.view.querySelector('.in-pill')), 'Centro');
  assert.ok(p.stats().some((c) => c.query.restaurantId === 'r_a' && c.query.restaurantIds === undefined), '🔴 the single form for one branch');
  assert.equal(cls(p.view, 'in-row').length, 0, 'Centro is not paused');
});
test('«Todas» where the member cannot read every branch: no merged figures (absent), the list still shows', async () => {
  const p = await page([branch('r_a', 'Centro'), branch('r_b', 'Los Próceres', { caps: ['location.pause'], control: PAUSED(null) })]);
  assert.equal(cls(p.view, 'in-figs').length, 0, '🔴 no figure without a source for every branch');
  assert.equal(p.stats().length, 0, 'no read');
  assert.equal(cls(p.view, 'in-row').length, 1, 'the pause row');
});
test('the figures cannot be read: no number is invented — the three slots keep their labels, the values read «—»', async () => {
  const p = await page([branch('r_a', 'Centro')], { statsFail: true });
  const figs = cls(p.view, 'in-fig').map((f) => [textOf(f.querySelector('.in-fl')), textOf(f.querySelector('.in-fn'))]);
  assert.deepEqual(figs, [['Ventas', '—'], ['Pedidos', '—'], ['Ticket promedio', '—']], '🔴 honest, no reflow');
});

test('SHIP GATE: no placeholder ships — every Inicio string is owner-approved text', () => {
  const pending = Object.entries(IL.INICIO_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});

// S3 EQUIVALENCE (advisor 11-13; 5f S3 LANDED at 8e94f0aa8): the server's pending_count for a SAVED draft === the review screen's
// line count (review.js reviewModel(...).total — the «Revisar y publicar» sentences, folded as the screen folds them). Each facet is a
// REAL save through 5f's real editCatalogCore (test/_s2core-harness, the production precondition decoder), the count read back with
// the real PS.readPendingCount; the screen's count comes from the portal's own review model over the SAME diff. A facet that differs is
// reported for a ruling (never silently aligned). The review context mirrors app.js productReviewCtx's option map (variantOf → parent).
export const S3_REF = '8e94f0aa8';
test('S3 equivalence (REAL save + REAL recorder at 5f 8e94f0aa8): pending_count === the review screen\'s line count, facet by facet', async () => {
  const fq = refTree(S3_REF);
  const H = fq('./test/_s2core-harness'); const PS = fq('./catalog/pending-summary');
  H.SW.extrasAuthoring = true;
  const { runInThisContext } = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  for (const f of ['extras-eligibility.js', 'exposure-transitions.js']) runInThisContext(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
  const { reviewModel } = await import('./review.js');
  const E = await import('./editor.js'); const IE = await import('./item-edit-logic.js');
  const ctxOf = (src) => { const items = src.items.filter((r) => r && r.display && typeof r.key === 'string'); const k = new Map(items.map((r) => [String(r.display.id), r.key])); const par = new Map(); const ix = new Map();
    for (const r of items) { if (r.display.variantOf == null) continue; const pk = k.get(String(r.display.variantOf)); if (pk) { par.set(r.key, pk); ix.set(r.key, ix.size); } }
    return { optionParent: (x) => par.get(x) || null, optionIndex: (x) => ix.get(x) || 0, extraName: (x) => x, structure: { nameOf: (x) => x, categoryName: (x) => String(x) } }; };
  const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
  const isLauncher = (d, i) => !!(d.structure.variant_items || {})[String(i.display.id)];
  const plain = (d) => d.items.filter((i) => i.display && i.display.variantOf == null && !isLauncher(d, i));
  const reprice = (it, n) => { it.price += n; it.display.price = it.price; };
  const viaDrawer = (n) => (source) => { const d = E.createDraft(JSON.parse(JSON.stringify(source))); const xs = E.draftSource(d).extras.filter((e) => e.display && e.display.cat === 'Salsas').map((e) => e.key);
    const st = IE.open(d, 'dimsum_01', [], { extrasAuthoring: true, extrasCatalog: true }); for (const x of xs.slice(0, n)) IE.set(st, 'extraOn', { key: x, on: false });
    assert.deepEqual(IE.save(d, st), { ok: true }, 'premise: the drawer writer saved'); return E.draftSource(d); };
  const FACETS = {
    'three prices': (d) => plain(d).slice(0, 3).forEach((it) => reprice(it, 7)),
    'a description': (d) => { plain(d)[0].display.desc = 'Otra descripción'; },
    'a name': (d) => { plain(d)[1].display.name += ' Nueva'; },
    'price + description on one dish': (d) => { const it = plain(d)[0]; reprice(it, 7); it.display.desc = 'Otra'; },
    'an option\'s price': (d) => reprice(d.items.find((i) => i.display && i.display.variantOf != null), 9),
    'an extra\'s price': (d) => { const x = d.extras.find((e) => e && e.display); x.price = (x.price || 0) + 5; if (x.display) x.display.price = x.price; },
    'a section move': (d) => { const it = plain(d)[0]; it.display.cat = d.structure.categories.find((c) => String(c.id) !== String(it.display.cat)).id; delete it.display.subcat; },
    'a subsection move': (d) => { const it = plain(d).find((i) => i.display.subcat); const c = d.structure.categories.find((x) => String(x.id) === String(it.display.cat)); it.display.subcat = c.subcats.find((x) => x !== it.display.subcat); },
    'a launcher + its options renamed': (d) => { const l = d.items.find((i) => i.display && isLauncher(d, i)); l.display.name += ' X';
      for (const id of d.structure.variant_items[String(l.display.id)].variantIds) { const o = d.items.find((i) => String(i.display.id) === String(id) || i.ref === id); if (o) o.display.name += ' X'; } },
    'a launcher\'s description': (d) => { d.items.find((i) => i.display && isLauncher(d, i)).display.desc = 'Nueva desc'; },
  };
  const got = {};
  for (const [name, f] of [...Object.entries(FACETS), ['one dish extra off (the drawer)', viaDrawer(1)], ['two dish extras off (the drawer)', viaDrawer(2)]]) {
    const w = H.world('la_musa');
    const src = (await w.draft()).source;
    const r = await quiet(() => (name.endsWith('(the drawer)') ? w.save(f(src)) : w.save(f)));
    assert.equal(r.status, 200, `premise: the real save of «${name}» ${JSON.stringify(r.body).slice(0, 160)}`);
    got[name] = [await PS.readPendingCount(w.fs, 'la_musa'), reviewModel(r.body.diff, ctxOf((await w.draft()).source)).total];
  }
  for (const [name, [pc, total]] of Object.entries(got)) assert.ok(Number.isInteger(pc) && pc > 0, `premise: a fresh count for «${name}» (got ${pc})`);
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, [pc]]) => [k, pc])), Object.fromEntries(Object.entries(got).map(([k, [, t]]) => [k, t])),
    '🔴 pending_count === the review screen\'s line count, every facet');
});
test('S3 equivalence — facets NOT yet exercised (the seeds / harness cannot produce them here): each needs its real save before it counts as proven', { todo: 'additions, removals, S2 attachments, the extras-order structure line, photos, S3 choices, S4 sections; and a section move that ALSO changes the subsection (no seed has two subsectioned sections)' }, () => {
  assert.fail('not exercised');
});
