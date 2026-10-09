'use strict';
// the PREREG-2 statistics (test/_latency-stats.js), against hand-computed values. Run: node test/_latency-stats.test.js
const assert = require('assert');
const S = require('./_latency-stats');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// nearest-rank: 1..100 → p95 = 95; 1..20 → ceil(19) = 19th = 19; 6 values → ceil(5.7) = 6th = the max; order-free
assert.strictEqual(S.p95(range(1, 100)), 95);
assert.strictEqual(S.p95(range(1, 20).reverse()), 19);
assert.strictEqual(S.p95([3, 1, 6, 2, 5, 4]), 6);
assert.strictEqual(S.nearestRank([10, 20, 30, 40], 0.025), 10);
assert.strictEqual(S.nearestRank([10, 20, 30, 40], 0.975), 40);
assert.strictEqual(S.nearestRank([10, 20, 30, 40], 0.5), 20);
ok('nearest-rank quantiles: p95 of 1..100 = 95, of 20 values = the 19th, of 6 values = the max; input order irrelevant');

assert.strictEqual(S.med([5, 1, 3, 2, 4, 6]), 4, 'one child: the upper middle (index n/2 of the sorted samples)');
assert.strictEqual(S.med([3, 1, 2]), 2);
assert.strictEqual(S.medianOf([6, 1, 5, 2, 4, 3]), 3.5, 'over blocks, K even: the mean of the two middle values');
assert.strictEqual(S.medianOf([3, 1, 2]), 2);
ok('medians: a child\'s samples → the upper middle; over blocks → the mean of the two middle values when K is even');

