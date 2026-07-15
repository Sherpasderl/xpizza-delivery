# Phase 1b — Ready-Time Predictor Graduation + Pre-Pickup ETA — Design Spec

**Date:** 2026-07-14 · **Owner (build):** split (functions/rules + dispatch client) · **Gate:** advisor **design-gate** (this doc), then plan-gate, then diff-gate.
**Status:** design/spec for the advisor design-gate. **Nothing coded until gated.** Prereq done: worktree on `origin/main` (1a merged `1de44e0`).

---

## 0. One-line

Graduate the ready-time predictor from pure-shadow into a live ETA prep input — **but only per-bucket, only where its accuracy is measured and beats the fallback** — and consume it in a new **pre-pickup single-order ETA**. This is the "data, not guessing" boundary of the ETA program.

## 1. Governing principle (sharpened)

1a's invariant 3 was "prep from data." 1b makes it enforceable: **we surface a prediction only for buckets where we have *measured* that the prediction is more accurate than the static buffer.** Graduation is **fail-closed and per-bucket** — an ungraduated bucket falls to the buffer, never to an unmeasured prediction.

## 2. The core finding (verified — do not re-litigate)

`ready-time-quality` is a **data-CAPTURE monitor** (tap-rate / rush-bias / missingness), **not** a prediction-accuracy metric — there is no MAE/RMSE/within-N anywhere. The only prediction-error signal is `prediction_logs/{orderId}/{v}.error_min` (`ready-time-predict-core.js:114`), **unaggregated and unconsumed**. So graduating on capture-quality alone would surface a prediction whose accuracy we've never measured — a principle violation. Hence the accuracy half of the gate is genuine net-new work.

## 3. Source facts (verified 2026-07-14)

- **Predictor is pure-shadow.** Writes only `order_predictions/{orderId}/{v}` + `prediction_logs/{orderId}/{v}` + `ready_time_model` via create-if-absent txns; every `/orders` access read-only.
- **`order_predictions/{orderId}/{v}`** node: `predicted_ready_at` (abs ms = `new_at + prep_min·60000`), `predicted_prep_min`, **`bucket_key`**, `source`, `sample_count`, `model_version`, `restaurant_id`, `new_at`, `features_snapshot`. (`:61-63`)
- **`prediction_logs/{orderId}/{v}`** node: `prep_new_min` (actual prep = `ready_at − new_at`), **`error_min = predicted_prep_min − prep_new_min`** (signed), `predicted_prep_min`, `restaurant_id`, `new_at`, `logged_at`, and flags **`quarantined`** (training-ineligible → untrustworthy label; EXCLUDE) / **`prediction_missing`** (EXCLUDE). (`:106-118`)
- **Buckets:** `bucketKeyDaypart = daypartOf(new_at)|loadBucketOf(kla)` (`ready-time-features.js:132`); the model's own `bucket_key` lives on the prediction node.
- **`ACTIVE_MODEL_VERSIONS`** — a set (may be >1); accuracy is per version.
- **RTDB rules** (`xpizza-reference/database.rules.json`): `order_predictions` / `prediction_logs` / `ready_time_model` / `ready_time_quality` all **`.read:false,.write:false`** (`:89-93`); `dispatcher_alerts.".read"` = `auth != null && root.child('dispatchers').child(auth.uid).exists()` (`:73` — the grant pattern to mirror); `order_timelines.".read": "auth != null"` (`:88` — Listo ground truth already client-readable).
- **Listo ground truth** = `order_timelines/{id}/ready_at` (server-derived, transactional).
- **S_merchant seed** (grab-bag dwell): `ready-time-quality`'s `tapped_sane_ready_to_ofd_ms.median` (`:132-134`) — measured ready→ofd; use it, don't guess.
- **Signed config:** thresholds live in admin-only `ready_time_config` (fail-closed, hashed — `ready-time-quality-run.js:147,164`).
- **Capture verdict:** `isCaptureAcceptable` / `restaurantVerdict` (signed thresholds) exist and are exported.
- **Dispatch auth:** Firebase email/pw → `auth.uid`; dispatcher = `/dispatchers/<uid>` exists.

