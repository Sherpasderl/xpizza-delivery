// «Rendimiento» · Ventas, the non-drawing half (PLAN-portal-rendimiento-r0, advisor ACCEPTED 11-14): rend-data.js + the additive
// ventas-logic.js pieces, against 5f's REAL stats cores at the PINNED ref d601ce505 (getSalesStatsCore + its S2 multi form), over
// orders the REAL fixtures build and the REAL nightly roll-up computes — reached through the portal's own api.js calls.
// Run: node --test rend-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as VL from './ventas-logic.js';
import * as RL from './rend-logic.js';
import * as RD from './rend-data.js';
import { getSalesStats, getSalesStatsMulti } from './api.js';

import { S2_REF, BLOB, DIR, git, T, J, A, F, TODAY, NOW, at, OLD, world, route } from './stats-harness.mjs';
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
  assert.deepEqual(RL.REND_PRESETS.map(([id]) => id), ['today', '7d', '14d', '30d', 'custom'], 'Hoy · 7 · 14 · 30 · Personalizado');
  assert.deepEqual(RL.REND_PRESETS.map(([, l]) => l), ['Hoy', 'Últimos 7 días', 'Últimos 14 días', 'Últimos 30 días', 'Personalizado']);
  assert.equal(RL.REND_DEFAULT_PRESET, '14d', '«Últimos 14 días» is the default');
  assert.deepEqual(RL.rendRangeFor('14d', TODAY), { from: '2026-10-30', to: TODAY }, '14 days ending today (the mockup\'s «30 oct – 12 nov»)');
  assert.deepEqual(VL.PRESETS.map(([id]) => id), ['today', 'yesterday', '7d', '30d', 'month', 'custom'], 'the shipped page keeps its set');
  const w = { serve: await world() };
  route(w);
  for (const [id] of RL.REND_PRESETS.filter(([id]) => id !== 'custom')) {
    const r = RL.rendRangeFor(id, TODAY);
    const b = await getSalesStats({ rid: 'r_a', from: r.from, to: r.to, granularity: VL.granularityFor(r), compare: VL.defaultCompare(r), token });
    assert.equal(RL.statsState({ body: b }).state, 'ok', `the real core answers «${id}»`);
  }
});

test('«Vendidos» counts UNITS: the real items carry qty (2 pizzas in ONE order), so «Pedidos» per product would be false', async () => {
  assert.equal(RL.TOP_QTY_LABEL, 'Vendidos', 'the column is «Vendidos» (units), never «Pedidos»');
  route({ serve: await world() });
  const b = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  const pep = b.items.find((i) => i.name === 'Pepperoni 12″');
  assert.deepEqual([pep.qty, b.kpis.orders], [2, 2], 'two units of Pepperoni from ONE order (the period has 2 orders in all)');
});

test('the state model from REAL answers: ok, empty, missing days (never zero-filled), 503 unavailable, 403 denied', async () => {
  route({ serve: await world() });
  const ok = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  assert.deepEqual(RL.statsState({ body: ok }), { state: 'ok', missing: [] });
  const none = await getSalesStats({ rid: 'r_b', from: '2026-11-08', to: '2026-11-09', granularity: 'day', compare: 'none', token });
  assert.deepEqual(RL.statsState({ body: none }), { state: 'empty', missing: [] }, 'a period with no orders is the honest empty');
  const gap = await getSalesStats({ rid: 'r_a', from: '2026-10-28', to: '2026-11-03', granularity: 'day', compare: 'none', token });
  const s = RL.statsState({ body: gap });
  assert.deepEqual([s.state, s.missing], ['empty', ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']], 'days the roll-up never computed ride as `missing`');
  for (const b of [ok, none, gap]) assert.equal(RL.bodyEmpty(b), VL.viewModel(b, { range: { from: b.range.from, to: b.range.to }, compare: 'none', metric: 'sales', nowMs: NOW }).empty, 'the same «empty» the shipped view model computes');
  route({ serve: await world({ keyerFails: true }) });
  const down = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token }).then(() => null, (e) => e);
  assert.deepEqual([down.status, RL.statsState({ error: down }).state], [503, 'unavailable'], 'the real 503 (the keyer fails closed)');
  route({ serve: await world() });
  const no = await getSalesStats({ rid: 'r_zz', ...OLD, granularity: 'day', compare: 'none', token }).then(() => null, (e) => e);
  assert.equal(RL.statsState({ error: no }).state, 'denied', 'a branch the member cannot read');
  assert.equal(RL.statsState({ error: { status: 0 } }).state, 'unavailable', 'a transport failure');
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
  assert.deepEqual([r1.source, u1.log.map((x) => x.ev), RL.statsState({ error: r1.error }).state], ['error', ['fail'], 'denied'], 'one branch the member cannot read: the whole total refused, nothing painted');
  w.serve = await world({ keyerFails: true });
  const u2 = ui();
  const r2 = await RD.loadStats({ uid: 'uA', rids: ['r_a', 'r_b'], range: OLD, compare: 'none', token, api: API, cache: null, now: () => NOW, ui: u2 });
  assert.deepEqual([r2.source, u2.log.map((x) => x.ev), RL.statsState({ error: r2.error }).state], ['error', ['fail'], 'unavailable'], 'no partial total is ever painted');
});

