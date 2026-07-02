# S3 — Pending-order re-offer sweeper (propose-first, v3, re-grounded)

Parent: `DRIVER_PICKUP_HUB_PLAN.md`. S1+S2 committed. **Re-grounded again (Xavier-directed):** *"SIN ASIGNAR orders are essentially held orders — every pending order should ALWAYS be visible on dispatch."* This **inverts v2** (which hid held orders) and **collapses S3 to its minimum**: no new task status, no timeout-path change — just **one background sweeper that re-offers pending orders**, plus a small **dispatcher park-exemption** (one additive dispatcher-gated `dispatch_parked` field + a dispatch UI toggle) so dispatchers can opt an order out of auto-retry.

## The model
- **SIN ASIGNAR = `'pending'` = always dispatcher-visible.** A no-taker order is not hidden and not a new state — it's a normal pending order in the human pool. **`'held'` status DROPPED.**
- **The entire existing timeout path is UNCHANGED** — `monitorAssignmentTimeout` no-eligible → `'pending'` + `dispatcher_alert` + SIN ASIGNAR; 2-strike takeover; cooldown; Fix-1; grace. **No exception, invariant #1 clean, x_pizza fully preserved.**
- **S3 = ADD ONE background sweeper** (`onSchedule` ~60s, fn 29 → 30) that re-offers **pending, unassigned, auto-assignable** orders to newly-eligible drivers via the normal `pickEligibleDriver` + `buildAssignmentUpdates` (a normal `'assigned'` + 60s-deadline swipe, which re-arms `monitorAssignmentTimeout`). Race-safe with the dispatcher manual-grab. Throttled.

## Reverts / drops vs v2
- **No `'held'` status** → **no `monitorAssignmentTimeout` change** (`:3300`/`:3219` stay), **no `getPendingOrders` change** (pending SHOULD show in SIN ASIGNAR — the v2 "leak-fix" is reverted), **no client `getDriverOrders` change** (a pending null-driver order never reaches a driver grouper). The ONE rules change is additive `dispatch_parked` (dispatcher-gated, both copies) for the park exemption.

## ★ The ONE new x_pizza behavior — TEST-PIN it (prime directive)
Today a pending order that ran out of drivers is **manual-only** — it waits in SIN ASIGNAR for a dispatcher. S3 makes the sweeper **auto-retry** it when a driver frees. This is additive/an improvement, but it IS new x_pizza behaviour → **pinned by a test as the conscious, chosen change.** Everything else in the timeout/assignment path is byte-identical.

