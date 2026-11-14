// «Rendimiento» · Ventas, the non-drawing half (PLAN-portal-rendimiento-r0, advisor ACCEPTED 11-14): rend-data.js + the additive
// ventas-logic.js pieces, against 5f's REAL stats cores at the PINNED ref d601ce505 (getSalesStatsCore + its S2 multi form), over
// orders the REAL fixtures build and the REAL nightly roll-up computes — reached through the portal's own api.js calls.
// Run: node --test rend-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as VL from './ventas-logic.js';
import * as RD from './rend-data.js';
import { getSalesStats, getSalesStatsMulti } from './api.js';
import { refTree } from './ref-tree.mjs';

const S2_REF = 'd601ce505071e4ea00ff38367abf231897a39df8';
const BLOB = 'xpizza-functions/stats/stats-api.js';
const DIR = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync('git', a, { cwd: DIR, encoding: 'utf8' }).trim();
const rq = refTree(S2_REF);
const T = rq('./stats/stats-time');
const J = rq('./stats/stats-job');
const A = rq('./stats/stats-api');
const F = rq('./stats/stats-fixtures');
const { makeRtdb } = rq('./stats/stats-rtdb-fake');
const { makeDb } = rq('./catalog/firestore-fake');
const { makeCustomerKeyer } = rq('./stats/stats-identity');
const { authorizeCatalogEdit } = rq('./catalog/catalog-edit-auth');

