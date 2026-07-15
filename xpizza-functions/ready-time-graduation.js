'use strict';
// Pure graduation core (Phase 1b-i). No I/O, no clock; RNG injected for determinism.
// Mirrors driver-freshness.js: a pure, unit-tested reconcile/stats core the thin onSchedule monitor wraps.
// Spec: docs/superpowers/specs/2026-07-14-phase1b-predictor-graduation-design.md (REV-4, codex round-4 APPROVED).

function mean(xs){ return xs.reduce((a,b)=>a+b,0)/xs.length; }
function quantile(xs, p){ const s=[...xs].sort((a,b)=>a-b); const r=Math.ceil((p/100)*s.length); return s[Math.max(0,Math.min(s.length-1,r-1))]; }

// Benjamini-Hochberg FDR, returned in the ORIGINAL order.
function bhFdrAdjust(pvals){
  const n = pvals.length;
  const idx = pvals.map((p,i)=>[p,i]).sort((a,b)=>a[0]-b[0]);
  const adj = new Array(n);
  let prev = 1;
  for (let k=n-1;k>=0;k--){ const [p,i]=idx[k]; const v=Math.min(prev, p*n/(k+1)); adj[i]=v; prev=v; }
  return adj;
}

// BCa one-sided bootstrap for H0: mean(deltas) <= threshold. Returns { pValue, lowerCB }.
function bootstrapLowerP(deltas, threshold, { rng, resamples=1000, alpha=0.05 }){
  const n = deltas.length;
  // Fail-closed on degenerate input (codex-on-diff #3): <2 points, any non-finite δ, or zero-variance deltas make
  // the jackknife den=0 → NaN acceleration → undefined lowerCB → a non-finite that poisons the atomic verdict
  // write. A degenerate bucket must NOT graduate and must NOT emit a non-finite. lowerCB -Infinity ⇒ (> MARGIN)
  // is false in the gate; the verdict node sanitizes it to null before writing (RTDB rejects ±Infinity/NaN).
  if (n < 2 || !deltas.every(Number.isFinite) || deltas.every(d => d === deltas[0])) {
    return { pValue: 1, lowerCB: -Infinity };
  }
  const theta = mean(deltas);
  // resample means
  const means = new Array(resamples);
  for (let b=0;b<resamples;b++){ let s=0; for(let i=0;i<n;i++) s+=deltas[(rng()*n)|0]; means[b]=s/n; }
  means.sort((a,b)=>a-b);
  // z0 bias-correction: proportion of resample means < theta
  const below = means.filter(m=>m<theta).length;
  const z0 = invNorm(Math.min(0.999, Math.max(0.001, below/resamples)));
  // acceleration via jackknife
  const jack = new Array(n);
  for (let i=0;i<n;i++){ jack[i] = (theta*n - deltas[i])/(n-1); }
  const jbar = mean(jack);
  let num=0, den=0; for(const j of jack){ const d=jbar-j; num+=d*d*d; den+=d*d; }
  const a = den===0 ? 0 : num/(6*Math.pow(den,1.5));
  // BCa-adjusted percentile for the one-sided lower bound
  const zAlpha = invNorm(alpha);
  const adjP = normCdf(z0 + (z0+zAlpha)/(1-a*(z0+zAlpha)));
  const lowerCB = means[Math.max(0, Math.min(resamples-1, Math.floor(adjP*resamples)))];
  // one-sided p for H0 mean<=threshold ≈ BCa-corrected mass at/below threshold
  const raw = means.filter(m=>m<=threshold).length/resamples;
  const zRaw = invNorm(Math.min(0.999,Math.max(0.001, raw)));
  const pValue = normCdf(2*z0 + zRaw);   // BC one-sided tail (+zRaw — plan-gate #1; strong δ → small p → graduates)
  return { pValue, lowerCB };
}
// standard-normal helpers (Acklam inverse CDF + erf-based CDF) — deterministic, no deps
function invNorm(p){ /* Acklam approximation */ const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];const pl=0.02425;let q,r; if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);} if(p<=1-pl){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);} q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
function normCdf(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function erf(x){ const t=1/(1+0.3275911*Math.abs(x)); const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x); return x>=0?y:-y; }

module.exports = { mean, quantile, bhFdrAdjust, bootstrapLowerP };

