# Phase 1b — Ready-Time Predictor Graduation + Pre-Pickup ETA — Design Spec (REV-2)

**Date:** 2026-07-14 (rev-2) · **Owner (build):** split (functions/rules + dispatch client) · **Gate:** advisor design re-gate (codex round-2) → plan-gate → diff-gate.
**Status:** rev-2 folds codex-round-1's 7 findings + advisor corrections A/B + a source-verified live-rules-truth blocker. **Nothing coded until re-gated.** Worktree on `origin/main` (`98b813d`).

**Rev-2 changelog:** §6/§7 fallback-ladder order fixed (Listo first, correction A); §7 OD2 resolved (prep-ETA only, correction B); §4(b) rebuilt for confidence/multiplicity/bias-tail/per-bucket-baseline/selection-bias/coverage (findings 1–5); §5/§6 add signed-provenance + TTL fence via `isFreshAuthoritativeRun` (findings 6–7, calibrated); §6/§10 corrected to the DEPLOYED rules file + a **BLOCKER** on live-rules truth.

---

## 0. One-line

Graduate the ready-time predictor from pure-shadow into a live ETA prep input — **per-bucket, fail-closed, only where a confidence-bounded, multiplicity-adjusted, bias/tail-guarded measurement proves it beats both the global buffer and a per-bucket baseline** — and consume it in a **pre-pickup PREP ETA only**. The data-not-guessing boundary of the program.

## 1. ★ BLOCKING PREREQUISITE — establish live-rules truth (before any 1b-i rules work)

The repo's local rules files are **out of sync with production**, so a rules edit off them would strip live rules:
- Deployed target = `xpizza-functions/database.rules.json` (per `xpizza-functions/firebase.json`). No root `.read` default → unlisted paths deny-by-default.
- The local deployed file (mtime Jun 11) **lacks `driver_cash`/`cuadre`**, yet the `driver_cash` rule is recorded **live since 2026-06-29** ([[sherpa-driver-cash-feature]]). ⇒ **the local file is stale vs live.**
- It also lacks `order_predictions`/`prediction_logs`/`ready_time_*`/`order_timelines`; the fuller `xpizza-reference/database.rules.json` (Jul 12) has them but is **not** the deploy source (drift).

**Required before editing rules:** pull the *actual* deployed ruleset from Firebase (`firebase database:get` / console export), reconcile it into `xpizza-functions/database.rules.json`, and design the 1b read-grant as a diff **against the true live baseline** — exactly like verifying `origin/main` before a deploy. Deploying a locally-reconstructed rules file is a live-strip footgun ([[advisor-approval-gate]]). This reconciliation is owned by whoever holds Firebase auth (advisor/Xavier), not inferred here.

## 2. Governing principle

Surface a prediction only for buckets where a **statistically defensible** measurement proves it more accurate than the fallback. Graduation is fail-closed, per-bucket, confidence-based, and gated behind a **signed** threshold + a fresh-authoritative **provenance/TTL fence** — during the bake nothing graduates.

## 3. Source facts (verified 2026-07-14)

