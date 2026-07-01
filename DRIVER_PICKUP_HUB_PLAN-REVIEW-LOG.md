# Plan Review Log: Driver per-restaurant pickup hub (full multi-hub)

Proposal-first (no Act-1 grill needed — user pre-decided full multi-hub). Codex adversarial review, read-only. MAX_ROUNDS=5. Codex thread `019f1a1b-6d36-7e43-a759-167cbf2143ae`.

Note: an initial invocation read a STALE `/tmp/codex-verdict.txt` (a prior session's visual-overhaul review) because `codex` wasn't on PATH and the failure was swallowed by `2>/dev/null`. Discarded. Round 1 below is the first real run (codex pinned via `-C` to the repo, absolute binary path).

## Round 1 — Codex (VERDICT: REVISE)
1. **`materialize.js` omitted** — online orders' pickup tasks (`buildMaterializeUpdates`) also lack `restaurant_id`; plan only named the cash path.
2. **Stale snapshot not optional** — cancel/reassign clear `current_task_id` but leave `current_hub_*` while another accepted pickup remains → native geofence runs with `hasTask=false` + stale hub. Need a single promote-or-clear helper across cancel/reassign/timeout/completeTask/cleanup.
3. **Accept cascade is cross-hub-unsafe** — `stackedTasksToAccept()` auto-accepts the OTHER order's tasks (incl. a cross-hub pickup) on first accept; plan only filtered completion, not acceptance.
4. **`isHubResolvable` coords-present is not fail-safe** — bad/malicious stamped coords become authoritative; web path has no guard. Weaker than the allowlist posture.
5. **Serial sequencing vs phase model** — `getDriverOrders` sorts `delivery < pickup`, `index.html` renders `orders[0]` ignoring `current_task_id`, so pickup B won't "surface" before delivery A; plan wording implied otherwise.
6. **`completeTask` next-pickup shadowed by next accepted delivery** — in a cross-hub stack the other order's delivery may already be `accepted`, so current code promotes that (un-picked-up) delivery before looking for the remaining pickup.
7. **Byte-identity overstated** — new persisted fields + changed read order + snapshot clears change DB shape/timing/logging even when coords are float-equal.
8. **Snapshot lifecycle during delivery underspecified** — geofence reads hub whenever status conditions match; a stale pickup hub can mis-fire returning/at_restaurant transitions.
9. **Observability too thin** — no logs/metrics for snapshot writes/promotes/clears, same-hub filtering, rejected cross-hub cascade, stale repair, or fallback-to-x_pizza.

### Claude's response — ACCEPT all 9 (final arbiter)
All valid; 3, 6, 2 catch real bugs. Revisions made to the plan:
- **(1)** Edit 7 now covers BOTH `buildCreateOrderUpdates` and `buildMaterializeUpdates`, with an order-fetch fallback for legacy tasks lacking `restaurant_id`.
- **(2)+(8)** New **Edit 0: `resolveActiveHub(driver, allTasks)` pure helper** + a `promoteNextActiveOrClearHub` write path, called from `acceptTask`, `pickupComplete`, `completeTask`, `cancelOrder`, `reassignOrder`, and the assignment-timeout cleanup. Snapshot lifecycle defined by status (table added).
- **(3)** Accept cascade made **same-hub only** — `stackedTasksToAccept` gains a hub filter; cross-hub stacked orders stay `assigned` and require an explicit accept (consistent with same-hub-cluster / cross-hub-explicit). Flagged to user as a UX change.
- **(4)** `isHubResolvable` now requires finite coords **AND** `restaurant_id ∈` the seed-identity allowlist (`x_pizza`,`la_musa`); legacy `null` → x_pizza only when coords are absent/equal fallback. Web path gets the same allowlist guard.
- **(5)** Sequencing wording made explicit: **pickup-A → deliver-A → pickup-B → deliver-B**, driven by the existing `delivery<pickup` rank + `orders[0]` render; `completeTask` promotes pickup B only after A's delivery completes. No phase-model re-rank.
- **(6)** `completeTask` now **excludes deliveries whose pickup is not completed** (guard on `depends_on_task_id`) and promotes an accepted pickup before any pickup-blocked delivery. (Largely mooted by (3) but kept defensive.)
- **(7)** Guarantee narrowed to "same geofence/nav **coordinates** + same same-hub **clustering behavior**"; golden tests added for x_pizza lone + stack.
- **(9)** Observability section added.

## Round 2 — Codex (VERDICT: REVISE)
1. **Model contradiction (the big one):** "cross-hub stays `assigned` + explicit accept" (same-hub-only cascade) vs "cross-hub pickups stay `accepted`" + "promote a remaining `accepted` pickup." Can't all be true — with a same-hub-only cascade, cross-hub B is `assigned`, so `completeTask` finds no `accepted` pickup to promote.
2. **Goal wording stale** — "hold accepted pickups from multiple restaurants at once" no longer matches the explicit-accept model (cross-hub is assigned-not-accepted).
3. **`resolveActiveHub` priority underspecified** — must separate `accepted delivery` / `accepted pickup` / `assigned pickup`, with exact outputs, and must not set `returning` while an assigned pickup still sits in the queue.
4. **Return-base policy undefined** — clearing hub on `returning` → fallback to X. Pizza means a lone La Musa delivery returns/arrives at X. Pizza. May be intended (fleet base) but unjustified + untested.
5. **Same-hub cascade task-type precision** — delivery tasks carry *customer* coords, not hub coords; "same hub" must be matched via the other order's pickup-task hub / order_id, then decide explicitly which task-types are accepted.
6. **Client allowlist source vague** — the PWA only has hardcoded X. Pizza constants; "seed-identity allowlist" needs a concrete client source (pinned client constant or /config).
7. **Web observability** — browser logs aren't prod-auditable unless sent somewhere; define RTDB telemetry vs local-only.
8. **(resolved)** `materialize.js restaurant_id` finding confirmed fixed.

### Claude's response — ACCEPT; commit to ONE model (Model X: cross-hub = explicit accept)
- **(1)+(2)** Locked to **Model X**: same-restaurant orders auto-stack + cluster; a **different-restaurant order stays `assigned` and is accepted explicitly** via the existing `awaiting_acceptance` flow when the driver turns to it. Removed the "promote accepted cross-hub pickup" logic (it was the contradiction). Goal rewritten to match. This is *less* new code — cross-hub reuses the shipped accept path.
- **(3)** `resolveActiveHub` priority made explicit: (a) next `accepted` + **pickable** delivery → keep `en_route_delivery`; (b) else → `returning` + clear hub. An `assigned` (un-accepted) cross-hub order is **left untouched** (surfaces as an accept card); never auto-promoted, never blocks `returning`.
- **(4)** Return-base policy stated explicitly: **global X. Pizza base** (shared-pool home) — a product decision, flagged for the user, with a test.
- **(5)** Same-hub cascade matches on the other order's **pickup-task hub + order_id** (not delivery coords); same-hub → accept both that order's pickup+delivery (preserves shipped same-hub behaviour); cross-hub → accept neither.
- **(6)** Client allowlist = a **pinned client `ALLOWED_HUBS` constant** mirroring `seed_identity.js`, with a test asserting equality to the seed (same hinge pattern as `assign-hub.test.js`).
- **(7)** Web guard rejection writes a best-effort RTDB breadcrumb (`drivers/{uid}/geofence_skip_reason` + ts); native path stays Cloud Logging — both auditable.

## Round 3 — Codex (VERDICT: REVISE)
Confirmed the R2 model contradiction is gone + return-base/allowlist/client-constant/materialize/breadcrumb are implementation-ready. Three leftover-wording inconsistencies remained:
1. `pickupComplete` edit still said "cross-hub pickups stay `accepted`" — contradicts Model X (`assigned`).
2. `resolveActiveHub` priority dropped the **accepted-pickup** branch → a same-hub stack survivor (active order cancelled pre-pickup) would wrongly fall through to `returning`+clear instead of becoming the active pickup.
3. Test plan/matrix still said "next cross-hub pickup promoted" (old model).

### Claude's response — ACCEPT all 3 (consistency fixes, no architecture change)
- Reworded `pickupComplete` edit: non-same-hub not auto-completed; cross-hub is `assigned` anyway.
- Re-added priority **(b) accepted/in_progress pickup → `assigned` + its hub** (only ever a same-hub survivor, since cross-hub is never auto-accepted); cross-hub `assigned` still never promoted.
- Updated `pickup-hub.test.js` + manual matrix (d) to the explicit-accept flow: deliver A → B `awaiting_acceptance` → accept B → snapshot La Musa → pickup/deliver B; added (e) same-hub-survivor cancel + (f) cross-hub assigned cancel.

## Round 4 — Codex (VERDICT: REVISE)
One implementation-blocking defect (missed by the plan + R1-3): the plan only fixed the **client** accept cascade. The **server** `autoAssignOnOrderCreate` sets `isStacked = chosen.hasAcceptedOrder` and `buildAssignmentUpdates(isStacked=true)` writes the new order's pickup+delivery `accepted` **regardless of hub** → would force-accept a cross-hub order, bypassing Model X. And leaving a cross-hub order plain `assigned` collides with `monitorAssignmentTimeout` (busy driver can't accept within 60s → premature reassign).

