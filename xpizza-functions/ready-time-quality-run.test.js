'use strict';

// Golden tests for the PURE helpers of the data-quality runner (ready-time-quality-run.js).
// Run: node ready-time-quality-run.test.js   (no emulator — the I/O side effects are proven separately
// in test/ready-time-quality-run.emulator.test.js).
// See PHASE1_STEP1B_QUALITY_RUNNER.md (rev-3): hash completeness (#2), fail-closed window (#4),
// active-restaurant materialization (#3, E2), freshness contract (E1b) + run-existence pin, monotonic
// latest (pin 2), pickNewEvent imported-not-copied (#8).
const assert = require('assert');
const runner = require('./ready-time-quality-run');
const core = require('./ready-time-quality');
const {
  hashRows, hashConfig, resolveWindow, buildRunNode, isFreshAuthoritativeRun, latestMergeMonotonic,
} = runner;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const baseRow = () => ({
  order: { restaurant_id: 'x_pizza', customer_phone: '99998888', order_id: 'A' },
  timeline: { new_at: 2000, preparing_at: 2100, ready_at: 2200, out_for_delivery_at: 2300, delivered_at: 2400 },
  events: { e1: { from: null, to: 'new', at: 2000, kitchen_load_ahead: 1 }, e2: { from: 'new', to: 'preparing', at: 2100, kitchen_load_ahead: 2 } },
});

// ── hashRows — completeness manifest (fold #2): every core-read field flips the hash ──
{
  const base = hashRows([baseRow()]);
  const mut = (f) => { const r = baseRow(); f(r); return hashRows([r]); };
  const fields = [
    ['order.restaurant_id', (r) => { r.order.restaurant_id = 'la_musa'; }],
    ['order.customer_phone', (r) => { r.order.customer_phone = '88887777'; }],
    ['order.order_id', (r) => { r.order.order_id = 'Z'; }],
    ['timeline.new_at', (r) => { r.timeline.new_at = 9; }],
    ['timeline.preparing_at', (r) => { r.timeline.preparing_at = 9; }],
    ['timeline.ready_at', (r) => { r.timeline.ready_at = 9; }],
    ['timeline.out_for_delivery_at', (r) => { r.timeline.out_for_delivery_at = 9; }],
    ['timeline.delivered_at', (r) => { r.timeline.delivered_at = 9; }],
    ['event.from', (r) => { r.events.e1.from = 'x'; }],
    ['event.to', (r) => { r.events.e1.to = 'preparing'; }],
    ['event.at', (r) => { r.events.e1.at = 1; }],
    ['event.kitchen_load_ahead', (r) => { r.events.e1.kitchen_load_ahead = 99; }],
    ['event.key', (r) => { r.events.e3 = { from: 'preparing', to: 'ready', at: 2200, kitchen_load_ahead: 3 }; }],
  ];
  for (const [name, f] of fields) assert.notStrictEqual(mut(f), base, `hash must change on ${name}`);
  ok('hashRows: every core-read field (13) flips the hash');
  // canonical: event-key order + row order don't matter
  const permEvents = baseRow(); permEvents.events = { e2: baseRow().events.e2, e1: baseRow().events.e1 };
  assert.strictEqual(hashRows([permEvents]), base); ok('hashRows: event-key order is canonical (same hash)');
  const b = baseRow(); b.order.order_id = 'B';
  assert.strictEqual(hashRows([baseRow(), b]), hashRows([b, baseRow()])); ok('hashRows: row order is canonical (same hash)');
}

