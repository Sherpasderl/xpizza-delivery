# Pickup-order completion — design spec (REVISED: `completed`, not `delivered`)

**Date:** 2026-07-31 · **Status:** design REVISED per advisor codex design-gate + owner devil's-advocate. Supersedes the `delivered` version (`ab1e15a`, gated REVISE). Advisor handoff: `HANDOFF-pickup-completion-REVISED.md` (main `3cec760`). Awaiting advisor DESIGN re-gate on this revision.
**One-line:** when the KDS "Completar" fires on a **pickup** order, write **`status='completed'`** — which earns rewards + consumes redemption (already wired), clears the dispatch queue, and closes the order in stats. **No functions / dispatch / rules change. Delivery + driver path 100% untouched; `delivered` stays delivery-only.**

## 1. Problem (bigger than the queue)

Customer-pickup orders (`order_type:'pickup'`) never reach a terminal status — no driver, no delivery task, and the only `delivered` transition (`completeDeliveryTask`, `xpizza-delivery.js:461`) never fires. Consequences:
- **Rewards hole (the real one):** pickups **never earn rewards** — an entire channel, including X. Pizza's pickup-only 18″ NY. This must close **before/with the rewards redemption launch** so the program launches whole.
- They linger in dispatch **En Fila → Recoger**, and are invisible to dashboard completed-stats.
- Confirmed live: `PZX-260726-140358-K976W1PP` sits at `ready`, collected weeks ago.

## 2. Decision — write `status='completed'` (NOT `delivered`)

`completed` is the codebase's intended terminal-fulfilled-without-delivery status ("intended-but-never-written today"). `delivered` is delivery-only and reusing it would misfire driver/customer paths. The KDS taps Completar on a `order_type==='pickup'` order → also `setOrderStatus(id,'completed')`.

## 3. Why `completed` is correct (source-verified — assert, don't take on faith)

1. **Earns + consumes redemption, ALREADY WIRED — no functions change.** `earnRewardsOnCompletion` (`xpizza-functions/index.js:2171`, trigger `/orders/{id}/status`) gates on `shouldEarnOnStatus(after) = delivered||completed` (`rewards-core.js:53`) → fires on `completed` → `creditEarnForOrder` (earn) + `settleRedemptionAtConfirm(...,'consume')`. Comment: *"CASH primary redemption consume at delivered/completed."*
2. **Clears En Fila for free — no dispatch change.** `getPickupQueue` done-set = `{cancelled,delivered,completed,picked_up}` (`xpizza-dispatch/index.html:3416`) → **already excludes `completed`.**
3. **Silent to the customer (correct) — no functions change.** `sendOrderStatusNotifications` early-returns unless status ∈ `{out_for_delivery,delivered,cancelled}` (`index.js:3160`) → `completed` sends **no WhatsApp**; the pickup customer's last touchpoint stays the ready-stage `tplPickupReady` *"¡Tu pedido está listo para recoger!"*. (Dissolves the `delivered`-version codex finding ③.)
4. **No leaderboard pollution.** The driver leaderboard keys on `status==='delivered'` (`xpizza-dashboard/index.html:1364`) → `completed` pickups never enter it. (Dissolves finding ②.)
5. **No misbehaving consumer.** Terminal-sets already treat `completed` as terminal (`TERMINAL_DONE`; `cancel-order.js` gate → `not_cancelable`; `sweep-pending` heal). Nothing reads `status==='completed'` assuming a driver/task.

## 4. Build — client-only (KDS + dashboard) + a backfill. NO functions, NO dispatch, NO rules.

**4.1 KDS — `xpizza-kitchen/index.html`** (~`:2082`, the Completar `completedSet.add(id)` beat): **only when `order.order_type==='pickup'`**, also `await XPD.setOrderStatus(id,'completed')`. Honor the return contract (`false`=ownership-skip / throw → do NOT local-bump, surface the existing error). **Idempotent:** only transition a non-terminal pickup. Delivery Completar stays the local `completedSet` bump — **do not touch it**; `completeDeliveryTask` + driver status path stay **byte-untouched**.

