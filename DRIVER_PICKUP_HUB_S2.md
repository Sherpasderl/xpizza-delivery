# S2 — same-hub-aware stacking + the R4 force-accept fix (propose-first)

Parent: `DRIVER_PICKUP_HUB_PLAN.md`. S1 (geofence/nav gate) is committed. S2 fixes the force-accept bug so a **cross-hub** order is never silently force-accepted. Functions-zone (logic inside existing `autoAssignOnOrderCreate` + the client cascade) — **no new functions, prune denominator stays 29.**

## Design fork — RESOLVED: (b) cross-hub offered as `assigned` (swipe-to-accept)
A cross-hub 2nd order is **assigned, not force-accepted** — the driver explicitly swipes to accept it (a real detour decision); a **same-hub** 2nd still rides along force-accepted (today's behaviour). Rationale: preserves the simultaneous-hold we chose (cross-restaurant repeat customers), satisfies "cross-hub never force-accepted," and doesn't kill cross-hub stacking the way (a) exclude-cap-at-1 would. The 60s acceptance timeout on that cross-hub `assigned` order is the **intermediate** state; **S3** (held-state + surgical timeout exemption) later makes it survive while the driver finishes the current order. So S2→S3 together deliver simultaneous-hold; S2 alone is x_pizza-safe (no cross-hub) and la_musa-dark.

## ⟳ REVISED per Codex round 1 (3 findings, all accepted)
1. **TOCTOU (High):** `isStacked` used the stale pick-time `chosen.hasAcceptedSameHubOrder`; the `reassertAssignable` recheck (`:3139`) re-reads tasks but didn't recompute it. → `reassertAssignable(db, driverId, hubLat, hubLng)` now returns a **fresh** `hasAcceptedSameHubOrder` (from the task read it already does), and `isStacked = recheck.hasAcceptedSameHubOrder`. hubLat/hubLng are in scope at the only call site (`:3139`, autoAssign); params default to `RESTAURANT_LAT/LNG` for any other caller.
2. **Legacy x_pizza fallback (server, Med):** excluding absent/non-numeric accepted-hub coords would regress a **legacy x_pizza** accepted order (no stamped hub) — today it force-accepts. → the accepted-hub resolver **mirrors `resolveAssignHub`**: numeric `destination_lat/lng` → use them; else `restaurant_id` null/`x_pizza` → `X_PIZZA_HUB` fallback; else (a **known non-x_pizza** with a bad/missing hub) → exclude (fail-closed, so a malformed la_musa order is never mis-treated as x_pizza).
3. **Legacy x_pizza fallback (client, Med):** same hole in the cascade — a legacy all-x_pizza assigned stack must still cascade. → `stackedTasksToAccept` resolves each pickup hub with the **same fallback** (legacy/null/x_pizza → `X_PIZZA_HUB`), fail-closed only for unknown/non-x_pizza missing hubs.

Both server + client use one shared same-hub resolution shape (pure, tested each side; documented as mirrors).

## Same-hub signal — hub-coord match, reusing `hubLat/hubLng` (NOT restaurant_id threading)
`pickEligibleDriver(db, exclude, hubLat, hubLng)` **already receives the new order's hub** at BOTH call sites — initial `autoAssignOnOrderCreate:3111` and reassign `monitorAssignmentTimeout:3293` (C1 already made these safe). Comparing the driver's **accepted order's hub** (from its pickup task's stamped `destination_lat/lng`, intact even after the pickup task flips to `completed`) against `hubLat/hubLng` adds **no new threaded param → sidesteps the C1-class scope trap by construction** (finding #5). Same epsilon as the geofence (1e-6). *(The auditor's `restaurant_id`-equality lean is cleaner as an id compare, but it would reintroduce a threaded new-order var — exactly the C1 ReferenceError surface; coords avoid it while giving the identical result, since hub coords and restaurant_id are stamped together.)*

## Server change (`index.js`)
0. **Pure helper** (testable, mirrors `resolveHubFromTask`): `resolvePickupHub(pk)` → `{lat,lng}` from numeric `destination_lat/lng`, else `X_PIZZA_HUB` for `restaurant_id` null/`x_pizza`, else `null` (fail-closed); and `sameHub(a,b,eps)`. `hasSameHubAcceptedOrder(acceptedHubs, hubLat, hubLng, eps)` = `acceptedHubs.some(h => sameHub(h,{lat:hubLat,lng:hubLng},eps))`.
1. In `pickEligibleDriver`'s task loop (`:2857-2872`), when marking an accepted order, resolve + collect its hub: `acceptedHubsByDriver[driverId].push(resolvePickupHub(tasks[`${order_id}_pickup`]))` (drop nulls). Pickup task exists + carries the stamped hub + `restaurant_id` regardless of its own status.
2. Per driver: `hasAcceptedSameHubOrder = hasSameHubAcceptedOrder(acceptedHubsByDriver[driverId]||[], hubLat, hubLng, EPS)`; carry on `eligible.push({…})` (`:2941`). (Kept for logging/parity; the authoritative value for the write is the recheck below.)
3. **`reassertAssignable(db, driverId, hubLat=RESTAURANT_LAT, hubLng=RESTAURANT_LNG)` (`:2998`)** — its existing fresh task read now also builds `acceptedHubs` (same `resolvePickupHub`) and returns `hasAcceptedSameHubOrder`. **`:3131` `isStacked` moves AFTER the recheck**: `const isStacked = recheck.hasAcceptedSameHubOrder` (TOCTOU-safe — the value that gates force-accept is the fresh one read right before the write).
4. **Cap logic (`:2909-2928`, `:3019-3024`) UNCHANGED** — orderCount-based; a cross-hub 2nd still occupies a slot (up to cap 2), so it CAN be assigned, just not force-accepted (fork b).
5. **Reassign path (`:3293`/`:3317`) UNCHANGED** — never passes `isStacked` (defaults false → never force-accepts); no same-hub value needed there.

## Client change (`xpizza-driver/stacking-helpers.js` — single copy, no 5-way fan-out)
`stackedTasksToAccept(allTasks, driverId, currentOrderId)` → **same-hub only**: cascade a candidate other-order task only if that order's pickup-hub matches the **current** order's pickup-hub, where each hub is resolved by the **same fallback** as the server (`resolvePickupHub`: numeric `destination_lat/lng`; else `X_PIZZA_HUB` for legacy/null/`x_pizza`; else null → fail-closed). So a legacy all-x_pizza assigned stack (no stamped hubs) still cascades unchanged; only an unknown/non-x_pizza order with a missing hub is dropped. Cross-hub other-order tasks stay `assigned` (driver swipes). Lone → []. (Mirrors the server resolver; both pure + unit-tested.)

## X. Pizza invariant (proof-required)
Every x_pizza order resolves to the x_pizza hub == `RESTAURANT` == `hubLat/hubLng` to full precision — **including a legacy order with no stamped hub** (the `resolvePickupHub` x_pizza fallback). So `hasAcceptedSameHubOrder` resolves **true whenever `hasAcceptedOrder` was true** for x_pizza → `isStacked` identical → force-accept exactly as today. Cascade: all x_pizza tasks (stamped or legacy) → same hub → cascade set unchanged. Cap unchanged. **Test-pinned** (below).

## Test plan
- **Pure helper unit test:** `resolvePickupHub` — numeric coords→{lat,lng}; legacy/null/x_pizza + no coords→X_PIZZA_HUB; **known non-x_pizza + missing/bad coords→null (fail-closed)**; numeric-string→treated as non-numeric→fallback rule. `hasSameHubAcceptedOrder` — same-hub→true; cross-hub→false; x_pizza-all-same (incl. legacy no-hub)→true; within/outside EPS; empty→false.
- **`stacking-helpers.test.js` extend:** same-hub other order → cascaded; cross-hub → NOT cascaded; **legacy all-x_pizza (no stamped hubs) cascade unchanged** (the regression pin Codex flagged); lone→[].
- **x_pizza stacking golden:** same-hub 2nd x_pizza order → `isStacked=true` unchanged; **legacy x_pizza accepted (no hub) + new x_pizza → still `isStacked=true`** (fallback preserves force-accept).
- **Cross-hub combos:** {accepted x_pizza + new la_musa} and {accepted la_musa + new x_pizza} → `isStacked=false`.
- **TOCTOU:** stale pick-time same-hub differs from the fresh recheck → the write uses the recheck value (a driver who accepted a cross-hub order between pick and recheck is not force-accepted).

## Gate checklist (auditor's 5)
1. x_pizza byte-behaviour-identical (same-hub always true for x_pizza) — golden + unit. 2. Cross-hub not force-accepted, per combo. 3. Cap x_pizza-unchanged. 4. Cascade same-hub-only, x_pizza cascade unchanged. 5. **C1 trap: no new threaded var**; reassign path (`:3293`) confirmed to pass `hubLat/hubLng` + never force-accept.

## Out of scope
The held-state + 60s-timeout exemption for the cross-hub `assigned` order = **S3**. S2 leaves it a normal assigned order (timeout applies) — x_pizza-safe, la_musa-dark until S3 + active:true.
