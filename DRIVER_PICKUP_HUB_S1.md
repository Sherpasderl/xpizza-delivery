# S1 (REV 3) — Single-order per-hub lifecycle: server-written hub + geofence + nav (propose-first)

Parent: `DRIVER_PICKUP_HUB_PLAN.md`. **The gate-required slice.** Behaviour-preserving for X. Pizza (Codex-confirmed at coordinate/state level), **test-pinned**. REV 2→3 = Codex hardening of the async-trigger race hazards (la_musa-correctness/robustness; X. Pizza preservation unchanged). Single accepted order at a time — no stacking (S2), no held-state (S3), no multi-order completion (S4).

## Headline change from REV 1: the `current_hub` write is SERVER-SIDE, driven by a trigger on `current_task_id`
REV 1 proposed a client SDK write in `acceptTask` — **rejected by the rules** (`database.rules.json:25-27`: `current_hub_lat/lng/restaurant_id` `.validate` = `dispatchers…exists()`; they're in the server-managed field family with `current_shift_id`/`ingest_token_hash`/`location_source`). The scaffold's design intent is server-writes-hub (`endDriverShift` nulls it server-side). So:

**E3 (REV 2) — new Cloud Function trigger `syncDriverHub` on `/drivers/{uid}/current_task_id`.** Admin context → bypasses the dispatcher-only `.validate`, keeps the rules tight (no loosening, no new attack surface, no rules-guard-test burden). It resolves the hub FROM `current_task_id`, which **also subsumes blocker #2**: every one of the six sites that nulls `current_task_id` (SDK `472`/`686`/`725`, server `1549`/`2106`/`2141`) automatically gets the correct hub clear — no per-site manual clears, no stale-hub regression. One discipline, one place. `acceptTask` SDK is **unchanged** → no `acceptTask` copy-drift.

### The lifecycle (the auditor's ask — nailed) + REV3 race-idempotency
| `current_task_id` after-value | `syncDriverHub` action | geofence/nav target |
|---|---|---|
| → **pickup** task (on accept) | write `current_hub_lat/lng = pickup.destination_lat/lng`, `current_restaurant_id = pickup.restaurant_id` | that restaurant (pickup approach) |
| → **delivery** task (on pickupComplete) | **conditional backfill** (REV3 #2): no-op **iff the existing `current_hub` is resolvable**; else resolve `delivery.linked_task_id`'s pickup task and **backfill** the hub from it | same restaurant — keeps the geofence **exit-backstop** working, behaviour-identical for x_pizza, and self-heals a lagged/failed pickup write for la_musa |
| → **null** (deliver-complete / cancel / reassign) | **clear** all three to null | X. Pizza fallback (returning + base; = Option 1) |

**REV3 #1 — idempotent recheck (mandatory for any `onValueWritten` on a mutable field).** A slow pickup event can fire *after* a newer delivery/null event already advanced `current_task_id` → stale hub. So the trigger, immediately before its write, **re-reads `current_task_id` (a fresh `once('value')`) and writes only if it still equals the event's `after`** (for the null/clear case, clears only if it's still null; for the backfill case, re-checks the value is still that delivery). If it diverged, the trigger no-ops — a newer event already (or will) handle the live value. This makes concurrent/out-of-order events converge to the latest `current_task_id`. Trigger latency (sub-second) is otherwise safe: while `current_hub` is transiently unset, `isHubResolvable` fail-closes → the geofence no-ops rather than mis-fires.

Pure resolver `resolveHubFromTask(afterTaskId, allTasks, existingHub)` → `{action:'set'|'clear'|'noop'|'backfill', hub?}` is unit-tested incl. the **out-of-order case** (pickup-event-arrives-after-null/delivery → no stale write) and the **delivery-backfill** case.

### Shift-boundary explicit clears (REV3 #4)
The trigger fires only on `current_task_id` **changes**, so an already-`null`→`null` write (e.g. `startDriverShift` after an abnormal prior end) won't fire → a stale hub could persist across shifts. So **keep/add explicit hub clears at the shift boundaries**: `endDriverShift` already nulls `current_hub_lat/lng/restaurant_id` (index.js:2142-2144 ✓); **add the same three nulls to `startDriverShift`** (index.js:2106 currently nulls only `current_task_id`). The "zero per-site edits" claim therefore narrows to **task-transition** sites (which the trigger covers); the two **shift boundaries** get explicit clears.

## Edits
- **E1 — `ALLOWED_HUBS` registry (`assign-hub.js`).** Export `LA_MUSA_HUB` + `ALLOWED_HUBS = { x_pizza: X_PIZZA_HUB, la_musa: LA_MUSA_HUB }`, pinned to `seed_identity.js` by a drift test. [functions]
- **E2 — `restaurant_id` on the pickup task — BOTH live builders + the dead writer.** `create-order-build.js:65-79` (cash) + `materialize.js buildMaterializeUpdates` (online). Additive; **rebump the task guard-hash** (the D2 pattern — task `.validate` accepts the extra field). Pure-builder goldens. **REV3 #6:** also stamp `restaurant_id: 'x_pizza'` on the pickup task in the **dead** `createOrderWithTasks` (`xpizza-delivery.js:885`, x_pizza-hardcoded `destination_lat: RESTAURANT.lat`, inert/unused) for consistency — noted as the dead writer so a future caller can't emit a `restaurant_id`-less task. [functions + SDK]
- **E3 — `syncDriverHub` trigger** with idempotent recheck + delivery-backfill (above). [functions]
- **E4 — `isHubResolvable(restaurantId, hubLat, hubLng)` + FAIL-CLOSED (`driver-ingest.js:60-62`).** New signature (auditor #3): resolvable iff `restaurantId ∈ ALLOWED_HUBS` **AND** `(hubLat,hubLng)` matches `ALLOWED_HUBS[restaurantId]`. **REV3 #5 fail-closed:** a `current_hub` that is **present but mismatched** (unknown rid, or coords ≠ the pinned hub) → resolvable=false → the server **skips** the geofence transition (does NOT silently fall back to X. Pizza); only a genuinely **absent** hub (`restaurantId == null` + coords absent/equal fallback) takes the legacy x_pizza path. **REV3 #3 call site:** `ingestDriverLocation:2217` must pass `(driver.current_restaurant_id, hubLat, hubLng)`. [functions]
- **E5 — client `checkGeofenceTransition` per-hub + FAIL-CLOSED (`xpizza-delivery.js:251-298`).** Below the driver fetch (`:255`): resolve `(current_restaurant_id, current_hub_lat/lng)` against the **pinned client `ALLOWED_HUBS` constant** (mirrors `assign-hub.js`; a test asserts equality to the seed). **REV3 #5:** present-but-mismatched → **skip the transition** (best-effort `drivers/{uid}/geofence_skip_reason` breadcrumb), NOT silent fallback; absent hub → legacy x_pizza. `geofence_radius_m` unchanged. **Copy-drift (auditor #10):** lands in **all 5 `xpizza-delivery.js` copies identically** (honours the no-drift invariant; pure logic-swap, **inert** in the 4 non-driver apps that never call it). [SDK ×5]
- **E6 — nav per-task (`index.html:1904-1905`).** `isPickup ? (o.pickupTask.destination_lat ?? XPD.RESTAURANT.lat) : ...` — the **immutable task hub** (`destination_lat/lng`), NOT the mutable `current_hub` (auditor refinement). `www/` mirror. [driver]
- **computeReturnEta — NO change** (verified: only the `en_route`/`returning` time-to-base meta, never pickup-approach; X. Pizza is correct under Option 1). [no-op, documented]

## Behaviour-preservation proof (the bar)
- **Golden — x_pizza lone order, server machine:** transition sequence `assigned→at_restaurant→en_route→returning→available` + chosen coords **identical** pre/post (`current_hub == X_PIZZA_HUB == RESTAURANT` to full precision; the **exit-backstop preserved** by the delivery-phase no-op). `driver-ingest.test.js`.
- **★ `resolveHubFromTask` out-of-order test (REV3 #1):** pickup-event-arrives-after-a-newer-null/delivery (idempotent recheck sees `current_task_id` diverged) → **no stale write**. Plus: pickup→set(hub,rid); null→clear; delivery with resolvable existing hub→noop; **delivery with stale/absent hub→backfill from `linked_task_id` pickup** (REV3 #2); missing task→clear (defensive).
- **`isHubResolvable(rid,lat,lng)` table:** matching coords for `x_pizza|la_musa`→true; **present-but-mismatched coords→false (fail-closed, skip — not fallback)**; unknown rid→false; legacy null+absent/fallback coords→x_pizza.
- **`ALLOWED_HUBS`↔seed drift test** (server + client constant).
- **Builder goldens** (`buildCreateOrderUpdates`/`buildMaterializeUpdates`): pickup task gains `restaurant_id`, else byte-identical; guard-hash rebumped.
- **Client `checkGeofenceTransition` read-swap golden** + the 5-copy identity check (all copies byte-equal).
- **On-device:** X. Pizza driver smoke (accept→arrive→pickup→deliver→return→available, dispatch pin + transitions unchanged) **+** la_musa smoke (nav + geofence resolve to La Musa, server geofence NOT skipped, hub set on accept / cleared on delivery-complete).

## Invariant check
- **#1** ✅ single-hub behaviour-identical (golden + smoke); la_musa branch only reachable with a real la_musa order; exit-backstop preserved.
- **#2/#3** n/a (no held-state / no timeout change).
- **#4** partial — single-order completion as today; multi-order per-hub completion is S4.

## Functions-zone flag (Ask 2) + routing
**Most of S1 is functions-zone:** E1 (`assign-hub.js`), E2 (`create-order-build.js`,`materialize.js`), **E3 (new trigger in `index.js`)**, E4 (`driver-ingest.js` + `ingestDriverLocation` call in `index.js`). → route through the La Musa auditor gate + coordinate with the `index.js` executor (hot file) before landing. E5 (SDK ×5) + E6 (`index.html`) are driver-session-owned but must reach phones (build + `www/` mirror) before `active:true`.

## Rollback base (pin before deploy)
Driver-app HEAD + `xpizza-driver` Netlify revision + `ingestDriverLocation`/(new) `syncDriverHub` Cloud Run/Functions revision.

## Open sub-fork resolved (was the auditor's "driver session's call")
**Server-side write chosen** (vs loosening the rule). Rationale: matches the server-managed field-family design, keeps rules tight, and the `current_task_id` trigger subsumes the whole clear-lifecycle (blocker #2) in one mechanism — strictly less surface than per-site clears + a rules change + rules-guard tests.
