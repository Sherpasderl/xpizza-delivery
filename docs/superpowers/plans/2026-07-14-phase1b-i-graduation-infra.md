# Phase 1b-i — Graduation Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. **Owner: the functions session** (builds from a synced checkout, e.g. `~/xpizza-lamusa`). **No UI in 1b-i.**

**Goal:** Produce the ready-time predictor **graduation verdicts** — a scheduled function + pure stats core that measures, per bucket, whether the prediction beats the fallback (fail-closed, confidence-based) and publishes `ready_time_graduation/…` verdicts + `_meta/active_config_hash`, plus the two dispatcher read-grants. Consumed later by 1b-ii.

**Architecture:** A pure, injected-RNG core `ready-time-graduation.js` (`computeGraduation` — restaurant×daypart coverage split, BCa one-sided CB, BH-FDR, bias/tail guards, worst-case sensitivity; unit-tested; mirrors `driver-freshness.js`) + a thin `readyTimeGraduationMonitor` (`onSchedule`, mirrors `driverFreshnessMonitor`) that reads `prediction_logs ⟕ order_predictions` + `ready_time_config` and writes **only** `ready_time_graduation`. Rules: reconcile the gitignored deploy file to tracked==live `xpizza-reference/`, then add two `.read` grants. During the ~2-week bake, thresholds are unsigned ⇒ verdicts `mode:'preview'` ⇒ nothing graduates.

**Tech Stack:** CommonJS Cloud Functions (`xpizza-functions/`), `firebase-functions/v2/scheduler`, Node built-in `node file.test.js` + `assert` (matches `driver-freshness.test.js`). **Spec:** `docs/superpowers/specs/2026-07-14-phase1b-predictor-graduation-design.md` (REV-4, codex round-4 APPROVED).

**Plan-gate corrections folded (advisor 2026-07-14):** (1) `bootstrapLowerP` p-value sign → `normCdf(2*z0 + zRaw)` (Task 1); (2) `isGraduationConfigSigned` = real `version && approved_at`, preview seed omits them, `hashConfig` must cover `graduation_thresholds` (Task 4/6); (3) range-bound the `order_predictions` read to the windowed orderIds — never the whole tree (Task 4).

**Standing invariants (from the spec — do not violate):**
- Monitor **reads shadow + config, writes ONLY `ready_time_graduation`** — never `/orders`, never the predictor's write paths (shadow boundary).
- Join base = **`prediction_logs`** (superset) ⟕ `order_predictions`; key fine buckets by the **stored** `(v,source,bucket_key,restaurant)` off the prediction node — never inferred.
- Fail-closed everywhere: any missing input / preview config / thin bucket ⇒ not graduated.
- Rules deploy = **reconcile-to-`xpizza-reference` first** (§1 of the spec); the deploy file is gitignored/per-checkout.

---

## File Structure

- **Create** `xpizza-functions/ready-time-graduation.js` — pure core. Exports `computeGraduation`, `gateBucket`, `bhFdrAdjust`, `bootstrapLowerP`, `coverageByCoarse`, `mean`, `quantile`, `daypartKeyOf`. No I/O, no clock, RNG injected.
- **Create** `xpizza-functions/ready-time-graduation.test.js` — node tests (`node ready-time-graduation.test.js`), added to the `test` script.
- **Modify** `xpizza-functions/index.js` — `require('./ready-time-graduation')` + `require('./ready-time-quality-run')`'s `hashConfig` (or re-export it); register `exports.readyTimeGraduationMonitor = onSchedule(...)`.
- **Reconcile + modify** `xpizza-functions/database.rules.json` — `cp` from `xpizza-reference/database.rules.json` first, then add two grants.
- **Config (data, not code)** `ready_time_config/graduation_thresholds` — seeded UNSIGNED during the bake; signed after.

### Core contracts (used across tasks)

