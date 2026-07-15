'use strict';
const assert = require('assert');
const { mean, quantile, bhFdrAdjust, bootstrapLowerP } = require('./ready-time-graduation');
const { coverageByCoarse, gateBucket, daypartKeyOf } = require('./ready-time-graduation');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const LUNCH = Date.UTC(2026,6,14,18,0);   // used by Task 2 coverage/gate tests

assert.strictEqual(mean([2,4,6]), 4); ok('mean');
assert.strictEqual(quantile([1,2,3,4], 50), 2); ok('quantile nearest-rank');

// BH-FDR: known example. pvals [0.01,0.02,0.03,0.04,0.05] at any q → monotone adjusted, order preserved.
{
  const adj = bhFdrAdjust([0.04, 0.01, 0.03]);   // unsorted input
  assert.strictEqual(adj.length, 3);
  assert.ok(adj[1] <= adj[2] && adj[2] <= adj[0], 'monotone by original p-order');
  assert.ok(Math.abs(adj[1] - 0.03) < 1e-9, 'smallest p*n/rank');   // 0.01*3/1
  ok('bhFdrAdjust');
}

// seeded RNG → deterministic. A clearly-positive delta (all ≈ +5, threshold 1) → tiny pValue.
{
  const rng = mulberry32(42);
  const deltas = Array.from({length: 60}, () => 5 + (rng()-0.5)); // ~+5 ± .5
  const { pValue, lowerCB } = bootstrapLowerP(deltas, 1, { rng: mulberry32(7), resamples: 400 });
  assert.ok(pValue < 0.01, `expected tiny p, got ${pValue}`);
  assert.ok(lowerCB > 1, `lowerCB above threshold, got ${lowerCB}`);
  ok('bootstrapLowerP: strong improvement passes');
}
// A null delta (≈ 0, threshold 1) → large pValue (won't reject).
{
  const rng = mulberry32(9);
  const deltas = Array.from({length: 60}, () => (rng()-0.5));  // ~0
  const { pValue } = bootstrapLowerP(deltas, 1, { rng: mulberry32(7), resamples: 400 });
  assert.ok(pValue > 0.2, `expected large p, got ${pValue}`);
  ok('bootstrapLowerP: no improvement fails');
}

// ── Task 2: coverage split + fail-closed gate ──
// coverage: 2 of 5 rows at (x_pizza, lunch) had no prediction → missing_share 0.4
{
  const rows = [
    {restaurant_id:'x_pizza', new_at: LUNCH, prediction_missing:true},
    {restaurant_id:'x_pizza', new_at: LUNCH, prediction_missing:true},
    {restaurant_id:'x_pizza', new_at: LUNCH},
    {restaurant_id:'x_pizza', new_at: LUNCH},
    {restaurant_id:'x_pizza', new_at: LUNCH},
  ];
  const cov = coverageByCoarse(rows);
  const key = `x_pizza|${daypartKeyOf(LUNCH)}`;
  assert.ok(Math.abs(cov[key].missing_share - 0.4) < 1e-9); ok('coverageByCoarse');
}
// gate fail-closed: a strong bucket with GOOD coarse coverage graduates; same bucket with BAD coverage does not.
{
  const cfg = { graduation_thresholds: { margin:1, margin_bkt:1, q_fdr:0.1, min_samples:30, coverage_cap:0.2, excl_cap:0.2, late_cap:0.15, p90_cap:5, within_floor:0.6, bias_cap:1 } };
  const strong = { n:50, quarantined_share:0.02, pAdjBuf:0.001, pAdjBkt:0.002, lowerCbBuf:2, lowerCbBkt:2, bias:0.3, late_rate:0.05, p90:3.5, within_n:0.8, buffer_within_n:0.55, sensitivity_ok:true };
  assert.strictEqual(gateBucket(strong, {missing_share:0.05}, cfg).graduated, true, 'good coverage → graduate');
  assert.strictEqual(gateBucket(strong, {missing_share:0.5}, cfg).graduated, false, 'bad coverage → block');
  assert.strictEqual(gateBucket({...strong, n:10}, {missing_share:0.05}, cfg).graduated, false, 'thin n → fail-closed');
  assert.strictEqual(gateBucket({...strong, late_rate:0.5}, {missing_share:0.05}, cfg).graduated, false, 'late-rate cap');
  ok('gateBucket fail-closed');
}

// tiny deterministic PRNG for tests
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

console.log(`\n${pass} passed`);