- Predictor pure-shadow. `order_predictions/{orderId}/{v}` (create-if-absent txn): `predicted_ready_at`(abs ms), `predicted_prep_min`, **`bucket_key`**, **`source`**, `sample_count`, `model_version`, `restaurant_id`, `new_at`, `features_snapshot`. `prediction_logs/{orderId}/{v}`: `prep_new_min`(actual), **`error_min = predicted_prep_min − prep_new_min`** (signed), `predicted_prep_min`, `restaurant_id`, `new_at`, flags **`quarantined`**/**`prediction_missing`** (EXCLUDE both). (`ready-time-predict-core.js:57-118`)
- Buckets: `bucketKeyDaypart = daypartOf(new_at)|loadBucketOf(kla)` (`ready-time-features.js:132`); the model's own `bucket_key`+`source` live on the prediction node.
- `ACTIVE_MODEL_VERSIONS` — a set; accuracy is per version.
- **Provenance/TTL contract to reuse:** `isFreshAuthoritativeRun(latest, expected)` (`ready-time-quality-run.js:85`) already checks `status==='ok'` + `mode==='authoritative'` + `settled===true` + `config_hash===expected` + window coverage + `now−computed_at ≤ max_age_ms`. This IS findings 6+7's fence.
- Signed thresholds live in admin-only `ready_time_config` (hashed → `config_hash`).
- Capture verdict: `isCaptureAcceptable`/`restaurantVerdict` (signed) exported.
- S_merchant seed: `tapped_sane_ready_to_ofd_ms.median` (measured).
- Deployed rules (see §1): `dispatcher_alerts.".read" = auth!=null && dispatchers/uid exists` (the grant pattern); ready-time paths + `order_timelines` absent → deny-by-default.

## 4. The graduation gate (Decision 1 — two conditions, fail-closed)

### 4(a) Capture-quality
Signed `restaurant/segment` verdict (`isCaptureAcceptable`/`restaurantVerdict`) passes — trustworthy labels.

### 4(b) Measured accuracy — REBUILT (findings 1–5)

**Population & join (finding 5):** left-outer audit `order_predictions ⟕ prediction_logs` on `{orderId,v}` over the window; count matched / unmatched / `prediction_missing` / `quarantined`. Key everything by the **stored tuple `(model_version, source, bucket_key, restaurant_id)`** read off the prediction node — never inferred; any bucket/schema change mints a new `v`. Eligible = matched ∧ ¬quarantined ∧ ¬missing.

**Per-order signals (eligible):** `predErr=|error_min|`; `actual_prep = predicted_prep_min − error_min`; `bufErr=|PREP_BUFFER_MIN − actual_prep|` (global buffer); `bktErr=|bucketMedian_prep − actual_prep|` (per-bucket historical-median, **shrinkage**-estimated — finding 4). Paired deltas `δ_buf=bufErr−predErr`, `δ_bkt=bktErr−predErr`.

**Per bucket `(v,restaurant,bucket_key)`, GRADUATE iff ALL hold (fail-closed):**
1. **Coverage & selection-bias (findings 1,5):** eligible `n ≥ minSamples`; `unmatched+missing share ≤ COVERAGE_CAP`; `quarantined+missing share ≤ EXCL_CAP`; report all shares. A bucket that only predicts part of its orders isn't ready.
2. **Confidence-bounded improvement (finding 2 — the big one):** the **one-sided lower confidence bound** (paired BCa bootstrap or paired-t) of `mean(δ_buf) > MARGIN` **AND** `mean(δ_bkt) > MARGIN_BKT`, with **multiplicity adjustment (Holm or BH-FDR)** across all buckets tested this run. (Small n ⇒ wide CB ⇒ fails; this subsumes `n ≥ minSamples` and kills chance graduates. No point-MAE comparison.)
3. **Bias & tail guards (finding 3):** signed `|mean(error_min)| ≤ BIAS_CAP`; **under-prediction (early-ready, `error_min<0`) rate ≤ LATE_CAP** (early "ready" is the dangerous direction); `p90(predErr) ≤ P90_CAP`; `pct_within_N ≥ WITHIN_FLOOR` — each also no worse than the buffer on the same orders.
4. **Sensitivity (finding 1):** impute excluded orders worst-case; if that erases the confidence-bounded margin, do NOT graduate.

**Thresholds learned then signed:** the first run *reports* the `predErr`/`bufErr`/`bktErr` distributions per bucket; seed `MARGIN≈1–2`, `MARGIN_BKT` similar, `LATE_CAP`/`P90_CAP`/`WITHIN_FLOOR`/`BIAS_CAP`/`minSamples`/`COVERAGE_CAP`/`EXCL_CAP`/window/adjustment-method from that distribution, then store **signed in `ready_time_config`**. Until signed, verdicts are `mode:'preview'` → client rejects (§6).

## 5. Verdict node (`ready_time_graduation/{v}/{restaurant}/{bucket_key}`)

`{ graduated, n, coverage:{matched,unmatched,missing,quarantined,shares}, predictor:{mae,p90,bias,late_rate,within_n}, vs_buffer:{mean_delta,lower_cb,p_adj}, vs_bucketmed:{mean_delta,lower_cb,p_adj}, window, computed_at, expires_at (TTL — finding 6), watermark:{sample_count} (drift — finding 6), config_hash (=threshold_v_hash), mode:'authoritative'|'preview', settled }` — same shape the `isFreshAuthoritativeRun` contract consumes. **Drift (finding 6, calibrated):** short TTL (`expires_at`, fail-closed stale) + carry `sample_count` watermark; full `model_snapshot_id`-matching deferred unless the 2-week bake shows drift-instability (don't over-build against a slow median ring).

## 6. Exposure (Decision 2 — dispatcher read-grant + client fence)

**Rules edit — against the reconciled LIVE baseline (§1), on the DEPLOYED `xpizza-functions/database.rules.json`; `predeploy` `check:rules` must pass. Add:**
- `order_predictions.".read"` = `auth!=null && dispatchers/uid exists` (mirror `dispatcher_alerts`).
- `ready_time_graduation.".read"` = same dispatcher predicate.
- `order_timelines.".read"` = `auth!=null` (or dispatcher) — the Listo-first step needs it; currently deny-by-default. [Open: grant now vs when first exercised; **rec grant now** — server-derived read-only.]
- **Do NOT add read** on `prediction_logs`/`ready_time_model`/`ready_time_quality` (stay deny). Predictor shadow preserved.

**Fallback ladder (correction A — Listo FIRST, a fact beats any prediction):**
```
predReadyAt = order_timelines[id].ready_at
           ?? (bucketGraduated(v,source,bucket_key,restaurant) ? order_predictions[id][v].predicted_ready_at : null)
           ?? (new_at + PREP_BUFFER_MIN·60000)
```

**Client provenance/TTL fence (findings 6,7):** a bucket counts as graduated ONLY if its verdict passes an `isFreshAuthoritativeRun`-style check — `mode==='authoritative' && settled===true && config_hash===<current signed ready_time_config hash> && now ≤ expires_at`. Otherwise → not graduated → buffer. Lookup strictly by the stored `(v,source,bucket_key,restaurant_id)` tuple off the prediction node. During the bake, verdicts are `preview`/unsigned → client rejects → nothing graduates.

## 7. Consumer — pre-pickup PREP ETA (correction B; OD2 resolved)

A still-cooking order (not yet `out_for_delivery`) shows the **prep ETA ONLY**:
> `en cocina · listo ≈ 7:30`

**No `llega ≈`.** Rendering a delivery arrival for a pre-pickup order with no assigned/positioned driver fabricates a delivery timeline → violates data-honesty. The pre-pickup delivery projection is **deferred to the assignment-aware fast-follow**. `S_merchant` (measured-median seed) is therefore unused in 1b-ii — kept noted for that fast-follow. (For a cooking order the ladder's Listo step doesn't fire → `predReadyAt` = graduated-prediction ‖ buffer; `order_timelines` read matters once the Listo step is exercised — 1c / already-ready orders — hence the grant is forward-looking.)

## 8. Sub-phasing + bake

- **1b-i — infra (functions + rules).** Pure `ready-time-graduation.js` (`computeGraduation`, unit-tested — bootstrap CB, Holm/BH, bias/tail/coverage/sensitivity) + `readyTimeGraduationMonitor` (`onSchedule` hourly, `America/Tegucigalpa`, writes only `ready_time_graduation`) + the read-grants (post-§1 reconciliation). **~2-week BAKE:** thresholds unsigned/`preview` → client rejects → nothing graduates; meanwhile the runs *report* the accuracy distribution → learn + **sign** the thresholds → decide bucket **coarsening** from the n-distribution. Rules/data boundary → **codex-on-diff**; functions **zero-prune (+1)** + complete `.env`.
- **1b-ii — client consumer.** Prep-ETA-only render via the ladder + fence. Client-only; own diff-gate. Graduation goes live only after signed thresholds.

## 9. Data-honesty invariants (extends 1a §5.5)

1. Confidence-bounded + multiplicity-adjusted — no chance graduates; small-n self-fails.
2. Bias/tail/coverage/selection-bias guarded — beats the buffer AND a per-bucket baseline; early-ready specifically bounded.
3. Threshold measured-then-signed; verdicts carry provenance; client rejects preview/unsigned/stale (fail-closed).
4. Predictor shadow boundary preserved (monitor reads shadow, writes only the verdict path; no `/orders` mutation; client use is read-only display).
5. Listo-first ladder (fact > prediction > buffer). Pre-pickup shows prep-ETA only — no fabricated delivery timeline.

## 10. Deploy discipline

- **§1 blocker first** — reconcile the true live ruleset into `xpizza-functions/database.rules.json`; design the read-grant as a diff vs that. Rules deploy runs `check:rules`.
- `readyTimeGraduationMonitor` touches `functions/` → **zero-prune (+1)**, deploy from current tree with **complete `.env`**, **codex-on-diff**. Xavier deploys with explicit go.
- Config drift (`xpizza-reference` ≠ deployed) flagged for separate hygiene; 1b adds only its paths to the reconciled deployed file.

## 11. Open decisions (rev-2)

Resolved: OD1 mechanism (scheduled monitor + pure core, hourly) ✓; OD2 (prep-ETA only) ✓; granularity (per-`v` + stored `bucket_key`, coarsen after first run's n-distribution) ✓; `PREP_BUFFER_MIN` = measured median prep ✓; sub-phase 1b-i/1b-ii + ~2-week bake ✓.
Remaining for the design re-gate: (1) **§1 live-rules reconciliation** — owner + method; (2) `order_timelines` grant now vs later; (3) CB method (BCa bootstrap vs paired-t) + multiplicity (Holm vs BH-FDR); (4) TTL length + `settle_lag`; (5) exact seed thresholds after the first reporting run.

## 12. Out of scope

1c 2-order stacked cascade (own gate; consumes the graduated predictor for a still-cooking leg); the assignment-aware pre-pickup `llega ≈`; model retraining; snapshot-id drift matching (deferred per §5); reconciling the *full* rules drift beyond 1b's paths.
