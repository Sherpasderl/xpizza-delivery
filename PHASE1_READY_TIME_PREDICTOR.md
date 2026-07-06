# Phase 1 — Ready-Time Predictor (propose-first design / executor blueprint)

_Status: DESIGN rev-3 — aligned via advisor↔owner 2026-07-03, Codex design-gate R1 (15 findings) + R2 (6 execution
hazards) folded. NOT built. EXECUTOR session builds; advisor gates (read-only + Codex) each step. Governance unchanged.
Sequenced under ASSIGNMENT_OPTIMIZATION_ROADMAP.md Phase 1 (rev-3 here supersedes that paragraph). Phase 0 LIVE._

## The unblock: how "food ready" is captured

The target is the **true food-ready moment**, which wasn't reliably observed (kitchen skipped "Listo"; pickup =
ready + driver-wait). **Owner decision 2026-07-03:** kitchen staff are **ops-enforced to tap "Listo" as the last
motion of finishing an order** → `ready_at` (`btn-listo → status 'ready' → order_timelines/{id}/ready_at`) is the
ground-truth label. **"Listo" is NOT wired to the driver app** (must never delay a pickup). A KDS overdue-nudge
sustains the habit.

**But `ready_at` is a human-entered, first-entry-preserved stamp (`index.js:2576` keeps the first `ready` even across
bounces) — treat it as noisy ground truth, not gospel.** Hence the label-validity + data-quality machinery below.

## Target definition
- **Serve:** `predictReadyAt(order)` predicts from **`new_at`** (known at order creation) → expected `ready_at`.
- **Train/eval BOTH** `ready_at − new_at` AND `ready_at − preparing_at`, and carry `preparing_at − new_at`
  (queue-accept latency) as an explicit feature/diagnostic — `ready − new` mixes prep with acceptance lag; `ready −
  preparing` is the cleaner prep signal when `preparing_at` is present (KDS "En preparación", `index.html:1142`).
- **Timeline-sanity filter (mandatory):** accept a label row only if `new_at ≤ preparing_at? ≤ ready_at ≤
  out_for_delivery_at?` (missing intermediate stamps allowed; ordering violations quarantined). The KDS maps
  `out_for_delivery`→"Listo" (`index.html` catch-all ~1122), so a late/batch tap can yield `ready_at >
  out_for_delivery_at` — those rows are **quarantined**, not trained on.

## Build sequence (corrected — substrate & data-quality BEFORE the nudge/predictor)

**Step 0 — schema + eligibility + filters (no user-visible change).**
- Write targets: **`order_predictions/**` and `prediction_logs/**` ONLY. NEVER `/orders/**`** (order-level triggers
  exist — `materializeOnConfirm` ~`index.js:1357`, `allocateFacturaOnSale` ~`:1388`, `autoAssignOnOrderCreate` ~`:3224`
  — so any `/orders` write risks live behavior).
- `isTrainingEligible(order, timeline, events)` — a concrete shared predicate: exclude test phones, QA-bypass orders,
  sandbox amounts, test drivers, `pending_payment`, and timeline-sanity failures. Golden-tested.
- Feature-extraction contract: creation-time features come from the **immutable `to:'new'` `order_events` row**
  (`kitchen_load_ahead`, `drivers_*`) — **never recomputed from current `/orders`**.

**Step 1 — data-quality monitor (gates everything downstream).**
- Track per restaurant × hour: **"Listo" tap rate, `ready→pickup` median, impossible-timeline rate, missingness.**
- Misses are **NOT missing-at-random** — they cluster under rush, exactly where prediction matters. Training/nudge-
  graduation is **gated on this monitor** showing acceptable, non-rush-biased capture. Observer-only.

