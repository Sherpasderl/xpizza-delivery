'use strict';

// Golden tests for the pure Ready-Time Phase-1 Step-1a data-quality monitor helpers
// (ready-time-quality.js). Run: node ready-time-quality.test.js
// A data-quality monitor must NEVER let a capture failure hide as a pass — every metric below is a
// gate input, so the design (PHASE1_STEP1_DATA_QUALITY_MONITOR.md rev-3) is pinned here, including all
// R2 false-green paths (population independence, non-kitchen-path gate, vacuous criticals, staleness).
const assert = require('assert');
const {
  rushProxyLoad, loadBucket, percentile, isMonitorPopulation,
  computeQualityMetrics, isCaptureAcceptable, runIdFor,
} = require('./ready-time-quality');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ev = (from, to, at, load) => ({ from, to, at, kitchen_load_ahead: load });

// ── rushProxyLoad — max load across {new, preparing, out_for_delivery} (fold #8) ──
{
  assert.strictEqual(rushProxyLoad({ a: ev(null, 'new', 100, 2), b: ev('new', 'preparing', 200, 5), c: ev('ready', 'out_for_delivery', 300, 3) }), 5); ok('rushProxyLoad: max across new/preparing/ofd = 5');
  assert.strictEqual(rushProxyLoad({ c: ev('ready', 'out_for_delivery', 300, 4) }), 4); ok('rushProxyLoad: OFD-only load = 4 (completion moment)');
  assert.strictEqual(rushProxyLoad({ a: ev(null, 'new', 100, undefined), b: ev('new', 'preparing', 200, null) }), null); ok('rushProxyLoad: no numeric load → null');
  assert.strictEqual(rushProxyLoad({ x: ev('ready', 'delivered', 400, 9) }), null); ok('rushProxyLoad: only non-{new,prep,ofd} events → null (delivered load not used)');
}

// ── loadBucket ──
{
  assert.deepStrictEqual([0, 1, 2, 3, 5, 6, 12, null].map(loadBucket), ['0', '1-2', '1-2', '3-5', '3-5', '6+', '6+', 'unknown']); ok('loadBucket: 0/1-2/3-5/6+/unknown edges');
}

// ── percentile — nearest-rank ──
{
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepStrictEqual([25, 50, 75, 90].map((p) => percentile(a, p)), [3, 5, 8, 9]); ok('percentile: nearest-rank p25/p50/p75/p90');
  assert.strictEqual(percentile([100], 90), 100); ok('percentile: single-element → that element');
  assert.strictEqual(percentile([], 50), null); ok('percentile: empty → null');
}

// ── isMonitorPopulation — INDEPENDENT of the label gates (fold #1, A) ──
const CFG = { epoch_start_ms: { x_pizza: 1000, la_musa: 1000 }, excluded_phones: { '50493736607': true }, excluded_orders: {} };
{
  const o = { restaurant_id: 'x_pizza', order_id: 'O', customer_phone: '99998888' };
  // missed tap (has OFD event, NO ready_at) is INCLUDED — it's the signal
  assert.strictEqual(isMonitorPopulation(o, { new_at: 2000 }, { a: ev(null, 'new', 2000, 1), b: ev('preparing', 'out_for_delivery', 2400, 1) }, CFG).included, true); ok('population: missed-tap order (OFD, no ready_at) → INCLUDED');
  // missing timeline.new_at but valid to:'new' event → INCLUDED (fold A), not dropped
  assert.strictEqual(isMonitorPopulation(o, {}, { a: ev(null, 'new', 2000, 1) }, CFG).included, true); ok('population: missing new_at stamp + valid to:new event → INCLUDED (fold A)');
  // no to:'new' event → excluded
  assert.deepStrictEqual(isMonitorPopulation(o, { new_at: 2000 }, { a: ev('new', 'preparing', 2100, 1) }, CFG), { included: false, reasons: ['no_new_event'] }); ok('population: no to:new event → excluded [no_new_event]');
  // pre-epoch → excluded via nonLabelExclusions
  assert.ok(isMonitorPopulation(o, { new_at: 500 }, { a: ev(null, 'new', 500, 1) }, CFG).reasons.includes('before_epoch')); ok('population: pre-epoch → excluded [before_epoch]');
  // denylisted phone → excluded
  const od = { ...o, customer_phone: '50493736607' };
  assert.ok(isMonitorPopulation(od, { new_at: 2000 }, { a: ev(null, 'new', 2000, 1) }, CFG).reasons.includes('excluded_phone')); ok('population: denylisted phone → excluded [excluded_phone]');
}

