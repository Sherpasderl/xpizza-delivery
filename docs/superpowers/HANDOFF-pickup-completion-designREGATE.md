# HANDOFF → AUDITOR: pickup-completion REVISED — codex DESIGN re-gate (`completed`)

**Written:** 2026-07-31 (executor). The `delivered` design gated **REVISE**; owner + advisor reversed it to **`completed`** and source-verified. Executor folded that into the revised spec. **Action:** codex **design re-gate** on the revised spec (still no code). Return **VERDICT: APPROVED / REVISE** + findings. This closes the pickup **rewards** hole → money-adjacent; gate accordingly.

## Gate this
- **Revised spec:** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (commit `2a9c377`, branch `docs/dispatch-redesign-spec`).
- **Advisor's reversal handoff (the source of the design):** `HANDOFF-pickup-completion-REVISED.md` (main `3cec760`).
- Read-only from repo root (`/Users/xavierlacayo/Downloads/xpizza-delivery`): `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null`.

## Design in one line
KDS Completar on `order_type==='pickup'` → also `XPD.setOrderStatus(id,'completed')`. Client-only: KDS write + dashboard aggregate-stats inclusion + pickup-scoped dry-run backfill. **No functions / dispatch / rules change; delivery + driver path byte-untouched; `delivered` stays delivery-only.**

## What's ALREADY been checked (don't re-litigate — confirm, then focus on the NEW surfaces)
The advisor's REVISE already dissolved the `delivered`-version findings by switching to `completed`. Codex should **independently re-verify** the 5 facts below **from source** (don't take them on faith), then spend the budget on the **NEW** dashboard + backfill surfaces this revision introduces.

## Facts to INDEPENDENTLY confirm from source (assert each)
1. **Earn/consume fires on `completed`, already wired.** `earnRewardsOnCompletion` (`xpizza-functions/index.js:2171`, trigger `/orders/{id}/status`) gates on `shouldEarnOnStatus(after) = delivered||completed` (`rewards-core.js:53`) → `creditEarnForOrder` + `settleRedemptionAtConfirm(...,'consume')`. Confirm a `completed` write on a pickup **actually reaches** earn+consume (no earlier guard excludes pickups / no-driver / no-task).
2. **Dispatch clears for free:** `getPickupQueue` done-set already includes `completed` (`xpizza-dispatch/index.html:3416`).
3. **Silent to customer:** `sendOrderStatusNotifications` early-returns unless status ∈ `{out_for_delivery,delivered,cancelled}` (`index.js:3160`) → `completed` ⇒ no WhatsApp.
4. **Leaderboard unaffected:** driver leaderboard keys on `status==='delivered'` (`xpizza-dashboard/index.html:1364`).
5. **`completed` already terminal:** `TERMINAL_DONE` / `cancel-order.js` gate (`completed`→`not_cancelable`) / `sweep-pending` heal treat it terminal; nothing reads `status==='completed'` assuming a driver/task.

## NEW surfaces — SCRUTINIZE HARDEST (added by this revision)
**A. Dashboard split (`xpizza-dashboard/index.html`) — the real new code.** Plan: ADD `completed` to the "completed today" count (`:897`), `completedOrders` (`:920`), `completedSeries` (`:957`), and active-exclusion (`:911`); close label (`:1595`) `completed`→**"Recogido"**; LEAVE `delivered`-only the driver leaderboard (`:1364`), delivery-count (`:1247/1249`), prep-time (`:1254/1256`). VERIFY: (a) those line anchors are the RIGHT sites and the list is COMPLETE (no other place that means "completed order" but checks only `delivered`, causing a pickup to be under/double-counted); (b) the orders-completed vs driver-deliveries split is internally consistent (a pickup counts as a completed order but NOT a driver delivery/prep-metric); (c) no path treats a `completed` pickup as active or as a delivery.

**B. Backfill.** Pickup-scoped (`order_type==='pickup'` AND non-terminal) → `completed`, dry-run-first. VERIFY it cannot touch a delivery order, and that the **retroactive earn/consume** on each backfilled order (fires `earnRewardsOnCompletion`) is correctly flagged as a conscious write — is retro-earning on stale/test pickups acceptable, or should backfill suppress earn (e.g., set a flag / skip trigger)? Call it out.

**C. Money-path scope.** The ONLY money path this touches is the already-gated earn/consume trigger, reached via a status write. Confirm: no NEW money logic; the earn/consume for a pickup behaves correctly (right amount, right redemption consume, idempotent under the KDS write + a possible re-tap).

## Invariants to confirm PRESERVED
Delivery/driver path byte-untouched (branch gated on `order_type==='pickup'`; delivery Completar = local `completedSet`; `completeDeliveryTask` unmodified; no rules/functions edit; `delivered` stays delivery-only). Idempotent (skip terminal). Fail-closed on `setOrderStatus` return.

## OUTPUT
VERDICT APPROVED/REVISE + numbered findings (BLOCKING/NON-BLOCKING). Priority order: (1) does `completed` truly reach earn/consume for a driverless pickup; (2) dashboard split correctness/completeness; (3) backfill retro-earn decision. If clean → executor → writing-plans → build → codex-on-diff.
