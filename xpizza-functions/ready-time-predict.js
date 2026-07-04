'use strict';

/**
 * Ready-Time Phase 1 · Step 3 — pure predictor helpers (hierarchical bounded-ring median).
 *
 * PURE: no db, no I/O (extract-then-golden, like ready-time-eligibility.js). Consumed by the deps-injected
 * core (ready-time-predict-core.js). See PHASE1_STEP3_SHADOW_PREDICTOR.md (rev-3).
 *
 * The v1 model: per-bucket last-RING_N eligible prep-times → p50 (median; outlier-robust on right-skewed
 * prep). Hierarchical fallback exact → daypart → restaurant → cold_start so a small fleet still gets a
 * useful non-cold-start prediction. Rings keyed by orderId → retry-idempotent (no blind append).
 */

const RING_N = 30;
const MIN_SAMPLES = 5;
// v1 = a single-element list; both triggers import THIS (R2-#4). Adding v2 = append here.
const ACTIVE_MODEL_VERSIONS = ['v1-hier-ringmed-30'];
// cold-start constant prep (minutes) per restaurant; config-tunable, these are the fail-safe defaults.
const DEFAULT_COLD_START_MIN = { x_pizza: 18, la_musa: 20 };
const coldStartMin = (restaurant, cfg) => {
  const c = cfg && cfg.coldStart && cfg.coldStart[restaurant];
  return (typeof c === 'number' && Number.isFinite(c) && c > 0) ? c : (DEFAULT_COLD_START_MIN[restaurant] || DEFAULT_COLD_START_MIN.x_pizza);
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// median of a numeric array (p50). Empty → null. Sorts a copy (input order-agnostic).
function median(arr) {
  const s = (arr || []).filter(isNum).slice().sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ringSetP50 — the transaction-callback core (pure). SETS samplesByOrder[orderId] (idempotent under RTDB
// retry — no blind append), keeps the newest `ringN` by `at`, recomputes p50. `ring` may be null (fresh).
function ringSetP50(ring, orderId, sample, opts) {
  const ringN = (opts && isNum(opts.ringN)) ? opts.ringN : RING_N;
  const now = opts && isNum(opts.now) ? opts.now : sample.at;
  const merged = { ...((ring && ring.samplesByOrder) || {}) };
  merged[orderId] = { prep_min: sample.prep_min, at: sample.at };
  // keep newest ringN by (at desc, orderId desc) — deterministic total order for stable trimming
  const kept = Object.entries(merged)
    .sort(([ia, a], [ib, b]) => (b.at - a.at) || (ia < ib ? 1 : ia > ib ? -1 : 0))
    .slice(0, ringN);
  const samplesByOrder = {};
  for (const [id, s] of kept) samplesByOrder[id] = s;
  const preps = kept.map(([, s]) => s.prep_min);
  return { samplesByOrder, p50: median(preps), sample_count: kept.length, updated_at: now };
}

// predictFromModel — hierarchical fallback. x_pizza walks exact → daypart → restaurant → cold_start,
// backing off until a level has ≥ minSamples. la_musa (or any non-x_pizza) → cold_start constant (v1
// log-only + constant, no rings). Returns { prep_min, source, sample_count, bucket_key }.
function predictFromModel(modelNode, opts) {
  const { restaurant, exactKey, daypartKey, minSamples, coldStartMin: cold } = opts;
  const coldStart = () => ({ prep_min: cold, source: 'cold_start', sample_count: 0, bucket_key: 'cold_start' });
  if (restaurant !== 'x_pizza') return coldStart();

  const usable = (ring) => ring && isNum(ring.p50) && ring.sample_count >= minSamples;
  const m = modelNode || {};
  const ex = m.exact && m.exact[exactKey];
  if (usable(ex)) return { prep_min: ex.p50, source: 'exact', sample_count: ex.sample_count, bucket_key: exactKey };
  const dp = m.daypart && m.daypart[daypartKey];
  if (usable(dp)) return { prep_min: dp.p50, source: 'daypart', sample_count: dp.sample_count, bucket_key: daypartKey };
  if (usable(m.restaurant)) return { prep_min: m.restaurant.p50, source: 'restaurant', sample_count: m.restaurant.sample_count, bucket_key: 'restaurant' };
  return coldStart();
}

module.exports = {
  median, ringSetP50, predictFromModel, coldStartMin,
  ACTIVE_MODEL_VERSIONS, RING_N, MIN_SAMPLES, DEFAULT_COLD_START_MIN,
};
