# Phase 1 · Step 1 — data-quality monitor (propose-first design)

_Status: PROPOSED · **rev-3** — folds the 4 Codex R2 REVISE items (adjacent false-green paths the R1 fixes exposed). R1's 12 confirmed landed. For advisor read-only + Codex Round-3 (thread 019f2b87) BEFORE any code._
_Sequenced under `PHASE1_READY_TIME_PREDICTOR.md` (rev-3) Step 1. Depends on Step 0 (`3e06446`). Phase 0 substrate LIVE._
_Prime directive (inherited): additive + observer-only. Reads the immutable `orders` ⋈ `order_events` ⋈ `order_timelines` join; **writes ONLY to a NEW admin-only tree `ready_time_quality/**`. NEVER `/orders/**`.** No behavior change; proven by golden tests + (for the runner) an emulator no-`/orders`-write proof._

### rev-3 changelog (the 4 R2 folds — all "a capture failure must not hide as a pass")
A. **Population no longer drops missing-`new_at`-stamp rows** — inclusion requires a numeric `to:'new'` **event** (not the `timeline.new_at` *stamp*, which can be missing/corrupt while the event exists — a real timeline-capture failure). Missing/corrupt `timeline.new_at` becomes a **metric** (`new_at_missingness`) + gate reason, not a silent drop. Temporal bucketing anchors on the `to:'new'` event `at` (always present in-population), decoupled from the possibly-missing stamp.
B. **`non_kitchen_path` is now gated** — a restaurant routinely skipping both `preparing` and `ready` (direct `new→ofd/delivered`) is *bad capture*; excluding those rows let the primary gate pass anyway. Added `non_kitchen_path_excess` hard gate (share too high ⇒ fail); config may classify specific paths as cleanup/test to exempt.
C. **`critical_segments` can't go vacuously green** — restaurant pass now requires **signed, non-empty** `critical_segments` for each active restaurant **and ≥1 in-scope passing segment**; missing/empty/all-`out_of_scope` ⇒ `missing_critical_segments` (fail).
D. **`runId` keyed on the actual joined-input hash + a settled window** — was `{window, config}`, which let a create-only rerun no-op and preserve **stale** metrics when late lifecycle events landed in the same window. Now keyed on `input_hash` (of the joined export snapshot) + `config_hash`, **and** the window must be closed past a high-watermark (`settle_lag`) before an immutable run is created. §6 reconciled with the changelog.

### rev-2 changelog (the 12 R1 folds)
1. **Population independence (critical false-green fix)** — the monitor population is defined **independently**, NOT through `isTrainingEligible` (whose `no_ready_label` gate drops the exact missed-tap rows we count → tap-rate ≈ 100%). Step 0 is reused ONLY for `timelineSanity` + a NEW extracted `nonLabelExclusions` (epoch + denylists) — never the label gates.
2. **Signed thresholds required** — `isCaptureAcceptable` fails `unsigned_thresholds` unless `quality_thresholds.version` + `approved_at` are present. Built-in defaults are **test fixtures only**, never a passing config.
3. **Finite-metric / positive-denominator guard** — the verdict rejects `NaN`/`Infinity`/`null`/`0` denominators (which pass JS `<` silently) with `non_finite_metric` / `empty_denominator`.
4. **`min_bucket_n` on the bias bucket** — the load bucket feeding the bias scalar must have `n ≥ min_bucket_n` (`insufficient_load_bucket`).
5. **≥2 populated load buckets** — else `insufficient_load_coverage` (single-bucket data yields ratio 1 and fake-passes).
6. **Contrast = top-vs-lowest-*sufficient* bucket** (not top-vs-overall, which dilutes), **plus** an absolute `top_tap_rate` floor.
7. **`unknown_load` bucket** — orders missing load on all events are bucketed explicitly with their `n`; `unknown_load_excess` fails if their share exceeds a small threshold (never silently dropped).
8. **Rush proxy = max load across {new, preparing, out_for_delivery}** — taps are skipped at *completion*, so prep-start load can miss the rush; use the peak the order actually saw.
9. **Denominator honesty** — dropped the "airtight" claim; events record the transition, not the actor. Primary tap-rate is over the **kitchen-path cohort** (reached OFD/delivered via `from ∈ {preparing, ready}`); non-kitchen-path transitions are counted+reported separately, not silently included.
10. **Dwell renamed + caveated** — `ready_to_ofd_ms` → `tapped_sane_ready_to_ofd_ms` with `n` and a caveat that it is unrepresentative when capture fails (rush-biased misses ⇒ rush-biased dwell).
11. **Per-segment verdicts** — restaurant-level pass requires the configured `critical_segments` to pass (or be explicitly `out_of_scope`); a green restaurant may not mask a failing/insufficient segment C2 depends on.
12. **Idempotent writer** — `ready_time_quality/{runId}` is a **create-only transaction** keyed by an input+config hash; reruns with identical inputs no-op instead of overwriting.

