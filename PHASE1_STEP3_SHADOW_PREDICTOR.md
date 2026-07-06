# Phase 1 · Step 3 — Shadow ready-time predictor + prediction-logging (propose-first design)

_rev-3 (Codex R1's 13 + R2's 4 findings folded; design-gate APPROVED R3, thread 019f2f75). Sequenced under PHASE1_READY_TIME_PREDICTOR.md (rev-3, locked) +
ASSIGNMENT_OPTIMIZATION_ROADMAP.md Phase 1. Steps 0/1/2 built (ready-time-eligibility.js,
ready-time-features.js, ready-time-quality*.js deployed-inert; KDS nudge live). NOT built — executor
builds, advisor gates (read-only + Codex). **PURE SHADOW: writes ONLY order_predictions, prediction_logs,
ready_time_model — NEVER /orders, /order_tracking, /tasks, /drivers, /dispatcher_alerts, or notifications.**_

## Goal
Serve `predictReadyAt(order)` in production **shadow mode** and log predicted-vs-actual so Step 4 can prove
the model beats the naive constant-prep baseline (segmented) BEFORE it is ever wired into dispatch (Phase 3).
No user-facing or dispatch behavior changes.

## Feature provenance (R1-#1 — corrected)
- **Ephemeral congestion/supply** (`kitchen_load_ahead`, `drivers_available`, `drivers_on_shift`) — come
  ONLY from the immutable `to:'new'` `order_events` row (order-lifecycle.js writes exactly
  `from/to/at/restaurant_id/kitchen_load_ahead/drivers_*`); unrecoverable if not read live.
- **Stable composition** (`item_count`, x_pizza) — the event row does NOT carry it, so it is READ from
  `/orders/{id}` (a READ only — never a write). Stable fields don't change post-creation, so no race.