const TODAY = '2026-11-12';
const NOW = T.dayStartMs(TODAY) + 15 * 3600000;   // 15:00 Honduras
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const keyer = makeCustomerKeyer('s'.repeat(40));
const OLD = { from: '2026-11-02', to: '2026-11-08' };   // fully rolled up: no live day
// the real world: orders by the REAL fixtures, the REAL nightly roll-up over 1–11 Nov, the REAL core answering (Inicio's statsWorld)
async function world({ extra = [], keyerFails = false } = {}) {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-11-05', 19), phone: '88880001', totalCents: 31000, items: [{ name: 'Pepperoni 12″', qty: 2, unit: 155 }] }), at('2026-11-05', 19, 20)), at('2026-11-05', 19, 40)));
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at('2026-11-06', 13), phone: '88880002', totalCents: 27000, items: [{ name: 'Carnívora 18″', qty: 1, unit: 270 }] }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-11-06', 12), phone: '88880003', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880009', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  for (const o of extra) add(o);
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
      fsdb, rtdb, getKeyer: () => { if (keyerFails) throw new Error('no secret'); return keyer; }, nowMs: NOW, liveCache }, req);
  };
}
// the portal's api.js → the real core (the functions.js handler: status + json)
function route(serveRef) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const query = Object.fromEntries(u.searchParams);
    calls.push({ fn: u.pathname.split('/').pop(), query });
    const out = await serveRef.serve(query, (opts && opts.headers && opts.headers.Authorization) || '');
    const text = JSON.stringify(out.body);
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => JSON.parse(text) };
  };
  return calls;
}
const token = async () => 'TK-test';
const API = { getSalesStats, getSalesStatsMulti };
function store() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, m };
}
function ui() {
  const log = [];
  return { log, paint: (x) => log.push({ ev: 'paint', ...x }), stamp: (x) => log.push({ ev: 'stamp', ...x }), fail: (x) => log.push({ ev: 'fail', ...x }) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('the pin: the S2 ref and its stats-api.js blob', () => {
  assert.equal(git('rev-parse', `${S2_REF}^{commit}`), S2_REF);
  assert.equal(git('rev-parse', `${S2_REF}:${BLOB}`), 'ffda4ed8eee51f7724aef181f1e19a6052cc4746', 'pinned stats-api.js');
});

test('the presets are exactly the mockup\'s, «Últimos 14 días» by default, and the real core accepts every one; the shipped set is untouched', async () => {
  assert.deepEqual(VL.REND_PRESETS.map(([id]) => id), ['today', '7d', '14d', '30d', 'custom'], 'Hoy · 7 · 14 · 30 · Personalizado');
  assert.deepEqual(VL.REND_PRESETS.map(([, l]) => l), ['Hoy', 'Últimos 7 días', 'Últimos 14 días', 'Últimos 30 días', 'Personalizado']);
  assert.equal(VL.REND_DEFAULT_PRESET, '14d', '«Últimos 14 días» is the default');
  assert.deepEqual(VL.rangeFor('14d', TODAY), { from: '2026-10-30', to: TODAY }, '14 days ending today (the mockup\'s «30 oct – 12 nov»)');
  assert.deepEqual(VL.PRESETS.map(([id]) => id), ['today', 'yesterday', '7d', '30d', 'month', 'custom'], 'the shipped page keeps its set');
  const w = { serve: await world() };
  route(w);
  for (const [id] of VL.REND_PRESETS.filter(([id]) => id !== 'custom')) {
    const r = VL.rangeFor(id, TODAY);
    const b = await getSalesStats({ rid: 'r_a', from: r.from, to: r.to, granularity: VL.granularityFor(r), compare: VL.defaultCompare(r), token });
    assert.equal(VL.statsState({ body: b }).state, 'ok', `the real core answers «${id}»`);
  }
});

test('«Vendidos» counts UNITS: the real items carry qty (2 pizzas in ONE order), so «Pedidos» per product would be false', async () => {
  assert.equal(VL.TOP_QTY_LABEL, 'Vendidos', 'the column is «Vendidos» (units), never «Pedidos»');
  route({ serve: await world() });
  const b = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  const pep = b.items.find((i) => i.name === 'Pepperoni 12″');
  assert.deepEqual([pep.qty, b.kpis.orders], [2, 2], 'two units of Pepperoni from ONE order (the period has 2 orders in all)');
});

test('the state model from REAL answers: ok, empty, missing days (never zero-filled), 503 unavailable, 403 denied', async () => {
  route({ serve: await world() });
  const ok = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  assert.deepEqual(VL.statsState({ body: ok }), { state: 'ok', missing: [] });
  const none = await getSalesStats({ rid: 'r_b', from: '2026-11-08', to: '2026-11-09', granularity: 'day', compare: 'none', token });
  assert.deepEqual(VL.statsState({ body: none }), { state: 'empty', missing: [] }, 'a period with no orders is the honest empty');
  const gap = await getSalesStats({ rid: 'r_a', from: '2026-10-28', to: '2026-11-03', granularity: 'day', compare: 'none', token });
  const s = VL.statsState({ body: gap });
  assert.deepEqual([s.state, s.missing], ['empty', ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']], 'days the roll-up never computed ride as `missing`');
  for (const b of [ok, none, gap]) assert.equal(VL.bodyEmpty(b), VL.viewModel(b, { range: { from: b.range.from, to: b.range.to }, compare: 'none', metric: 'sales', nowMs: NOW }).empty, 'the same «empty» the shipped view model computes');
  route({ serve: await world({ keyerFails: true }) });
  const down = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token }).then(() => null, (e) => e);
  assert.deepEqual([down.status, VL.statsState({ error: down }).state], [503, 'unavailable'], 'the real 503 (the keyer fails closed)');
  route({ serve: await world() });
  const no = await getSalesStats({ rid: 'r_zz', ...OLD, granularity: 'day', compare: 'none', token }).then(() => null, (e) => e);
  assert.equal(VL.statsState({ error: no }).state, 'denied', 'a branch the member cannot read');
  assert.equal(VL.statsState({ error: { status: 0 } }).state, 'unavailable', 'a transport failure');
});

test('«Todas las sucursales» is ONE call, merged on the server; one branch refused refuses the whole total; a 503 paints nothing', async () => {
  const w = { serve: await world() };
  const calls = route(w);
  const u = ui();
  const r = await RD.loadStats({ uid: 'uA', rids: ['r_b', 'r_a'], range: OLD, compare: 'none', token, api: API, cache: RD.makeCache(store()), now: () => NOW, ui: u });
  assert.equal(r.source, 'network');
  assert.equal(calls.length, 1, '«Todas» is ONE call');
  assert.deepEqual(calls[0].query.restaurantIds, 'r_a,r_b', 'the ids in ONE param, sorted');
  const painted = u.log.find((x) => x.ev === 'paint').body;
  const one = async (rid) => (await getSalesStats({ rid, ...OLD, granularity: 'day', compare: 'none', token })).kpis;
  const [ka, kb] = [await one('r_a'), await one('r_b')];
  assert.deepEqual([painted.kpis.orders, painted.kpis.sales_cents], [ka.orders + kb.orders, ka.sales_cents + kb.sales_cents], 'the server\'s merged figures');
  const u1 = ui();
  const r1 = await RD.loadStats({ uid: 'uA', rids: ['r_a', 'r_zz'], range: OLD, compare: 'none', token, api: API, cache: null, now: () => NOW, ui: u1 });
  assert.deepEqual([r1.source, u1.log.map((x) => x.ev), VL.statsState({ error: r1.error }).state], ['error', ['fail'], 'denied'], 'one branch the member cannot read: the whole total refused, nothing painted');
  w.serve = await world({ keyerFails: true });
  const u2 = ui();
  const r2 = await RD.loadStats({ uid: 'uA', rids: ['r_a', 'r_b'], range: OLD, compare: 'none', token, api: API, cache: null, now: () => NOW, ui: u2 });
  assert.deepEqual([r2.source, u2.log.map((x) => x.ev), VL.statsState({ error: r2.error }).state], ['error', ['fail'], 'unavailable'], 'no partial total is ever painted');
});

test('cached-first: the cached body paints at once WITH ITS OWN stamp; an unchanged revalidate moves only the stamp (no swap)', async () => {
  route({ serve: await world() });
  const cache = RD.makeCache(store());
  const T1 = NOW, T2 = NOW + 12 * 60000;
  const first = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: VL.rangeFor('14d', TODAY), compare: 'previous', token, api: API, cache, now: () => T1, ui: first });
  assert.deepEqual(first.log.map((x) => [x.ev, x.source]), [['paint', 'network']], 'no cache yet: one paint, from the network');
  const again = ui();
  const r = await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: VL.rangeFor('14d', TODAY), compare: 'previous', token, api: API, cache, now: () => T2, ui: again });
  assert.deepEqual(again.log.map((x) => x.ev), ['paint', 'stamp'], 'an unchanged revalidate never swaps the body');
  assert.equal(r.source, 'cache+same');
  assert.equal(again.log[0].source, 'cache');
  assert.equal(again.log[0].freshAt, T1, 'the cached paint carries its own stamp (a live day: as fresh as its FETCH, never «now»)');
  assert.equal(again.log[1].freshAt, T2, 'the revalidate moves the stamp to the new fetch');
  // a fully rolled-up period: freshness = the newest computed_at the SERVER stamped, the same on the cached paint
  const old = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: OLD, compare: 'none', token, api: API, cache, now: () => T1, ui: old });
  const stamped = old.log[0].body.days.map((d) => Date.parse(d.computed_at)).filter(Number.isFinite);
  assert.ok(stamped.length > 0, 'premise: the roll-up stamped its days');
  const cachedOld = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: OLD, compare: 'none', token, api: API, cache, now: () => T2, ui: cachedOld });
  assert.equal(cachedOld.log[0].freshAt, Math.max(...stamped), 'a rolled-up body is as fresh as the server\'s computed_at');
});