---

## 0. Why this step gates everything downstream

The predictor's label is a **human "Listo" tap** — noisy ground truth. Before training on it, or graduating the nudge (Step 2) or shadow predictor (Steps 3→4), we must measure whether the tap is reliable and, critically, whether its misses are **rush-biased** (absent exactly when the queue is deepest — where prediction matters most). This monitor is that measurement: observer-only, producing structured evidence wired into gates.

**The enabling insight (grounded in the Phase-0 log):** every `order_events` row carries `kitchen_load_ahead` — at `new`, `preparing`, **and `out_for_delivery`**. So even for an order whose "Listo" tap was **missed** (no `ready_at`), the log still records the queue depth it lived through. That is the only reason "are misses missing-at-random?" is answerable — the confounder (rush) survives on the events, not lost with the missing stamp.

## 1. Consumers (stated first — they drive the output shape)

Output is an **input to gates**, wired directly:

| Consumer | Reads | Drives |
|---|---|---|
| **C1 — Post-epoch hard gate** (Step 0 §2c) | `capture_acceptable[restaurant]` + `rush_bias` | Blocks any *trained* model from consuming post-epoch rows until capture is acceptable **and** non-rush-biased (or the durable `training_exclude` marker / owner denylist audit exists). |
| **C2 — Nudge/predictor graduation** (Steps 2→4) | **per-segment** `capture_acceptable`, `tap_rate`, `missingness`, `n` | A segment graduates to `predictReadyAt` / is trusted by Step-4 eval only if *that segment's* capture passed here — never a restaurant-level average. |
| **C3 — Open-question resolution** | `preparing_at` missingness/consistency; impossible-timeline rate; `tapped_sane_ready_to_ofd_ms` | Answers: is "Listo" reliable now; is it rush-biased; is `preparing_at` trustworthy as a feature (§blueprint Q). |

Because consumers are **gates**, the monitor emits a machine verdict (`isCaptureAcceptable`, per-segment **and** per-restaurant) — they call a function, not re-implement thresholds.

## 2. Population — defined INDEPENDENTLY of the label gates _(fold #1)_