// ── hashConfig — each config input flips the hash ──
{
  const cfg = { active_restaurants: ['x_pizza'], epoch_start_ms: { x_pizza: 1000 }, excluded_phones: {}, excluded_orders: {}, cleanup_paths: [], critical_segments: {}, quality_thresholds: { version: 't1', approved_at: 1 }, settle_lag_ms: 100 };
  const base = hashConfig(cfg);
  assert.notStrictEqual(hashConfig({ ...cfg, active_restaurants: ['x_pizza', 'la_musa'] }), base); ok('hashConfig: active_restaurants flips hash (E2)');
  assert.notStrictEqual(hashConfig({ ...cfg, settle_lag_ms: 200 }), base); ok('hashConfig: settle_lag_ms flips hash');
  assert.notStrictEqual(hashConfig({ ...cfg, quality_thresholds: { version: 't2', approved_at: 1 } }), base); ok('hashConfig: quality_thresholds flips hash');
  assert.notStrictEqual(hashConfig({ ...cfg, critical_segments: { x_pizza: [{ segment: '18', scope: 'in' }] } }), base); ok('hashConfig: critical_segments flips hash');
}

// ── resolveWindow — fail-closed (fold #4, E2) ──
const CFG = { active_restaurants: ['x_pizza', 'la_musa'], epoch_start_ms: { x_pizza: 1000, la_musa: 1000 }, settle_lag_ms: 100 };
{
  const w = resolveWindow(CFG, 10000, {});
  assert.deepStrictEqual({ from: w.from_ms, to: w.to_ms, s: w.settled, m: w.mode }, { from: 1000, to: 9900, s: true, m: 'authoritative' }); ok('resolveWindow: authoritative clamps to now−settle_lag, settled');
  assert.strictEqual(resolveWindow({ ...CFG, active_restaurants: [] }, 10000, {}).status, 'config_invalid'); ok('resolveWindow: empty active_restaurants → config_invalid (E2)');
  assert.strictEqual(resolveWindow({ ...CFG, active_restaurants: undefined }, 10000, {}).status, 'config_invalid'); ok('resolveWindow: missing active_restaurants → config_invalid');
  assert.strictEqual(resolveWindow({ ...CFG, settle_lag_ms: undefined }, 10000, {}).status, 'config_invalid'); ok('resolveWindow: non-finite settle_lag_ms → config_invalid');
  assert.strictEqual(resolveWindow({ ...CFG, epoch_start_ms: { x_pizza: 1000 } }, 10000, {}).status, 'config_invalid'); ok('resolveWindow: active la_musa missing epoch → config_invalid');
  assert.strictEqual(resolveWindow(CFG, 10000, { from: 500 }).from_ms, 1000); ok('resolveWindow: requested.from < epoch → clamped up to epoch');
  assert.strictEqual(resolveWindow(CFG, 10000, { from: 5000 }).from_ms, 5000); ok('resolveWindow: requested.from ≥ epoch → honored');
  assert.strictEqual(resolveWindow(CFG, 1050, {}).status, 'nothing_settled'); ok('resolveWindow: from_ms ≥ to_ms → nothing_settled');
  const p = resolveWindow(CFG, 10000, { mode: 'preview' });
  assert.deepStrictEqual({ to: p.to_ms, s: p.settled, m: p.mode }, { to: 10000, s: false, m: 'preview' }); ok('resolveWindow: preview → to_ms=now, settled false');
}

// ── buildRunNode — every active restaurant materialized (fold #3), empty_settled_window (E1a) ──
{
  const win = { from_ms: 1000, to_ms: 9900, settled: true, mode: 'authoritative' };
  const opts = { active: ['x_pizza', 'la_musa'], window: win, input_hash: 'I', config_hash: 'C', thresholds: { version: 't1', approved_at: 1 }, now: 9500 };
  const node = buildRunNode({ restaurants: { x_pizza: { n_population: 5, capture_acceptable: true, gate_reasons: [] } } }, opts);
  assert.strictEqual(node.restaurants.la_musa.capture_acceptable, false); assert.ok(node.restaurants.la_musa.gate_reasons.includes('empty_denominator')); ok('buildRunNode: absent active restaurant materialized as fail (empty_denominator)');
  assert.strictEqual(node.status, 'ok'); assert.strictEqual(node.computed_at, 9500); ok('buildRunNode: status ok when ≥1 restaurant has rows; computed_at=now');
  const empty = buildRunNode({ restaurants: {} }, opts);
  assert.strictEqual(empty.status, 'empty_settled_window'); assert.strictEqual(empty.restaurants.x_pizza.capture_acceptable, false); ok('buildRunNode: all-empty active set → status empty_settled_window, all fail');
}