### Claude's response — ACCEPT; refine Model X to be timeout-safe (sequential cross-hub)
The "hold both simultaneously" reading of Model X needs a held/queued state exempt from the 60s timeout — real functions-zone cost. Refined the model so the gate ships without it:
- **New Edit 9:** server `isStacked` must be **same-hub-aware** — force-accept only when the chosen driver's accepted active order shares the new order's hub. Cross-hub → `isStacked=false` → normal 60s-accept path; a busy driver lets it lapse → `monitorAssignmentTimeout` reassigns (graceful, no held state). 2-order cap kept.
- Goal + sequencing reworded: cross-hub served **sequentially** (driver serves both restaurants across a shift, not held at once). Per-order hub resolution (the gate) holds for all orders regardless.
- Open-question #1 reframed as the launch decision for the user: **sequential** (recommended, this plan) vs elevate **simultaneous-hold** (deferred, Out of scope). Matrix (d)/(d2) updated for the normal-flow + timeout-reassign cases.

## Round 5 — Codex (VERDICT: APPROVED)
"Internally consistent for the stated sequential cross-hub scope. R4's server-side force-accept hole is covered by Edit 9, the timeout behavior is explicit and bounded, and simultaneous cross-hub holding is correctly separated into out of scope. The remaining product choices are called out as launch decisions, not hidden implementation contradictions."

