# HANDOFF → EXECUTOR: pickup-order completion — REVISED design (`completed`, not `delivered`)

**Written:** 2026-07-31 (advisor). **Supersedes** the `delivered`-based spec (`ab1e15a`) that design-gated **REVISE**.
Owner played devil's-advocate; advisor verified from source and **reversed the design to `completed`** — cleaner,
smaller, and it wires the earn/redemption-consume path the codebase was already built for. **Delivery/driver path
stays 100% untouched (owner's hard constraint) — `delivered` remains delivery-only.**

## The decision
Pickup orders never reach a terminal status → never earn rewards (a hole in a whole channel, incl. X. Pizza's
pickup-only 18″ NY). **Fix: when the kitchen taps Completar on a `order_type==='pickup'` order, also write
`status='completed'`** (NOT `delivered`). That one write earns rewards, consumes any redemption, clears the
dispatch queue, and closes the order in stats — with **no functions change and no dispatch change**.

## Why `completed` (source-verified — assert these, don't take on faith)
1. **Earns + consumes redemption, already wired.** `earnRewardsOnCompletion` (`xpizza-functions/index.js:2171`,
   trig `/orders/{id}/status`) gates on `shouldEarnOnStatus(after)` = `delivered||completed`
   (`rewards-core.js:53`) → fires on `completed` → `creditEarnForOrder` (earns) + `settleRedemptionAtConfirm(...,
   'consume')`. Comment: *"CASH primary redemption consume at delivered/completed."* → **NO functions change.**
2. **Clears the En Fila queue for free.** `getPickupQueue` done-set = `{cancelled,delivered,completed,picked_up}`
   (dispatch `index.html:3416`) → **already excludes `completed`.** → **NO dispatch change.**
3. **Silent to the customer (correct).** `sendOrderStatusNotifications` early-returns unless status ∈
   `{out_for_delivery,delivered,cancelled}` (`index.js:3160`) → `completed` sends **no WhatsApp**. The pickup
   customer's touchpoint stays the ready-stage *"¡Tu pedido está listo para recoger!"* (`tplPickupReady`). No
   redundant "Entregado". → **codex finding ③ dissolves, no functions change.**
4. **No leaderboard pollution.** The driver leaderboard keys on `status==='delivered'` (`xpizza-dashboard/
   index.html:1364`) → `completed` pickups never enter it. → **codex finding ② dissolves, no exclusion code.**
5. **No misbehaving consumer.** Nothing reads `order.status==='completed'` assuming a driver/task; terminal-sets
   (`TERMINAL_DONE`, `cancel-order.js` gate→`not_cancelable`, `sweep-pending` heal) already treat `completed` as
   terminal. `order.status='completed'` is intended-but-never-written today → wiring the KDS completes the design.

## BUILD — the whole change set (client-only + a backfill; NO functions, NO dispatch, NO rules)
1. **KDS** `xpizza-kitchen/index.html` (~`:2082`, the Completar handler): **only when `order.order_type==='pickup'`**,
   also `await XPD.setOrderStatus(id,'completed')`. Delivery Completar stays the local `completedSet` bump —
   **do not touch it**; `completeDeliveryTask` and the driver status path stay **byte-untouched**. Honor the
   `setOrderStatus` return (`false`/throw → no local completed-bump, surface the error). Idempotent: only
   transition a non-terminal pickup.
2. **Dashboard** `xpizza-dashboard/index.html` — count pickups as completed in the AGGREGATE, keep driver metrics
   `delivered`-only (deliberate split *orders-completed* vs *driver-deliveries*):
   - **Add `completed`** to: the "completed today" count (`:897`), `completedOrders` (`:920`), `completedSeries`
     (`:957`), and the **active-exclusion** (`:911`, so a completed pickup isn't counted "active").
   - **Close label** (`:1595`): a `completed` order should read **"Recogido"** (currently only `delivered`→"Entregado").
   - **LEAVE `delivered`-only**: the driver **leaderboard** (`:1364`), the delivery-count (`:1247/1249`), and the
     prep-time metrics (`:1254/1256`) — those are driver/delivery measures.
3. **Backfill** — a pickup-scoped, **dry-run-first** script: `order_type==='pickup'` **AND** non-terminal → set
   `status='completed'`. Review the dry-run list before writing. **Cannot touch a delivery order.** Note: each
   backfilled order will fire `earnRewardsOnCompletion` → retroactive earn/consume; **accepted** (launch-status =
   test orders only, low stakes) — but call it out in the run so it's a conscious write.

## Invariants (owner hard constraint)
Delivery/driver path byte-untouched: change gated on `order_type==='pickup'`; delivery Completar = local
`completedSet`; `completeDeliveryTask` unmodified; **no rules edit; no functions edit; `delivered` stays
delivery-only.** Idempotency + fail-closed on the `setOrderStatus` return. Backfill strictly pickup + non-terminal
+ dry-run-reviewed.

## Codex-gate carry-over
- **① earning on completion = the FEATURE** (this is what closes the rewards hole) — accepted; the backfill
  retroactive-earning note carries (low-stakes now, real once volume ramps).
- **② leaderboard / ③ WhatsApp = DISSOLVED** by using `completed` (see facts 3 & 4).

## Flow
Revise the spec `delivered`→`completed` (fold the above) → **advisor codex DESIGN re-gate** on the revised spec
(should come back clean given the source-verification) → writing-plans → build → **advisor codex-on-diff
(money-adjacent** — the KDS write triggers the already-gated earn/consume) → deploy.

## Deploy note (FYI, not gated)
KDS = per-folder Netlify, **TWO sites** (lamusakitchendisplay + X. Pizza) — explicit `--site` each (or git-CD if
wired). Dashboard = its own site. **No functions/rules deploy.** **Fold into the rewards launch — ship pickup
earning before/with the redemption flip** so the program launches whole.
