// Stats S2 — ventas-logic.js, the Ventas page's decisions. Run: node --test xpizza-portal/ventas-logic.test.mjs
// Pure functions only. The REAL server response → viewModel composition is proven in
// xpizza-functions/stats/stats-portal-composition.test.mjs (real S1 core → real portal module).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  rangeFor, validateCustom, defaultCompare, granularityFor, todayHN, addDays, rangeLabel, vsLabel, dayLabel,
  lempiras, count, pct1, updatedLabel, missingLabel, points, viewModel, csvHeaderOk, joinCsvPages, csvFilename,
  CSV_HEADERS, ventasMessage, PRESETS, COMPARES,
} from './ventas-logic.js';

const T = '2026-10-05';   // a Monday

test('presets map to the mockup\'s periods (Honduras dates)', () => {
  assert.deepStrictEqual(PRESETS.map((p) => p[1]), ['Hoy', 'Ayer', 'Últimos 7 días', 'Últimos 30 días', 'Este mes', 'Personalizado']);
  assert.deepStrictEqual(COMPARES.map((c) => c[1]), ['Período anterior', 'Mismo día, semana pasada', 'Sin comparar']);
  assert.deepStrictEqual(rangeFor('today', T), { from: T, to: T });
  assert.deepStrictEqual(rangeFor('yesterday', T), { from: '2026-10-04', to: '2026-10-04' });
  assert.deepStrictEqual(rangeFor('7d', T), { from: '2026-09-29', to: T });
  assert.deepStrictEqual(rangeFor('30d', T), { from: '2026-09-06', to: T });
  assert.deepStrictEqual(rangeFor('month', T), { from: '2026-10-01', to: T });
  assert.strictEqual(rangeFor('custom', T), null);
  assert.deepStrictEqual(rangeFor('custom', T, { from: 'a', to: 'b' }), { from: 'a', to: 'b' });
});

test('labels match the mockup copy exactly', () => {
  assert.strictEqual(rangeLabel(rangeFor('today', T)), 'Lun 5 oct');
  assert.strictEqual(rangeLabel(rangeFor('yesterday', T)), 'Dom 4 oct');
  assert.strictEqual(rangeLabel(rangeFor('7d', T)), '29 sep – 5 oct');
  assert.strictEqual(rangeLabel(rangeFor('30d', T)), '6 sep – 5 oct');
  assert.strictEqual(rangeLabel(rangeFor('month', T)), '1 – 5 oct');
  assert.strictEqual(rangeLabel(null), 'Elegir fechas…');
  assert.strictEqual(vsLabel('previous_week', rangeFor('today', T)), 'vs. lunes pasado');
  assert.strictEqual(vsLabel('previous', rangeFor('7d', T)), 'vs. período anterior');
  assert.strictEqual(vsLabel('none', rangeFor('7d', T)), '');
  assert.strictEqual(dayLabel('2026-10-10'), 'Sáb 10 oct');
  assert.strictEqual(defaultCompare(rangeFor('today', T)), 'previous_week');
  assert.strictEqual(defaultCompare(rangeFor('yesterday', T)), 'previous_week');
  assert.strictEqual(defaultCompare(rangeFor('7d', T)), 'previous');
});

test('money and counts: "L 38,146", "12.4%"', () => {
  assert.strictEqual(lempiras(3814600), 'L 38,146');
  assert.strictEqual(lempiras(24149), 'L 241');
  assert.strictEqual(lempiras(0), 'L 0');
  assert.strictEqual(lempiras(100000000), 'L 1,000,000');
  assert.strictEqual(lempiras(undefined), '—');
  assert.strictEqual(count(1234), '1,234');
  assert.strictEqual(pct1(12.4), '12.4%');
  assert.strictEqual(pct1(-1.94), '1.9%', 'the sign is the arrow, not the text');
  assert.strictEqual(pct1(null), '—');
});

test('Honduras "today" is UTC−6, and day arithmetic crosses months', () => {
  assert.strictEqual(todayHN(Date.UTC(2026, 9, 6, 5, 59)), '2026-10-05', '05:59Z is still the 5th in Honduras');
  assert.strictEqual(todayHN(Date.UTC(2026, 9, 6, 6, 0)), '2026-10-06');
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
});

