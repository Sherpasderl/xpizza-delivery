'use strict';
const assert = require('assert');
const { mean, quantile, bhFdrAdjust, bootstrapLowerP } = require('./ready-time-graduation');
const { coverageByCoarse, gateBucket, daypartKeyOf } = require('./ready-time-graduation');
const { computeGraduation } = require('./ready-time-graduation');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const GT = { margin:1, margin_bkt:1, q_fdr:0.1, min_samples:30, coverage_cap:0.2, excl_cap:0.2,
  late_cap:0.15, p90_cap:5, within_floor:0.6, bias_cap:1, within_n_min:5, ttl_ms:216e5, window_ms:12096e5, bootstrap_resamples:400 };
// 50 matched rows, one tuple: predictor tracks each order (tiny error), actuals SPREAD 10–20 so both the flat
// buffer (12) and the bucket median (~15) are poor per-order baselines → δ_buf, δ_bkt clearly positive.
function makeStrongBucketRows(){
  const rows = [];
  for (let i=0;i<50;i++){
    const actual = 10 + (i % 11);          // 10..20 spread
    const err = (i % 3) * 0.2;             // 0, 0.2, 0.4 — small, all ≥0 (late_rate 0, small bias)
    rows.push({ model_version:'v1', restaurant_id:'x_pizza', source:'exact', bucket_key:'b1', new_at: LUNCH,
      predicted_prep_min: actual + err, error_min: err, prediction_missing:false, quarantined:false });
  }
  return rows;
}

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

// ── Task 3: computeGraduation orchestration (authoritative vs preview) ──
{
  const cfg = { config_hash:'abc', signed:true, graduation_thresholds: GT, buffer_prep_min: 12 };
  const rows = makeStrongBucketRows();
  const out = computeGraduation(rows, cfg, { rng: mulberry32(7), now: 1_700_000_000_000 });
  assert.strictEqual(out.mode, 'authoritative');
  assert.strictEqual(out.activeConfigHash, 'abc');
  const paths = Object.keys(out.verdicts);
  assert.ok(paths.some(p => out.verdicts[p].graduated === true), 'strong bucket graduates');
  const v = out.verdicts[paths[0]];
  assert.strictEqual(v.config_hash, 'abc'); assert.strictEqual(v.settled, true);
  assert.ok(v.vs_buffer && v.vs_bucketmed && v.predictor && v.coverage, 'verdict node shape (§5)');
  // unsigned config → preview → nothing graduates
  const outP = computeGraduation(rows, { ...cfg, signed:false }, { rng: mulberry32(7), now: 1 });
  assert.strictEqual(outP.mode, 'preview');
  assert.ok(Object.values(outP.verdicts).every(v => v.graduated === false), 'preview graduates nothing');
  ok('computeGraduation authoritative vs preview');
}

// tiny deterministic PRNG for tests
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

console.log(`\n${pass} passed`);
