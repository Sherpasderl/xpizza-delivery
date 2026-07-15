# Phase 1b — Ready-Time Predictor Graduation + Pre-Pickup ETA — Design Spec (REV-3)

**Date:** 2026-07-14 (rev-3) · **Owner (build):** split (functions/rules + dispatch client) · **Gate:** advisor design re-gate (codex round-3) → plan-gate → diff-gate.
**Status:** rev-3 = codex round-2's fixes 1–4 + §11 rulings + the **corrected §1 rules deploy trap** (the gitignored deploy-file footgun, verified). Nothing coded until re-gated. Worktree on `origin/main` (`695d9b2`).

**Rev-3 changelog:** §1 corrected — the blocker STANDS but reframed (deploy-source file is gitignored/per-checkout, drifts; tracked truth = `xpizza-reference/`); `order_timelines` needs no grant (already live-readable). Fix 1 (join base = `prediction_logs`). Fix 2 (verdict path adds `source`). Fix 3 (drop `sample_count` watermark; drift = bake-measured). Fix 4 (client fence = `mode`/`settled`/TTL, not client-side hash). §11 ruled (BCa; BH-FDR; TTL 3–6h; reuse `settle_lag`; seed after the preview run).

---

## 0. One-line

Graduate the ready-time predictor from pure-shadow into a live ETA prep input — per-bucket, fail-closed, only where a **BCa-bootstrap confidence bound, BH-FDR-adjusted**, bias/tail-guarded measurement proves it beats both a global buffer and a per-bucket baseline — consumed in a **pre-pickup PREP ETA only**.

## 1. ★ Rules deploy trap (verified — the deploy-source file is gitignored/per-checkout)

- The firebase.json deploy source `xpizza-functions/database.rules.json` is **gitignored** (`git check-ignore` confirms) → **per-checkout, can and does drift**. The dispatch checkout holds a **stale 16-key** set; another checkout holds the full 28-key set. A rules deploy from a stale checkout would **strip live rules** (`driver_cash`, `order_predictions`, `order_timelines`, `ready_time_*`, `prediction_logs`, `pickup_ready_notifications`, `menus`, `restaurants`, `facturas`, `payment_audit`, …) — the **`.env`-class footgun for rules** ([[functions-env-management]]).
- **Source of truth = `xpizza-reference/database.rules.json`** (tracked, 28 keys) — advisor-verified **byte-identical to LIVE** (recursive diff, nothing live-only).
- **Rules deploy discipline (mandatory):** (1) `cp xpizza-reference/database.rules.json → <deploy-checkout>/xpizza-functions/database.rules.json` (reconcile the gitignored artifact to the tracked truth); (2) add the two grants (§6) **as a diff** on top; (3) re-fetch live + diff → confirm **0 stripped** (only the two grants added); (4) deploy (`predeploy check:rules`).
- **Standing fragility (flag for Xavier, not a 1b blocker):** a gitignored deploy file + a tracked reference copy is exactly how a checkout deploys stale rules. Close it for good — **track `xpizza-functions/database.rules.json`** (drop from `.gitignore`) or make the deploy path always `cp xpizza-reference → xpizza-functions` first.

## 2. Governing principle

Surface a prediction only for buckets where a statistically defensible measurement proves it beats the fallback; fail-closed, per-bucket, confidence-based, behind a **signed** threshold + a fresh-authoritative provenance/TTL fence. During the bake, nothing graduates.

## 3. Source facts (verified 2026-07-14)

- Predictor pure-shadow. `order_predictions/{orderId}/{v}`: `predicted_ready_at`(abs ms), `predicted_prep_min`, **`bucket_key`**, **`source`**, `sample_count`, `model_version`, `restaurant_id`, `new_at`, `features_snapshot`. `prediction_logs/{orderId}/{v}` (**written for every order that reaches ready — the superset**): `prep_new_min`(actual), **`error_min`** (signed = predicted − actual), `predicted_prep_min`, `restaurant_id`, `new_at`, flags **`quarantined`** / **`prediction_missing`** (the latter ONLY here, for orders with no prediction node → the reason the join base must be `prediction_logs`). (`ready-time-predict-core.js:57-118`)
- Buckets: `bucketKeyDaypart = daypartOf(new_at)|loadBucketOf(kla)`; the model's own `bucket_key`+`source` live on the prediction node.
- `ACTIVE_MODEL_VERSIONS` — a set; accuracy per version.
- Provenance/TTL contract to reuse: `isFreshAuthoritativeRun` (`ready-time-quality-run.js:85`) checks `status==='ok'` + `mode==='authoritative'` + `settled===true` + window coverage + `now−computed_at ≤ max_age_ms`.
- Signed thresholds + `settle_lag` live in admin-only `ready_time_config`.
- Capture: `isCaptureAcceptable`/`restaurantVerdict` (signed) exported. S_merchant seed: `tapped_sane_ready_to_ofd_ms.median`.
- **Live rules (== `xpizza-reference/`):** `order_timelines.".read": "auth != null"` (Listo readable — no grant needed); `order_predictions`/`prediction_logs`/`ready_time_*` deny; `dispatcher_alerts.".read"` = dispatcher predicate (grant pattern).