test('custom ranges: both dates, ordered, not future, ≤ two years', () => {
  assert.strictEqual(validateCustom('', T, T).ok, false);
  assert.strictEqual(validateCustom('2026-10-10', '2026-10-01', T).error, 'La fecha final es anterior a la inicial.');
  assert.strictEqual(validateCustom('2026-10-01', '2026-10-06', T).error, 'La fecha final no puede ser futura.');
  assert.strictEqual(validateCustom('2024-10-01', T, T).error, 'Elegí un período de hasta dos años.');
  assert.strictEqual(validateCustom('2026-02-30', T, T).ok, false, 'an impossible date');
  assert.deepStrictEqual(validateCustom('2026-09-01', T, T), { ok: true, range: { from: '2026-09-01', to: T } });
  assert.strictEqual(granularityFor({ from: '2026-01-01', to: '2026-03-31' }), 'day');
  assert.strictEqual(granularityFor({ from: '2026-01-01', to: '2026-06-30' }), 'week');
  assert.strictEqual(granularityFor({ from: '2025-01-01', to: T }), 'month');
});

test('"Actualizado" comes from the per-day computed_at: en vivo / hoy / ayer / a date', () => {
  const now = Date.UTC(2026, 9, 5, 18, 0);   // 12:00 Honduras, 5 oct
  assert.strictEqual(updatedLabel([{ computed_at: '2026-10-04T09:12:00.000Z' }, { computed_at: 'live' }], now), 'en vivo');
  assert.strictEqual(updatedLabel([{ computed_at: '2026-10-05T09:12:00.000Z' }], now), 'hoy 03:12');
  assert.strictEqual(updatedLabel([{ computed_at: '2026-10-04T09:12:00.000Z' }, { computed_at: '2026-10-03T09:00:00.000Z' }], now), 'ayer 03:12');
  assert.strictEqual(updatedLabel([{ computed_at: '2026-09-20T09:12:00.000Z' }], now), '20 sep 03:12');
  assert.strictEqual(updatedLabel([{ computed_at: null }], now), null);
  assert.strictEqual(missingLabel(['2026-10-03', '2026-10-04']), '3 oct, 4 oct');
});

test('GOLDEN vs the mockup: chart points and heat alpha are the mockup\'s own formulas', () => {
  // the approved mockup's sample series and its pts(): x = round(i·1000/6), y = round(258 − v/max·250)
  const cur = [4.9, 4.2, 5.1, 5.6, 7.4, 8.1, 6.3], cmp = [4.4, 4.0, 4.6, 5.0, 6.6, 7.2, 5.9];
  const max = Math.max(...cur, ...cmp) * 1.15;
  const mock = (a) => a.map((v, i) => `${Math.round(i * 1000 / 6)},${Math.round(258 - (v / max) * 250)}`).join(' ');
  assert.strictEqual(points(cur, max), mock(cur));
  assert.strictEqual(points(cmp, max), mock(cmp));
  assert.strictEqual(points(cur, max), '0,126 167,145 333,121 500,108 667,59 833,41 1000,89', 'frozen literal');
  // heat: mockup a = v===0 ? .05 : .12 + v·.088 on a 0..10 scale whose max is 10 → ours with peak = 10
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ orders: 0, cents: 0 })));
  heatmap[5][19].orders = 10; heatmap[0][12].orders = 4; heatmap[0][22].orders = 0; heatmap[1][13].orders = 1;
  const vm = viewModel({ heatmap, kpis: { orders: 1 } }, { range: rangeFor('7d', T), compare: 'previous', metric: 'sales', nowMs: 0 });
  const cell = (w, h) => vm.heat[w].cells[vm.hours.indexOf(h)];
  for (const [w, h, v] of [[5, 19, 10], [0, 12, 4], [1, 13, 1], [0, 15, 0]]) {
    assert.strictEqual(cell(w, h).alpha.toFixed(2), (v === 0 ? 0.05 : 0.12 + v * 0.088).toFixed(2), `alpha for v=${v}`);
  }
  assert.strictEqual(vm.peakNote, 'Pedidos por día y hora · hora de Honduras · pico: sábado 19:00, 10 pedidos');
  assert.deepStrictEqual(vm.hours, [12, 13, 14, 15, 16, 17, 18, 19], 'the hours that had orders');
  assert.strictEqual(cell(0, 12).label, 'Lun 12:00, 4 pedidos');
});