**Step 2 — v0 KDS overdue nudge (kitchen-facing).**
- Beep + flash a card that is `status==='preparing'`, `ready_at` unset, and age past the threshold.
- **Eligibility computed ONLY from canonical Firebase status + `order_timelines` stamps — NEVER from the rendered
  class / column / `localState`** (`index.html` render assigns "listo" to every non-nuevo/non-prep status ~1122; column
  placement is `localState||estado` ~1222 — both are display state, unsafe as logic inputs). Requires a NEW read-only
  read of `order_timelines/{id}/preparing_at` into the KDS; **fallback to `created_at`-age if `preparing_at` absent.**
- **Threshold config is MANDATORY per-restaurant** — RTDB `config/ready_time/{restaurantId}/prep_threshold_min`, read
  by the KDS (host-derived `KDS_RESTAURANT_ID`, `order-filter.js:21`). **Fail-closed default** (a conservative constant,
  e.g. 25 min) when the key is unset — never nudge-spam on a missing/misread config. Owner/ops-tunable. **Tests for both
  host mappings** (x_pizza + la_musa).
- v0 = per-restaurant constant; graduates to `predictReadyAt` only after Step 4 beats baseline.
- **HARD CONSTRAINT:** additive only; KDS rendering/behavior **byte-identical both restaurants** except the beep/flash.

**Step 3 — shadow predictor + prediction-logging.**
- **Prediction trigger:** fires off the **`order_events/{orderId}/{eventId}` write where `to==='new'`** — NOT a
  `/orders/{id}/status` trigger, which races `logOrderLifecycle` (`index.js:2537`) and could read features before the
  event row exists. Creates ONE immutable prediction at **`order_predictions/{orderId}/{modelVersion}`** (multi-version
  shadows allowed; each node immutable; transactional create → idempotent against bounces/retries).
- **Actual trigger:** a separate observer on the **`order_timelines/{orderId}/ready_at` creation** copies that exact
  stored timestamp into `prediction_logs/{orderId}` **once** — never from `/orders/status==='ready'` (which can differ
  from the first-entry label).
- v1 = per-restaurant rolling-median heuristic (buckets: hour-of-day × `kitchen_load_ahead`-bucket × item-count-bucket
  **x_pizza only**); per-restaurant constant cold-start. v2 (learned) = its own design later.
- **Emulator test proving NO writes to `/orders`, `/order_tracking`, driver tasks, or notifications.**

**Step 4 — offline eval (segmented).**
- Replay on the immutable `order_events`/`order_timelines`. **Not aggregate MAE alone** — segmented holdout by
  restaurant × hour × order-type × kitchen-load × missingness-cohort, plus calibration + error-percentiles. A
  median-by-hour model can beat a constant on average while being worse in rushes — the segments catch that.

**Deferred out of Phase 1 v1:**
- **Driver-wait backfill (E):** `arrived_at_restaurant_at` is a **driver-level MUTABLE field** (`index.js:2280`) —
  stacked orders / later arrivals overwrite it before a join. If built, it needs **immutable per-order arrival capture**
  (stamp on the pickup task/order, or arrival events keyed by task/order), and rows stay a **separate censored/weak-label
  set with their own metrics**, never mixed into primary training until bias is quantified. Deferred until the enforced
  signal's reliability is measured (Step 1).
- **Customer-facing ETA:** invisible until the predictor is proven; then Phase 1.x, off the validated model.

## la_musa feature parity
la_musa omits `order.items` (external_pos, `index.js:494/1401`). **Restaurant-specific feature schemas are explicit;
NO cross-restaurant bucket comparison unless the feature exists with the same meaning.** Do not parse `items_text` as
a proxy in v1.

## Gate flow (unchanged)
Each step: executor propose-first → advisor read-only verify (KDS byte-identity both restaurants; observer-only /
no-`/orders`-write for the predictor) → Codex adversarial → gated deploy. KDS deploy is per-folder Netlify, explicit
`--site` per KDS site.

## Remaining open questions
1. Whether `preparing_at` is reliable enough to be a feature — the Step-1 data-quality monitor answers this empirically.