## S1 gate — La Musa auditor session, Round 1 (VERDICT: REVISE)
Decisions elevated by the auditor: **SIMULTANEOUS HOLD** (S3 in scope) + **return-base = X. Pizza** + directive recalibrated to **behaviour-preserving/test-proven** (not byte-identical; generalize single-hub → hub-parameterized). S1 grew to the full single-order hub lifecycle + a rules resolution. Blockers:
1. **Rules reject the driver-self `current_hub` write** (`database.rules.json:25-27` dispatcher-only `.validate`). → server-side write or loosen-rule fork (auditor lean: server-side).
2. **Clear all three hub fields at every release site** (SDK `686`/`725`/`472`, server `1549`/`2106`/`2141`) or stale-hub mis-geofences the next order (incl. an x_pizza regression).
3. **`isHubResolvable(restaurantId, hubLat, hubLng)`** — validate coords match `ALLOWED_HUBS[rid]`, not just the id.
4. Option-1 reconciliation: Codex's "retain la_musa hub through returning" + "computeReturnEta wrong" are Option-2 behaviours → resolved by Option 1, BUT verify `computeReturnEta` isn't used for pickup-approach.
- Refinements: E6 use the immutable task hub (not mutable `current_hub`); resolve SDK copy-drift (#10).
- HOLD S2 until S1 re-clears. Route the actual artifact (doc/diff) to the auditor's repo.

### Claude's response — ACCEPT all; S1 REV 2 (real-file-grounded)
- **Blockers #1+#2 collapsed into ONE mechanism:** **E3 = server trigger `syncDriverHub` on `/drivers/{uid}/current_task_id`** (admin → bypasses the dispatcher-only validate; keeps rules tight). Resolving hub FROM `current_task_id` means all six null-sites auto-clear — no per-site edits. `acceptTask` SDK unchanged → no acceptTask drift. Lifecycle table nailed: pickup→set, delivery→**no-op (preserves the exit-backstop = behaviour-identical for x_pizza)**, null→clear→X. Pizza.
- **#3** E4 signature `isHubResolvable(restaurantId, hubLat, hubLng)` with coords-match.
- **#4** Verified `computeReturnEta:1787` is en_route/returning time-to-base only (never pickup-approach) → **no change**, correct under Option 1.
- **E6** uses immutable `o.pickupTask.destination_lat/lng`. **Copy-drift:** E5 lands in all 5 `xpizza-delivery.js` copies identically (inert in the 4 non-driver apps; honours the no-drift invariant).
- Sub-fork resolved: **server-side write** (less surface than rules-loosening + per-site clears + rules-guard tests).
- Routed `DRIVER_PICKUP_HUB_S1.md` (+ plan + log) into `~/Downloads/xpizza-delivery` (auditor's readable root). S2 held.

## S1 gate — Codex Rev 2 (VERDICT: REVISE → a Rev 3 hardening, not a redesign)
Trigger design sound + **X. Pizza preservation confirmed** (Codex's own Low findings: active write changes storage not behaviour; delivery-phase no-op preserves the at_restaurant→en_route exit-backstop). All findings are la_musa-correctness/trigger-robustness. ACCEPT all:
1. **(High) Out-of-order trigger race** — slow pickup event writes hub after a newer delivery/null advanced `current_task_id` → stale hub. → idempotent recheck: re-read `current_task_id` before every write, write only if still == event `after`.
2. **(High) Delivery no-op inherits stale/null hub** if the pickup write lagged/failed. → on delivery, no-op only if existing hub resolvable; else backfill from `delivery.linked_task_id`'s pickup (+ recheck).
3. **(Med) E4 call site** `index.js:2217` must pass `(rid, hubLat, hubLng)`; legacy null matches X. Pizza coords when present.
4. **(Med) Shift-boundary explicit clears** — trigger fires only on `current_task_id` *changes*, so already-null→null (startDriverShift after abnormal end) won't fire. → keep endDriverShift's clear (2142-44 ✓) + **add hub-null to startDriverShift (2106)**. Narrows "zero per-site edits" to task-transition sites.
5. **(Med/Low) Fail-CLOSED on mismatch** — E4 + E5 skip the transition when rid unknown / coords mismatch the pinned ALLOWED_HUBS (not silent fallback). Absent hub → legacy x_pizza ok.
6. **(Med) E2 dead writer** — `createOrderWithTasks:885` (x_pizza-hardcoded, inert) → stamp `restaurant_id:'x_pizza'` for consistency.
- Proof-bar: add the **out-of-order-events test** for `syncDriverHub` (the #1 hazard).

### Claude's response — ACCEPT all 6 (S1 REV 3, real-file-grounded)
Trigger stays. Added: idempotent recheck (#1) + delivery-backfill (#2) to `syncDriverHub` + `resolveHubFromTask(after, allTasks, existingHub)`; E4 call-site coords + fail-closed (#3/#5) on both server + client E5; explicit hub-null added to startDriverShift, endDriverShift already clears (#4); E2 stamps the dead writer (#6); proof-bar gains the out-of-order + delivery-backfill tests. Verified real files: startDriverShift:2106 nulls only current_task_id (needs the add); createOrderWithTasks:885 is the dead x_pizza-hardcoded builder. Re-routed REV 3 to the auditor repo.

## Resolution — CONVERGED (APPROVED, round 5/5)
Plan locked for implementation pending the user's two launch decisions (sequential vs simultaneous cross-hub; X. Pizza global return-base). No code written during the review. Acts improved the plan by: (1) catching that the per-restaurant-hub scaffold's WRITE side was entirely unwired (both geofence paths silently fell back to X. Pizza) + the `isHubResolvable` la_musa fail-closed; (2) eliminating a class of stale-snapshot/race bugs via one `resolveActiveHub`/`promoteNextActiveOrClearHub` write path + a same-hub-aware accept model on BOTH client and server (the R4 server force-accept hole + 60s-timeout collision); (3) hardening fail-safety (allowlist+coords), observability (RTDB breadcrumb + structured logs), and x_pizza behavioural-identity (golden tests) — and surfacing the real product forks as explicit launch decisions instead of buried assumptions.