test('x labels: at most 7, first and last always shown', () => {
  const series = Array.from({ length: 30 }, (_, i) => ({ key: addDays('2026-09-06', i), sales_cents: i, orders: 1 }));
  const vm = viewModel({ series, kpis: { orders: 1 } }, { range: rangeFor('30d', T), compare: 'none', metric: 'sales', nowMs: 0 });
  assert.strictEqual(vm.chart.xLabels.length, 7);
  assert.strictEqual(vm.chart.xLabels[0], 'Dom 6');
  assert.strictEqual(vm.chart.xLabels[6], 'Lun 5');
  const vm7 = viewModel({ series: series.slice(23), kpis: { orders: 1 } }, { range: rangeFor('7d', T), compare: 'none', metric: 'sales', nowMs: 0 });
  assert.deepStrictEqual(vm7.chart.xLabels, ['Mar 29', 'Mié 30', 'Jue 1', 'Vie 2', 'Sáb 3', 'Dom 4', 'Lun 5'], 'the mockup\'s row, for its period');
});

test('CSV allowlist: exact header only; pages join with the header once', () => {
  assert.ok(csvHeaderOk('daily', `${CSV_HEADERS.daily.join(',')}\r\nx`));
  assert.ok(csvHeaderOk('orders', `${CSV_HEADERS.orders.join(',')}\r\n`));
  assert.ok(!csvHeaderOk('orders', `${CSV_HEADERS.orders.join(',')},telefono\r\n`));
  assert.ok(!csvHeaderOk('orders', `${CSV_HEADERS.daily.join(',')}\r\n`), 'a daily header is not an orders header');
  assert.ok(!csvHeaderOk('nope', 'fecha'));
  assert.ok(!csvHeaderOk('daily', null));
  for (const pii of ['telefono', 'phone', 'nombre', 'direccion', 'address', 'email', 'rtn', 'lat', 'lng', 'token']) {
    assert.ok(!CSV_HEADERS.orders.includes(pii) && !CSV_HEADERS.daily.includes(pii), `no ${pii} column is allowlisted`);
  }
  assert.strictEqual(joinCsvPages(['h\r\na\r\n', 'h\r\nb\r\n', 'h\r\n']), 'h\r\na\r\nb\r\n');
  assert.strictEqual(csvFilename('orders', 'x_pizza', { from: 'a', to: 'b' }), 'pedidos_x_pizza_a_b.csv');
});

test('API failures → Ventas sentences', () => {
  assert.strictEqual(ventasMessage('NotAuthorized', 'not_owner')[0], 'Solo el dueño ve las ventas');
  assert.strictEqual(ventasMessage('NotAuthorized', 'not_authorized')[0], 'No tenés acceso a este local');
  assert.strictEqual(ventasMessage('Unavailable')[0], 'No pudimos cargar las ventas');
  assert.strictEqual(ventasMessage('Whatever')[0], 'Algo salió mal');
});

test('single day: the hourly window spans BOTH periods, so the comparison is not flattened to zero', () => {
  const grid = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ orders: 0, cents: 0 })));
  const cur = grid(); cur[0][8] = { orders: 2, cents: 20000 };                      // Monday 5 oct, 08:00
  const prev = grid(); prev[0][19] = { orders: 3, cents: 45000 };                   // Monday 28 sep, 19:00
  const vm = viewModel({ heatmap: cur, kpis: { orders: 2 }, comparison: { range: { from: '2026-09-28', to: '2026-09-28' }, heatmap: prev, kpis: {} } },
    { range: rangeFor('today', T), compare: 'previous_week', metric: 'sales', nowMs: 0 });
  const ys = (pts) => pts.split(' ').map((p) => Number(p.split(',')[1]));
  assert.ok(Math.min(...ys(vm.chart.prev)) < 258, '🔴 the comparison line rises somewhere (19:00), not flat at zero');
  assert.ok(Math.min(...ys(vm.chart.cur)) < 258, 'and the current line too (08:00)');
  assert.strictEqual(vm.chart.xLabels[0], '8:00');
  assert.strictEqual(vm.chart.xLabels[vm.chart.xLabels.length - 1], '19:00');
});
