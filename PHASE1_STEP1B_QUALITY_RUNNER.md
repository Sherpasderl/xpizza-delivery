# Phase 1 · Step 1b — data-quality-monitor runner (propose-first design)

_Status: PROPOSED · **rev-3** — folds the 2 Codex R2 REVISE items (stale-green from writer + reader sides) + one editorial. For advisor read-only + Codex Round-3 (thread 019f2ba8) BEFORE any code._

### rev-3 changelog (the 2 R2 folds + editorial)
E1. **Aborted runs can't leave stale-green as "latest."** Two-sided: **(a)** every invocation — including a `config_invalid` / `nothing_settled` / `read_budget_exceeded` abort — updates a mutable `ready_time_quality/latest` beacon with its outcome, so the newest outcome reflects the failure, not the last green run; **(b)** an explicit **C1/C2 freshness contract** (`isFreshAuthoritativeRun`, pure) that reader gates MUST honor: `mode==='authoritative'` ∧ `settled===true` ∧ `config_hash`==current ∧ window covers the expected coverage ∧ `computed_at` within max-age ∧ the referenced `runs/{runId}` exists — **absence of a current matching run = FAIL**.
E2. **`activeRestaurants` is derived from signed config, never a caller arg.** Fold #3 (materialize) and #4 (epoch-validate) key off the active set — so it comes ONLY from `ready_time_config.active_restaurants` (missing/empty ⇒ `config_invalid`), is folded into `config_hash`, and can't be narrowed by a caller to skip a restaurant's fail verdict. The omission case is tested.
E3. _(editorial)_ removed the now-resolved "`hashRows` field set" open question from §8 (rev-2's completeness manifest resolved it).

_Below: rev-2 folds (8) retained._

_Status: (rev-2) — folds the 8 Codex R1 REVISE items._
_Sequenced under `PHASE1_STEP1_DATA_QUALITY_MONITOR.md` (rev-3) §6/§8 (Step-1b). Depends on Step-1a (`7224995`): the pure core (`computeQualityMetrics`, `isCaptureAcceptable`, `runIdFor`, `pickNewEvent`, …) is FROZEN and reused unchanged (imported, never copied). Phase 0 substrate LIVE._
_Prime directive: **the first I/O piece** — the gate shifts from "pure + golden" to "prove the side effects are exactly what's claimed." Observer-only: reads the immutable `orders` ⋈ `order_events` ⋈ `order_timelines` join (read-only) + `ready_time_config`; **writes ONLY `ready_time_quality/**`. NEVER `/orders`, `/order_tracking`, driver tasks, or notifications.** NOT a deployed Cloud Function → no prune risk. Proven on this machine's emulator._

### rev-2 changelog (the 8 R1 folds)
1. **Create-only proof exercises the null-first path for real** — the emulator idempotency test runs the rerun in a **fresh app/process** (or an instrumented transaction callback) so the callback actually sees `[null → existingNode]`, and asserts `committed===false` + the existing node **byte-identical** (no overwrite). Guards the `a679797` same-process path-cache landmine.
2. **`hashRows` completeness manifest** — the hash canonicalizes the exact post-window joined rows over **every core-read field**; a dependency-manifest test mutates each field the core reads and requires the hash to change (no metric-affecting field can slip out → no stale no-op).
3. **Empty settled window ≠ pass** — `buildRunNode` **materializes every active restaurant** (missing ⇒ `capture_acceptable:false` + `empty_denominator`/`insufficient_sample`); an all-empty settled window carries an `empty_settled_window` status consumed by C1/C2 as **fail**, never green-by-absence.
4. **Fail-closed window config** — require a finite `settle_lag_ms` (else no authoritative write + explicit error); clamp `requested.from` to `≥ epoch`; missing/invalid active epochs ⇒ no authoritative write + error.
5. **No-`/orders`-write proof spies the API, not just the persisted state** — a `db.ref()` spy records every `set/update/remove/transaction/onDisconnect` path; assert the only mutating prefix is `ready_time_quality/` (catches a same-value write a snapshot-diff would miss).
6. **Bounded reads** — an explicit row/byte/time budget in v1 + a defined indexed/windowed-read migration gate that MUST precede any cron/prod use.
7. **`preview/` isolated from the authoritative collection** — authoritative runs live at `ready_time_quality/runs/{runId}`, previews at `ready_time_quality/preview/{runId}`; C1/C2 read only `runs/` **and** filter `mode==='authoritative' && settled===true` (belt-and-suspenders so a "latest child" reader can't consume a preview).
8. **Import `pickNewEvent`, don't copy** — window selection imports the frozen core's `pickNewEvent` (verified exported); a duplicate-`to:'new'` test proves runner windowing and core bucketing pick the same event.

---

## 0. Scope — what Step-1b is (and is not)

Step-1b is a **thin I/O shell** around the frozen Step-1a pure core. It ships:
1. `scripts/ready-time-quality-run.js` — an **offline-replayable node runner** (admin SDK). Exports pure helpers (`hashRows`, `hashConfig`, `resolveWindow`, `buildRunNode`) + an I/O `main()`. **No metric logic lives here** — it calls `computeQualityMetrics(rows, cfg, thresholds)` from `ready-time-quality.js` unchanged.
2. `ready-time-quality-run.test.js` — golden unit tests for the pure helpers (hash determinism, window/settle resolution, node shape), **no emulator**.
3. The **emulator integration proof** (`test/ready-time-quality-run.emulator.test.js`) — the load-bearing gate artifact: seeds both restaurants + sentinel data under `/orders`, `/order_tracking`, `/tasks`, `/notifications`, runs `main()`, and asserts the side effects (below).

**NOT in Step-1b:** any change to the frozen Step-1a modules; any new Cloud Function or `index.js` export; any deploy; the KDS nudge (Step 2) or predictor (Step 3). **No new rules** — the `ready_time_quality` admin-only leaf already landed in Step-1a; `preview/` lives under it.

## 1. What it does (one pass)

```
main({ now, window?, mode }):        // NOTE: no activeRestaurants arg (E2 — derived from signed config only)
  cfg        ← read ready_time_config            (admin SDK; signed quality_thresholds + active_restaurants live here)
  active     ← cfg.active_restaurants            // signed source of truth; missing/empty → config_invalid
  win        ← resolveWindow(cfg, now, window)   // fail-closed; config_invalid/nothing_settled → ABORT
  if abort:  update ready_time_quality/latest = { status:<abort-reason>, config_hash, mode, computed_at:now, runId:null }  // E1a — no green left as latest
             return
  join rows  ← readJoin(db, win)                 (READ-ONLY: orders, order_events, order_timelines; bounded)
  if read_budget_exceeded: update latest = { status:'read_budget_exceeded', … }; return    // E1a
  metrics    ← computeQualityMetrics(rows, cfg, cfg.quality_thresholds)   // FROZEN core, unchanged
  node       ← buildRunNode(metrics, { active, window:win, input_hash, config_hash, thresholds, now })  // active from cfg
  runId      ← runIdFor(input_hash, config_hash)                          // config_hash includes `active`
  write      ← create-only txn at ready_time_quality/runs/{runId}         // authoritative (or preview/{runId})
  update       ready_time_quality/latest = { status:node.status||'ok', runId, config_hash, window:win, mode, settled, computed_at:now }  // E1a
```
Everything between read and the writes is pure. The runner never mutates anything it reads. The ONLY mutating targets are `ready_time_quality/runs/{runId}` (create-only immutable), `ready_time_quality/preview/{runId}`, and the `ready_time_quality/latest` beacon (a mutable status pointer, the one overwrite) — all under the `ready_time_quality/` leaf.

## 2. Read plan (bounded, read-only)

- Reads `orders`, `order_events`, `order_timelines` and joins by `orderId` into `rows = [{ order, timeline, events }]` — the exact triplet the pure core consumes.
- **Window filter (fold #8):** a row is in-window iff its chosen `to:'new'` event `at` ∈ `[from_ms, to_ms)`, selected by the **imported** frozen `pickNewEvent` (`require('../ready-time-quality').pickNewEvent`) — **never a reimplementation** (else runner windowing could diverge from core bucketing, which also uses `pickNewEvent` for the hour anchor). A duplicate-`to:'new'` golden proves both pick the same event. Epoch/denylist filtering stays the core's `isMonitorPopulation` (inside `computeQualityMetrics`); the runner does **not** re-filter.
- **Bounded reads (fold #6):** v1 enforces an explicit budget — `cfg.read_budget = { max_rows, max_ms }`; exceeding it **aborts with `read_budget_exceeded`** (no partial/misleading run). A full-tree read is acceptable ONLY at current just-launched volume; **a defined migration gate — a windowed/indexed read (e.g. an `order_events` `at`-range index or maintained per-window counters) — MUST land before any cron/prod invocation.** `orders` is the live tree — **read only**, never written.

## 3. Window & settle resolution — `resolveWindow(cfg, now, requested?)` (pure)

Returns `{ from_ms, to_ms, settled, mode }` — **fail-closed (fold #4)**.
- **Config validation first:** the active set comes ONLY from `cfg.active_restaurants` (E2) — **missing or empty ⇒ `config_invalid`** (a caller can't supply it). `cfg.settle_lag_ms` must be a **finite number** and every active restaurant must have a finite `epoch_start_ms`; otherwise `config_invalid` ⇒ **no authoritative write + the `latest` beacon records the failure** (never `to_ms = NaN` silently passing comparisons).
- `from_ms` = `max(requested.from ?? −∞, min epoch_start_ms across active restaurants)` — **requested bounds are clamped to `≥ epoch`** so a caller can't slip the window earlier than go-live.
- **Authoritative mode (default):** `to_ms = min(requested.to ?? now, now − cfg.settle_lag_ms)` — the high-watermark. The window is therefore **always settled** (`to_ms ≤ now − settle_lag`), so late lifecycle events have landed (fold D). If `from_ms ≥ to_ms` (nothing settled yet) → **no run written**, `nothing_settled`.
- **Preview mode (explicit `mode:'preview'`):** `to_ms = now`; `settled=false`; written under **`ready_time_quality/preview/{runId}`** only. C1/C2 never read `preview/` (fold #7, §4).

## 4. Write plan — create-only, idempotent (folds #12, D)

- **`input_hash = hashRows(rows)` — completeness-manifested (fold #2).** Canonicalizes the exact post-window-selection joined rows (sorted by `orderId`) over **every field the core reads**: order `restaurant_id`/`customer_phone`/`order_id`; all `order_timelines` stamps (`new_at`, `preparing_at`, `ready_at`, `out_for_delivery_at`, `delivered_at`); each event's key + `from`/`to`/`at`/`kitchen_load_ahead`. `config_hash = hashConfig(cfg)` covers `active_restaurants` (E2)/`epoch_start_ms`/`excluded_phones`/`excluded_orders`/`cleanup_paths`/`critical_segments`/`quality_thresholds`/`settle_lag_ms`. A dependency-manifest test mutates each of these and requires the hash to flip — so no metric-affecting change can keep the same `runId` (no stale no-op).
- `runId = runIdFor(input_hash, config_hash)` (frozen pure fn).
- **Write paths (fold #7):** authoritative → `ready_time_quality/runs/{runId}`; preview → `ready_time_quality/preview/{runId}`. Physically separate sub-collections so a "latest child of `runs/`" reader can never see a preview; C1/C2 helpers additionally filter `mode==='authoritative' && settled===true`.
- **Create-only transaction:** `ref.transaction(cur => cur === null ? node : undefined)` — admin SDK bypasses rules, so the transaction is the *only* immutability enforcement. Identical-input rerun no-ops (the callback sees `null → existingNode`, `committed===false`); a changed join (late events → new `input_hash`) yields a **new** `runId` (no stale overwrite, no stale no-op).
- **`node` shape — every active restaurant materialized (fold #3, E2).** `buildRunNode(metrics, { active, … })` — where `active` is `cfg.active_restaurants`, NOT a caller arg — fills any active restaurant absent from `metrics.restaurants` with `capture_acceptable:false` + `gate_reasons:['empty_denominator']` (or `insufficient_sample`), and sets a top-level `status:'empty_settled_window'` when **all** active restaurants are empty. C1/C2 consume that status as **fail** — a settled window with no rows can never read green-by-absence. Otherwise the shape matches §6 of the Step-1 design (per-restaurant + per-segment metrics + verdicts + `window.settled` + hashes + signed `thresholds`).

### 4a. The C1/C2 freshness contract — `isFreshAuthoritativeRun(latest, expected)` (pure, E1b)
Reader gates (C1 post-epoch, C2 graduation) MUST NOT "read the newest `runs/` child" naively — a stale green would pass. Instead they read `ready_time_quality/latest` and call this pure checker; **any** miss ⇒ FAIL (fail-closed):

```
isFreshAuthoritativeRun(latest, { now, config_hash, coverage, max_age_ms }) → { fresh, reasons[] }
  fails with:  no_latest_run            (latest absent)
               run_not_ok               (latest.status !== 'ok' — an abort/empty_settled_window beacon)
               not_authoritative        (latest.mode !== 'authoritative')
               not_settled              (latest.settled !== true)
               config_hash_mismatch     (latest.config_hash !== current config_hash)
               coverage_shortfall       (latest.window does not cover the expected [from,to])
               stale                     (now − latest.computed_at > max_age_ms)
```
So a failed/aborted run (beacon `status !== 'ok'`) and a run under an old config or an out-of-date window both read as **not fresh ⇒ gate FAIL**. Belt-and-suspenders with E1a: the writer never leaves green as latest, and the reader refuses anything that isn't a current, settled, authoritative, covering run.

## 5. The three build-gate proofs (this is what Step-1b must earn)

### 5a. No-`/orders`-write discipline — API spy, not just state diff (fold #5)
Snapshot-diff alone proves persisted equality, not that no mutating call was *made* (a same-value `set` passes a diff). So the emulator test **wraps `db.ref()`** and records the path of every mutating call — `set` / `update` / `remove` / `transaction` / `push` / `onDisconnect` — then asserts the **only** mutating prefix observed is `ready_time_quality/`. Belt-and-suspenders: it also seeds sentinels under `/orders/*`, `/order_tracking/*`, `/tasks/*`, `/notifications/*`, snapshots each before/after `main()`, and asserts **byte-identical**. Static backing: the runner's sole mutating target is `ready_time_quality/...`; every other ref is `.once('value')`.

### 5b. Create-only idempotency + staleness — exercise the null-first path for real (fold #1)
The `a679797` landmine: a **same-process** rerun can hit RTDB's cached path, so the transaction callback never sees `[null, existingNode]` and the "no-op" isn't actually exercised. So the rerun runs in a **fresh app/process** (or with an instrumented transaction callback that records its `(currentValue)` call sequence). Assertions: (1) run → `ready_time_quality/runs/{runId}` created + `latest` points at it with `status:'ok'`; (2) rerun (fresh process) → the callback is invoked with the **existing node** and returns `undefined` → `committed===false` and the stored node is **byte-identical** (no overwrite, `computed_at` unchanged); (3) mutate the seeded join (add a late `ready_at`) → rerun → a **different** `runId` node appears, the first untouched, `latest` repoints; (4) preview mode (`to_ms=now`, unsettled) writes under `preview/` and creates **nothing** under `runs/`.

### 5c. Aborts overwrite `latest`, never leave stale-green (E1a)
Emulator test: after a successful run leaves `latest.status:'ok'`, invoke `main()` under a **`config_invalid`** config (empty `active_restaurants` / non-finite `settle_lag_ms`) → **no new `runs/` child**, but `latest` is overwritten to the failure status → `isFreshAuthoritativeRun(latest, current)` now returns `run_not_ok` (FAIL). Same for `nothing_settled` and `read_budget_exceeded`. Proves a failed run can't be read as the last green.

### 5d. Prune-safety
The runner is a **script**, not an `exports.foo` in `index.js` — `firebase deploy --only functions` never sees it, so it **cannot prune** the live driver-native/payment functions (`prod-functions-deployed-state`). Invocation is manual/cron on an ops box, or `firebase emulators:exec` for tests. **If** later promoted to a scheduled Cloud Function, that is a **separate gated deploy bundling ALL live functions** — called out, not done here.

## 6. Emulator authority (this machine)
```
JAVA_HOME=/opt/homebrew/opt/openjdk firebase emulators:exec --only functions,database \
  --project demo-xpizza "node test/ready-time-quality-run.emulator.test.js"
```
The runner reads `FIREBASE_DATABASE_EMULATOR_HOST` and `admin.initializeApp()` binds to the emulator db; `now` is injected by the test for deterministic settle/idempotency assertions.

## 7. Pure helpers + tests

`ready-time-quality-run.test.js` (node, no emulator):
- **`hashRows` dependency manifest (fold #2):** baseline hash; then a battery that mutates EACH core-read field in turn — order `restaurant_id`/`customer_phone`/`order_id`; every timeline stamp; each event's key/`from`/`to`/`at`/`kitchen_load_ahead` — and asserts the hash **changes** for every one; key-order/row-order permutations → **same** hash (canonical); adding a row → different hash.
- `hashConfig`: mutating each of `epoch_start_ms`/`excluded_phones`/`excluded_orders`/`cleanup_paths`/`critical_segments`/`quality_thresholds`/`settle_lag_ms` → different hash.
- **`resolveWindow` fail-closed (fold #4):** non-finite `settle_lag_ms` → `config_invalid`; an active restaurant with no finite epoch → `config_invalid`; `requested.from` earlier than epoch → **clamped up** to epoch; authoritative clamps `to_ms` to `now − settle_lag` (`settled:true`); `from_ms ≥ to_ms` → `nothing_settled`; preview → `to_ms=now`, `settled:false`, `mode:'preview'`.
- **`buildRunNode` active-restaurant materialization (fold #3):** an active restaurant absent from `metrics.restaurants` appears with `capture_acceptable:false` + `empty_denominator`; all-empty → top-level `status:'empty_settled_window'`; shape otherwise matches §6; `computed_at = now`.
- **active set from config, not caller (E2):** `resolveWindow`/`main` derive `active` from `cfg.active_restaurants` only; empty/missing → `config_invalid`; a config listing both restaurants materializes both even if one has zero rows (a caller cannot omit `la_musa` to dodge its fail verdict — there is no such arg).
- **`isFreshAuthoritativeRun` (E1b):** current ok/authoritative/settled/covering/in-age run → `{ fresh:true }`; each miss fires its reason (`no_latest_run`, `run_not_ok`, `not_authoritative`, `not_settled`, `config_hash_mismatch`, `coverage_shortfall`, `stale`); a beacon with `status:'config_invalid'` → `run_not_ok`.
- **`pickNewEvent` parity (fold #8):** the runner imports the frozen `pickNewEvent`; a duplicate-`to:'new'` (same-ms, tie-break) input selects the identical event the core uses for bucketing.

`test/ready-time-quality-run.emulator.test.js`: the 5a (API-spy no-write) + 5b (fresh-process create-only/staleness) + 5c (abort overwrites `latest`, never stale-green) proofs above.

## 8. Open questions / sign-off
- **`settle_lag_ms` default** (how long to wait for late lifecycle events before a window is gate-authoritative) — proposal e.g. 30–60 min; owner-tunable in `ready_time_config`.
- **Window default** — full-since-epoch each run (simple, deterministic) vs rolling window; rec full-since-epoch at current volume, revisit with the index caveat (§2).
- **Invocation cadence** — manual/cron offline for v1 (rec) vs promote to scheduled fn later (separate gated deploy).
- **`latest` beacon max-age** — the `max_age_ms` C1/C2 pass to `isFreshAuthoritativeRun` (how stale a run may be before a gate refuses it) — owner-tunable.

## 9. Gate flow (unchanged)
Executor propose-first (this doc, rev-3) → advisor read-only verify + **runs the emulator proofs** (API-spy no-`/orders`-write, fresh-process idempotency/staleness, abort-overwrites-`latest`) → Codex Round-3 (thread 019f2ba8) → build (commit, NO deploy). After Step-1b: Step 2 — the v0 KDS overdue nudge (the first kitchen-facing, byte-identical-both-restaurants change).
