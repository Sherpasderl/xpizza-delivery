# Plan: Driver per-restaurant pickup hub (full multi-hub)

_Proposal-first. Driver session scopes + executes; routed to the Codex auditor before any code. HARD pre-launch gate — must land before `la_musa active:true`. Terms per CONTEXT.md / ADR-0002 (hub snapshot)._

## Decisions LOCKED (La Musa auditor session, post-Codex-R5)
- **Cross-hub depth = SIMULTANEOUS HOLD** — a driver can carry a La Musa + X. Pizza pickup at once and visit each hub independently (shared repeat customers make cross-restaurant concurrency real at launch; build the status-machine change once, not twice).
- **Return-base = X. Pizza global base** — on finishing with nothing queued, hub clears to the X. Pizza fallback (= today's single-hub "return to base"); la_musa deliveries rejoin that *same* existing path (pin in tests).

## Prime directive — RECALIBRATED: behavior-preserving, PROVEN (not byte-identical)
The rule is **"don't break X. Pizza's current behaviour,"** not "byte-identical diff." Byte-identity was a proxy for small additive slices; multi-hub must touch shared single-hub code, so **refactoring X. Pizza code is allowed + encouraged when it's the correct build** — generalize single-hub logic into **hub-parameterized** logic (X. Pizza is simply `hub = X. Pizza`), not la_musa-only branches. Because "behavior-preserving" is harder to verify than "no diff," **the rigor moves onto the tests:** any slice that refactors shared X. Pizza code must pin the single-hub behaviour with golden/unit tests **+ an X. Pizza driver on-device smoke** (the driver app has lighter auto-coverage than functions). Refactor for correctness; bring the proof. The byte-identity hinge (`RESTAURANT == seeded x_pizza hub == the x_pizza pickup task's destination_lat/lng`, every per-hub path falling back to that constant) is the basis of the single-hub proof.

## Goal
A driver in the **shared pool** can serve orders from **multiple restaurants concurrently** (X. Pizza + La Musa, hubs ~0.4 km apart) and visit each hub independently, with **nav, geofence, pickup-completion, and dispatch all resolving per that order's own hub**. Same-restaurant orders keep today's auto-stack + cluster; a different-restaurant order is **held** (not force-accepted, exempt from the 60s acceptance timeout) and activates when the driver turns to it. X. Pizza single-hub behaviour stays **behaviour-identical, test-pinned**.

## Slice decomposition (independently gated, propose-first each — route every diff to the La Musa auditor session)
| Slice | Scope | Functions-zone? | Gate emphasis |
|---|---|---|---|
| **S1 — START HERE** | Per-hub geofence + nav + **wire the never-connected `current_hub` write** (web `checkGeofenceTransition` + native `ingestDriverLocation`). The gate-required piece that unblocks `active:true`. | Yes (`ingestDriverLocation`) | x_pizza behaviour-preserving, golden + smoke |
| **S2** | Same-hub-aware stacking + the **R4 force-accept fix** (client cascade `stacking-helpers.js` + server `isStacked` in `autoAssignOnOrderCreate`). | Yes (`isStacked`) | don't regress Fix 1 / grace-recheck |
| **S3** | The **held/queued task state + surgical 60s-acceptance-timeout exemption** (novel + riskiest → most adversarial Codex rounds). | Yes (`monitorAssignmentTimeout`) | invariants 2 & 3 |
| **S4** | `pickupComplete` per-hub completion + the phase/sort model. | No (SDK) | invariant 4 |
| **S5** | Dispatcher view of held cross-hub orders. | No (dispatch) | read-only surfacing |

Edits 0–9 below are the technical backing; they map onto these slices (S1: edits 4,5,6 + the write-side of 0/7; S2: edits 8,9; S3: held-state + timeout; S4: edits 2,3 + `resolveActiveHub`; S5: dispatch).

## Gate invariants (non-negotiable, every slice)
1. **Single-hub path behaviour-identical to today, proven by tests** — an all-X.-Pizza driver behaves exactly as now; held-state + per-hub branches are **unreachable without a real cross-restaurant stack** (la_musa-gated).
2. **No held order lost or stuck** — a held order reliably activates when the driver frees up, with a bounded fallback (re-eligible / dispatcher escalation) if they never do.
3. **Timeout exemption is surgical** — held tasks skip the 60s acceptance timeout; **active tasks' timeouts are untouched** (don't regress the live Fix 1 / grace-recheck).
4. **Per-hub completion is exact** — "Recogí" at hub A completes only hub-A pickups; a held hub-B order stays held (no false out-for-delivery).

## Background — the verified current architecture (a half-wired scaffold)
The per-restaurant hub scaffold exists but the **write side was never connected**, so today **every** order geofences/navigates to X. Pizza on **both** the native and web paths.

- **Hub source of truth:** `assign-hub.js` `X_PIZZA_HUB = {15.507489753573818, -88.0398486953722}`, pinned EQUAL to `seed_identity.js` x_pizza hub (the byte-identity hinge, `assign-hub.test.js`). Orders carry a stamped per-restaurant hub: `create-order-build.js:39-41` (`hub_lat/lng`, `restaurant_name`), and the **pickup task** carries `destination_lat/lng = hubSnap.hub_lat/lng` (`create-order-build.js:72-73`). La Musa's hub is distinct (`assign-hub.test.js:31`).
- **Server geofence (native path):** `ingestDriverLocation` (`index.js:2212-2240`) reads `driver.current_hub_lat ?? RESTAURANT_LAT` (2215-2216), runs the **pure** `geofenceTransition()` (`driver-ingest.js:31-51`), and **fails closed** via `isHubResolvable(driver.current_restaurant_id)` (`driver-ingest.js:60-62`) — which returns `true` ONLY for `null`/`'x_pizza'`. For `la_musa` it returns **false → geofence skipped + logged** (2224-2226).
- **Client geofence (web-PWA path):** `checkGeofenceTransition()` (`xpizza-delivery.js:251-298`) hardcodes `haversineDistance(lat,lng, RESTAURANT.lat, RESTAURANT.lng)` (252) + `RESTAURANT.geofence_radius_m` (50 m). No hub-resolvability guard.
- **The missing write:** `current_hub_lat/lng` + `current_restaurant_id` are **only ever set to `null`** — at clock-out `endDriverShift` (`index.js:2142-2144`). **Nothing writes a real value anywhere** (verified across `index.js`, `create-order-build.js`, `assign-hub.js`, `xpizza-delivery.js`, `index.html`). So `?? RESTAURANT_LAT` always fires AND `isHubResolvable(null) === true` → server geofences every driver against X. Pizza.
- **Nav:** `index.html:1904-1905` pickup Waze/Maps + the "arrived" distance use `XPD.RESTAURANT.lat/lng`.
- **Task state machine (single-active-task, SDK):** one `current_task_id`; `acceptTask` sets it to the accepted **pickup** (`:394`); `pickupComplete` advances it to the delivery (`:794`) **and auto-completes EVERY accepted pickup** the driver holds (`:806-820`, same-hub "grab both pizzas at the counter" assumption); `completeTask` promotes the next stacked **delivery** or else goes `returning` (`:466-473`). Phase model `getDriverOrders` ranks `delivery < pickup < awaiting < completed`.

## The gap — 4 gates (all must open for `la_musa`)
1. **Nav** hardcoded to `RESTAURANT` → pickup routes to X. Pizza. (`index.html:1904-1905`)
2. **Client geofence** hardcoded to `RESTAURANT`. (`xpizza-delivery.js:252`)
3. **Hub write-side missing** → server `?? RESTAURANT_LAT` fallback always fires. (`current_hub_*` never written)
4. **`isHubResolvable` fail-closed** on `la_musa` → server geofence skipped even once the hub is written. (`driver-ingest.js:60-62`)

Plus the **cross-hub stacking correctness bug:** `pickupComplete`'s grab-all (`:806-820`) would falsely mark a stacked **La Musa** pickup completed (+ order `out_for_delivery`) when the driver taps "Recogí" at **X. Pizza**, having never been to La Musa.

## x_pizza behavioural-identity guarantee (the non-negotiable) — narrowed per Codex R1#7
The guarantee is **same geofence/nav coordinates + same same-hub clustering behaviour**, NOT literal byte-identity (the change adds persisted `current_hub_*`/`restaurant_id` fields and reorders a read, so the DB shape + logs differ). Concretely: an x_pizza order's stamped hub **equals** `X_PIZZA_HUB`/`RESTAURANT` to full float precision, and every fallback resolves to that constant — so a lone x_pizza order geofences/navigates against identical coordinates with identical transitions, and an all-x_pizza stack keeps the existing grab-all cluster. `geofence_radius_m = 50` unchanged. **Pinned by golden tests** (x_pizza lone + x_pizza stack: assert identical transition sequence + chosen coords pre/post change).

## Design — full multi-hub via a persisted hub snapshot + "same-hub cluster, cross-hub serial"
The geofence stays **single-active-hub-at-a-time** (the pure `geofenceTransition` is already hub-parametrised and correct). Multi-hub is achieved by **snapshotting the active pickup's hub onto the driver** and **advancing that snapshot** as the driver walks their tasks — never by tracking two live hubs at once. This keeps the entire status machine intact.

### Sequencing model (simultaneous hold — locked)
- **Same-restaurant stack → auto-accept + cluster** (today's behaviour, S2 keeps it same-hub-only).
- **Different-restaurant order → HELD** (S3): not force-accepted, **exempt from the 60s acceptance timeout**, surfaces when the driver turns to it; on accept, `acceptTask` snapshots that order's hub. The driver genuinely carries both restaurants' work and visits each hub independently.
- **Per-order hub resolution** (geofence/nav/snapshot/completion) is correct for every order regardless — that is the gate (S1 + S4).
- The detailed held-state lifecycle, eligibility, and timeout exemption are designed + Codex-gated **in S3** (the riskiest slice); S1/S2 land first and are behaviour-preserving for x_pizza.

### Concrete edits
**Hub snapshot model:** `current_hub_lat/lng` + `current_restaurant_id` are a **persisted snapshot of the driver's CURRENT geofence target**, recomputed from the live task set (never left stale), per the `driver-ingest.js:28-29` intent. Lifecycle by status:

| Driver status | Snapshot target | Set by |
|---|---|---|
| `assigned` (heading to the accepted pickup) | the accepted pickup task's `destination_lat/lng` + order `restaurant_id` | `acceptTask` |
| `at_restaurant` / `en_route_delivery` | unchanged (delivery transitions don't gate on it) | — |
| `returning` (no accepted pickable task left) | **cleared to null** → server falls back to **X. Pizza global base** (return-base policy below) | `completeTask` via the helper |
| after cancel/reassign | **recomputed** from the surviving active task, or cleared | `promoteNextActiveOrClearHub` |

**Return-base policy (R2#4, product decision — flagged for user):** when a driver has no accepted pickable task left they go `returning` with hub cleared → both geofences fall back to **X. Pizza** as the shared-pool home base. So a driver finishing a lone La Musa delivery becomes `available` upon reaching X. Pizza, not La Musa. This matches today's single-hub "return to base" behaviour and the fact most volume originates at X. Pizza. (Alternative — return to last-served hub — is rejected for launch: it splits "available" across two bases and complicates dispatch's mental model.) Pinned by a test.

0. **(NEW, Codex R1#2/#8, R2#3) Pure helper `resolveActiveHub(driver, allTasks)` + write path `promoteNextActiveOrClearHub`.** Single source of truth returning `{current_task_id, status, current_hub_lat/lng, current_restaurant_id}` with **explicit priority**: (a) a still-`accepted`/`in_progress` **pickable** delivery (its pickup `completed`) → keep `en_route_delivery`, hub left as-is; (b) else a still-`accepted`/`in_progress` **pickup** → `assigned` + **that pickup's hub** (R3 — this is the same-hub-stack survivor when the active order is cancelled before pickup; such a pickup is only ever `accepted` for a same-hub stack, since cross-hub is never auto-accepted); (c) else → `returning` + **clear hub**. An `assigned` (un-accepted) cross-hub order is **never promoted and never blocks `returning`** — it surfaces as an accept card and is handled by `acceptTask` when the driver accepts it. **Called from every task-state-cleanup path:** `pickupComplete`, `completeTask`, `cancelOrder` (`:678-686`), `reassignOrder` (`:717-725`), and the assignment-timeout cleanup — eliminating the stale-snapshot class (no path clears `current_task_id` while leaving a stale hub). TDD as a pure helper.

1. **Write the snapshot (SDK)** via the helper in `acceptTask` (`:391-409`; `task` already fetched at `:380`) — set `current_hub_lat/lng = task.destination_lat/lng`, `current_restaurant_id = task.restaurant_id` (now stamped, edit 7).

2. **`pickupComplete` → same-hub only (`:806-820`, R3).** Filter the grab-all loop to pickups whose `destination_lat/lng` **equal the tapped pickup's**. Non-same-hub pickups are **not** auto-completed — and under Model X a cross-hub order is normally still `assigned` anyway (never auto-accepted), so it isn't a candidate here. Then call the helper to set the post-pickup active task.

3. **`completeTask` → pickup-block guard, then returning (`:448-473`, Codex R1#6/R2#3).** The next-delivery search MUST **exclude any delivery whose `depends_on_task_id` pickup is not `completed`** (defensive: a future stack could have an accepted-but-un-picked-up delivery). When no *pickable* delivery remains → `returning` + clear hub (via the helper). Under Model X a cross-hub order is `assigned` (not accepted) so it is correctly *not* promoted here — it awaits explicit accept.

4. **`isHubResolvable` (`driver-ingest.js:60-62`, Codex R1#4/R2#6) — fail-safe, allowlist + coords.** Resolvable iff `current_hub_lat/lng` are finite **AND** `current_restaurant_id ∈ ALLOWED_HUBS` (`x_pizza`, `la_musa`), with legacy `null` → x_pizza only when coords are absent or exactly the fallback. Rejects mis-stamped/garbage coords. **Allowlist source:** a single `ALLOWED_HUBS` registry in `assign-hub.js` (already the hub source-of-truth, imported by `index.js`), pinned to `seed_identity.js` by a test (the existing hinge pattern). `ingestDriverLocation:2217` passes coords + id; keep + expand the fail-closed log.

5. **Client geofence per-hub + mirrored guard + telemetry (`xpizza-delivery.js:251-298`, R2#6/R2#7).** Move the distance calc below the driver fetch (`:255`); use `driver.current_hub_lat ?? RESTAURANT.lat`/`...lng`, **gated by a pinned client `ALLOWED_HUBS` constant** mirroring `assign-hub.js` (the PWA can't import the functions module; a client constant + a build-time/test assertion of equality to the seed is the source). On a guard rejection, write a **best-effort RTDB breadcrumb** `drivers/{uid}/geofence_skip_reason` + ts (so web rejections are prod-auditable, not console-only); native uses Cloud Logging. Keeps `RESTAURANT.geofence_radius_m`.

6. **Nav per-task (`index.html:1904-1905`).** `targetLat = isPickup ? (o.pickupTask.destination_lat ?? XPD.RESTAURANT.lat) : ...` (+ `destination_lng`). Delivery branch unchanged.

7. **(Enabler) Stamp `restaurant_id` on the pickup task — BOTH order paths (Codex R1#1).** Add `restaurant_id` to the pickup task in `create-order-build.js:65-79` (cash) **and** `materialize.js` `buildMaterializeUpdates` (online/PixelPay). SDK snapshots it without an extra fetch; **order-fetch fallback** in the helper for legacy tasks created before this field.

8. **Same-hub accept cascade (`stacking-helpers.js` `stackedTasksToAccept`, Codex R1#3/R2#5).** Add a hub filter keyed on the other order's **pickup-task hub** (`destination_lat/lng` of *its pickup task*) + `order_id` — **not** delivery-task coords (deliveries carry customer coords, R2#5). Same-hub → cascade accepts that order's pickup **and** delivery (preserves shipped same-hub clustering); cross-hub → accepts **neither** (follows the normal assign+accept flow). TDD the filter.

9. **(NEW, Codex R4) Server auto-assign `isStacked` must be same-hub-aware (`index.js` `autoAssignOnOrderCreate` + `buildAssignmentUpdates`).** Today `isStacked = chosen.hasAcceptedOrder` and `buildAssignmentUpdates(isStacked=true)` writes the new order's pickup+delivery `accepted` **regardless of hub** — which would force-accept a cross-hub order, bypassing Model X. Change `isStacked` to also require the chosen driver's existing accepted active order be **same-hub** as the new order (compare the orders' hub `hub_lat/lng` / `restaurant_id`). For a cross-hub candidate `isStacked=false` → the order is `assigned` via the normal 60s-accept path (busy driver times out → `monitorAssignmentTimeout` reassigns — verified graceful, no held state needed). **Keep the 2-order cap as-is.** *(Optional optimization, not required for the gate: drop a busy-different-hub driver from cross-hub eligibility to avoid a spurious accept card + up-to-60s latency before reassign.)* This is the **functions zone** (La Musa session) — propose-first; ships in the whole-suite functions deploy alongside Edits 0/3/4/7.

## Test plan (TDD, repo idiom: `node X.test.js` + assert)
- **`driver-ingest.test.js`** — extend `isHubResolvable`: true for `(x_pizza|la_musa)` + finite coords; **false** for finite coords with an unknown/garbage `restaurant_id` (the fail-safe case); legacy `null` → x_pizza only at-or-absent fallback coords.
- **New `pickup-hub.test.js`** (pure helpers): `resolveActiveHub(driver, allTasks)` across the priority ladder — pickable delivery → `en_route`; accepted **same-hub** pickup survivor (active order cancelled pre-pickup) → `assigned`+its hub; un-pickable delivery excluded; an `assigned` cross-hub order left untouched (NOT promoted); nothing-left → `returning`+null. Plus same-hub pickup-filter (destination-coord equality) + same-hub accept-cascade filter (pickup-hub + order_id, cross-hub excluded).
- **`stacking-helpers.test.js`** — extend for the same-hub cascade (cross-hub task NOT returned).
- **Golden tests (x_pizza behavioural-identity, Codex R1#7):** assert the transition sequence + chosen geofence/nav coords are unchanged for (a) lone x_pizza and (b) x_pizza same-hub stack, pre/post change.
- **Manual matrix (sandbox seed: x_pizza + la_musa):** (a) lone x_pizza — identical geofence/nav; (b) lone la_musa — nav + geofence to La Musa, server geofence NOT skipped; (c) same-hub x_pizza×2 — grab-both unchanged; (d) cross-hub la_musa to an **available** driver (or the X. Pizza driver once free) — nav + geofence to La Musa, server geofence NOT skipped, hub snapshot = La Musa on accept; (d2) **busy X. Pizza driver is auto-assigned a la_musa order** → `isStacked=false` (not force-accepted) → driver lets it lapse → `monitorAssignmentTimeout` reassigns it, no false La Musa pickup; (e) **cancel the active order mid same-hub stack** — `resolveActiveHub` promotes the surviving same-hub pickup with its hub, no stale geofence; (f) **cancel a cross-hub order while assigned** — the other driver's snapshot unaffected.

## Observability (Codex R1#9)
Structured logs (with `driverId`, `taskId`, `orderId`, `restaurant_id`, hub coords, reason, before/after `current_task_id`) on every: snapshot **write/clear/promote** (`resolveActiveHub` outcome), **same-hub filter** drop (pickupComplete + cascade), **cross-hub accept rejection**, **stale-snapshot recompute** (cancel/reassign), and every **fail-closed guard rejection / fallback-to-X-Pizza** (both server `ingestDriverLocation` and the web path). These make the cross-hub paths auditable in prod logs before/after `la_musa active:true`. **Native path** → Cloud Logging (structured); **web-PWA path** → best-effort RTDB breadcrumb `drivers/{uid}/geofence_skip_reason` + ts (R2#7 — not console-only), since browser console isn't prod-auditable.

## Coordination
`index.js` + `driver-ingest.js` + `create-order-build.js` are the **functions zone (La Musa advisor session)**; per [[parallel-session-file-coordination]] + [[prod-functions-deployed-state]] the driver session **proposes**, and the functions deploy is **whole-suite** (driver-native + payment + this). SDK (`xpizza-delivery.js`) + `index.html` are driver-session-owned; they ship in a **driver app build + www/ mirror** and must reach phones **before** `la_musa active:true`.

## Resolved by Rounds 1–2 (was: open questions)
- Sequencing → **locked Model X** (same-hub auto-stack/cluster; cross-hub `assigned` + explicit accept via existing `awaiting_acceptance`). No phase re-rank, no new promote path.
- `isHubResolvable` → **`ALLOWED_HUBS` allowlist + finite coords**, sourced from `assign-hub.js` (server) / a seed-pinned client constant (web).
- Stale snapshot → **eliminated** by `resolveActiveHub` + `promoteNextActiveOrClearHub` across all cleanup paths (Edit 0).
- `completeTask` delivery-shadows-pickup → **pickup-block guard** (Edit 3).
- Same-hub cascade → matched on the **pickup-task hub + order_id** (Edit 8).
- Return-base → **global X. Pizza** (stated policy + test).
- Web observability → **RTDB breadcrumb**.

## Product decisions — RESOLVED (La Musa auditor session)
1. Cross-hub depth → **SIMULTANEOUS HOLD** (in scope, S3).
2. Return-base → **X. Pizza global base** (la_musa deliveries rejoin the existing single-hub return path; pinned in S1/S4 behaviour tests).

## Rollback base (pin before ANY deploy)
Driver-app HEAD (commit) + the `xpizza-driver` Netlify revision + the `ingestDriverLocation` Cloud Run revision. Record all three per slice that deploys.

## Out of scope
- Cross-hub pickup *cluster* routing (forcing "collect both pizzas first" ordering — the driver may visit hubs in any order); the dead `createOrderWithTasks` dispatcher fn (`index.js` — not live); tips/short-pays; any change to `geofence_radius_m`.