- **Snapshot** the exact feature vector used into `order_predictions` for provenance (no eligibility flag —
  see #4).

## Two triggers (additive; idempotent; join-safe; neither touches /orders)

### Trigger A — Prediction (on `order_events/{orderId}/{eventId}` create, act only when `to==='new'`)
- **Anchor `new_at` = the `to:'new'` event's numeric `at`** (R1-#2) — do NOT depend on
  `order_timelines/{orderId}/new_at`, which is written in a separate transaction and can lag. The event
  `at` IS the creation instant. **The new bucket helpers derive prediction-time temporal features
  (hour/daypart) from THIS event `at`, NOT from `timeline.new_at`** (R2-#2 — `extractCreationFeatures`
  currently reads `timeline.new_at`; Step 3's prediction path must take an explicit `at` anchor arg).
- **Why this trigger:** a `/orders/status` trigger races `logOrderLifecycle` (index.js:2537) and could read
  features before the event row exists.
- **Idempotency:** transactional create-if-absent at `order_predictions/{orderId}/{modelVersion}`; abort if
  present (immutable — safe against event bounces).
- **Restaurant-aware:** x_pizza → hierarchical bucket model; la_musa → **log-only + constant, no bucket
  model** (R1-#9; external_pos omits `order.items`).
- **Predict — hierarchical fallback (R1-#8, the fleet-size fix):** compute the exact bucket, then back off
  until a level has `≥ MIN_SAMPLES`:
  1. exact `hour × kitchen_load_ahead_bucket × item_count_bucket`
  2. → `daypart × load_bucket` (dayparts, not 24 hours)
  3. → restaurant rolling median (all eligible)
  4. → `coldStart(restaurant)` constant
  Record which level served (`source: exact|daypart|restaurant|cold_start`) + `sample_count`.
- **Write** `order_predictions/{orderId}/{modelVersion}` = `{ predicted_ready_at = new_at +
  predicted_prep_min·60000, predicted_prep_min, bucket_key, source, sample_count, model_version,
  restaurant_id, features_snapshot, created_at }`. **No stored `is_training_eligible`** (R1-#4 — Step 0 says
  eligibility is recomputed at model-update/eval time, not stored). Predictions are made for ALL orders
  (shadow-harmless).

### Trigger B — Actual label + model update (on `order_timelines/{orderId}/ready_at` create)
- Fires on the **first-entry** `ready_at` (index.js:2576 preserves the first `ready`).
- **Join-safe / order-independent, WRITE-ONCE, NO backfill (R1-#5/#6, R2-#3):** for **each version in
  `ACTIVE_MODEL_VERSIONS`** (the single shared source of truth — see model section, R2-#4), transactionally
  write-once `prediction_logs/{orderId}/{modelVersion}`. ALWAYS records the actual (`actual_ready_at`,
  `prep_new = ready_at − new_at`, `prep_preparing = ready_at − preparing_at?`); if that version's prediction
  already exists, also `predicted_ready_at` + `error_min`, else `prediction_missing:true`. **No later
  backfill** — the definitive predicted-vs-actual join is Step-4 eval (which reads both
  `order_predictions` and `prediction_logs`). This keeps the write-once contract clean (resolves the
  R2-#3 contradiction). `new_at` for `prep_new` = the same `to:'new'` event `at`. Never sourced from
  `/orders/status==='ready'`.
- **Gate for the MODEL UPDATE ONLY (reuse ready-time-eligibility.js):** recompute `isTrainingEligible` +
  timeline-sanity (`new_at ≤ preparing_at? ≤ ready_at ≤ out_for_delivery_at?`) HERE (not from a stored
  flag). Ineligible / ordering-violation → log row gets `quarantined:true`+reason, **no model update.**
- **Model update (x_pizza, eligible+sane only) — update ALL fallback levels (R2-#1), retry-safe ring
  (R1-#7):** Trigger A reads exact → daypart/load → restaurant, so Trigger B must MAINTAIN all three or the
  coarser levels stay empty and the fallback is dead (always drops to cold_start). On each eligible label,
  idempotently update the three rings — `ready_time_model/{r}/{v}/exact/{exactKey}`, `…/daypart/{daypartKey}`,
  `…/restaurant`. Each ring node holds `{ samplesByOrder: { <orderId>: { prep_min, at } }, p50, sample_count,
  updated_at }`; the transaction **sets `samplesByOrder[orderId]`** (keyed by orderId → idempotent under RTDB
  retry, no blind append; the SAME orderId contributes one sample per level), keeps the newest `RING_N` by
  `at`, recomputes `p50`. la_musa: **no ring updates** in v1 (log-only + constant).

## The v1 model — hierarchical bounded-ring median
- Per-bucket **last-`RING_N` eligible prep-times → `p50`** (median; outlier-robust vs EWMA-of-mean on
  right-skewed prep). Maintained (O(1) read at predict, raceless) vs query-at-predict or a scheduled batch.
- Hierarchical fallback (above) so a small fleet gets a useful non-cold-start prediction from coarser levels.
- Start `RING_N=30`, `MIN_SAMPLES=5`, config-tunable per restaurant. `modelVersion='v1-hier-ringmed-30'`
  (v2 learned shadows alongside).
- **`ACTIVE_MODEL_VERSIONS` — single shared source of truth (R2-#4):** one constant (v1 = a single-element
  list `['v1-hier-ringmed-30']`) imported by BOTH triggers. Trigger A writes a prediction per active version;
  Trigger B logs per active version. This is how Trigger B knows which version logs to write when Trigger A
  may not have run yet. Adding v2 = appending to this list (both triggers pick it up).

## Invariants (advisor + emulator verify)
1. **Zero writes** to `/orders`, `/order_tracking`, `/tasks`, `/drivers`, `/dispatcher_alerts`, any push/
   notification path, or `config/ready_time/*` (the KDS-read config). Model store is a SEPARATE root
   `ready_time_model/…`.
2. `order_predictions/{orderId}/{modelVersion}` immutable (transactional create-if-absent).
3. `prediction_logs/{orderId}/{modelVersion}` write-once per version; join-safe (no dependency on trigger
   order).
4. Model ring updated ONLY from eligible + timeline-sane rows; ring keyed by orderId (retry-idempotent).
5. la_musa = log-only + constant, no bucket model. Restaurant-specific schemas; la_musa never uses items.
6. `ready-time-features.js` gains explicit bucket helpers (`bucketKeyExact`, `bucketKeyDaypart`, dayparts)
   — **added + golden-tested as part of this step** (R1-#3; currently only `extractCreationFeatures`/
   `extractLabels`/`TZ_OFFSET_MS` exist).

## Rules (R1-#10, #11)
- Add admin-only (server-write, no public read) leaves for `order_predictions`, `prediction_logs`,
  `ready_time_model` to BOTH `xpizza-reference/database.rules.json` (canonical) AND verify the mirror to the
  gitignored `xpizza-functions/database.rules.json` is empty (`npm run check:rules`). Also reconcile the
  pre-existing Step-0 leaves the reference already diverges on (`ready_time_config`, `ready_time_quality`).
- Add a rules test proving the KDS client key **cannot read `ready_time_model/`**.

## Deploy (R1-#12) — an ADD, not a prune
- Two new `onValueCreated` exports → **31 → 33**. Gate with an explicit before/after `exports.*` name list:
  all 31 live names survive + exactly the 2 new names appear (`comm` the deployed set vs source; verify the
  Firebase deploy output shows 2 creates, 0 deletes).

## Build shape (executor)
- Pure `ready-time-predict.js` (hierarchical `predictFromModel`, `ringSetP50`) + bucket helpers in
  ready-time-features.js — goldens.
- Deps-injected core (emulator-drivable), like resolve-manual.js / cancel-order-core.js.
- Two `onValueCreated` triggers in index.js (thin adapters).
- **Emulator F-matrix:** prediction idempotent on event bounce; hierarchical fallback (exact→daypart→
  restaurant→cold_start); ring set-by-orderId + p50 + trim at RING_N + **retry-idempotency (re-run same
  orderId → no dup)**; quarantine on timeline violation (no model update); log-once per version; v1/v2
  coexist; la_musa log-only+constant (no bucket write); **and a denylist API-spy asserting NO write to
  /orders, /order_tracking, /tasks, /drivers, /dispatcher_alerts, push mocks, config/ready_time** (R1-#13,
  the load-bearing shadow guarantee).

## Gate flow (unchanged)
propose-first (this doc) → Codex adversarial design gate → **executor build** → advisor read-only (no-
`/orders`-write proof) + emulator F-matrix + Codex-on-diff → gated ADD deploy (31→33 verified).

## Build note (R3)
Thread a single **event-anchored order object** (carrying `new_at = to:'new' event.at`) through
`isTrainingEligible`, the bucket helpers, and label extraction, so `new_at` is consistently the chosen
event `at` everywhere — never `timeline.new_at`.

## Open questions (executor's call at build; gate-cleared)
1. Daypart boundaries (breakfast/lunch/dinner/late) + load-bucket cut points — pin at v1 or config.
2. `RING_N`/`MIN_SAMPLES` per-restaurant config from day one, or constants until volume grows.
(Backfill question resolved: NO backfill — join at Step-4 eval.)
