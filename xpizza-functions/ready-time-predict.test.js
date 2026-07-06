'use strict';

// Golden tests for the pure Ready-Time Phase-1 Step-3 predictor helpers (ready-time-predict.js).
// Run: node ready-time-predict.test.js
// The hierarchical fallback + the retry-idempotent bounded-ring median are the model's core; a wrong
// p50/trim or a non-idempotent ring silently poisons the shadow predictions. See PHASE1_STEP3_*.md.
const assert = require('assert');
const {
  median, ringSetP50, predictFromModel, coldStartMin,
  ACTIVE_MODEL_VERSIONS, RING_N, MIN_SAMPLES,
} = require('./ready-time-predict');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── median ──
assert.strictEqual(median([]), null); ok('median: empty → null');
assert.strictEqual(median([5]), 5); ok('median: single');
assert.strictEqual(median([3, 1, 2]), 2); ok('median: odd → middle (unsorted input)');
assert.strictEqual(median([1, 2, 3, 4]), 2.5); ok('median: even → avg of two middles');

// ── ringSetP50 — retry-idempotent, orderId-keyed, trim to RING_N by at ──
{
  const r1 = ringSetP50(null, 'A', { prep_min: 10, at: 100 }, { ringN: RING_N, now: 100 });
  assert.deepStrictEqual({ p50: r1.p50, c: r1.sample_count, keys: Object.keys(r1.samplesByOrder) }, { p50: 10, c: 1, keys: ['A'] }); ok('ring: fresh (null) + 1 sample → p50=10, count 1');
  const r2 = ringSetP50(r1, 'B', { prep_min: 20, at: 200 }, { ringN: RING_N, now: 200 });
  assert.strictEqual(r2.p50, 15); assert.strictEqual(r2.sample_count, 2); ok('ring: 2nd order → p50 median(10,20)=15');
  // retry: same orderId + same sample → IDENTICAL ring (idempotent under RTDB retry)
  const r2b = ringSetP50(r2, 'B', { prep_min: 20, at: 200 }, { ringN: RING_N, now: 999 });
  assert.deepStrictEqual(r2b.samplesByOrder, r2.samplesByOrder); assert.strictEqual(r2b.p50, r2.p50); ok('ring: re-set same orderId → no dup, p50 unchanged (retry-idempotent)');
  // same orderId, NEW sample → overwrites (one sample per orderId per ring)
  const r2c = ringSetP50(r2, 'B', { prep_min: 40, at: 200 }, { ringN: RING_N, now: 200 });
  assert.strictEqual(r2c.sample_count, 2); assert.strictEqual(r2c.samplesByOrder.B.prep_min, 40); ok('ring: same orderId new sample → overwrites, still one B');
}
// trim: 32 samples (at=prep=1..32) → keep newest 30 (at 3..32) → p50 = median(3..32)=17.5
{
  let ring = null;
  for (let i = 1; i <= 32; i++) ring = ringSetP50(ring, 'o' + i, { prep_min: i, at: i }, { ringN: RING_N, now: i });
  assert.strictEqual(ring.sample_count, RING_N); assert.strictEqual(Object.keys(ring.samplesByOrder).length, 30); ok('ring: 32 in → trimmed to RING_N=30 (newest by at)');
  assert.ok(!ring.samplesByOrder.o1 && !ring.samplesByOrder.o2 && ring.samplesByOrder.o32); ok('ring: oldest (o1,o2) evicted, newest (o32) kept');
  assert.strictEqual(ring.p50, 17.5); ok('ring: p50 = median(prep 3..32) = 17.5');
}

// ── predictFromModel — hierarchical fallback exact → daypart → restaurant → cold_start ──
const ringOf = (p50, c) => ({ p50, sample_count: c });
const model = {
  exact: { 'EX_OK': ringOf(12, MIN_SAMPLES), 'EX_THIN': ringOf(99, MIN_SAMPLES - 1) },
  daypart: { 'DP_OK': ringOf(16, MIN_SAMPLES), 'DP_THIN': ringOf(88, 1) },
  restaurant: ringOf(22, MIN_SAMPLES),
};
const OPTS = { restaurant: 'x_pizza', minSamples: MIN_SAMPLES, coldStartMin: coldStartMin('x_pizza') };
{
  let p = predictFromModel(model, { ...OPTS, exactKey: 'EX_OK', daypartKey: 'DP_OK' });
  assert.deepStrictEqual({ m: p.prep_min, s: p.source }, { m: 12, s: 'exact' }); ok('predict: exact ≥ MIN_SAMPLES → exact (12)');
  p = predictFromModel(model, { ...OPTS, exactKey: 'EX_THIN', daypartKey: 'DP_OK' });
  assert.deepStrictEqual({ m: p.prep_min, s: p.source }, { m: 16, s: 'daypart' }); ok('predict: exact thin → daypart (16)');
  p = predictFromModel(model, { ...OPTS, exactKey: 'MISS', daypartKey: 'DP_THIN' });
  assert.deepStrictEqual({ m: p.prep_min, s: p.source }, { m: 22, s: 'restaurant' }); ok('predict: exact miss + daypart thin → restaurant median (22)');
  p = predictFromModel({}, { ...OPTS, exactKey: 'MISS', daypartKey: 'MISS' });
  assert.deepStrictEqual({ s: p.source, c: p.sample_count }, { s: 'cold_start', c: 0 }); assert.ok(p.prep_min > 0); ok('predict: empty model → cold_start constant');
}
// la_musa → constant (cold_start), NEVER a ring (log-only + constant, R1-#9)
{
  const p = predictFromModel(model, { restaurant: 'la_musa', exactKey: 'EX_OK', daypartKey: 'DP_OK', minSamples: MIN_SAMPLES, coldStartMin: coldStartMin('la_musa') });
  assert.strictEqual(p.source, 'cold_start'); assert.strictEqual(p.prep_min, coldStartMin('la_musa')); ok('predict: la_musa → cold_start constant, ignores rings');
}

// ── ACTIVE_MODEL_VERSIONS — single shared source of truth (R2-#4) ──
assert.ok(Array.isArray(ACTIVE_MODEL_VERSIONS) && ACTIVE_MODEL_VERSIONS.includes('v1-hier-ringmed-30')); ok('ACTIVE_MODEL_VERSIONS = [v1-hier-ringmed-30]');

console.log(`\n${n} passed`);
