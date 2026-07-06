# FINDING (on-device, driver-app session → auditor) — cross-hub 2nd order is un-acceptable in the driver UI

**Date:** 2026-07-01  **Build:** native driver AAB versionCode 11 / versionName 2.2.0 (pickup-hub, installed + confirmed on the test phone)
**Surfaced by:** the multi-hub on-device smoke (prod test-seed via `/tmp/mh-seed.js` + `mh-seed-xpizza.js`).
**Severity:** driver-facing gap in **cross-hub simultaneous-hold** — a core La Musa scenario. NOT a server bug.

## What passed (so this is scoped precisely)
- **x_pizza cash order** on 2.2.0 → no regression.
- **S1 hub-routing → PASS.** `syncDriverHub` stamped `current_hub = la_musa (15.50414, -88.03848)`, version==task; the **phone routed/navigated to the La Musa hub**, not X. Pizza.
- **S2 cross-hub, SERVER side → PASS.** The cross-hub x_pizza order was offered `status=assigned` + deadline + `attempts=1` at assignment time (the swipe-to-accept path) — **not** force-accepted. `driverHasSameHubAccepted` correctly returned false (accepted=la_musa ≠ new=x_pizza). The CAS / same-hub-stacking logic is correct.

## The gap (driver UI, code-confirmed)
When the test driver **already held an accepted la_musa order** and the **cross-hub x_pizza order** arrived (correctly `assigned` / swipe-needed), the driver app rendered it in the **view-only queue** — clicking it shows only a detail modal, **no swipe-to-accept**. The driver **cannot accept the 2nd cross-hub order.**

### Root cause (xpizza-driver/index.html + xpizza-delivery.js)
1. `getDriverOrders` (SDK) sorts by phase: `phaseRank = { delivery:0, pickup:1, awaiting_acceptance:2, completed:3 }`.
   - The **accepted** la_musa order → `pickup.status='accepted'` → phase `pickup` (rank 1).
   - The **new** x_pizza order → `pickup.status='assigned'` → phase `awaiting_acceptance` (rank **2**).
2. `renderActiveAndQueue` (index.html:1819): `const [active, ...rest] = orders` → the **first** order is the **active card** (which *can* show a swipe when `status==='assigned'`, index.html:1258); **the rest go to `renderQueue` → a VIEW-ONLY detail sheet** (index.html:1440, *"Stacked-order queue → view-only detail sheet"*).
3. So a driver with an in-progress order pushes any **new `awaiting_acceptance` order into the view-only queue** → the accept affordance never renders.

### Why it only bites cross-hub
The queue was designed for the **same-hub** stacking model, where a 2nd same-hub order is **auto-accepted** (`status='accepted'` → already accepted → view-only is correct). S2 correctly keeps a **cross-hub** 2nd order as `assigned` (must be manually accepted) — a case the queue UI was never built to handle. This is very likely the **"P2 stacked-order sheet"** noted as *still unbuilt* (see [[sherpa-driver-visual-overhaul]]); S2 made it load-bearing.

## Impact
- **Broken:** cross-hub **simultaneous hold** — a driver already holding an order cannot accept a 2nd order from a different hub. It sits in the view-only queue → 60s acceptance timeout → `monitorAssignmentTimeout` reassigns/escalates. The order is **not lost** (it bounces to the dispatcher or another driver), but the driver-side simultaneous-hold does not work, and there's timeout/escalation friction.
- **Unaffected:** a single order to an **idle** driver (renders as the active card → swipe works — S1 confirmed); **same-hub** stacks (auto-accept → view-only queue is correct).
- La Musa launch uses a **shared driver pool**, so cross-hub simultaneous-hold *will* occur.

## Reproduction
`node /tmp/mh-seed.js <uid>` (la_musa, assigned+accepted) → `node /tmp/mh-seed-xpizza.js <uid>` (cross-hub x_pizza) → observe: x_pizza lands in the view-only queue, no swipe. `node /tmp/mh-cleanup.js <uid>` to tear down. (test uid `HUQ4nOdvNvQcbxoqyYinp8wAC7f2` = xavierlacayo@gmail.com.)

## Decision needed (launch-scope — auditor's / Xavier's call)
1. **Block `la_musa active:true`** until a driver-UI increment lands: surface a **swipe-to-accept for a 2nd `awaiting_acceptance` order** (options: an "incoming order" prompt layered over the active card; an *acceptable* stacked-order sheet; or promote a swipe-needed order without demoting the in-progress delivery). This is its own scoped + gated increment (brainstorm → design → gate → build), NOT a mid-session patch.
   — OR —
2. **Ship with the limitation documented:** cross-hub 2nd orders fall back to dispatcher/idle-driver reassignment as an accepted initial limitation; build the acceptable-2nd-order UI as a fast follow.

Server S1 + S2 are validated; **the remaining `sweep_pending_enabled` flip + `active:true` should factor this finding in.** No code was changed for this finding — it's a report only.

## Auditor addendum — sub-finding: the timeout PENALIZES the driver
The Impact above says the un-accepted order "times out → reassigns" (fail-safe). Verified deeper: `monitorAssignmentTimeout` also **marks the driver with a 3-minute cooldown** (`timeout_until`, index.js:3275/3277), and cooled-down drivers are **excluded from assignment** (index.js:2927 / 3036). So the corner case doesn't merely churn — it **benches a working driver for 3 min for an order they physically could not accept**, shrinking a small launch fleet. Most reachable trigger: a **dispatcher manually assigning** a cross-hub order to a busy driver. This ruled out "ship doc-only."

Grounded severity: `pickEligibleDriver` sorts **idle-first** (index.js:2969) and the sweeper offer-pass is OFF at launch, so the broken case is the **all-drivers-busy cross-hub corner**, not the steady state — but the cooldown makes even the corner actively harmful.

## DECISION (2026-07-01, auditor + Xavier) — BLOCK
**`la_musa active:true` is BLOCKED** until a driver-UI increment makes a **2nd `awaiting_acceptance` order acceptable** (swipe-to-accept without demoting the in-progress order). Chosen over server-side degradation (defers cross-hub stacking efficiency + re-gates S2) and over ship-doc-only (the 3-min cooldown). Full cross-hub simultaneous-hold works day one.

**Path:** DRIVER-APP session scopes the increment (brainstorm → design → propose-first) → **auditor Codex-gates the design** → build (AAB versionCode 12+) → Play internal testing → Xavier re-runs the on-device multi-hub smoke (`/tmp/mh-seed*.js`) → auditor verifies → THEN `sweep_pending_enabled` + `active:true`. Server state stays as-is (S3 live, offer-pass OFF, la_musa DARK) during the driver-UI work.