test('a CHANGED revalidate swaps once; a failed one keeps the cached body; the key separates users, scopes, ranges and compares', async () => {
  const w = { serve: await world() };
  route(w);
  const cache = RD.makeCache(store());
  const range = VL.rangeFor('14d', TODAY);
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range, compare: 'previous', token, api: API, cache, now: () => NOW, ui: ui() });
  w.serve = await world({ extra: [F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-11-10', 20), phone: '88880077', totalCents: 44000, items: [{ name: 'Suprema 18″', qty: 1, unit: 440 }] })] });
  const u = ui();
  const r = await RD.loadStats({ uid: 'uA', rids: ['r_a'], range, compare: 'previous', token, api: API, cache, now: () => NOW + 60000, ui: u });
  assert.equal(r.source, 'cache+swap');
  assert.deepEqual(u.log.map((x) => [x.ev, x.source]), [['paint', 'cache'], ['paint', 'network']], 'a changed answer swaps the body once');
  assert.ok(u.log[1].body.kpis.orders > u.log[0].body.kpis.orders, 'premise: the new order is in the fresh body');
  w.serve = await world({ keyerFails: true });
  const f = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range, compare: 'previous', token, api: API, cache, now: () => NOW + 120000, ui: f });
  assert.deepEqual(f.log.map((x) => x.ev), ['paint', 'fail'], 'a failed revalidate: the cached body stays, the failure is reported');
  assert.equal(f.log[1].hasBody, true);
  const k = (uid, rids, rg, cmp) => RD.cacheKey(uid, RD.scopeOf(rids), rg, cmp);
  const base = k('uA', ['r_a'], range, 'previous');
  for (const other of [k('uB', ['r_a'], range, 'previous'), k('uA', ['r_a', 'r_b'], range, 'previous'), k('uA', ['r_a'], OLD, 'previous'), k('uA', ['r_a'], range, 'none')]) assert.notEqual(other, base, 'a different user / scope / range / compare is a different entry');
  assert.equal(k('uA', ['r_b', 'r_a'], range, 'x'), k('uA', ['r_a', 'r_b'], range, 'x'), 'the scope is order-free');
  assert.ok(base.includes('|day|'), 'the granularity is in the key');
});

test('storage that throws or fills: no cache, never a crash; the session keeps at most a dozen bodies; clear(uid) drops only that user', async () => {
  route({ serve: await world() });
  const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {}, key: () => null, length: 0 };
  const u = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: OLD, compare: 'none', token, api: API, cache: RD.makeCache(boom), now: () => NOW, ui: u });
  assert.deepEqual(u.log.map((x) => x.ev), ['paint'], 'blocked storage: the network paint alone');
  const s = store();
  const c = RD.makeCache(s);
  for (let i = 0; i < 15; i++) c.put(`sherpa.portal.rend.uA|r_a|2026-10-${String(i + 1).padStart(2, '0')}|x|day|none`, { kpis: {} }, NOW + i);
  c.put('sherpa.portal.rend.uB|r_a|2026-11-01|x|day|none', { kpis: {} }, NOW + 99);
  s.setItem('sherpa.portal.envio.uA', 'other cache');
  assert.equal([...s.m.keys()].filter((x) => x.startsWith('sherpa.portal.rend.')).length, 12, 'at most a dozen bodies');
  assert.ok(!s.m.has('sherpa.portal.rend.uA|r_a|2026-10-01|x|day|none'), 'the oldest left first');
  c.clear('uA');
  assert.deepEqual([...s.m.keys()].sort(), ['sherpa.portal.envio.uA', 'sherpa.portal.rend.uB|r_a|2026-11-01|x|day|none'], 'clear(uid): that user\'s bodies only; other caches untouched');
});