## 4. The graduation gate (two conditions, fail-closed)

### 4(a) Capture-quality
Signed `isCaptureAcceptable`/`restaurantVerdict` (restaurant/segment) passes.

### 4(b) Measured accuracy

**Population & join (fix 1 + finding 5):** base = **`prediction_logs`** (superset: every order that reached ready) **⟕ `order_predictions`** on `{orderId,v}` over the window — so `prediction_missing` rows are visible and the coverage/selection caps are enforceable. Count matched / `prediction_missing` / `quarantined`. Key by the **stored tuple `(model_version, source, bucket_key, restaurant_id)`** read off the prediction node — never inferred; any bucket/schema change mints a new `v`. Eligible = matched ∧ ¬quarantined ∧ ¬missing.

**Per-order signals (eligible):** `predErr=|error_min|`; `actual_prep = predicted_prep_min − error_min`; `bufErr=|PREP_BUFFER_MIN − actual_prep|` (global buffer); `bktErr=|bucketMedian_prep − actual_prep|` (per-bucket shrinkage median — finding 4). Paired deltas `δ_buf=bufErr−predErr`, `δ_bkt=bktErr−predErr`.

**Per bucket `(v,restaurant,source,bucket_key)`, GRADUATE iff ALL (fail-closed):**
1. **Coverage & selection-bias (findings 1,5):** eligible `n ≥ minSamples`; `prediction_missing share ≤ COVERAGE_CAP`; `quarantined+missing share ≤ EXCL_CAP`; report all shares.
2. **Confidence-bounded improvement (finding 2):** the **one-sided lower confidence bound** — **BCa paired bootstrap** (skewed non-negative deltas at modest n; no normality; paired-t only as a fast fallback) — of `mean(δ_buf) > MARGIN` AND `mean(δ_bkt) > MARGIN_BKT`, with **BH-FDR** multiplicity control at **q ≈ 0.05–0.10** across all buckets tested this run (a false graduate is bounded by the fail-closed + bias/tail/median backstops, so FDR-power > FWER-conservatism at this volume). Subsumes `n ≥ minSamples`.
3. **Bias & tail guards (finding 3):** `|mean(error_min)| ≤ BIAS_CAP`; **under-prediction (early-ready, `error_min<0`) rate ≤ LATE_CAP**; `p90(predErr) ≤ P90_CAP`; `pct_within_N ≥ WITHIN_FLOOR` — each also no worse than the buffer on the same orders.
4. **Sensitivity (finding 1):** impute excluded orders worst-case; if it erases the confidence-bounded margin, don't graduate.

**Thresholds learned then signed:** the first `preview` run reports the `predErr`/`bufErr`/`bktErr`/coverage distributions per bucket; seed the constants from that, store **signed in `ready_time_config`**. Until signed, verdicts are `mode:'preview'` → client rejects (§6).

## 5. Verdict node (path adds `source` — fix 2)

`ready_time_graduation/{v}/{restaurant}/{source}/{bucket_key}` = `{ graduated, n, coverage:{matched,missing,quarantined,shares}, predictor:{mae,p90,bias,late_rate,within_n}, vs_buffer:{mean_delta,lower_cb,q_adj}, vs_bucketmed:{mean_delta,lower_cb,q_adj}, window, computed_at, expires_at, config_hash (audit only), mode:'authoritative'|'preview', settled }`.

