'use strict';
// 1D D4-c2b — the per-row verdict of the §8 latency measurement (LATENCY-PROTOCOL v2), shared by test/c2b-latency.measure.js and
// test/c2b-latency.merge.js (which joins a row's blocks from several jobs). Bars FIXED (plan §8): p95 Δ ≤ +10 % AND ≤ +150 ms,
// paired median Δ ≤ 5 ms; A/A noise only grades adequacy (verdictV2).
const ST = require('./_latency-stats');
const BARS = Object.freeze({ relMax: 0.10, absMaxMs: 150, medMaxMs: 5 });
const r1 = (v) => +v.toFixed(1);
const childValid = (c, cond, SAMPLES) => c.digest && c.digest.mismatches === 0 && c.digest.start_ok === true && c.errors === 0 && c.ms.length === SAMPLES && (cond === 'on' ? c.monitor.overlapped === SAMPLES && c.monitor.runs > 0 : c.monitor.runs === 0);

function verdictRow(row, R, SAMPLES) {
  const abBlocks = R.ab.map((b) => ({ x: b.off.ms, y: b.on.ms }));
  const aaBlocks = R.aa.map((b) => ({ x: b.off1.ms, y: b.off2.ms }));
  const pooled = ST.pooledP95Delta(abBlocks); const paired = ST.pairedMedianDelta(abBlocks); const noise = ST.aaNoiseMax(aaBlocks);
  const sum = (xs, f) => xs.reduce((a, c) => a + f(c), 0);
  const att = { off: sum(R.ab, (b) => b.off.attempts), on: sum(R.ab, (b) => b.on.attempts) };
  const err = { off: sum(R.ab, (b) => b.off.errors), on: sum(R.ab, (b) => b.on.errors) };
  const valid = R.ab.every((b) => childValid(b.off, 'off', SAMPLES) && childValid(b.on, 'on', SAMPLES)) && R.aa.every((b) => childValid(b.off1, 'off', SAMPLES) && childValid(b.off2, 'off', SAMPLES));
  const v = ST.verdictV2({ pooled, paired, noise, invariants: { attempts_equal: att.off === att.on, errors_equal: err.off === err.on }, valid, bars: BARS });
  return { row: row.key, overlap: row.overlap, off_p95: r1(pooled.x_p95), on_p95: r1(pooled.y_p95), p95_delta_ms: r1(pooled.delta_ms), p95_delta_pct: r1(pooled.delta_rel * 100),
    paired_median_delta_ms: r1(paired), paired_median_ci95: ST.bootstrapCI(abBlocks).map(r1), block_median_deltas: ST.blockMedianDeltas(abBlocks).map(r1),
    aa_noise_p95_pct: r1(noise.noise_p95 * 100), aa_noise_median_ms: r1(noise.noise_med),
    attempts: att, errors: err, monitor: { runs: sum(R.ab, (b) => b.on.monitor.runs), reads: sum(R.ab, (b) => b.on.monitor.reads), checked: sum(R.ab, (b) => b.on.monitor.checked) },
    ab_first: R.ab.map((b) => b.first), aa_first: R.aa.map((b) => b.first), blocks: R.ab.map((b) => b.k), valid, verdict: v.verdict, cost: v.cost, quality: v.quality, values: v.values };
}

module.exports = { verdictRow, childValid, BARS };