// ── isCaptureAcceptable — signed thresholds, finite guards, rush-bias gates (folds #2..#8, A, B) ──
const TH = {
  version: 't1', approved_at: 1, min_segment_n: 2, min_bucket_n: 5, min_tap_rate: 0.9, min_rush_bias: 0.85,
  min_top_tap_rate: 0.85, max_impossible_rate: 0.02, max_unknown_load_share: 0.05, max_new_at_missingness: 0.02, max_non_kitchen_path_share: 0.10,
};
const cleanBundle = () => ({
  n_kitchen_path: 100, tap_rate: 0.95,
  by_load: { '0': { n: 50, hits: 48, tap_rate: 0.96 }, '6+': { n: 50, hits: 47, tap_rate: 0.94 } },
  impossible_timeline_rate: 0.0, n_multi_stamp: 100, new_at_missingness: 0.0, non_kitchen_path_share: 0.0, unknown_load: { share: 0.0 },
});
{
  assert.deepStrictEqual(isCaptureAcceptable(cleanBundle(), TH), { acceptable: true, reasons: [] }); ok('verdict: clean signed bundle → acceptable');
  // fold #2 — unsigned thresholds
  assert.deepStrictEqual(isCaptureAcceptable(cleanBundle(), { ...TH, version: undefined }).reasons, ['unsigned_thresholds']); ok('verdict: missing version → [unsigned_thresholds]');
  assert.deepStrictEqual(isCaptureAcceptable(cleanBundle(), { ...TH, approved_at: undefined }).reasons, ['unsigned_thresholds']); ok('verdict: missing approved_at → [unsigned_thresholds]');
  assert.deepStrictEqual(isCaptureAcceptable(cleanBundle(), undefined).reasons, ['unsigned_thresholds']); ok('verdict: no thresholds → [unsigned_thresholds]');
  // fold #3 — finite / denominator guards
  { const b = cleanBundle(); b.n_kitchen_path = 0; b.tap_rate = null; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('empty_denominator')); ok('verdict: n_kitchen_path 0 / tap_rate null → empty_denominator'); }
  { const b = cleanBundle(); b.tap_rate = NaN; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('non_finite_metric')); ok('verdict: tap_rate NaN → non_finite_metric'); }
  { const b = cleanBundle(); b.tap_rate = Infinity; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('non_finite_metric')); ok('verdict: tap_rate Infinity → non_finite_metric'); }
  // low tap_rate
  { const b = cleanBundle(); b.tap_rate = 0.5; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('low_tap_rate')); ok('verdict: tap_rate 0.5 → low_tap_rate'); }
  // fold #6 — rush-biased (contrast top-vs-lowest sufficient) + absolute top floor
  { const b = cleanBundle(); b.by_load = { '0': { n: 50, hits: 49, tap_rate: 0.98 }, '6+': { n: 50, hits: 25, tap_rate: 0.5 } };
    const r = isCaptureAcceptable(b, TH).reasons; assert.ok(r.includes('rush_biased_capture') && r.includes('low_top_tap_rate'), r); ok('verdict: high-load tap_rate 0.5 vs low 0.98 → rush_biased_capture + low_top_tap_rate'); }
  // fold #5 — single populated bucket → insufficient coverage
  { const b = cleanBundle(); b.by_load = { '0': { n: 100, hits: 95, tap_rate: 0.95 } }; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('insufficient_load_coverage')); ok('verdict: single load bucket → insufficient_load_coverage'); }
  // fold #4 — top present bucket too thin
  { const b = cleanBundle(); b.by_load = { '0': { n: 50, hits: 48, tap_rate: 0.96 }, '6+': { n: 1, hits: 1, tap_rate: 1 } }; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('insufficient_load_bucket')); ok('verdict: top bucket n=1 < min_bucket_n → insufficient_load_bucket'); }
  // fold #7 — unknown load excess
  { const b = cleanBundle(); b.unknown_load = { share: 0.2 }; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('unknown_load_excess')); ok('verdict: unknown_load share 0.2 → unknown_load_excess'); }
  // high impossible rate
  { const b = cleanBundle(); b.impossible_timeline_rate = 0.1; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('high_impossible_rate')); ok('verdict: impossible 0.1 → high_impossible_rate'); }
  // fold A — new_at missingness
  { const b = cleanBundle(); b.new_at_missingness = 0.1; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('high_new_at_missingness')); ok('verdict: new_at_missingness 0.1 → high_new_at_missingness'); }
  // fold B — non-kitchen-path excess
  { const b = cleanBundle(); b.non_kitchen_path_share = 0.3; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('non_kitchen_path_excess')); ok('verdict: non_kitchen_path_share 0.3 → non_kitchen_path_excess'); }
  // insufficient sample
  { const b = cleanBundle(); b.n_kitchen_path = 1; assert.ok(isCaptureAcceptable(b, TH).reasons.includes('insufficient_sample')); ok('verdict: n_kitchen_path 1 < min_segment_n → insufficient_sample'); }
}