// ── Task 2: coverage split (restaurant×daypart) + the fail-closed gate ──

// Stable, NON-model time bucket for coverage (do not reuse the model's fine bucketer).
function daypartKeyOf(newAtMs){
  const h = new Date(newAtMs).getUTCHours();  // coarse; refine to America/Tegucigalpa in the monitor if desired
  if (h < 11) return 'morning'; if (h < 15) return 'lunch'; if (h < 20) return 'afternoon'; return 'night';
}
function coverageByCoarse(logRows){
  const acc = {};
  for (const r of logRows){
    const k = `${r.restaurant_id}|${daypartKeyOf(r.new_at)}`;
    const a = acc[k] || (acc[k] = { total:0, missing:0, missing_share:0 });
    a.total++; if (r.prediction_missing) a.missing++;
  }
  for (const k in acc){ acc[k].missing_share = acc[k].total ? acc[k].missing/acc[k].total : 1; }
  return acc;
}
// PURE fail-closed gate. Every condition must pass; ANY missing input ⇒ false.
function gateBucket(s, coarseCov, cfg){
  const t = (cfg && cfg.graduation_thresholds) || {};
  const reasons = [];
  const need = (cond, why) => { if (!cond) reasons.push(why); };
  need(Number.isFinite(s.n) && s.n >= t.min_samples, 'min_samples');
  need(coarseCov && coarseCov.missing_share <= t.coverage_cap, 'coverage_cap');   // restaurant×daypart
  need(s.quarantined_share <= t.excl_cap, 'excl_cap');
  need(s.pAdjBuf <= t.q_fdr && s.pAdjBkt <= t.q_fdr, 'fdr');                       // BH-adjusted
  need(s.lowerCbBuf > t.margin && s.lowerCbBkt > t.margin_bkt, 'lower_cb_margin');
  need(Math.abs(s.bias) <= t.bias_cap, 'bias_cap');
  need(s.late_rate <= t.late_cap, 'late_cap');
  need(s.p90 <= t.p90_cap, 'p90_cap');
  need(s.within_n >= t.within_floor && s.within_n >= s.buffer_within_n, 'within_floor');
  need(s.sensitivity_ok === true, 'sensitivity');
  return { graduated: reasons.length === 0, reasons };
}
module.exports = { ...module.exports, coverageByCoarse, gateBucket, daypartKeyOf };