**The population MUST include missed-tap rows** — they are the signal. So it is NOT `isTrainingEligible`-filtered (that gate's `no_ready_label`/`no_new_label`/prep-magnitude rules drop precisely the misses).

Step-0 reuse is surgical:
- **NEW in Step 0 module (behavior-preserving refactor):** extract `nonLabelExclusions(order, timeline, cfg) → { excluded, reasons }` covering ONLY `before_epoch` + `excluded_phone` + `excluded_order`. `isTrainingEligible` is refactored to **compose** it (spreads its reasons) so its output stays byte-identical — the existing 31 Step-0 golden cases must still pass, plus new cases pinning `nonLabelExclusions` directly. This gives one source of truth for the non-label exclusions instead of forking them.
- **Reused as-is:** `timelineSanity` (for the impossible-timeline *metric* — impossible rows are **counted, not excluded**) and the exported `normalizePhone`.

`isMonitorPopulation(order, timeline, events, cfg)` — included iff: has a **numeric `to:'new'` event** (a real order that reached `new` — reuses the Step-0 event selection) **and** `!nonLabelExclusions(...).excluded` (post-epoch, not denylisted). **NOT** conditioned on the `timeline.new_at` *stamp* _(fold A)_ — a valid `to:'new'` event can coexist with a missing/corrupt `new_at` stamp (Step-0 R2b), and dropping those would hide a real timeline-capture failure. Instead:
- **Temporal anchor** = the chosen `to:'new'` event's `at` (always present in-population), so hour bucketing never depends on the possibly-missing stamp.
- **`new_at_missingness`** = fraction of population with absent/non-numeric `timeline.new_at`, reported as a metric and gated (§5) — surfaced, not filtered.

No ready/sanity/label filtering. Each metric below applies its own sub-denominator over this base.

## 3. Metrics (precise; all from the immutable join)

- **Rush proxy** _(fold #8)_ — `rushProxyLoad(events) = max(kitchen_load_ahead)` over the order's `to ∈ {new, preparing, out_for_delivery}` events (the peak congestion it saw; OFD-load is the completion-moment signal taps are skipped at). `null` if none present → `unknown_load`.
- **Load buckets** — `0` / `1-2` / `3-5` / `6+` / **`unknown`** _(fold #7)_. Every bucket reports `n`.
- **"Listo" tap rate** — primary over the **kitchen-path cohort** _(fold #9)_:
  - `kitchen_path` denominator = orders reaching `out_for_delivery`/`delivered` via a `from ∈ {preparing, ready}` transition (normal kitchen flow — the food *was* made ready by the kitchen). Events record transition not actor, so this path-inference is the honest denominator; **non-kitchen-path** transitions (e.g. dispatcher `new→delivered` cleanup) are **counted and reported separately** (`n_non_kitchen_path`), never folded into the primary rate.
  - `hits` = of the kitchen-path cohort, those with numeric `ready_at`. A **miss** = kitchen-path order with no `ready_at`.
  - `tap_rate = hits / n_kitchen_path`.
- **Rush-bias** _(folds #4,5,6)_ — `tap_rate` per load bucket; `rush_bias = tap_rate(highest sufficient load bucket) / tap_rate(lowest sufficient load bucket)` where "sufficient" = `n ≥ min_bucket_n`. Requires **≥2 sufficient buckets** (else `insufficient_load_coverage`); the highest must be sufficient (else `insufficient_load_bucket`). Also report `top_tap_rate` (absolute high-load capture) for its own floor.
- **Impossible-timeline rate** — `count(!timelineSanity(t).ok) / count(rows with ≥2 numeric stamps)`, using the exact Step-0 `timelineSanity`; broken out by violation edge.
- **Dwell** _(fold #10)_ — `tapped_sane_ready_to_ofd_ms = out_for_delivery_at − ready_at` over rows with numeric, sane `ready_at`+`ofd_at`; report `{ n, p25, median, p75, p90 }` with the caveat: **unrepresentative when capture fails** (if misses are rush-biased, this dwell — computed only on tapped rows — is too).
- **Missingness** — per stamp (`new_at` _(fold A)_, `preparing_at`, `ready_at`, `out_for_delivery_at`), fraction absent/non-numeric over the population, per bucket. `new_at_missingness` is a timeline-capture-failure signal (gated §5); `preparing_at` missingness feeds C3.
- **Non-kitchen-path share** _(fold B)_ — `n_non_kitchen_path / n_terminal` where `n_terminal` = orders reaching `out_for_delivery`/`delivered` by any path. A high share means staff routinely skip both `preparing` and `ready` (bad capture masquerading as "excluded cleanup"); gated (§5). `cfg.cleanup_paths` may classify specific `from→to` paths as exempt cleanup/test.

## 4. Bucketing & segments

Primary segment key: **`restaurant_id × hour_of_day`** (UTC−6, Step-0 convention); cross-tab `× load_bucket`. Per-restaurant only — **no cross-restaurant comparison**. Every bucket/segment carries `n`; `n < cfg.min_bucket_n` ⇒ `insufficient_data`, cannot pass a gate. `critical_segments` (e.g. peak dinner hours per restaurant) are declared in cfg for the per-segment gate (§5).

## 5. Verdict — `isCaptureAcceptable(metrics, thresholds)` (pure, fail-closed, signed)

Returns `{ acceptable, reasons[] }` (same discipline as `isTrainingEligible`). **Emitted per-segment AND per-restaurant** _(fold #11)_.

**Preconditions (fail before any threshold compare):**
- `unsigned_thresholds` _(fold #2)_ — `thresholds.version` or `approved_at` missing ⇒ not acceptable. Built-in defaults carry NO signature → usable only in tests, never a passing prod verdict.
- `non_finite_metric` / `empty_denominator` _(fold #3)_ — any gated metric not a finite number, or its denominator `n ≤ 0` ⇒ fail (blocks `0/0`=`NaN`, `Infinity`, `null` silently passing `<`).

**Segment-level gate reasons** (defaults are *proposals for owner sign-off*, and only valid once signed):

| reason | condition |
|---|---|
| `insufficient_sample` | `n_kitchen_path < min_segment_n` (default 200) |
| `low_tap_rate` | `tap_rate < min_tap_rate` (0.90) |
| `insufficient_load_coverage` | `< 2` load buckets with `n ≥ min_bucket_n` (fold #5) |
| `insufficient_load_bucket` | highest load bucket `n < min_bucket_n` (fold #4) |
| `rush_biased_capture` | `rush_bias < min_rush_bias` (0.85) — top-vs-lowest-sufficient (fold #6) |
| `low_top_tap_rate` | `top_tap_rate < min_top_tap_rate` (0.85) — absolute high-load floor (fold #6) |
| `high_impossible_rate` | `impossible_timeline_rate > max_impossible_rate` (0.02) |
| `unknown_load_excess` | `unknown_load n / population n > max_unknown_load_share` (0.05) (fold #7) |
| `high_new_at_missingness` | `new_at_missingness > max_new_at_missingness` (0.02) — timeline-capture failure (fold A) |
| `non_kitchen_path_excess` | `n_non_kitchen_path / n_terminal > max_non_kitchen_path_share` (0.10), excluding `cfg.cleanup_paths` (fold B) |

**Restaurant-level** _(fold #11 + fold C)_: `acceptable` iff — for the active restaurant — `cfg.critical_segments[restaurant]` is **signed and non-empty**, **≥1** of its entries is in-scope AND `acceptable`, and **every** in-scope entry is `acceptable` (out-of-scope entries are skipped but cannot be the *only* entries). A missing/empty `critical_segments`, or one where every entry is `out_of_scope`, ⇒ **`missing_critical_segments` (fail)** — a restaurant can never pass vacuously. `reasons` aggregates the offending segments.

## 6. Output schema — `ready_time_quality/{runId}` (admin-only; idempotent)

`{runId}` = a deterministic hash of **`input_hash` (the joined export snapshot — the actual rows) + `config_hash`** _(folds #12, D)_ — **not** `{window,config}`. So if late lifecycle events change the joined input, the hash changes → a **new** immutable run (never a stale no-op). Additionally, an immutable run is created **only over a settled window**: `window.to_ms ≤ now − cfg.settle_lag_ms` (high-watermark), so late events have landed before the snapshot is frozen; an unsettled window may be computed for preview but is written under a distinct `preview/` prefix, never as a gate-authoritative run. The runner writes via a **create-only transaction** (write iff the node is `null`; admin SDK bypasses rules) so an identical-input rerun no-ops, never overwrites.

```jsonc
ready_time_quality/{runId} = {
  "computed_at": 1751600000000,
  "window":      { "from_ms": …, "to_ms": …, "settled": true },  // settled = to_ms ≤ now − settle_lag (fold D)
  "input_hash":  "…",  "config_hash": "…",             // runId = hash(input_hash + config_hash) (folds #12, D)
  "thresholds":  { "version": "q1", "approved_at": … }, // the SIGNED thresholds used (or null → unsigned run)
  "restaurants": {
    "x_pizza": {
      "n_population": …, "n_terminal": …, "n_kitchen_path": …, "n_non_kitchen_path": …,
      "tap_rate": 0.94, "top_tap_rate": 0.90, "rush_bias": 0.88,
      "impossible_timeline_rate": 0.011,
      "new_at_missingness": 0.004, "preparing_at_missingness": 0.07,
      "non_kitchen_path_share": 0.03,
      "unknown_load": { "n": …, "share": … },
      "tapped_sane_ready_to_ofd_ms": { "n": …, "p25": …, "median": …, "p75": …, "p90": … },
      "by_load":    { "0": {"n":…,"tap_rate":…}, "1-2": {…}, "3-5": {…}, "6+": {…}, "unknown": {"n":…} },
      "by_segment": { "18": { "n":…, "tap_rate":…, "capture_acceptable":true, "gate_reasons":[] }, … },
      "capture_acceptable": true,           // restaurant verdict (§5: ≥1 in-scope critical segment + ALL in-scope pass; empty/all-out-of-scope ⇒ missing_critical_segments FAIL)
      "gate_reasons": []
    },
    "la_musa": { … }
  }
}
```
Nothing under `/orders`. Runs are append-only history of capture quality.

## 7. Rules substrate
Add one admin-only leaf in canonical `xpizza-reference/database.rules.json` (functions copy gitignored, synced by `check:rules`):
```jsonc
"ready_time_quality": { ".read": false, ".write": false }
```
Mirror byte-equal; `check:rules` green. (Dispatcher-readable quality view deferred.)

## 8. Build split, modules, tests

- **Step-1a (buildable now, inert, commit no-deploy):** the Step-0 `nonLabelExclusions` refactor (behavior-preserving) + the pure `ready-time-quality.js` (`isMonitorPopulation`, `rushProxyLoad`, `loadBucket`, `computeQualityMetrics`, `isCaptureAcceptable`, percentile) + the `ready_time_quality` rules leaf + golden tests.
- **Step-1b (separate gate):** the observer runner (offline-replayable first — zero prune-risk; immutable log ⇒ deterministic replay; scheduled-fn wrapper later on its own gated deploy) with an **emulator proof it writes ONLY `ready_time_quality/**`** (assert no `/orders`, `/order_tracking`, task, or notification write) + create-only-transaction idempotency proof.

`ready-time-eligibility.test.js` additions: `nonLabelExclusions` in isolation (epoch/phone/order only, no label reasons); `isTrainingEligible` output unchanged (all 31 still green).

`ready-time-quality.test.js`:
- **population (fold #1):** a missed-tap order (has OFD event, no `ready_at`) is INCLUDED; a pre-epoch / denylisted order EXCLUDED; an impossible-timeline row is INCLUDED (counted, not filtered).
- **population missing-stamp (fold A):** an order with a numeric `to:'new'` **event** but absent/non-numeric `timeline.new_at` is **INCLUDED** and counted in `new_at_missingness`; its hour bucket is taken from the event `at` (not the missing stamp); `high_new_at_missingness` fires when the share exceeds the bound.
- **non-kitchen-path gate (fold B):** a restaurant where most terminals are direct `new→delivered` → `non_kitchen_path_excess` fires; a path listed in `cfg.cleanup_paths` is exempted from the share.
- **tap_rate + kitchen-path (fold #9):** kitchen-path misses counted; a `new→delivered` cleanup lands in `n_non_kitchen_path`, NOT the primary rate.
- **rush proxy (fold #8):** `max` across new/preparing/ofd loads; OFD-only load used when prep-start lower; none present → `unknown_load`.
- **rush_bias (folds #4,5,6):** misses concentrated in the top bucket → `rush_bias<1` + `rush_biased_capture`; single populated bucket → `insufficient_load_coverage`; top bucket `n<min_bucket_n` → `insufficient_load_bucket`; contrast uses lowest *sufficient* bucket not overall; `top_tap_rate` floor fires independently.
- **unknown_load (fold #7):** share over threshold → `unknown_load_excess`.
- **verdict guards:** `unsigned_thresholds` (fold #2) with no version/approved_at; `non_finite_metric`/`empty_denominator` on `0/0`, `Infinity`, `null` (fold #3).
- **per-segment (fold #11):** a restaurant with a failing critical segment → restaurant `capture_acceptable:false` even if the average passes; `out_of_scope` critical segment doesn't block.
- **critical_segments fail-closed (fold C):** missing `critical_segments`, empty, or all-`out_of_scope` for an active restaurant → `missing_critical_segments` (fail); ≥1 in-scope passing + all in-scope passing → pass.
- **dwell/impossible:** `tapped_sane_ready_to_ofd_ms` percentiles + `n`; impossible rate via real `timelineSanity`, `<2`-stamp rows excluded from its denominator.
- **idempotency + staleness (folds #12, D):** `runId` = hash(input_hash + config_hash) — a run with the SAME joined input no-ops; a run where **late events changed the join** produces a DIFFERENT `runId` (new run, not a stale no-op); an unsettled window (`to_ms > now − settle_lag`) is not written as a gate-authoritative run. Unit-tested at the pure hash + transaction-fn level.
- **bucketing:** UTC−6 straddle-midnight; per-restaurant isolation.

## 9. Open questions this step RESOLVES / items for sign-off
- **Resolves** (once run on live data): is "Listo" reliable (tap_rate); rush-biased (rush_bias, top_tap_rate); is `preparing_at` trustworthy (missingness + impossible edges); the `ready→pickup` dwell.
- **Sign-off:** the §5 default thresholds **and their signature** (`version`/`approved_at`); `min_segment_n`/`min_bucket_n`/`max_unknown_load_share`/`max_new_at_missingness`/`max_non_kitchen_path_share`/`settle_lag_ms`; load-bucket edges; **signed non-empty `critical_segments` per active restaurant**; `cleanup_paths` classification; runner offline-first (rec) vs scheduled-fn.

## 10. Gate flow (unchanged)
Executor propose-first (this doc, rev-3) → advisor read-only verify (pure core reuses Step-0 predicates; Step-0 refactor behavior-preserving; runner observer-only) → Codex Round-3 (thread 019f2b87) → build Step-1a (commit, NO deploy) → build-gate → runner Step-1b on its own emulator-proof gate.