{
  const blocks = [{ x: range(1, 50), y: range(1, 50).map((v) => v + 10) }, { x: range(51, 100), y: range(51, 100).map((v) => v + 10) }];
  const p = S.pooledP95Delta(blocks);
  assert.deepStrictEqual(p, { x_p95: 95, y_p95: 105, delta_ms: 10, delta_rel: 10 / 95 });
  ok('pooled p95: ALL blocks\' samples per side together (1..100 vs +10 → 95 vs 105, Δ 10 ms, 10/95 relative)');
}
{
  const mk = (bx, by) => ({ x: [bx, bx, bx], y: [by, by, by] });
  const blocks = [mk(10, 12), mk(10, 9), mk(10, 15), mk(10, 10), mk(10, 30), mk(10, 11)];   // Δs 2, −1, 5, 0, 20, 1
  assert.deepStrictEqual(S.blockMedianDeltas(blocks), [2, -1, 5, 0, 20, 1]);
  assert.strictEqual(S.pairedMedianDelta(blocks), 1.5, 'sorted −1 0 1 2 5 20 → (1 + 2) / 2');
  const ci = S.bootstrapCI(blocks);
  assert.deepStrictEqual(S.bootstrapCI(blocks), ci, 'seeded: reproducible');
  assert.ok(ci[0] <= 1.5 && 1.5 <= ci[1] && ci[0] >= -1 && ci[1] <= 20, `CI inside the data range and around the estimate (${ci})`);
  assert.ok(ci[1] - ci[0] > 0, 'varied blocks → a CI of non-zero width (the blocks ARE resampled)');
  // GOLDEN (seed 20261008, B 10000; recorded from this implementation, pinned so the reported CI is reproducible from the
  // raw samples): it also pins the 2.5 / 97.5 % quantiles and the seeded generator
  assert.deepStrictEqual(ci, [-0.5, 12.5]);
  assert.deepStrictEqual(S.bootstrapCI([0, 3, 7, 12, 20, 40].map((d) => mk(10, 10 + d))), [1.5, 30]);
  assert.deepStrictEqual(S.bootstrapCI(blocks, { B: 20 }), [0, 20], 'a small B is still deterministic under the seed');
  assert.deepStrictEqual(S.bootstrapCI(blocks, { B: 20, seed: 1 }), [0, 12.5], 'and the seed is what decides it');
  const flat = [mk(10, 13), mk(10, 13), mk(10, 13), mk(10, 13), mk(10, 13), mk(10, 13)];
  assert.deepStrictEqual(S.bootstrapCI(flat), [3, 3], 'identical blocks → a zero-width CI');
  ok('paired median Δ = the median of the per-block (median cand − median base); the 95 % bootstrap CI resamples BLOCKS, seeded');
}
{
  const aa = [
    { x: [100, 100], y: [110, 110] },   // |p95 Δ| 10/100 = 0.10, |median Δ| 10
    { x: [100, 100], y: [95, 95] },     // 0.05, 5
    { x: [200, 200], y: [140, 140] },   // −0.30 → |0.30|, −60 → |60| (the largest A/A deltas are NEGATIVE here)
    { x: [100, 100], y: [100, 100] },   // 0, 0
    { x: [50, 50], y: [40, 40] },       // 0.20, 10
    { x: [100, 100], y: [102, 102] },   // 0.02, 2
  ];
  assert.deepStrictEqual(S.aaNoise(aa), { noise_p95: 0.30, noise_median: 60 }, 'K = 6 → the 95th pct is the block max, on ABSOLUTE deltas');
  ok('A/A noise: noise_p95 = p95 over blocks of |block p95 Δ| / block base p95; noise_median = p95 of |block median Δ| (ms)');
}
{
  const base = { errors: 0, attempts: 300 }; const cand = { errors: 0, attempts: 300 };
  const V = (o) => S.verdict({ pooled: { delta_ms: 10, delta_rel: 0.05 }, paired: 3, noise: { noise_p95: 0.08, noise_median: 2 }, base, cand, valid: true, ...o });
  assert.strictEqual(V({}).pass, true);
  assert.strictEqual(V({ pooled: { delta_ms: 50, delta_rel: 0.10 } }).pass, true, 'the bounds are inclusive');
  assert.strictEqual(V({ pooled: { delta_ms: 50.1, delta_rel: 0.01 } }).pass, false, '> +50 ms fails even inside the relative bar');
  assert.strictEqual(V({ pooled: { delta_ms: 12, delta_rel: 0.101 } }).pass, false, '> 10 % with A/A noise below 10 % fails');
  assert.strictEqual(V({ pooled: { delta_ms: 12, delta_rel: 0.25 }, noise: { noise_p95: 0.25, noise_median: 2 } }).pass, true, 'A/A noise above 10 % widens the relative bar to it');
  assert.strictEqual(V({ pooled: { delta_ms: 12, delta_rel: 0.26 }, noise: { noise_p95: 0.25, noise_median: 2 } }).pass, false);
  assert.strictEqual(V({ paired: 5 }).pass, true); assert.strictEqual(V({ paired: 5.1 }).pass, false, 'median above +5 ms with A/A noise below fails');
  assert.strictEqual(V({ paired: 8, noise: { noise_p95: 0.08, noise_median: 8 } }).pass, true, 'A/A median noise above 5 ms widens it');
  assert.strictEqual(V({ paired: 8.1, noise: { noise_p95: 0.08, noise_median: 8 } }).pass, false);
  assert.strictEqual(V({ cand: { errors: 1, attempts: 300 } }).pass, false, 'errors differ');
  assert.strictEqual(V({ cand: { errors: 0, attempts: 299 } }).pass, false, 'attempts differ');
  assert.strictEqual(V({ valid: false }).pass, false, 'an invalid row never passes');
  assert.deepStrictEqual(Object.keys(V({}).checks), ['p95_abs', 'p95_rel', 'median', 'counts', 'valid']);
  ok('verdict = ALL of: p95 Δ ≤ +50 ms; p95 Δ ≤ max(10 %, A/A noise_p95); paired median Δ ≤ max(5 ms, A/A noise_median); errors + attempts equal; valid — inclusive bounds');
}
console.log(`\nlatency-stats: OK (${n})`);