// ── Task 3: computeGraduation orchestration ──
// rows = prediction_logs ⟕ order_predictions join rows (buildGraduationRows in the monitor). A matched row
// carries model_version/restaurant_id/source/bucket_key/new_at/predicted_prep_min/error_min (+ quarantined);
// a missing row carries restaurant_id/new_at/prediction_missing:true (coverage only). Spec §4(b)/§5.
// FLAGS for the codex-gate: (a) bucket baseline uses the PLAIN per-bucket median (plan Task 3 `median(actual)`);
// spec §finding-4 calls for a "shrinkage median" — the plan simplified it; refine post-bake if warranted.
// (b) within_n uses cfg.graduation_thresholds.within_n_min (default 5) — add to the seed. (c) sensitivity =
// append `quarantined` excluded rows at the worst OBSERVED δ and re-check the lower CB (bounded worst-case).
function computeGraduation(rows, cfg, { rng, now }){
  const c = cfg || {};
  const gt = c.graduation_thresholds || {};
  const signed = !!c.signed;                     // caller computes it (isGraduationConfigSigned in the monitor)
  const mode = signed ? 'authoritative' : 'preview';
  const configHash = c.config_hash;
  // PREP_BUFFER_MIN — the global flat-buffer baseline. Read top-level (test) OR nested in graduation_thresholds
  // (the Task-6 seed) — the plan places it both ways, so accept either.
  const buffer = Number.isFinite(c.buffer_prep_min) ? c.buffer_prep_min : gt.buffer_prep_min;
  const ttl = Number.isFinite(gt.ttl_ms) ? gt.ttl_ms : 0;
  const windowMs = Number.isFinite(gt.window_ms) ? gt.window_ms : 0;
  const withinN = Number.isFinite(gt.within_n_min) ? gt.within_n_min : 5;
  const resamples = Number.isFinite(gt.bootstrap_resamples) ? gt.bootstrap_resamples : 1000;
  const fin = (x) => (Number.isFinite(x) ? x : null);   // RTDB rejects ±Infinity/NaN → null-out non-finite verdict numbers

  // Coverage over ALL rows (incl. missing) — coarse restaurant×daypart (spec §4(b).1).
  const coverage = coverageByCoarse(rows);

  // Group by the STORED tuple; track matched + quarantined counts at the fine level.
  const groups = new Map();
  const matchedByTuple = new Map();
  const quarByTuple = new Map();
  for (const r of rows){
    if (r.prediction_missing) continue;                         // missing → coverage only, never a fine bucket
    // codex-on-diff #2: a present-but-INCOMPLETE prediction node (any of the stored tuple absent) must NOT group
    // under `undefined/...` — treat it as coverage-only (still counted by coverageByCoarse over ALL rows), never
    // a fine bucket. Requires the full stored (v, restaurant_id, source, bucket_key).
    if (r.model_version == null || r.restaurant_id == null || r.source == null || r.bucket_key == null) continue;
    const tuple = `${r.model_version}/${r.restaurant_id}/${r.source}/${r.bucket_key}`;
    matchedByTuple.set(tuple, (matchedByTuple.get(tuple)||0)+1);
    if (r.quarantined){ quarByTuple.set(tuple,(quarByTuple.get(tuple)||0)+1); continue; }   // excluded
    if (!Number.isFinite(r.error_min) || !Number.isFinite(r.predicted_prep_min)) continue;  // eligible = finite metrics
    let g = groups.get(tuple);
    if (!g){ g = { rows:[], v:r.model_version, restaurant:r.restaurant_id, source:r.source, bucket_key:r.bucket_key,
                   coarseKey:`${r.restaurant_id}|${daypartKeyOf(r.new_at)}` }; groups.set(tuple, g); }
    g.rows.push(r);
  }

  // First pass: per-group deltas, CB, and predictor stats (BH-FDR needs all p-values before gating).
  const stats = [];
  for (const [tuple, g] of groups){
    const el = g.rows, n = el.length;
    if (n < gt.min_samples) continue;                           // fail-closed thin (also subsumed by the CB)
    const actuals = el.map(r => r.predicted_prep_min - r.error_min);   // actual_prep
    const bktMed = quantile(actuals, 50);
    const predErr = el.map(r => Math.abs(r.error_min));
    const dBuf = actuals.map((a,i) => Math.abs(buffer - a) - predErr[i]);
    const dBkt = actuals.map((a,i) => Math.abs(bktMed - a) - predErr[i]);
    const cbBuf = bootstrapLowerP(dBuf, gt.margin, { rng, resamples });
    const cbBkt = bootstrapLowerP(dBkt, gt.margin_bkt, { rng, resamples });
    const bias = mean(el.map(r => r.error_min));
    const mae = mean(predErr);
    const p90 = quantile(predErr, 90);
    const late_rate = el.filter(r => r.error_min < 0).length / n;              // under-prediction (spec §4(b).3)
    const within_n = predErr.filter(e => e <= withinN).length / n;
    const buffer_within_n = actuals.filter(a => Math.abs(buffer - a) <= withinN).length / n;   // buffer on same orders
    const matched = matchedByTuple.get(tuple) || n;
    const quarantined = quarByTuple.get(tuple) || 0;
    const quarantined_share = matched ? quarantined / matched : 0;
    // Sensitivity (spec §4(b).4): impute the `quarantined` excluded orders worst-case (at the worst OBSERVED δ),
    // re-check the lower CB still clears the margin. Bounded, deterministic (flag (c)).
    let sensitivity_ok;
    if (quarantined > 0){
      const wBuf = Math.min(...dBuf), wBkt = Math.min(...dBkt);
      const sBuf = bootstrapLowerP(dBuf.concat(Array(quarantined).fill(wBuf)), gt.margin, { rng, resamples });
      const sBkt = bootstrapLowerP(dBkt.concat(Array(quarantined).fill(wBkt)), gt.margin_bkt, { rng, resamples });
      sensitivity_ok = sBuf.lowerCB > gt.margin && sBkt.lowerCB > gt.margin_bkt;
    } else sensitivity_ok = cbBuf.lowerCB > gt.margin && cbBkt.lowerCB > gt.margin_bkt;
    stats.push({ g, tuple, n, matched, quarantined, quarantined_share, cbBuf, cbBkt,
      meanDBuf: mean(dBuf), meanDBkt: mean(dBkt), bias, mae, p90, late_rate, within_n, buffer_within_n, sensitivity_ok });
  }

  // BH-FDR across all buckets tested this run (separately for buffer + bucket-median tracks).
  const pAdjBuf = bhFdrAdjust(stats.map(s => s.cbBuf.pValue));
  const pAdjBkt = bhFdrAdjust(stats.map(s => s.cbBkt.pValue));

  const verdicts = {};
  stats.forEach((s, i) => {
    const coarse = coverage[s.g.coarseKey] || { missing_share: 1, missing: 0, total: 0 };
    const gate = gateBucket({
      n: s.n, quarantined_share: s.quarantined_share,
      pAdjBuf: pAdjBuf[i], pAdjBkt: pAdjBkt[i],
      lowerCbBuf: s.cbBuf.lowerCB, lowerCbBkt: s.cbBkt.lowerCB,
      bias: s.bias, late_rate: s.late_rate, p90: s.p90,
      within_n: s.within_n, buffer_within_n: s.buffer_within_n, sensitivity_ok: s.sensitivity_ok,
    }, coarse, c);
    const graduated = signed && gate.graduated;   // unsigned ⇒ preview ⇒ never graduates
    const path = `ready_time_graduation/${s.g.v}/${s.g.restaurant}/${s.g.source}/${s.g.bucket_key}`;
    verdicts[path] = {
      graduated, n: s.n,
      coverage: { matched: s.matched, missing: coarse.missing || 0, quarantined: s.quarantined,
        fine_shares: { quarantined_share: s.quarantined_share }, coarse_missing_share: coarse.missing_share },
      predictor: { mae: s.mae, p90: s.p90, bias: s.bias, late_rate: s.late_rate, within_n: s.within_n },
      vs_buffer: { mean_delta: fin(s.meanDBuf), lower_cb: fin(s.cbBuf.lowerCB), q_adj: fin(pAdjBuf[i]) },
      vs_bucketmed: { mean_delta: fin(s.meanDBkt), lower_cb: fin(s.cbBkt.lowerCB), q_adj: fin(pAdjBkt[i]) },
      window: { from: now - windowMs, to: now },
      computed_at: now, expires_at: now + ttl,
      config_hash: configHash, mode, settled: true,
      reasons: gate.reasons,   // preview reporting: WHY a bucket didn't graduate
    };
  });
  return { verdicts, activeConfigHash: configHash, mode };
}
// buildGraduationRows — flatten prediction_logs[orderId][v] (JOIN BASE, superset) ⟕ order_predictions[orderId][v].
// codex-on-diff #1: the deep-path range query returns the WHOLE {orderId} node, so iterate ONLY the ACTIVE
// versions and re-verify each log.new_at is finite AND within [from,to] before pushing — never trust the sibling
// / out-of-window versions the full-node return carries. Attach the prediction node's source/bucket_key/
// predicted_prep_min when present; keyed strictly by the STORED tuple — never inferred.
function buildGraduationRows(logsVal, preds, { from, to, activeVersions }){
  const rows = [];
  for (const orderId in logsVal){
    const perV = logsVal[orderId] || {};
    for (const v of activeVersions){
      const log = perV[v]; if (!log || typeof log !== 'object') continue;
      if (!Number.isFinite(log.new_at) || log.new_at < from || log.new_at > to) continue;   // window belt-and-suspenders
      const pred = (preds[orderId] || {})[v];
      rows.push({
        model_version: v,
        restaurant_id: log.restaurant_id,
        new_at: log.new_at,
        error_min: log.error_min,
        prediction_missing: log.prediction_missing === true || !pred,
        quarantined: log.quarantined === true,
        source: pred && pred.source,
        bucket_key: pred && pred.bucket_key,
        predicted_prep_min: pred ? pred.predicted_prep_min : log.predicted_prep_min,
      });
    }
  }
  return rows;
}
module.exports = { ...module.exports, computeGraduation, buildGraduationRows };
