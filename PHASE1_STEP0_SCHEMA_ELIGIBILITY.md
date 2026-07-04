# Phase 1 · Step 0 — schema + eligibility + filters (propose-first design)

_Status: PROPOSED · **rev-3** — Codex R2 confirmed 6/7 R1 folds solid; this rev folds the 2 remaining refinements. For advisor read-only + Codex Round-3 (same thread) BEFORE any code._
_Sequenced under `PHASE1_READY_TIME_PREDICTOR.md` (rev-3, Codex design-gated). Phase 0 substrate is LIVE (`e995285`, `logOrderLifecycle`, 30→31)._
_Prime directive (inherited): additive + observer-only. Step 0 introduces **no Cloud Function, no trigger, and no deploy that changes behavior** — pure code (golden-testable modules) + a rules-substrate addition. It MUST NOT change any X. Pizza / La Musa behavior. Proven by golden tests + the rules equality gate._

### rev-3 changelog (the 2 R2 refinements)
- **§2e no longer drags Step 4 in early** — the zero-row contract is now enforced by a **pure Step-0 helper `assertNonzeroEligibleCounts(counts, activeRestaurants)`** (throws a structured failure on any active restaurant with zero rows), golden-tested in Step 0. Step 4's harness merely calls it. No ETL/eval machinery is built in Step 0.
- **`extractLabels` guards each delta by its OWN endpoint pair only** — `accept_latency_ms = preparing_at − new_at` is independent of `ready_at`, so `preparing_at > ready_at` nulls **only** `prep_ms_from_preparing`, never `accept_latency_ms`. Module logic + test contract corrected.

### rev-2 changelog (the 7 folds)
1. **Zero-rows is an error, not a pass** — new §2e contract: ETL/eval MUST hard-fail + report per-restaurant eligible-row counts on any zero-row restaurant. Fail-closed can no longer look "green but empty."
2. **Phone key = exact `normalizePhone` output** — reuse the *exported* `whatsapp.js` `normalizePhone` (verified output: **digits-only, no `+`**, 504-prefixed; `+50493736607`→`50493736607`). Config keys fixed to that form; null-safe. Not forked.
3. **`no_new_label` gate** — R2b requires numeric `timeline.new_at` (the label anchor / prep denominator); `to:'new'` event presence is used only for predictability + provenance.
4. **Deterministic first-event pick** — select the `to:'new'` event by `(at, eventId)` ascending with a documented tie-break; events with non-numeric/missing `at` are quarantined.
5. **`extractLabels` self-guards** — negative/out-of-order deltas return `null` + a `label_issues` reason, even if called without `timelineSanity`.
6. **`modelVersion` is path-safe** — constrained to `/^[A-Za-z0-9_-]{1,64}$/` (rejects RTDB-forbidden `. $ # [ ] /`); golden-tested rejection; the Step-3 writer refuses invalid.
7. **Post-epoch gap is a gate, not just prose** — §2c/§7: before any *trained* model consumes post-epoch rows, require EITHER the durable `training_exclude` marker (deferred companion) OR an owner-reviewed post-epoch denylist audit.

---

## 0. Scope — what Step 0 delivers (and pointedly does NOT)

Step 0 is the **substrate + data contracts** the predictor (Step 3) and eval (Step 4) will consume. It ships **inert artifacts only**:

