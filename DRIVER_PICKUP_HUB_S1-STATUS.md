# S1 implementation — status (driver session → auditor gate)

S1 REV 3 design APPROVED. Implementing TDD-first in **this live repo** (`~/xpizza-lamusa`, `feature/lamusa-integration`). Split into increments so the functions-zone hot file (`index.js`) lands under coordination.

## ✅ Increment A — LANDED (uncommitted in the working tree) + GREEN
The pure, self-contained core — the design's heart (the #1 race-hazard resolver + the fail-closed guard + the allowlist). **Zero `index.js` edits.** Diff: `DRIVER_PICKUP_HUB_S1-INCREMENT-A.diff`.

- **E1** `assign-hub.js`: `LA_MUSA_HUB` + `ALLOWED_HUBS` (keyed by restaurant_id), pinned to `seed_identity.js` by a drift test (keys + coords).
- **E4** `driver-ingest.js`: `isHubResolvable(restaurantId, hubLat, hubLng)` — allowlist + coords-match, **fail-closed** on unknown rid / mismatched / (known-rid) absent coords; legacy `null` → x_pizza only when coords absent or exactly x_pizza.
- **E3 pure core** `driver-ingest.js`: `resolveHubFromTask(afterTaskId, allTasks, existingHub)` → `{action: set|noop|backfill|clear}`. Delivery-phase uses **compare-to-linked-pickup-hub** (a strengthening of Codex #2: backfills whenever the snapshot ≠ the linked pickup's hub, which also catches the la_musa-lagged case that a literal `isHubResolvable` check would miss — `isHubResolvable(null,null,null)` is true-as-legacy-x_pizza and would wrongly no-op a la_musa delivery).

**Tests (TDD RED→GREEN):** `assign-hub.test.js` 15/15 (incl. ALLOWED_HUBS↔seed drift + key-set pin); `driver-ingest.test.js` 23/23 (new isHubResolvable fail-closed table + resolveHubFromTask set/noop/backfill/clear incl. the ★ stale/absent-hub backfill). **Full `npm test` suite: GREEN (24 files).**

## ⚠️ Critical coupling (atomic-landing requirement)
The only non-test caller of `isHubResolvable` is **`index.js:2217`** (`isHubResolvable(driver.current_restaurant_id)` — one arg). With the new signature, a one-arg call fail-closes a known rid → **x_pizza geofence would break at runtime.** So Increment A's `driver-ingest.js` change MUST land **in the same commit** as the `index.js:2217` coords update (Increment B). They are not independently deployable. (Unit tests pass because `index.js` is composed at runtime, not unit-tested.)

## ⬜ Increment B — index.js (NEEDS hot-file coordination with the executor)
- **E3 trigger** `syncDriverHub` = `onValueWritten('/drivers/{uid}/current_task_id')` → read driver+tasks → `resolveHubFromTask` → apply with the **idempotent recheck** (re-read `current_task_id`, write only if still == event `after`; for the residual write-after-recheck window: `runTransaction` on the hub keyed on `current_task_id`, or document the x_pizza-benign/sub-second rationale — auditor watch-point #1). **Function count 28 → 29** (runbook prune denominator).
- **E4 call site** `index.js:2217` → `isHubResolvable(driver.current_restaurant_id, hubLat, hubLng)`.
- **#4** add `current_hub_lat/lng/restaurant_id: null` to `startDriverShift` (`index.js:2106`; `endDriverShift:2142-44` already clears).
- **Test (watch-point #1):** an out-of-order test that exercises the **trigger's real read-write path** (pickup-event-after-null/delivery → no stale write), not only the pure resolver.

## ⬜ Increment C — builders + dead writer (functions/SDK, no index.js)
- **E2** `restaurant_id` on the pickup task in `create-order-build.js` + `materialize.js`; **rebump the task guard-hash**; builder goldens. **E2/#6** stamp `restaurant_id:'x_pizza'` on the dead `createOrderWithTasks` (`xpizza-driver/xpizza-delivery.js:885`).

## ⬜ Increment D — driver app (driver-session-owned; must reach phones before active:true)
- **E5** client `checkGeofenceTransition` per-hub + fail-closed, in **all 5** `xpizza-delivery.js` copies (identity check). **E6** nav per-task (`index.html:1904-1905`) + `www/` mirror.

## Gate ask
Gate Increment A's diff (Codex on the real code). On clear, I implement Increment B **with you/the executor coordinating `index.js`** (it can't land without B anyway). C and D follow.