## 4. The graduation gate (Decision 1 — baked; two-condition, fail-closed)

A bucket `(v, restaurant, bucket_key)` **graduates** iff BOTH:

**(a) Capture-quality passes** — reuse `isCaptureAcceptable` / `restaurantVerdict` (per restaurant/segment) against signed thresholds, so the labels feeding the accuracy metric are trustworthy. *Exists — wire it.*

**(b) Measured accuracy beats the fallback** — NET-NEW:
- Join `order_predictions ⋈ prediction_logs` on `{orderId, v}` over a recent window; drop `quarantined` / `prediction_missing`.
- Per `(v, restaurant, bucket_key)` with `n ≥ minSamples`, compute:
  - `predictor_MAE = mean(|error_min|)`
  - `actual_prep = predicted_prep_min − error_min`; `buffer_MAE = mean(|PREP_BUFFER_MIN − actual_prep|)` — same static buffer the client falls back to (apples-to-apples).
  - `pct_within_N = share(|error_min| ≤ N)`
- **Graduate iff** `predictor_MAE ≤ buffer_MAE − MARGIN_MIN` **AND** `predictor_MAE ≤ ABS_CAP_MIN` **AND** `n ≥ minSamples`.

**Thresholds from data, not blind:** the first aggregation run *learns* current `predictor_MAE` and `buffer_MAE`; seed `MARGIN_MIN ≈ 1–2`, `ABS_CAP_MIN ≈ 4–5`, `minSamples ≈ 30–50` — then store them **signed in `ready_time_config`** (same discipline as `quality_thresholds`). Per-bucket: some restaurant/dayparts graduate, others fall to the buffer.

### 4.1 ★ Open decision OD1 — where the aggregation runs
`ready-time-quality-run.js` is a **CLI script, not a deployed function** — so a live, client-consumable verdict needs a deployed writer. **Recommendation:** a new **scheduled function** `readyTimeGraduationMonitor` (`onSchedule`, hourly, `America/Tegucigalpa`) that is a thin adapter over a new **pure core `ready-time-graduation.js`** (`computeGraduation(joinedRows, cfg) → per-bucket verdicts`, unit-tested — mirrors `driver-freshness.js`). It **READS** `order_predictions` + `prediction_logs` + `ready_time_config`, and **WRITES only the new `ready_time_graduation` path** — it never touches `/orders` or the predictor's write paths, so the predictor's shadow boundary is preserved (graduation is additive, read-side). *Advisor to confirm mechanism + cadence.*

## 5. Gate-verdict output (new RTDB path)

`ready_time_graduation/{v}/{restaurant}/{bucket_key}` = `{ graduated: bool, n, predictor_mae, buffer_mae, pct_within, window, computed_at }`. Fail-closed: absent/false ⇒ not graduated. New default-deny path (see §6).

## 6. Exposure (Decision 2 — baked; dispatcher read-grant, NOT a stamp-function)

RTDB rules change only (a rules deploy; no writes; preserves pure-shadow):
- Grant `order_predictions.".read"` = `auth != null && root.child('dispatchers').child(auth.uid).exists()` (mirror `dispatcher_alerts`).
- Grant `ready_time_graduation.".read"` = same dispatcher predicate.
- **Keep `prediction_logs` / `ready_time_model` / `ready_time_quality` deny.**

The client applies the gate itself (verdict + prediction both read-granted):
```
predReadyAt = (graduated(v, restaurant, bucket_key) && order_predictions[id][v].predicted_ready_at)
              || order_timelines[id].ready_at        // Listo, if already ready (prep done)
              || (new_at + PREP_BUFFER_MIN·60000)     // static buffer
```
Reading the prediction WITHOUT the verdict would bypass the accuracy gate — both grants are required, verdict-first.

## 7. The client consumer — pre-pickup single-order ETA

**New surface:** an order still cooking (not yet `out_for_delivery` / pickup not completed) shows a two-part ETA instead of just the phase pill:
> `en cocina · listo ≈ 7:30  →  llega ≈ 7:45`