1. **Schema definitions** for `order_predictions/{orderId}/{modelVersion}` and `prediction_logs/{orderId}` — documented here; **no writer is built in Step 0** (Step 3 writes them).
2. **Rules substrate** — add `order_predictions`, `prediction_logs`, `ready_time_config` as admin-only `{".read": false, ".write": false}` (mirrors `order_events`/`order_timelines` at `database.rules.json:87-88`), in BOTH `xpizza-functions/database.rules.json` and the `xpizza-reference/` mirror (the equality gate).
3. **Two PURE modules** (extract-then-golden pattern, exactly like `order-lifecycle.js`; no db, no I/O):
   - `ready-time-eligibility.js` → `isTrainingEligible(order, timeline, events, cfg)` + `timelineSanity(timeline, cfg)` + `isValidModelVersion(v)` + `assertNonzeroEligibleCounts(counts, activeRestaurants)` (the §2e zero-row guard)
   - `ready-time-features.js` → `extractCreationFeatures(events, order, timeline)` + `extractLabels(timeline)`
   - **Phone normalization is REUSED, not re-authored:** `require('./whatsapp').normalizePhone` (verified import-safe under bare `node`; verified output form). No new normalizer module. _(If the coupling to whatsapp.js's module graph is later judged undesirable, the clean home is a single-source pure extraction that BOTH whatsapp.js and eligibility import — a separate refactor gate, out of Step 0 to keep Step 0 inert.)_
4. **The zero-rows ETL/eval contract** (§2e) — a written precondition Step 4 MUST honor.
5. **Golden tests** (`*.test.js`, `node`-run, no emulator) pinning every predicate, filter branch, and validator.

**NOT in Step 0:** the `predictReadyAt` trigger (Step 3), the actual-logger trigger (Step 3), the KDS nudge (Step 2), the data-quality monitor (Step 1), any deployed function, any customer-facing surface. No file under `/orders/**` is touched. No functions deploy is requested.

**Behavior-preservation is trivial for Step 0:** the modules are pure and imported by nothing that runs in prod yet; the only prod-adjacent change is three rules leaves granting *no* new access (`false`/`false`). Gate: golden tests green, `check:rules`/`test:rules` green, `diff xpizza-functions/database.rules.json xpizza-reference/database.rules.json` empty.

---

## 1. Schema — `order_predictions/{orderId}/{modelVersion}` (immutable, Step 3 writer)

One immutable node per (order, model version). Multi-version shadows coexist under the same order. Written by a transactional create (only-if-absent) → idempotent against event-bounces/retries.

**`{modelVersion}` is a path key** → MUST satisfy `isValidModelVersion(v)`: `/^[A-Za-z0-9_-]{1,64}$/`. This rejects the RTDB-forbidden characters `. $ # [ ] /` (and empty / >64), which would silently corrupt or fork the path. The Step-3 writer calls `isValidModelVersion` and **refuses to write** (logs + returns) on failure — never constructs a bad ref.

```jsonc
order_predictions/{orderId}/{modelVersion} = {
  "model_version":       "v1",              // == the {modelVersion} path key; matches isValidModelVersion
  "restaurant_id":       "x_pizza",         // normalized; from the to:'new' event row
  "new_at":              1751430000000,     // label ANCHOR (ms) = order_timelines/{id}/new_at (numeric, first-entry)
  "predicted_prep_ms":   1080000,           // the model output: expected (ready_at − new_at) in ms
  "predicted_ready_at":  1751431080000,     // = new_at + predicted_prep_ms (convenience; derivable)
  "features":            { /* see §3 — the EXACT immutable snapshot the prediction was made from */ },
  "source_event_id":     "-Nabc123…",       // push id of the CHOSEN to:'new' order_events row (provenance, §3)
  "created_at":          1751430000500      // ServerValue.TIMESTAMP when the prediction node was written
}
```

Notes:
- **`features` is snapshotted into the node** so a prediction is self-contained and reproducible even if the event schema evolves. Provenance is pinned by `source_event_id`.
- **No `/orders` field is written.** The node lives under a NEW admin-only top-level tree.
- Immutability is enforced by the writer (transaction: write only if the `{modelVersion}` child is `null`), NOT by rules (admin SDK bypasses rules). A Step-3 writer invariant.

## 1b. Schema — `prediction_logs/{orderId}` (the ACTUAL label sink, Step 3 writer)

One node per order, written **once** from the `order_timelines/{orderId}/ready_at` **creation** (the exact stored first-entry timestamp — never from `/orders/status==='ready'`, which can differ from the first-entry label).

```jsonc
prediction_logs/{orderId} = {
  "restaurant_id":   "x_pizza",
  "new_at":          1751430000000,   // copied from order_timelines/{id}/new_at (join anchor)
  "actual_ready_at": 1751431020000,   // copied ONCE from order_timelines/{id}/ready_at at its creation
  "logged_at":       1751431020200    // ServerValue.TIMESTAMP
}
```

- **Predictions and actuals are kept in separate trees and JOINED by `orderId` at eval** (Step 4). We do NOT copy predictions into `prediction_logs` or vice-versa — mirrors Phase 0's "everything else is joined, not copied."
- **`isTrainingEligible` is NOT stored** in either tree. It is computed at ETL/eval time from the immutable `orders`⋈`order_timelines`⋈`order_events` join, so the predicate can evolve without rewriting history. (This is why Step 0 ships it as a pure, versionable module.)
- `actual_prep_ms = actual_ready_at − new_at` is derived at eval, not stored.

---

## 2. `isTrainingEligible(order, timeline, events, cfg)` — the shared predicate

Returns a **structured verdict**, not a bare boolean, so eval can bucket exclusion reasons (Step 4 segments by missingness-cohort):

```
{ eligible: boolean, reasons: string[] }   // eligible === (reasons.length === 0)
```

### 2a. Reliable, code-only exclusions (deterministic from order/timeline/events)

| # | Rule | Reason string | Rationale |
|---|------|---------------|-----------|
| R1 | Not predictable: no `to:'new'` event with a numeric `at` exists | `never_new` | No creation-time feature row ⇒ can't have produced a prediction. Uses event presence for **predictability/provenance only**. |
| R2 | No target label: `timeline.ready_at` absent/non-numeric | `no_ready_label` | The target is `ready_at`. Drops cancelled-before-ready, abandoned, in-progress **without** guessing. |
| **R2b** | **No label anchor: `timeline.new_at` absent or non-numeric** | `no_new_label` | `new_at` is the label anchor **and** the prep denominator. A `to:'new'` event can exist while the first-entry `new_at` stamp is missing/corrupt — that row is unusable even though R1 passed. _(fold #3)_ |
| R3 | Timeline-sanity violation (see §4) | `timeline_sanity:<edge>` | Ordering violation ⇒ untrustworthy label ⇒ quarantine. |
| R4 | Non-positive prep: `ready_at − new_at ≤ 0` | `nonpositive_prep` | Zero/negative prep is impossible; guards same-ms/clock artifacts. |
| R5 | Implausible prep: `ready_at − new_at > cfg.max_plausible_prep_ms` (fail-closed default **3 h**) | `implausible_prep` | Batched/forgotten "Listo" taps produce hours-later labels; quarantine, don't train. |

### 2b. Config-driven exclusions (ops-maintained; additive; NEVER under `/orders`)

Because **QA-bypass, sandbox, and test-driver orders write no durable marker** (verified — §2c), retroactive per-order detection is impossible. The robust, honest substitute is an **explicit, ops-maintained exclusion registry** read at ETL/eval time:

| # | Rule | Reason | Source key |
|---|------|--------|-----------|
| R6 | `new_at < cfg.epoch_start_ms[restaurant_id]` | `before_epoch` | Per-restaurant go-live cutoff. **One cutoff drops the entire pre-launch synthetic population** (x_pizza & la_musa went live on different dates). |
| R7 | `normalizePhone(order.customer_phone)` ∈ `cfg.excluded_phones` | `excluded_phone` | Ops/staff/QA test numbers. `normalizePhone` is the **reused exported** `whatsapp.js` fn; a `null` result (invalid phone) matches nothing (no crash, no exclusion). Empty set ⇒ excludes nothing. _(fold #2)_ |
| R8 | `order.order_id` ∈ `cfg.excluded_orders` | `excluded_order` | Named known test/dress-rehearsal orders (e.g. `PZX-260702-145122`, `/tmp/mh-seed*` set). |

`cfg` is read (admin SDK) from an **admin-only** config subtree at ETL/eval time — a NEW top-level `ready_time_config` `{".read": false, ".write": false}` node (so staff phone numbers are NOT exposed to the `auth != null`-readable `config` tree). Shape — **note the phone keys are digits-only, no `+`** (exact `normalizePhone` output):

```jsonc
ready_time_config = {
  "max_plausible_prep_ms": 10800000,
  "epoch_start_ms":  { "x_pizza": 0, "la_musa": 1751432400000 },   // owner sets real go-live ms
  "excluded_phones": { "50493736607": true, "…": true },           // normalizePhone output form (no '+')
  "excluded_orders": { "PZX-260702-145122": true }
}
```
Fail-closed: a **missing `ready_time_config`** ⇒ conservative built-in defaults (`max_plausible_prep_ms=3h`, `epoch_start_ms={}` treated as `+Infinity` per restaurant so **nothing is eligible until the owner sets a real epoch**). No epoch configured ⇒ zero training rows, by design — **and §2e makes zero rows a hard error, so this can't hide as a healthy-looking empty run.**

> **Note — Step 2's KDS threshold is separate.** The blueprint's `config/ready_time/{restaurantId}/prep_threshold_min` stays under the existing `auth`-readable `config` tree (the KDS client must read it). Only the **training** exclusion registry (which contains phone numbers) lives in the admin-only `ready_time_config`. Two consumers, two visibility needs.

### 2c. Honest residual limitation — now bounded by a gate _(fold #7)_

A QA-bypass or sandbox-charged order created **after** the epoch, with a **real-looking phone not on the denylist**, is **NOT auto-excludable** — the DB carries no marker (`CLOSED_BYPASS_ENABLED` sets only a client session flag `la-musa-orders/index.html:1503,1510`; sandbox mode is server-env only, `pixelpay-config.js:49`, never stamped on the order; test drivers have no flag). Mitigations, in order of leverage:
- **(a)** the epoch cutoff removes the entire pre-launch test mass — the dominant contaminant today;
- **(b)** the phone/order denylists catch known post-epoch stragglers;
- **(c) durable marker (RECOMMENDED forward companion — separate gate, touches `/orders`):** stamp `training_exclude: true` on the order when the closed-hours bypass fires or when `PIXELPAY_MODE!=='production'`, so future test orders self-identify and R-series gains a reliable `qa_marked` rule.

**Bounding gate (hard precondition, not prose):** before any *trained* model (Step 4 graduation onward) is allowed to consume **post-epoch** rows, the gate REQUIRES **either** (c) the durable `training_exclude` marker is live, **or** an **owner-reviewed post-epoch denylist audit** has been signed off for the training window. Until one holds, post-epoch rows may be logged/replayed but **must not graduate a model**. This closes the "one real-phone staff order silently poisons training" hole.

### 2d. Signature / ordering
```
isTrainingEligible(order, timeline, events, cfg) → { eligible, reasons[] }
```
- Pure; inputs are plain objects (ETL/eval supplies them from the immutable join). No db reads inside.
- Rules R1…R8 evaluated with **all** failing reasons collected (not short-circuited) so eval can attribute exclusions.
- `restaurant_id` normalized once (legacy/no-id ⇒ `x_pizza`, mirroring `order-lifecycle.js:25`).

### 2e. Zero eligible rows is an ERROR, not a pass _(fold #1)_

A fail-closed default that yields zero rows is *safe* but looks identical to a healthy empty pipeline — a silent failure mode. **Step 0 ships the guard as a PURE helper so the contract is enforceable and tested WITHOUT building any Step-4 ETL machinery** (the harness that computes `counts` is Step 4; Step 0 only provides — and pins — the assertion it must call):

```
assertNonzeroEligibleCounts(counts, activeRestaurants)
  // counts: { [restaurant_id]: eligibleRowCount }   (produced by the Step-4 harness)
  // activeRestaurants: string[]                       (explicit input, never inferred)
  // → returns { ok: true, counts } if every active restaurant has count > 0
  // → THROWS a structured Error (name/code + { restaurant_id, count } offenders + the full counts)
  //    if ANY active restaurant is missing from counts or has count === 0
```
Contract binding Step 1 (monitor) and Step 4 (eval/ETL): the harness MUST compute per-restaurant eligible-row counts (plus the exclusion-reason histogram) and **call `assertNonzeroEligibleCounts` before emitting any success** — so it can never emit a "green" result on an empty set, and "we intended zero rows" (no active restaurant listed) is impossible to confuse with "the filter silently ate everything" (an active restaurant at zero → throw). Because the guard is pure, Step 0 golden-tests it directly; the Step-4 harness just wires real counts into it.

---

## 3. Immutable `to:'new'` feature-extraction contract

`extractCreationFeatures(events, order, timeline) → { features, source_event_id } | null`

- **Ephemeral congestion/supply features come ONLY from the CHOSEN `to:'new'` `order_events` row. Never recomputed from current `/orders`.**
- **Deterministic selection _(fold #4)_:** among rows with `to==='new'`, keep only those whose `at` is a finite number (others are **quarantined** — logged, not used); pick the **minimum by the tuple `(at, eventId)`** — `at` ascending, ties broken by lexicographic `eventId` (push ids are already time-sortable, so this is a stable, documented total order). This matches first-entry-timeline semantics; a later dispatcher-induced re-`new` never wins.
- Returns `null` if no `to:'new'` row with a numeric `at` exists (⇒ not predictable; Step 3 skips prediction).
- **Stable order-composition features are joined from `/orders` and frozen into the snapshot** (read once at prediction time; `order.items` is immutable post-creation) — a one-time snapshot, not a live recompute.
- **Temporal features** derived from `timeline.new_at` in **fixed America/Tegucigalpa (UTC−6, no DST)** — NOT server-local — so hour-of-day buckets are stable across function regions.

### Per-restaurant feature schema (explicit; NO cross-restaurant bucket comparison unless the feature exists with the same meaning — blueprint §la_musa parity)

| feature | source | x_pizza | la_musa |
|---|---|---|---|
| `kitchen_load_ahead` | chosen event row | ✅ | ✅ |
| `drivers_available` | chosen event row | ✅ | ✅ |
| `drivers_on_shift` | chosen event row | ✅ | ✅ |
| `hour_of_day` (0–23, UTC−6) | derived from `new_at` | ✅ | ✅ |
| `day_of_week` (0–6, UTC−6) | derived from `new_at` | ✅ | ✅ |
| `item_count` | `order.items.length` | ✅ | **`null`** (external_pos, no `items` — `index.js:494/1401`; do **not** parse `items_text`) |
| `accept_latency_ms` | `preparing_at − new_at` | ✅ diagnostic | ✅ diagnostic |

`accept_latency_ms` is `null` when `preparing_at` absent (or when the pair is out-of-order — see self-guard). Carried as a diagnostic (queue-accept lag), consistent with training BOTH `ready−new` and `ready−preparing`.

### `extractLabels(timeline)` — self-guarding, per-pair _(fold #5 · refined R2)_
Returns `{ new_at, preparing_at, ready_at, out_for_delivery_at, prep_ms_from_new, prep_ms_from_preparing, accept_latency_ms, label_issues[] }`.
- Each delta is guarded **only by its OWN endpoint pair** (a violation in one pair must not null an unrelated delta):
  - `accept_latency_ms = preparing_at − new_at` — valid iff `new_at`, `preparing_at` numeric ∧ `preparing_at ≥ new_at`
  - `prep_ms_from_preparing = ready_at − preparing_at` — valid iff `preparing_at`, `ready_at` numeric ∧ `ready_at ≥ preparing_at`
  - `prep_ms_from_new = ready_at − new_at` — valid iff `new_at`, `ready_at` numeric ∧ `ready_at ≥ new_at`
- An invalid pair ⇒ that delta is `null` and a reason is pushed to `label_issues` (e.g. `'neg:prep_from_preparing'`, `'nonnum:ready_at'`). So `preparing_at > ready_at` nulls **only** `prep_ms_from_preparing` — `accept_latency_ms` (independent of `ready_at`) and `prep_ms_from_new` stay valid.
- `extractLabels` thus **never emits a negative/nonsensical delta even if called without `timelineSanity` first** — defense-in-depth. `timelineSanity`/`isTrainingEligible` remain the row-level gate.

---

## 4. Timeline-sanity filter — `timelineSanity(timeline, cfg)`

Accept a label row only if present stamps are monotonically ordered:
```
new_at ≤ preparing_at? ≤ ready_at ≤ out_for_delivery_at?
```
- **Missing intermediate stamps allowed** (`preparing_at` / `out_for_delivery_at` may be absent — compare only present numeric neighbors).
- **Any ordering violation is quarantined** (not repaired). Returns `{ ok, violation }`, `violation ∈ { 'new>preparing', 'preparing>ready', 'new>ready', 'ready>ofd', null }`.
- Load-bearing case: the KDS catch-all maps `out_for_delivery` → "Listo" (`index.html` ~1122), so a **late/batch tap can yield `ready_at > out_for_delivery_at`** → `ready>ofd` → quarantined (= R3).
- Exposed separately so Step 1's data-quality monitor counts the **impossible-timeline rate** using the identical logic.

---

## 5. Rules substrate change (the only prod-adjacent edit in Step 0)

In BOTH `xpizza-functions/database.rules.json` and `xpizza-reference/database.rules.json`, alongside the existing observer trees:

```jsonc
"order_events":     { ".read": false, ".write": false },   // existing
"order_timelines":  { ".read": false, ".write": false },   // existing
"order_predictions":{ ".read": false, ".write": false },   // ADD (Step 3 writer is admin/bypasses rules)
"prediction_logs":  { ".read": false, ".write": false },   // ADD
"ready_time_config":{ ".read": false, ".write": false }    // ADD (admin-only training exclusion registry)
```
Equality gate (Codex #8 pattern): `diff xpizza-functions/database.rules.json xpizza-reference/database.rules.json` empty; `npm run check:rules` + `test:rules` green. No index needed (no query on these trees in Step 0).

---

## 6. Golden test matrix (all `node`-run, no emulator)

**`ready-time-eligibility.test.js`**
- R1: no `to:'new'` event (and one with non-numeric `at`) ⇒ `never_new`.
- R2: `new_at` present, `ready_at` absent/non-numeric ⇒ `no_ready_label`.
- **R2b _(fold #3)_:** valid `to:'new'` event exists but `timeline.new_at` absent → `no_new_label`; `new_at` non-numeric (`"x"`, `null`) → `no_new_label`.
- R3: `ready_at > out_for_delivery_at` ⇒ `timeline_sanity:ready>ofd`; `preparing_at > ready_at` ⇒ `timeline_sanity:preparing>ready`.
- R4: `ready_at === new_at` ⇒ `nonpositive_prep`.
- R5: `ready−new = 4h` ⇒ `implausible_prep`; `= 2h59m` ⇒ clears.
- R6: `new_at` before `epoch_start_ms[restaurant]` ⇒ `before_epoch`; equal/after ⇒ clears; **epoch unset for restaurant ⇒ `before_epoch` (fail-closed)**.
- **R7 _(fold #2)_:** `cfg.excluded_phones` keyed `"50493736607"`; order `customer_phone` of `"+504 9373-6607"`, `"9373-6607"`, `"50493736607"` all normalize to the key ⇒ `excluded_phone`; an invalid phone (`normalizePhone→null`) ⇒ NOT excluded, no throw.
- R8: `order_id` in `excluded_orders` ⇒ `excluded_order`.
- Multi-reason: pre-epoch order with denylisted phone collects BOTH reasons (no short-circuit).
- Clean, post-epoch, sane, real order ⇒ `{ eligible: true, reasons: [] }`.
- `cfg` missing entirely ⇒ built-in fail-closed defaults (nothing eligible until epoch set).
- **`isValidModelVersion` _(fold #6)_:** accepts `"v1"`, `"v2_median-hod"`, 64-char id; rejects `""`, 65-char, and each of `. $ # [ ] /` and whitespace.
- **`assertNonzeroEligibleCounts` _(fold #1, refined R2)_:** all active restaurants > 0 ⇒ `{ ok: true }`, no throw; an active restaurant at `0` ⇒ throws with that restaurant in the offenders; an active restaurant **missing from `counts`** ⇒ throws (treated as zero); a restaurant at `0` that is NOT in `activeRestaurants` ⇒ no throw (intended-empty is explicit). Error carries the full `counts` for the operator.

**`ready-time-features.test.js`**
- **Deterministic pick _(fold #4)_:** two `to:'new'` rows, distinct `at` → earlier chosen; **same-ms `at`** → lexicographically-smaller `eventId` chosen (documented tie-break); a `to:'new'` row with non-numeric `at` is ignored, a later valid one wins; all rows non-numeric `at` ⇒ `null`. `source_event_id` == chosen row's id.
- No `to:'new'` event ⇒ `null`.
- x_pizza order with 3 `items` ⇒ `item_count: 3`; la_musa order with no `items` (but `items_text` present) ⇒ `item_count: null` (and `items_text` NOT parsed).
- `hour_of_day`/`day_of_week` at UTC−6: pin a `new_at` straddling UTC-midnight to prove the fixed offset is applied, not server-local.
- `accept_latency_ms`: present when `preparing_at` set + ordered; `null` when absent.
- **`extractLabels` per-pair self-guard _(fold #5, refined R2)_:** ordered timeline → all three deltas correct, empty `label_issues`; **`preparing_at > ready_at` → ONLY `prep_ms_from_preparing` is `null`** while `accept_latency_ms` and `prep_ms_from_new` stay valid (the key R2 assertion); `ready_at < new_at` → `prep_ms_from_new` AND `prep_ms_from_preparing`(if preparing≥ready still holds, else also) guarded per their own pairs; `new_at > preparing_at` → only `accept_latency_ms` null; non-numeric stamp nulls only the deltas touching it + a `nonnum:` issue. Asserts **no negative delta is ever emitted, and no valid delta is collaterally nulled**.

---

## 7. Open questions for the advisor / owner (resolve at the gate)

1. **Exclusion-signal gap** — accepted approach: epoch-cutoff + explicit denylists + fail-closed default, with the durable `training_exclude` marker deferred to a separately-gated companion **and** the §2c bounding gate blocking post-epoch model graduation until a marker or owner-audited denylist exists. Rec: **yes**.
2. **`ready_time_config` admin-only** (holds staff phones) vs folding into `config`. Rec: **separate admin-only tree**.
3. **Reuse path for `normalizePhone`** — Step 0 uses direct `require('./whatsapp').normalizePhone` (inert, verified import-safe). Single-source pure extraction is a later optional refactor gate. Rec: **direct reuse now**.
4. **`max_plausible_prep_ms` default = 3 h** — sane upper quarantine bound? Owner-tunable.
5. **Epoch values** — owner supplies real per-restaurant `epoch_start_ms` (x_pizza earlier; la_musa 2026-07-02). Until set, fail-closed = no training rows (intended, and §2e surfaces it loudly).

---

## 8. Gate flow (unchanged)
Executor propose-first (this doc, rev-3) → advisor read-only verify (pure modules import nothing prod-live; rules grant no access; reference mirror byte-identical) → Codex Round-3 (same thread) → **commit code + rules, NO deploy**. The predictor/actual-logger triggers and any deploy are Step 3, separately gated._Status update: design APPROVED at rev-3; Step 0 built (2 pure modules + golden tests + 3 rules leaves), committed, NOT deployed._