```js
// mean(nums) -> number ; quantile(nums, p) -> number (nearest-rank, matches ready-time-quality)
// daypartKeyOf(newAtMs) -> string   (stable, non-model time bucket — do NOT reuse the model's fine bucketer)
// coverageByCoarse(logRows) -> { [restaurant|daypart]: { total, missing, missing_share } }
//   logRows = every prediction_logs row in-window (missing rows included); coarse key from log's own restaurant_id + daypartKeyOf(new_at)
// bhFdrAdjust(pvalues:number[]) -> number[]   (Benjamini-Hochberg, order-preserving)
// bootstrapLowerP(deltas:number[], threshold:number, {rng, resamples}) -> { pValue, lowerCB }
//   BCa one-sided: H0 mean(delta) <= threshold; pValue = P(resample mean <= threshold) with z0 (bias) + a (jackknife accel) correction
// gateBucket(bucketStats, coarseCov, cfg) -> { graduated:boolean, reasons:string[] }   (PURE fail-closed gate)
// computeGraduation(rows, cfg, {rng, now}) -> { verdicts:{path->node}, activeConfigHash, mode }  (orchestration)
```

---

### Task 1: Pure stat helpers (`mean`, `quantile`, `bhFdrAdjust`, `bootstrapLowerP`)

**Files:** Create `ready-time-graduation.js`, `ready-time-graduation.test.js`

- [ ] **Step 1: Failing test** (deterministic helpers + seeded bootstrap)

```js
// ready-time-graduation.test.js
'use strict';
const assert = require('assert');
const { mean, quantile, bhFdrAdjust, bootstrapLowerP } = require('./ready-time-graduation');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

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

// tiny deterministic PRNG for tests
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module`). Run: `node ready-time-graduation.test.js`
- [ ] **Step 3: Implement the helpers** in `ready-time-graduation.js`:

```js
'use strict';
// Pure graduation core (Phase 1b-i). No I/O, no clock; RNG injected for determinism.
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
```

- [ ] **Step 4: Run → PASS** (`5 passed`). Run: `node ready-time-graduation.test.js`
- [ ] **Step 5: Commit** — `git add xpizza-functions/ready-time-graduation.js xpizza-functions/ready-time-graduation.test.js && git commit -m "feat(functions): graduation stats core — BH-FDR + BCa bootstrap (1b-i)"`

---

### Task 2: Coverage split + the fail-closed gate

**Files:** Modify `ready-time-graduation.js`, `ready-time-graduation.test.js`

- [ ] **Step 1: Add tests** (coverage at restaurant×daypart; gate is fail-closed)