// ── computeQualityMetrics — integration (kitchen-path denom, cleanup exemption, criticals, hour bucket) ──
// at=2000ms → UTC−6 = 1969-12-31 18:00 → hour '18'. All rows land in segment 18.
const rows = () => [
  // A: kitchen-path, tapped, load1 → bucket '1-2', dwell 100
  { order: { restaurant_id: 'x_pizza', order_id: 'A', customer_phone: '99998888' },
    timeline: { new_at: 2000, preparing_at: 2100, ready_at: 2200, out_for_delivery_at: 2300 },
    events: { e1: ev(null, 'new', 2000, 1), e2: ev('new', 'preparing', 2100, 1), e3: ev('preparing', 'ready', 2200, 1), e4: ev('ready', 'out_for_delivery', 2300, 1) } },
  // B: kitchen-path (preparing→ofd), MISSED tap, load6 → bucket '6+'
  { order: { restaurant_id: 'x_pizza', order_id: 'B', customer_phone: '99998888' },
    timeline: { new_at: 2000, preparing_at: 2100, out_for_delivery_at: 2400 },
    events: { e1: ev(null, 'new', 2000, 6), e2: ev('new', 'preparing', 2100, 6), e3: ev('preparing', 'out_for_delivery', 2400, 6) } },
  // C: non-kitchen-path terminal (new→delivered cleanup), load1
  { order: { restaurant_id: 'x_pizza', order_id: 'C', customer_phone: '99998888' },
    timeline: { new_at: 2000, delivered_at: 2500 },
    events: { e1: ev(null, 'new', 2000, 1), e2: ev('new', 'delivered', 2500, 1) } },
  // D: not terminal (still preparing), load1
  { order: { restaurant_id: 'x_pizza', order_id: 'D', customer_phone: '99998888' },
    timeline: { new_at: 2000, preparing_at: 2100 },
    events: { e1: ev(null, 'new', 2000, 1), e2: ev('new', 'preparing', 2100, 1) } },
];
{
  const m = computeQualityMetrics(rows(), { ...CFG, cleanup_paths: [], critical_segments: {} }, TH).restaurants.x_pizza;
  assert.strictEqual(m.n_population, 4); ok('metrics: n_population = 4');
  assert.strictEqual(m.n_terminal, 3); ok('metrics: n_terminal = 3 (A,B,C)');
  assert.strictEqual(m.n_kitchen_path, 2); ok('metrics: n_kitchen_path = 2 (A,B)');
  assert.strictEqual(m.tap_rate, 0.5); ok('metrics: tap_rate = 1/2 (A tapped, B missed)');
  assert.strictEqual(m.n_non_kitchen_path, 1); ok('metrics: n_non_kitchen_path = 1 (C, cleanup_paths empty)');
  assert.ok(Math.abs(m.non_kitchen_path_share - 1 / 3) < 1e-9); ok('metrics: non_kitchen_path_share = 1/3');
  assert.strictEqual(m.tapped_sane_ready_to_ofd_ms.n, 1); assert.strictEqual(m.tapped_sane_ready_to_ofd_ms.median, 100); ok('metrics: dwell over tapped-sane rows only (A) → n1 median 100');
  assert.ok(m.by_segment['18'], 'segment 18 present'); ok('metrics: rows bucketed into hour segment 18 (UTC−6 anchor from event at)');
  // cleanup exemption (fold B): classify new>delivered as cleanup → C no longer counts as non-kitchen-path
  const m2 = computeQualityMetrics(rows(), { ...CFG, cleanup_paths: ['new>delivered'], critical_segments: {} }, TH).restaurants.x_pizza;
  assert.strictEqual(m2.n_non_kitchen_path, 0); ok('metrics: cleanup_paths [new>delivered] exempts C → n_non_kitchen_path 0');
}