test('cached-first: the cached body paints at once WITH ITS OWN stamp; an unchanged revalidate moves only the stamp (no swap)', async () => {
  route({ serve: await world() });
  const cache = RD.makeCache(store());
  const T1 = NOW, T2 = NOW + 12 * 60000;
  const first = ui();
  await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: RL.rendRangeFor('14d', TODAY), compare: 'previous', token, api: API, cache, now: () => T1, ui: first });
  assert.deepEqual(first.log.map((x) => [x.ev, x.source]), [['paint', 'network']], 'no cache yet: one paint, from the network');
  const again = ui();
  const r = await RD.loadStats({ uid: 'uA', rids: ['r_a'], range: RL.rendRangeFor('14d', TODAY), compare: 'previous', token, api: API, cache, now: () => T2, ui: again });
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
  const range = RL.rendRangeFor('14d', TODAY);
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

// ═══ V1 · the tab's drawing model (MOCKUP-portal-rendimiento-ventas-delta, PLAN-portal-ventas-draw-r0) — from REAL answers ══════════
const byLabel = (m) => Object.fromEntries(m.buckets.map((b) => [b.label, b]));
test('V1 chart · day buckets: «Ventas por día», the axis labels («2 nov», «3» …), the bucket tooltip, a nice y-scale from the data', async () => {
  route({ serve: await world() });
  const b = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  const m = RL.chartModel(b, { range: OLD, nowMs: NOW });
  assert.equal(m.title, 'Ventas por día');
  assert.deepEqual(m.buckets.map((x) => x.label), ['2 nov', '3', '4', '5', '6', '7', '8'], 'the month on the first bucket (and at a change)');
  assert.ok(m.buckets.every((x) => x.k === 'ok'));
  const d5 = byLabel(m)['5'];
  assert.deepEqual([d5.cents, d5.orders, d5.tip.strong, d5.tip.rest], [31000, 1, 'L 310', '5 nov · 1 pedido'], 'the server\'s bucket, worded');
  assert.deepEqual([m.ymaxCents, m.ticks], [100000, [0, 25000, 50000, 75000, 100000]], 'max L 310 ⇒ step L 250 (the mockup\'s nice steps), 4 steps');
  assert.equal(m.sparse, false, '≤ 14 buckets: every label');
});
test('V1 chart · «Hoy»: hour buckets (today\'s heatmap row), the shipped 12–22 window widened by order hours; the running hour is partial, later hours empty', async () => {
  route({ serve: await world() });
  const r = { from: TODAY, to: TODAY };
  const b = await getSalesStats({ rid: 'r_a', ...r, granularity: 'day', compare: 'none', token });
  const m = RL.chartModel(b, { range: r, nowMs: NOW });
  assert.equal(m.title, 'Ventas por hora');
  assert.deepEqual([m.buckets[0].label, m.buckets[m.buckets.length - 1].label], ['11:00', '22:00'], 'widened to 11 by today\'s 11:00 order');
  const h = byLabel(m);
  assert.deepEqual([h['11:00'].k, h['11:00'].cents, h['11:00'].tip.rest], ['ok', 15000, '11:00 – 12:00 · 1 pedido']);
  assert.deepEqual([h['15:00'].k, h['15:00'].tip.rest], ['partial', '15:00 – 16:00 · 0 pedidos · en curso'], 'now = 15:00: the running hour');
  assert.ok(['16:00', '22:00'].every((l) => h[l].k === 'future' && h[l].cents === null), 'hours after now are empty positions, never zeros');
});
test('V1 chart · long ranges: week buckets keyed by the server, the clipped first week «semana parcial», the running week «en curso»; label row sampled', async () => {
  route({ serve: await world() });
  const r = { from: '2026-07-01', to: TODAY };
  const b = await getSalesStats({ rid: 'r_a', ...r, granularity: VL.granularityFor(r), compare: 'none', token });
  const m = RL.chartModel(b, { range: r, nowMs: NOW });
  assert.equal(m.title, 'Ventas por semana');
  assert.equal(m.buckets[0].label, '1 jul', 'the first bucket starts at the range (a Wednesday), not its Monday');
  assert.equal(m.buckets[0].tip.rest.endsWith('semana parcial') || m.buckets[0].k === 'missing', true, 'a clipped first week says so (or is uncomputed)');
  const last = m.buckets[m.buckets.length - 1];
  assert.deepEqual([last.k, last.tip.rest.endsWith('en curso')], ['partial', true], 'the running week');
  assert.equal(m.sparse, true, '> 14 buckets: a sampled label row');
  assert.ok(m.buckets.filter((x) => x.k === 'missing').length > 0, 'weeks the roll-up never computed are breaks, never zeros');
});
test('V1 words: freshness from the server (live ⇒ «Hoy en vivo · actualizado hace N min» by fetch; else «Calculado hoy / ayer / el …, h:mm p. m.»), the range and the pill', async () => {
  route({ serve: await world() });
  const old = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  const t = Math.max(...old.days.map((d) => Date.parse(d.computed_at)).filter(Number.isFinite));   // the REAL roll-up's stamp
  const { clock12 } = await import('./portal-time.js');
  assert.equal(RL.freshWords(old, { fetchedAt: t, nowMs: t + 60000 }), `Calculado hoy, ${clock12(t)}`, 'the roll-up\'s own stamp, THE portal clock');
  assert.equal(RL.freshWords(old, { fetchedAt: t, nowMs: t + 86400000 }), `Calculado ayer, ${clock12(t)}`);
  assert.match(RL.freshWords(old, { fetchedAt: t, nowMs: t + 5 * 86400000 }), /^Calculado el \d{1,2} [a-z]{3}, \d{1,2}:\d{2} [ap]\. m\.$/, 'older: «el 9 nov»');
  const r = RL.rendRangeFor('14d', TODAY);
  const live = await getSalesStats({ rid: 'r_a', ...r, granularity: 'day', compare: 'none', token });
  assert.equal(RL.freshWords(live, { fetchedAt: NOW - 10 * 60000, nowMs: NOW }), 'Hoy en vivo · actualizado hace 10 min', 'live ⇒ when THIS body arrived');
  assert.equal(RL.rangeWords({ from: TODAY, to: TODAY }), 'jueves 12 de noviembre');
  assert.equal(RL.rangeWords(r), '30 oct – 12 nov 2026');
  assert.equal(RL.rangeWords({ from: '2026-11-06', to: TODAY }), '6 – 12 nov 2026');
  assert.equal(RL.rangeWords({ from: '2025-12-24', to: '2026-01-03' }), '24 dic 2025 – 3 ene 2026');
  assert.equal(RL.pillWords('14d', r, TODAY), 'Últimos 14 días');
  assert.equal(RL.pillWords('custom', { from: '2026-05-01', to: TODAY }, TODAY), '1 may – 12 nov', 'this year: no year on the pill');
  assert.equal(RL.pillWords('custom', { from: '2025-12-24', to: '2025-12-25' }, TODAY), '24 – 25 dic 2025');
  assert.equal(RL.missingNote(['2026-11-10', '2026-11-11']), 'Aún sin calcular: 10 nov, 11 nov · los totales de arriba no los incluyen.');
});
test('V1 figures + «Productos más vendidos» from the REAL body: three figures (no deltas), honest «—» for an empty ticket / an outage; units + sales, the bar against the top sales', async () => {
  route({ serve: await world() });
  const b = await getSalesStats({ rid: 'r_a', ...OLD, granularity: 'day', compare: 'none', token });
  assert.deepEqual(RL.figures(b, 'ok'), [['Ventas', 'L 580'], ['Pedidos', '2'], ['Ticket promedio', 'L 290']]);
  const none = await getSalesStats({ rid: 'r_b', from: '2026-11-08', to: '2026-11-09', granularity: 'day', compare: 'none', token });
  assert.deepEqual(RL.figures(none, 'empty'), [['Ventas', 'L 0'], ['Pedidos', '0'], ['Ticket promedio', '—']], 'no average without orders');
  assert.deepEqual(RL.figures(null, 'unavailable'), [['Ventas', '—'], ['Pedidos', '—'], ['Ticket promedio', '—']], 'never a number without its answer');
  const rows = RL.topProducts(b);
  assert.deepEqual(rows.map((x) => [x.name, x.qty, x.sales, x.width]), [['Pepperoni 12″', '2', 'L 310', 100], ['Carnívora 18″', '1', 'L 270', 87]], 'ranked by sales; the bar is its sales against the top');
});