**4.2 Dashboard — `xpizza-dashboard/index.html`** (count pickups as completed in the AGGREGATE; keep driver metrics `delivered`-only — a deliberate *orders-completed* vs *driver-deliveries* split):
- **ADD `completed`** to: "completed today" count (`:897`), `completedOrders` (`:920`), `completedSeries` (`:957`), and the **active-exclusion** (`:911`, so a completed pickup isn't counted "active").
- **Close label** (`:1595`): a `completed` order reads **"Recogido"** (currently only `delivered`→"Entregado").
- **LEAVE `delivered`-only**: the driver **leaderboard** (`:1364`), the delivery-count (`:1247/1249`), and prep-time metrics (`:1254/1256`) — driver/delivery measures.

**4.3 Backfill** — pickup-scoped, **dry-run-first** script: `order_type==='pickup'` **AND** non-terminal status → set `status='completed'`. Review the dry-run list before writing; **cannot touch a delivery order**. Note: each backfilled order fires `earnRewardsOnCompletion` → **retroactive earn/consume** — **accepted** (launch-status = test orders only, low stakes) but printed in the run as a conscious write.

## 5. Idempotency & errors

Only transition a non-terminal pickup (skip if `status ∈ {completed,delivered,cancelled}`). Honor `setOrderStatus` return: `false`/throw → no card bump, surface the KDS's existing error path (no silent success). Fail-closed.

## 6. Invariants (owner hard constraint)

Delivery/driver path byte-untouched: change gated on `order_type==='pickup'`; delivery Completar = local `completedSet`; `completeDeliveryTask` unmodified; **no rules edit; no functions edit; `delivered` stays delivery-only.**

## 7. Files / surfaces

- **`xpizza-kitchen/index.html`** — one `order_type==='pickup'` branch in Completar.
- **`xpizza-dashboard/index.html`** — aggregate-stats `completed` inclusion + "Recogido" label (driver metrics unchanged).
- **Backfill script** (one-off, pickup-scoped, dry-run) — e.g. `scripts/backfill-pickup-completion.mjs`.
- **NOT touched:** `xpizza-functions/*` (the earn/consume trigger already handles `completed`), `xpizza-dispatch/*`, RTDB rules, `xpizza-delivery.js` (any copy), the driver app.

## 8. Testing

- **Pure:** the KDS branch predicate + idempotency guard (`order_type==='pickup' && !terminal(status)`), extracted so it's testable without the DOM. Dashboard `completed`-inclusion assertions where feasible.
- **On-device (the proof):** a pickup order in the KDS → Completar → `orders/{id}/status='completed'` in RTDB → leaves dispatch En Fila → Recoger; earn credited + any redemption consumed (verify against the rewards ledger); dashboard aggregate "completed" +1 and label "Recogido"; **no WhatsApp sent**; driver leaderboard/metrics unchanged. Then confirm a **delivery** order's Completar is unchanged (local bump; status untouched) and the driver "¡Entregado!" path still writes `delivered`+`delivered_at`.
- **Backfill:** dry-run prints the pickup-only candidates; confirm no delivery `order_id` before writing; note the retroactive earn.

## 9. Gating

- Advisor **codex DESIGN re-gate** on this revised spec (should be clean given §3 source-verification).
- Then writing-plans → build → advisor **codex-on-diff (money-adjacent** — the KDS `completed` write triggers the already-gated `earnRewardsOnCompletion` earn/consume; the gate confirms the trigger path, the delivery-path byte-untouched invariant, dashboard split, and backfill scope).

## 10. Deploy

`xpizza-kitchen/` = per-folder Netlify, **TWO sites** (lamusakitchendisplay + X. Pizza) — explicit `--site` each ([[netlify-deploy-mechanics]]). `xpizza-dashboard/` = its own site. **No functions/rules deploy.** **Fold into the rewards launch** — ship pickup earning **before/with** the redemption flip so the program launches whole.

## 11. Out of scope

`delivered_at`/`picked_up_at` for pickups; any delivery-path change; a distinct new status; Phase-2 comms.