## `sweepPendingOrders` (NEW `onSchedule` ~60s)
1. **Find sweepable orders** — mirror `getPendingOrders` (delivery task exists, `!assigned_driver_id`, `status !== 'cancelled'`) PLUS ALL of: order `status ∈ AUTO_ASSIGNABLE_STATUSES` (`new/preparing/ready`); **`created_at <= now - (GRACE_PERIOD_MS + SWEEP_INTERVAL_MS)`** so it can't collide with `autoAssignOnOrderCreate` which still reads/picks/writes *after* its 30s sleep (R1#3); **both** pickup AND delivery unassigned with **no live `assignment_deadline`** (not mid-assignment, R1#3); `retry_count < RETRY_MAX`; and **NOT `order.dispatch_parked`** (the park exemption — below).
2. **Per order, race-safe placement:**
   - `pickEligibleDriver(db, [], hubLat, hubLng)` (order hub) — normal best-driver ranking, no dibs.
   - Eligible → **`runTransaction` CAS-claim on the delivery task's `assigned_driver_id`** (`null → chosen`, only if still null — the field `getPendingOrders` reads, so the claim atomically leaves SIN ASIGNAR + blocks a concurrent grab).
   - **`reassertAssignable(db, chosen, orderId)` — which must EXCLUDE `orderId` from its `orderCount` (R1#1)**, else the just-claimed delivery inflates the driver to `orderCount=2` and a valid stackable candidate is wrongly rejected. (Also re-check `!order.dispatch_parked` here — a dispatcher parking mid-sweep aborts placement.)
   - `ok` → **final park re-read (R2#2):** re-read `orders/${orderId}/dispatch_parked` immediately before the write; if now parked → rollback + skip. Else → `buildAssignmentUpdates(orderId, chosen, 1, true)` — **attempts = 1, a FRESH offer** (R2#1: the 3rd arg is `assignment_attempts`/the 2-strike counter, NOT the sweeper throttle — do NOT pass `retry_count` there) — plus write `tasks/${orderId}_delivery/retry_count = retry_count + 1` **separately**.
   - **reassert FAILS / parked-now → ROLL BACK the CAS (R1#2):** transactionally clear the delivery `assigned_driver_id` back to `null` (only if still `chosen`), so the order returns to SIN ASIGNAR (it isn't hidden). Bump `retry_count`, stamp `last_swept`.
   - No eligible driver → leave `'pending'` in SIN ASIGNAR, **keep waiting for a driver — NO throttle bump**.
3. **Throttle (not a safety net):** `retry_count` (on the **delivery task**) counts actual **offers that then bounced** (a driver was found + assigned but declined → order returns to pending), **NOT no-driver cycles** — so a no-taker order keeps waiting for a driver to free, and the throttle only gives up on an order drivers *repeatedly decline*. After `retry_count >= RETRY_MAX` (default **2**) → **stop auto-retrying but LEAVE it in SIN ASIGNAR** (human looks / parks it). `retry_count`/`last_swept` are additive delivery-task fields (R1#5 — not `assignment_attempts`); no task-rule change.

## Dispatcher park-exemption (Xavier-confirmed) — the per-order escape hatch
Dispatchers deliberately park orders (bad address, awaiting a customer callback, holding for a specific returning driver). So auto-retry is the **default**, and **park is an explicit per-order opt-out** = "behaves like today (sits until a human acts)".
- **`orders/{orderId}/dispatch_parked` — a dispatcher-write-only field.** Rules `.validate` mirrors the existing dispatcher-membership pattern (`root.child('dispatchers').child(auth.uid).exists()`), in **BOTH** `database.rules.json` copies. (This is the ONE rules change in v3 — additive, dispatcher-gated.) The sweeper (Admin) reads it.
- **Sweeper skips parked** — excluded from the candidate query (step 1) AND re-checked inside the claim/reassert guard (step 2), so a dispatcher parking an order mid-sweep aborts the placement.
- **Dispatch UI** (`xpizza-dispatch/index.html`): a park/un-park toggle on the SIN ASIGNAR card + a visible "parked" indicator (dispatcher can tell parked from actively-auto-retrying). Parked orders **stay in SIN ASIGNAR** (visible, fully dispatcher-actionable) — just exempt from the sweeper.
- **Park lifecycle (sub-decision — RESOLVED, Xavier's lean, justified):** `dispatch_parked` is the dispatcher's **standing intent → it PERSISTS** until they explicitly un-park or the order completes/cancels. A **dispatcher manual-assign IS the release** (clears `dispatch_parked` — assigning it is an explicit act that supersedes the park). A **driver-decline bounce on a NON-parked order stays non-parked** (auto-retry resumes). Justification: if park cleared on every assign→decline bounce, a parked order the dispatcher assigns to a specific driver who declines would silently re-enter auto-retry — defeating the standing intent; persisting until explicit release preserves it, while the manual-assign-clears rule lets the dispatcher hand it off cleanly.

## Race-safety (dispatcher grab INCLUDED) — RESOLVED: CAS on both sides (auditor overrule)
The sweeper's CAS is on the **delivery task's `assigned_driver_id`** (the field `getPendingOrders` reads): concurrent sweeps are mutually exclusive, and claiming delivery is invisible to `monitorAssignmentTimeout` (which watches the *pickup*'s `assigned_driver_id`) so the claim doesn't spuriously fire a timer. But a plain-`.update` dispatcher `assignOrderToDriver` (`xpizza-dispatch/xpizza-delivery.js:647`) racing the sweeper would resolve last-writer → a **driver-facing double-offer** (a driver gets a swipe for an order that's now someone else's → stale offer → failed accept → confusion). Unacceptable on the riskiest slice.
**Fix (auditor overrule of the earlier last-writer lean): make `assignOrderToDriver` CAS-aware** — assign only if **both pickup and delivery are currently unassigned** (transactional guard), else fail gracefully (surface "ya fue asignada" to the dispatcher). This closes the sweeper race cleanly AND fixes the pre-existing **dispatcher-vs-dispatcher** race (two dispatchers grabbing the same SIN ASIGNAR order) for free. Applies to all 5 `xpizza-delivery.js` copies (identical body, the E5/S2 pattern). Last-writer is the wrong default for a driver-facing assignment.
*(Note: the delivery-CAS-claim briefly hides the order from SIN ASIGNAR during the claim→finalize window; a rolled-back sweep flickers it out+back in ms — acceptable, and the rollback path MUST restore the null `assigned_driver_id` so it never stays hidden.)*

## Invariants
1. **Whole timeout/assignment path byte-identical** — nothing in `monitorAssignmentTimeout`/`autoAssignOnOrderCreate`/`buildAssignmentUpdates` changes. **Pin:** goldens for first-strike reassign, 2-strike takeover, cooldown, no-eligible→pending+alert, stack-on-accept.
2. **No black hole BY CONSTRUCTION** — a pending order is always dispatcher-grabbable; the sweeper is a *bonus* retry, not a safety net. The `RETRY_MAX` throttle only stops auto-retry; the order stays visible.
3. **Race-safe** — delivery-task CAS + `reassertAssignable` (sweeper vs dispatcher vs concurrent sweeps).
4. **x_pizza** — the sweeper is hub-agnostic; it re-offers x_pizza pending orders identically. The single new behaviour (auto-retry) is the test-pinned conscious change.

## Cross-hub simultaneous hold — still works, via this
Driver 1 (`at_restaurant`, order A) is auto-assigned cross-hub B (normal swipe, S2 unchanged) → leaves with A without accepting B → B times out → `'pending'`/SIN ASIGNAR (visible) → the sweeper re-offers → when driver 1 finishes A **or** driver 2 frees, the sweeper assigns B (normal swipe). No dibs, best-ranked wins, dispatcher can grab B anytime.

## Settled sub-decisions (auditor)
- `RETRY_MAX` = **2**; sweeper cadence ~**60s** (new Cloud Scheduler dependency — runbook flag).
- **Deploy-gating (Codex S3a High):** the sweeper is gated behind **`config/sweep_pending_enabled` (default OFF)** + honors `config/auto_assign_enabled`. So S3a can deploy **dormant**; flip the flag **only after S3b (`assignOrderToDriver` CAS) is live**, otherwise the sweeper could overwrite a dispatcher grab that lands between its CAS-claim and finalize. Doubles as a kill-switch.
- **Dispatcher-grab race → CAS on `assignOrderToDriver`** (resolved above, overruling last-writer).
- **Sweepable predicate = a first-class, unit-tested pure helper `sweepDecision(order, tasks, now, {graceMs, sweepIntervalMs, retryMax})`** → `{sweep:true}` iff ALL: order `status ∈ AUTO_ASSIGNABLE_STATUSES` (excludes cancelled/completed/pending_payment/no-tasks); **both** pickup+delivery tasks exist, `!assigned_driver_id`, `status !== 'cancelled'`; **no live `assignment_deadline`** on either; `retry_count < retryMax`; **not `order.dispatch_parked`**; `created_at <= now - (graceMs + sweepIntervalMs)`. Else `{sweep:false, reason}`. A too-loose predicate is the main way this sweeper misbehaves → this is the core test target.

## Test plan
- Pure helper `sweepDecision(order, tasks, now, {graceMs, retryMax})` → `sweep | skip(reason)` — unit-tested (grace, retry throttle, cancelled, already-assigned, non-auto-assignable).
- Goldens: the full timeout path unchanged (invariant #1).
- ★ New-behaviour pin (BOTH cases): **unparked** pending no-driver order + a newly-eligible driver → sweeper assigns it (the conscious x_pizza change); **`dispatch_parked`** pending order → **skipped, stays visible in SIN ASIGNAR**. Plus: retry throttle stops after `RETRY_MAX` but leaves it visible; CAS-claim aborts when the dispatcher grabbed first; reassert-fail rolls back the CAS (order returns to SIN ASIGNAR); `reassertAssignable` excludes `orderId` from `orderCount`.
- **Reassert exclusion edit:** `reassertAssignable(db, driverId, newOrderId)` (from S2) gets `orderCount` computed **excluding `newOrderId`'s tasks** — pin with a unit test (a driver with 1 stackable order is still eligible when the new order is the one being placed).

## Out of scope
Ready-time policy; S4 (per-hub pickupComplete + phase); S5 (dispatcher held/pending enhancements).