**Drift (fix 3):** **no `sample_count` watermark** (it saturates at `RING_N` while the ring median keeps moving → useless). Defense = **hourly re-graduation over a recent window + a short TTL** (a degrading bucket un-graduates as its recent predictions enter the window); explicit caveat that a long window dilutes recent degradation. **Measure the real ring-median drift rate during the 2-week bake** — add recency-weighting or `model_snapshot_id`-matching ONLY if the measured drift warrants (measure-first; don't build snapshot-matching blind).

## 6. Exposure (two grants + client fence)

**Rules edit — on the reconciled ==live file per §1. Add exactly two grants:**
- `order_predictions.".read"` = `auth!=null && dispatchers/uid exists`.
- `ready_time_graduation.".read"` = same dispatcher predicate.
- `order_timelines` — **no grant** (already `.read:"auth!=null"` in live). `prediction_logs`/`ready_time_model`/`ready_time_quality` stay deny.

**Fallback ladder (Listo FIRST — correction A):**
```
predReadyAt = order_timelines[id].ready_at
           ?? (bucketGraduated(v,source,bucket_key,restaurant) ? order_predictions[id][v].predicted_ready_at : null)
           ?? (new_at + PREP_BUFFER_MIN·60000)
```

**Client provenance/TTL fence (fix 4):** the client **cannot read the admin config hash**, so it trusts **`mode==='authoritative' && settled===true && now ≤ expires_at`**. The monitor (Admin SDK, reads signed `ready_time_config`) stamps `authoritative` **only** when computed under a validly-signed config; `config_hash` rides in the verdict for **audit**, not client comparison. During the bake, verdicts are `preview` → client rejects → nothing graduates. Lookup strictly by the stored `(v,source,bucket_key,restaurant_id)` tuple off the prediction node.

## 7. Consumer — pre-pickup PREP ETA (correction B; OD2)

A still-cooking order (not yet `out_for_delivery`) shows the **prep ETA ONLY**: `en cocina · listo ≈ 7:30`. **No `llega ≈`** — fabricating a delivery timeline for an unassigned/unpositioned order violates data-honesty; the pre-pickup delivery projection is **deferred to the assignment-aware fast-follow** (where `S_merchant`'s measured-median seed is used). For a cooking order the ladder's Listo step doesn't fire → `predReadyAt` = graduated-prediction ‖ buffer.

## 8. Sub-phasing + bake

- **1b-i — infra (functions + rules).** Pure `ready-time-graduation.js` (`computeGraduation`: BCa CB, BH-FDR, bias/tail/coverage/sensitivity — unit-tested) + `readyTimeGraduationMonitor` (`onSchedule` hourly, `America/Tegucigalpa`, writes only `ready_time_graduation`) + the two grants (per §1 reconciliation). **~2-week BAKE:** thresholds unsigned/`preview` → client rejects → nothing graduates; runs report the distribution → learn + **sign** thresholds → decide bucket **coarsening** from the n-distribution → measure ring-median drift (fix 3). TTL **3–6h**; `settle_lag` = **reuse `ready_time_config`'s existing value** (don't invent a second). Rules/data boundary → **codex-on-diff**; functions **zero-prune (+1)** + complete `.env`.
- **1b-ii — client consumer.** Prep-ETA-only render via the ladder + fence. Client-only; own diff-gate. Live only after signed thresholds.

## 9. Data-honesty invariants (extends 1a §5.5)

1. Confidence-bounded (BCa) + BH-FDR-adjusted — no chance graduates; small-n self-fails.
2. Bias/tail/coverage/selection-bias guarded — beats buffer AND per-bucket baseline; early-ready bounded.
3. Threshold measured-then-signed; monitor stamps `authoritative` only under signed config; client rejects preview/stale (fail-closed).
4. Predictor shadow boundary preserved (monitor reads shadow, writes only the verdict path; no `/orders` mutation; client read-only display).
5. Listo-first ladder; pre-pickup = prep-ETA only (no fabricated delivery timeline).
6. Rules deploy reconciles to the tracked==live file first (§1) — never deploys a gitignored per-checkout artifact.

## 10. Deploy discipline

- **Rules:** §1 mandatory reconciliation (`cp xpizza-reference → xpizza-functions/database.rules.json`, add 2 grants as a diff, re-diff vs live = 0 stripped, `check:rules`, deploy).
- **Functions:** `readyTimeGraduationMonitor` → **zero-prune (+1)**, complete `.env`, **codex-on-diff**. Xavier deploys with explicit go.
- Separately: close the gitignored-rules fragility (§1 standing fragility).

## 11. Open decisions — all ruled

CB = BCa bootstrap (paired-t fallback) ✓; multiplicity = BH-FDR q≈0.05–0.10 ✓; TTL 3–6h ✓; `settle_lag` reuse ✓; seed thresholds after the first `preview` reporting run ✓; join base = `prediction_logs` ✓; verdict path incl. `source` ✓; drift = TTL + bake-measured, no watermark ✓; client fence = mode/settled/TTL ✓; two grants, `order_timelines` no grant ✓; granularity per-`v`+stored-`bucket_key`, coarsen after first run ✓; `PREP_BUFFER_MIN` = measured median ✓. **Nothing outstanding** except the seed constants (set during the bake) + the standing gitignored-rules fragility (Xavier to close).

## 12. Out of scope

1c 2-order stacked cascade (own gate); assignment-aware pre-pickup `llega ≈`; model retraining; `model_snapshot_id` drift matching (deferred per §5); the full rules-drift hygiene beyond 1b's two grants (§1 standing fragility).