### 7.1 Fallback ladder (prep leg)
`predReadyAt` per §6 (Listo-actual → graduated prediction → buffer). Bucket + `predicted_ready_at` come from the prediction node; `graduated` from the verdict path.

### 7.2 Composition (delivery leg)
`arrival = pickupTime + Directions(restaurant → customer) + S_customer`, where `pickupTime = predReadyAt + S_merchant`. `S_customer` reuses 1a's config; **`S_merchant` seeds from `tapped_sane_ready_to_ofd_ms.median`** (measured), config-tunable. All `≈`.

### 7.3 ★ Open decision OD2 — driver-leg / assignment-state
`pickupTime` above assumes the driver is at the restaurant when the food is ready. Options: **(minimal)** assume pickup at `predReadyAt` (simplest; the advisor's "ready → llega" framing); **(richer)** when a driver is assigned + en route to the restaurant, `pickupTime = max(predReadyAt, now + Directions(driver→restaurant)) + S_merchant`; **(strict)** only show the pre-pickup ETA once a driver is assigned. *Recommendation: minimal for 1b (assume pickup ≈ ready), driver-leg as a later refinement — keeps 1b honest-`≈` and tractable. Advisor to rule.*

## 8. Sub-phasing (recommendation)

- **1b-i — graduation infrastructure (functions + rules).** New pure `ready-time-graduation.js` + tests; `readyTimeGraduationMonitor` scheduled fn; the two read-grants; the signed threshold config. **No UI change** — the verdict is produced + measurable in shadow before anything consumes it. This is the rules/data boundary → **codex-on-diff**, zero-prune functions deploy + complete `.env`.
- **1b-ii — pre-pickup ETA client consumer.** Dispatch reads the verdict + prediction, renders the two-part pre-pickup ETA via the fallback ladder. Client-only; its own diff-gate.

Splitting isolates the risky functions/rules change for focused review, and lets 1b-i bake (produce real verdicts) before 1b-ii trusts them.

## 9. Data-honesty invariants (extends 1a §5.5)

1. **Graduation is fail-closed + per-bucket** — absent/insufficient/unmeasured ⇒ buffer, never an unproven prediction.
2. **Quarantined/missing logs excluded** from the accuracy metric.
3. **Threshold is measured then signed** — no blind constant; stored in admin-only `ready_time_config`.
4. **Predictor shadow boundary preserved** — the monitor reads shadow + writes only the new verdict path; no `/orders` mutation anywhere; the client use is read-only display.
5. Pre-pickup ETA is `≈` and composed from the ladder; no flat promise.

## 10. Deploy discipline (build time)

- `readyTimeGraduationMonitor` touches `functions/` → **zero-prune** (compare `functions:list` to exports) + deploy from current tree with the **complete `.env`** (env footgun strips live payments/La Musa WhatsApp). New fn ⇒ count +1.
- The read-grants = a **rules deploy** (`database.rules.json`).
- Both come back **diff-gated** (codex-on-diff on the functions/rules piece); Xavier deploys with explicit go.

## 11. Open decisions for the design-gate

1. **OD1** — aggregation mechanism: new scheduled fn + pure core (rec) vs other. Cadence/window.
2. **OD2** — pre-pickup driver-leg: minimal (assume pickup≈ready, rec) vs driver-en-route-aware vs assigned-only.
3. **Graduation key granularity** — per model's own `bucket_key` (rec, via join) vs daypart-only; per `v`.
4. **Seed constants** — `PREP_BUFFER_MIN` (the buffer baseline + client fallback), `MARGIN_MIN`, `ABS_CAP_MIN`, `minSamples`, window length — starting values, to be re-set from the first aggregation.
5. **Sub-phasing** — split 1b-i/1b-ii (rec) vs one gate.

## 12. Out of scope

1c 2-order stacked cascade (its own gate; consumes the same graduated predictor for a still-cooking leg); full assignment-aware / multi-driver ETA; retraining the model; changing the predictor's write paths.