// ── isFreshAuthoritativeRun — freshness contract (E1b) + run-existence pin (pin 1) ──
{
  const latest = { status: 'ok', mode: 'authoritative', settled: true, config_hash: 'H', window: { from_ms: 1000, to_ms: 9900 }, computed_at: 9000, runId: 'r1' };
  const exp = { now: 9500, config_hash: 'H', coverage: { from_ms: 2000, to_ms: 9000 }, max_age_ms: 1000, runExists: true };
  assert.deepStrictEqual(isFreshAuthoritativeRun(latest, exp), { fresh: true, reasons: [] }); ok('fresh: current ok/auth/settled/covering/in-age + run exists → fresh');
  assert.deepStrictEqual(isFreshAuthoritativeRun(null, exp).reasons, ['no_latest_run']); ok('fresh: no latest → no_latest_run');
  assert.ok(isFreshAuthoritativeRun({ ...latest, status: 'config_invalid' }, exp).reasons.includes('run_not_ok')); ok('fresh: beacon status config_invalid → run_not_ok (E1a↔E1b)');
  assert.ok(isFreshAuthoritativeRun({ ...latest, mode: 'preview' }, exp).reasons.includes('not_authoritative')); ok('fresh: mode preview → not_authoritative');
  assert.ok(isFreshAuthoritativeRun({ ...latest, settled: false }, exp).reasons.includes('not_settled')); ok('fresh: settled false → not_settled');
  assert.ok(isFreshAuthoritativeRun({ ...latest, config_hash: 'OTHER' }, exp).reasons.includes('config_hash_mismatch')); ok('fresh: stale config → config_hash_mismatch');
  assert.ok(isFreshAuthoritativeRun(latest, { ...exp, coverage: { from_ms: 2000, to_ms: 9950 } }).reasons.includes('coverage_shortfall')); ok('fresh: window does not cover expected → coverage_shortfall');
  assert.ok(isFreshAuthoritativeRun(latest, { ...exp, now: 11000 }).reasons.includes('stale')); ok('fresh: computed_at older than max_age → stale');
  assert.ok(isFreshAuthoritativeRun(latest, { ...exp, runExists: false }).reasons.includes('run_missing')); ok('fresh: runs/{runId} absent → run_missing (pin 1 — beacon runId not trusted blindly)');
}

// ── latestMergeMonotonic — an overlapping run can't repoint latest backwards (pin 2) ──
{
  const cur = { computed_at: 100, runId: 'new' }; const older = { computed_at: 50, runId: 'old' }; const newer = { computed_at: 150, runId: 'newer' };
  assert.strictEqual(latestMergeMonotonic(cur, older).runId, 'new'); ok('latest: older node cannot overwrite newer latest (keeps cur)');
  assert.strictEqual(latestMergeMonotonic(cur, newer).runId, 'newer'); ok('latest: newer node overwrites');
  assert.strictEqual(latestMergeMonotonic(null, older).runId, 'old'); ok('latest: no existing → node');
}

// ── pickNewEvent imported, not copied (fold #8) ──
{
  assert.strictEqual(runner.pickNewEvent, core.pickNewEvent); ok('pickNewEvent: runner re-uses the FROZEN core reference (identity, not a copy)');
  const dup = { b: { to: 'new', at: 100 }, a: { to: 'new', at: 100 } };
  assert.strictEqual(runner.pickNewEvent(dup), core.pickNewEvent(dup)); ok('pickNewEvent: duplicate to:new tie-break identical to core selection');
}

console.log(`\n${n} passed`);