// ── restaurant verdict — critical_segments fail-closed (fold C) ──
{
  // missing critical_segments → missing_critical_segments (vacuous green blocked)
  const mMissing = computeQualityMetrics(rows(), { ...CFG, cleanup_paths: [], critical_segments: {} }, TH).restaurants.x_pizza;
  assert.strictEqual(mMissing.capture_acceptable, false); assert.ok(mMissing.gate_reasons.includes('missing_critical_segments')); ok('restaurant: no critical_segments → missing_critical_segments (fail)');
  // all out_of_scope → still missing_critical_segments
  const mAllOut = computeQualityMetrics(rows(), { ...CFG, cleanup_paths: [], critical_segments: { x_pizza: [{ segment: '18', scope: 'out' }] } }, TH).restaurants.x_pizza;
  assert.ok(mAllOut.gate_reasons.includes('missing_critical_segments')); ok('restaurant: all critical segments out_of_scope → missing_critical_segments (fail)');
  // in-scope segment 18 fails (tap_rate 0.5 < 0.9) → restaurant fails on that segment
  const mFail = computeQualityMetrics(rows(), { ...CFG, cleanup_paths: [], critical_segments: { x_pizza: [{ segment: '18', scope: 'in' }] } }, TH).restaurants.x_pizza;
  assert.strictEqual(mFail.capture_acceptable, false); assert.ok(mFail.gate_reasons.some((r) => r.includes('18'))); ok('restaurant: in-scope critical segment 18 failing → restaurant not acceptable');
}

// ── runIdFor — idempotency keyed on input+config hash, NOT window alone (fold #12, D) ──
{
  const a = runIdFor('inputHashA', 'cfgHash1');
  assert.strictEqual(a, runIdFor('inputHashA', 'cfgHash1')); ok('runId: same input+config → same id (create-only no-op)');
  assert.notStrictEqual(a, runIdFor('inputHashB', 'cfgHash1')); ok('runId: changed joined input (late events) → different id (no stale no-op)');
  assert.notStrictEqual(a, runIdFor('inputHashA', 'cfgHash2')); ok('runId: changed config → different id');
}

console.log(`\n${n} passed`);