```js
const { coverageByCoarse, gateBucket, daypartKeyOf } = require('./ready-time-graduation');
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
```
(Define `LUNCH = Date.UTC(2026,6,14,18,0)` and import at top of the test file.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (append to `ready-time-graduation.js`):

```js
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
```

- [ ] **Step 4: Run → PASS.** **Step 5: Commit** — "feat(functions): graduation coverage split + fail-closed gate (1b-i)"

---

### Task 3: `computeGraduation` orchestration

**Files:** Modify `ready-time-graduation.js`, `ready-time-graduation.test.js`

- [ ] **Step 1: Add test** — fixture rows (join of predictions + logs) → verdicts. Assert: a strong fine bucket in a well-covered restaurant graduates `authoritative` under a signed config; `mode:'preview'` (unsigned) graduates NOTHING; a low-coverage restaurant blocks its buckets; the `_meta` node carries `active_config_hash`.

```js
const { computeGraduation } = require('./ready-time-graduation');
{
  const cfg = { config_hash:'abc', signed:true, graduation_thresholds: {/* as Task 2 */} , buffer_prep_min: 12 };
  const rows = makeStrongBucketRows(); // 50 matched rows, predictor ≈ +5 better than buffer & bucket-median, 0 missing
  const out = computeGraduation(rows, cfg, { rng: mulberry32(7), now: 1_700_000_000_000 });
  assert.strictEqual(out.mode, 'authoritative');
  assert.strictEqual(out.activeConfigHash, 'abc');
  const paths = Object.keys(out.verdicts);
  assert.ok(paths.some(p => out.verdicts[p].graduated === true), 'strong bucket graduates');
  // unsigned config → preview → nothing graduates
  const outP = computeGraduation(rows, { ...cfg, signed:false }, { rng: mulberry32(7), now: 1 });
  assert.strictEqual(outP.mode, 'preview');
  assert.ok(Object.values(outP.verdicts).every(v => v.graduated === false), 'preview graduates nothing');
  ok('computeGraduation authoritative vs preview');
}
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement** `computeGraduation(rows, cfg, {rng, now})`:
  - `coverage = coverageByCoarse(rows)` (ALL rows incl. missing).
  - Group MATCHED, non-quarantined rows by the stored tuple `${v}/${restaurant}/${source}/${bucket_key}`.
  - Per group with `n≥min_samples`: `actual = predicted_prep_min − error_min`; `δ_buf = |buffer−actual| − |error_min|`; `δ_bkt = |median(actual)−actual| − |error_min|`; `pBuf/pBkt = bootstrapLowerP(...).pValue`, `lowerCb* = .lowerCB`; stats `bias=mean(error_min)`, `late_rate=share(error_min<0 beyond tol)`, `p90=quantile(|error_min|,90)`, `within_n`, `buffer_within_n`, `quarantined_share` (matched), `sensitivity_ok` (worst-case impute of excluded).
  - `bhFdrAdjust` the pBuf list and pBkt list across all groups → `pAdjBuf/pAdjBkt`.
  - `graduated = signed && gateBucket(stats, coverage[coarseKey], cfg).graduated` (unsigned ⇒ preview ⇒ false).
  - Emit `verdicts['ready_time_graduation/'+tuple] = { graduated, n, coverage:{…}, predictor:{…}, vs_buffer:{…}, vs_bucketmed:{…}, window, computed_at:now, expires_at:now+ttl, config_hash:cfg.config_hash, mode, settled:true }`.
  - `activeConfigHash = cfg.config_hash`; `mode = cfg.signed ? 'authoritative' : 'preview'`.
- [ ] **Step 4: Run → PASS. Step 5: Commit** — "feat(functions): computeGraduation orchestration (1b-i)"

---

### Task 4: `readyTimeGraduationMonitor` (onSchedule) — thin adapter

**Files:** Modify `xpizza-functions/index.js`

- [ ] **Step 1:** add requires near the other ready-time requires:
```js
const { computeGraduation } = require('./ready-time-graduation');   // Phase 1b-i graduation core (writes only ready_time_graduation)
const { hashConfig } = require('./ready-time-quality-run');          // reuse the signed-config hash (add to its module.exports if not already)
const { ACTIVE_MODEL_VERSIONS } = require('./ready-time-predict');   // or wherever P.ACTIVE_MODEL_VERSIONS is exported
```
- [ ] **Step 2:** register the scheduled function (mirror `driverFreshnessMonitor` fail-safe shape):
```js
// Phase 1b-i — hourly graduation sweep. READS prediction_logs ⟕ order_predictions + ready_time_config;
// WRITES ONLY ready_time_graduation/{v}/{restaurant}/{source}/{bucket_key} + _meta/active_config_hash.
// PURE-SHADOW-ADJACENT: never touches /orders or the predictor's write paths.
exports.readyTimeGraduationMonitor = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const db = getDatabase();
    const now = Date.now();
    let cfg;
    try { cfg = (await db.ref('ready_time_config').once('value')).val() || {}; }
    catch (e) { console.error('readyTimeGraduationMonitor: config read failed, skipping', e.message); return; }
    const gt = cfg.graduation_thresholds;
    if (!gt || !Number.isFinite(gt.window_ms)) { console.warn('graduation: no thresholds config, skipping'); return; }
    const settleLag = Number.isFinite(cfg.settle_lag_ms) ? cfg.settle_lag_ms : 0;
    const from = now - gt.window_ms, to = now - settleLag;

    // Read the window: prediction_logs is the join BASE (superset). order_predictions supplies bucket/source/predicted_prep.
    // ★ BOUND (plan-gate #3): NEVER read the whole order_predictions tree — fetch ONLY the windowed orderIds.
    let logsVal, preds = {};
    try {
      const logs = await db.ref('prediction_logs').orderByChild('new_at').startAt(from).endAt(to).once('value');  // windowed base (requires .indexOn new_at)
      logsVal = logs.val() || {};
      const orderIds = Object.keys(logsVal);
      const snaps = await Promise.all(orderIds.map((id) => db.ref(`order_predictions/${id}`).once('value')));
      orderIds.forEach((id, i) => { const v = snaps[i].val(); if (v) preds[id] = v; });
    } catch (e) { console.error('graduation: read failed, skipping', e.message); return; }

    const rows = buildGraduationRows(logsVal, preds, cfg);   // flatten {orderId}/{v} pairs into join rows
    // (If the windowed orderId count ever grows large, switch to order_predictions .indexOn new_at + a range query;
    //  the per-orderId fanout is bounded by the windowed prediction_logs count — fine for the bake / low volume.)
    // Deterministic RNG seed from the window so reruns are reproducible without Math.random.
    const rng = mulberry32((from ^ to) >>> 0);
    const out = computeGraduation(rows, { ...cfg, config_hash: hashConfig(cfg), signed: isGraduationConfigSigned(cfg) }, { rng, now });

    const updates = {};
    for (const path in out.verdicts) updates[path] = out.verdicts[path];
    updates['ready_time_graduation/_meta/active_config_hash'] = out.activeConfigHash;   // fix 7' pointer
    try { await db.ref().update(updates); console.log(`graduation: ${Object.keys(out.verdicts).length} verdicts (${out.mode})`); }
    catch (e) { console.error('graduation: write failed', e.message); }
  }
);
```
Add `buildGraduationRows`, `isGraduationConfigSigned`, and a local `mulberry32` (or import) as small helpers near the function. `buildGraduationRows` walks `prediction_logs[orderId][v]` (base), attaches the matching `order_predictions[orderId][v]` (`bucket_key`,`source`,`predicted_prep_min`,`restaurant_id`) when present, sets `prediction_missing` from the log flag.

**★ Provenance (plan-gate #2):** `isGraduationConfigSigned` must require a **real version + approval stamp** (mirrors `ready-time-quality.js:156`), NOT a flippable boolean (a bare `signed:false`/`true` is spoofable by any admin write):
```js
function isGraduationConfigSigned(cfg){
  const g = cfg && cfg.graduation_thresholds;
  return !!(g && g.version && g.approved_at != null);
}
```
The preview seed simply **omits `version`/`approved_at`** (that IS "unsigned"). **Confirm `hashConfig(cfg)` hashes `graduation_thresholds`** so a re-sign flips `config_hash` → old verdicts fail the `_meta/active_config_hash` fence (the whole point of fix 7'); extend `hashConfig` if it doesn't already cover it. Unit-test `isGraduationConfigSigned` (version+approved_at present → true; either missing → false).

- [ ] **Step 3: Update the index.js header comment list** (the `driverFreshnessMonitor (sched)` block) to add `readyTimeGraduationMonitor (sched)`.
- [ ] **Step 4: `node --check index.js`** → parses. **Commit** — "feat(functions): readyTimeGraduationMonitor scheduled sweep (1b-i)"

---

### Task 5: Rules — reconcile to live, add two grants

**Files:** `xpizza-functions/database.rules.json` (gitignored — reconcile first)

- [ ] **Step 1: Reconcile the gitignored deploy file to the tracked==live source of truth**
```bash
cp xpizza-reference/database.rules.json xpizza-functions/database.rules.json
```
- [ ] **Step 2: Add exactly two `.read` grants** (dispatcher predicate, mirroring `dispatcher_alerts`), leaving every other path byte-unchanged. In `order_predictions` set `".read": "auth != null && root.child('dispatchers').child(auth.uid).exists()"`; add a sibling `"ready_time_graduation": { ".read": "auth != null && root.child('dispatchers').child(auth.uid).exists()" }`. **Do NOT** grant `prediction_logs`/`ready_time_model`/`ready_time_quality`. `order_timelines` already `auth!=null` — leave it.
- [ ] **Step 3: Add `.indexOn` for the monitor's query** — `prediction_logs` needs `".indexOn": ["new_at"]` (the `orderByChild('new_at')` range read). Add it under `prediction_logs`.
- [ ] **Step 4: Verify no strip** — diff the edited file vs the tracked source; only the 2 grants + the index should differ:
```bash
diff <(git show :xpizza-reference/database.rules.json) xpizza-functions/database.rules.json
```
Expected: only the `order_predictions .read`, the new `ready_time_graduation` block, and the `prediction_logs .indexOn`. **At deploy time, re-fetch LIVE and diff to confirm 0 stripped** (§1 discipline).
- [ ] **Step 5: `npm run check:rules`** passes. **Commit** — note: the file is gitignored so the commit records nothing; the reconciliation + grants must be re-applied in the deploy checkout. Capture the exact 2-grant diff in the commit message / a tracked `docs/` snippet so the deploy checkout reproduces it. (Or: track the file — the §1 standing-fragility fix — if Xavier closes it first.)

---

### Task 6: Config seed (preview) + verification + hand to advisor

**Files:** `ready_time_config/graduation_thresholds` (RTDB data), test script

- [ ] **Step 1: Seed `graduation_thresholds` UNSIGNED (preview)** in `ready_time_config` (admin write) — **omit `version`/`approved_at`** so `isGraduationConfigSigned` returns false ⇒ `mode:'preview'` ⇒ nothing graduates (plan-gate #2: "unsigned" = no version/approval stamp, NOT a `signed:false` flag):
`{ window_ms: 12096e5 /*14d*/, min_samples: 40, q_fdr: 0.1, coverage_cap: 0.2, excl_cap: 0.2, late_cap: 0.15, p90_cap: 6, within_floor: 0.6, bias_cap: 1.5, margin: 1, margin_bkt: 1, ttl_ms: 216e5 /*6h*/, buffer_prep_min: <median of prep_new_min = actual PREP time (ready_at − new_at)> }`
> **★ Correction (advisor, at deploy):** `buffer_prep_min` is the **prep** baseline = **median `prep_new_min`** (kitchen time), NOT `tapped_sane_ready_to_ofd_ms` (the ready→OFD merchant-dwell leg = the separate `S_merchant`, used only in the deferred assignment-aware pre-pickup `llega`). Don't conflate the legs. The deployed preview seed used a `16` placeholder (harmless while unsigned); set the true median-`prep_new_min` at the signing gate.
After the bake, add `version` + `approved_at` (that is "signing") → flips `hashConfig` → activates authoritative verdicts.
- [ ] **Step 2: Add tests to the `test` script** in `package.json`: append `&& node ready-time-graduation.test.js`.
- [ ] **Step 3: Full suite green** — `npm test` (includes the new file). Confirm `node ready-time-graduation.test.js` passes standalone.
- [ ] **Step 4: Zero-prune check** — the deploy adds ONE function: `firebase functions:list` vs `grep -c "^exports\." index.js` → expect +1 (`readyTimeGraduationMonitor`), nothing pruned.
- [ ] **Step 5: Hand the functions+rules diff to the advisor for codex-on-diff.** Do NOT deploy. On clearance: deploy from a synced checkout with the **complete `.env`** + the **reconciled+re-diffed-vs-live rules** (0 stripped) → then the **~2-week preview bake**: the monitor runs hourly in `preview`, reporting per-bucket `predErr/bufErr/bktErr/coverage` distributions; from those, **set + sign** the `graduation_thresholds` (flip `signed:true`) and decide bucket **coarsening**; **measure the real ring-median drift** (fix 3). Graduation goes authoritative only after signing. **1b-ii is held until authoritative verdicts exist.**

---

## Self-Review

**Spec coverage (REV-4):** join base = `prediction_logs` (Task 4 `buildGraduationRows`, Task 3) ✓; fine-bucket accuracy by stored tuple + coarse coverage split (Tasks 2,3) ✓; BCa CB + BH-FDR (Task 1) ✓; bias/tail/late/within guards + sensitivity (Task 2 `gateBucket`) ✓; per-bucket median baseline `δ_bkt` (Task 3) ✓; verdict path incl. `source` + `_meta/active_config_hash` (Tasks 3,4) ✓; fail-closed preview (Task 3, Task 6 unsigned seed) ✓; TTL/`settle_lag` reuse (Task 4,6) ✓; monitor writes ONLY `ready_time_graduation` (Task 4) ✓; rules reconcile-to-live + 2 grants + no strip (Task 5) ✓; zero-prune/.env/codex-on-diff (Task 6) ✓; no UI ✓.

**Placeholder scan:** the only data-dependent blanks are the seed thresholds (deliberately set from the bake's reported distributions — Task 6) and `buffer_prep_min`/drift (measured), which is the spec's intent, not hand-waving. Stat code is concrete.

**Type consistency:** `computeGraduation`/`gateBucket`/`bhFdrAdjust`/`bootstrapLowerP`/`coverageByCoarse`/`daypartKeyOf`/`mean`/`quantile` names identical across module, tests, and the monitor. Verdict node shape matches REV-4 §5. `graduation_thresholds` keys identical between `gateBucket`, the test fixtures, and the Task-6 seed.

**Note (gitignored rules):** Task 5 records the 2-grant diff for reproduction in the deploy checkout because `xpizza-functions/database.rules.json` is gitignored. If Xavier closes the standing fragility (tracks the file / cp-in-deploy-path) first, Task 5 simplifies to a normal tracked edit.
