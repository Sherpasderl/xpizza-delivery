'use strict';
// D4-c4 §6 re-measure (evidence latency/PREREG-2.md) — the pure statistics, per row. Every quantile is NEAREST-RANK
// (the smallest value with at least q·n values ≤ it), so with K = 6 blocks the A/A "95th percentile" is the block maximum.
//
//   blocks:   [{ x: <ms[] of side X>, y: <ms[] of side Y> }, …]   (A/B: x = base, y = cand; A/A: x = base#1, y = base#2)
//   pooledP95Delta  → p95(all y) − p95(all x), absolute and relative to p95(all x)
//   blockMedianDeltas → per block, median(y) − median(x);  pairedMedianDelta → the median of those (K even: the mean of
//                       the two middle values)
//   bootstrapCI     → 95 % percentile CI of pairedMedianDelta, resampling the BLOCKS with replacement, seeded
//   aaNoise         → from the A/A blocks: noise_p95 = p95 over blocks of |p95(y) − p95(x)| / p95(x);
//                                           noise_median = p95 over blocks of |median(y) − median(x)| (ms)
//   verdict         → PREREG-2 PASS rule (all must hold)

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const nearestRank = (xs, q) => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };
const p95 = (xs) => nearestRank(xs, 0.95);
// the sample median of ONE child's samples: the upper middle (as the first measurement, PREREG.md)
const med = (xs) => sorted(xs)[Math.floor(xs.length / 2)];
// the median over blocks (K even → the mean of the two middle values)
const medianOf = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function pooledP95Delta(blocks) {
  const x = p95(blocks.flatMap((b) => b.x)); const y = p95(blocks.flatMap((b) => b.y));
  return { x_p95: x, y_p95: y, delta_ms: y - x, delta_rel: (y - x) / x };
}
const blockMedianDeltas = (blocks) => blocks.map((b) => med(b.y) - med(b.x));
const pairedMedianDelta = (blocks) => medianOf(blockMedianDeltas(blocks));

// mulberry32 — a fixed seed makes the CI reproducible from the recorded samples
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bootstrapCI(blocks, { B = 10000, seed = 20261008 } = {}) {
  const d = blockMedianDeltas(blocks); const r = rng(seed); const stats = [];
  for (let i = 0; i < B; i++) stats.push(medianOf(d.map(() => d[Math.floor(r() * d.length)])));
  return [nearestRank(stats, 0.025), nearestRank(stats, 0.975)];
}

function aaNoise(aaBlocks) {
  return {
    noise_p95: p95(aaBlocks.map((b) => Math.abs(p95(b.y) - p95(b.x)) / p95(b.x))),
    noise_median: p95(aaBlocks.map((b) => Math.abs(med(b.y) - med(b.x)))),
  };
}

// PASS iff ALL: pooled p95 Δ ≤ +50 ms; pooled p95 Δ (relative) ≤ max(+10 %, noise_p95); paired median Δ ≤ max(+5 ms,
// noise_median); errors and attempts equal on both sides (and the row valid: every child complete, 0 errors, reuse kept)
function verdict({ pooled, paired, noise, base, cand, valid }) {
  const checks = {
    p95_abs: pooled.delta_ms <= 50,
    p95_rel: pooled.delta_rel <= Math.max(0.10, noise.noise_p95),
    median: paired <= Math.max(5, noise.noise_median),
    counts: base.errors === cand.errors && base.attempts === cand.attempts,
    valid: valid === true,
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

module.exports = { nearestRank, p95, med, medianOf, pooledP95Delta, blockMedianDeltas, pairedMedianDelta, bootstrapCI, aaNoise, verdict };
