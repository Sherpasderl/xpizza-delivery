# Pickup-order completion — design spec (v4: `completed`, complete consumer matrix, on current main)

**Date:** 2026-07-31 · **Status:** REVISED (v4) — folds the re-gate's findings ⑤⑥⑦ **plus** a full systematic enumeration so the design is **complete-by-construction** (next gate confirms, not discovers). **Base = `origin/main` `c09fe12`** (post-rewards-v2). Worktree **`feat/pickup-completion`**. Supersedes v3 (`9f29872`).
**One-line:** KDS "Completar" on a **pickup** order → write `status='completed'`, and wire `completed` into **every** terminal/active consumer that currently only knows `delivered`. Earns rewards + consumes redemption (already wired). **Delivery + driver path byte-untouched; `delivered` stays delivery-only.**

## 1. Problem
Pickup orders (`order_type:'pickup'`) never reach a terminal status → never earn rewards (whole channel, incl. X. Pizza pickup-only 18″), linger in dispatch En Fila, invisible to completed-stats. Close **before/with the rewards redemption launch**.

## 2. Decision — reuse `completed` (NOT `delivered`, NOT a new `PickupCompleted`)
- `completed` is the codebase's **intended-but-never-written** terminal-fulfilled-without-delivery order status. **Verified: nothing writes `order.status='completed'` today** (the only `completed` in code is `TASK_STATUS.COMPLETED`, a task status). So once pickups write it, `order.status==='completed'` **uniquely means "a pickup was collected"** — de-facto pickup-unique, no parallel status needed.
- **Why not a new `PickupCompleted`:** it's wired into NOTHING — it would need the money/terminal machinery re-taught (incl. editing `rewards-core.js shouldEarnOnStatus` — a money-path change) that `completed` gets for free, AND the same display wiring (unmapped statuses hit the same bad defaults). Strictly more work + more money-path risk, no reduction in audit burden.
- **Why not `delivered`:** delivery-only; would fire the driver leaderboard, a redundant "Entregado" WhatsApp, driver-delivery metrics.

## 3. THE COMPLETE CONSUMER MATRIX (every `status` terminal/active branch, verified on main)

### 3A. FIX — wire `completed` as terminal / "Recogido" (the whole change set)

**KDS — `xpizza-kitchen/index.html`**
- **K1** (~:2082, Completar handler): **only when `order.order_type==='pickup'`** → `await XPD.setOrderStatus(id,'completed')`. Honor return (`false`/throw → no local bump, surface error). **Idempotent:** skip if `status ∈ {completed,delivered,cancelled}`. *The write.*
- **K2** (:2752, status→estado map): `else if (o.status==='delivered' || o.status==='completed') estado='Archivado'`. Else `completed` → `else→'Nuevo'` and a server-completed pickup **reappears as a NEW ticket** on any device without the local `completedSet`. (`deriveTab` then classifies Archivado→Completed tab — auto-covered.)

**Dashboard — `xpizza-dashboard/index.html`**
- **D1 [MONEY]** (:1718, `actionConfig` universal-cancel gate `if (o.status !== 'delivered' && !inReconFlow)`): add `&& o.status !== 'completed'` → no bogus Cancelar/**Reembolsar** on a fulfilled pickup.
- **D2** (:1446, `statusBucket`): add `if (s==='completed') return 'completed';` before the `return 'active'` → not shown active.
- **D3** (:897, "completed today" count) / **D4** (:911, active exclusion `!['delivered','cancelled']`) / **D5** (:920, `completedOrders`) / **D6** (:957, `completedSeries`): include `completed` (aggregate orders-completed).
- **D7** (:1595, `closeLabel`): `completed → 'Recogido'`.
- **D8** (:560, filter `<option>`): add `<option value="completed">Recogidos</option>` so the D2 bucket is filterable.

**Dispatch — `xpizza-dispatch/index.html`**
- **DI1** (:4001, closed/history list filter `status==='delivered' || 'cancelled'`): add `|| status==='completed'` (finding ⑥ — else completed pickups vanish from closed search).
- **DI2** (:4030, closed `dCount`): `dCount = filter(status==='delivered' || status==='completed')` — else `cCount = total - dCount` miscounts a completed pickup as ✕/cancelled.
- **DI3** (:4228, detail-modal status pill): add `completed → "Recogido"` pill (finding ⑧ — else shows raw "completed").
- **DI4** (:3122, `getDeliveredTodayCount` topbar KPI): **include `completed`** → `(status==='delivered' || status==='completed') && created_at>=dayStart`. *Decision: done-today = delivered + completed pickups, consistent with the dashboard aggregate. Label "Entregados" stays; semantically "hoy".*

**Tracker — `xpizza-track/index.html`** (finding ⑤ — customer-facing)
- **T1** (:728, `progressStep`): `else if (status==='delivered' || status==='completed') progressStep=4`.
- **T2** (:732, `pickupDone`): `isPickup && (status==='ready' || status==='delivered' || status==='completed')`.
- **T3** (:783, terminal copy branch): add `|| status==='completed'`, with pickup-appropriate **"Recogido"** heading (a completed order is always a pickup). (:738 auto-covered via T2.)

**Account "Mis pedidos" — BOTH copies** (finding ⑦ — customer-facing)
- **A1** `xpizza-orders/account.js` (:1376, `orderStatusPill`) + **A2** `la-musa-orders/account.js` (:1380): add `case 'completed': return { label: 'Recogido', cls: 'ok' };` before the `default: 'En preparación'`.

**Functions — `xpizza-functions/index.js`** ⚠ **the one functions change → functions deploy required**
- **F1** (:3738, inbound WhatsApp status-check active filter `status !== 'delivered' && status !== 'cancelled'`): add `&& o.status !== 'completed'` → a customer texting after pickup no longer gets an "active order" reply.

### 3B. LEAVE `delivered`-only (deliberate — delivery/driver measures)
Dashboard `isPlausibleDelivery` (:805), delivery-count (:1247/:1249), prep-time (:1254/:1256), **driver leaderboard** (:1364), `rv-delivered` display (:1260). Functions: tracking `delivered_at` stamp (:3111 — the mirror already propagates the status; `delivered_at` is delivery-specific), `tplDelivered` (:3242 — unreachable for `completed` via the :3160 notify guard). Dispatch `closedTime` (:3998 — `completed` has no `delivered_at`, sorts by `created_at`; accepted, Option A).

### 3C. ALREADY HANDLES `completed` — NO CHANGE (verified on main)
- `rewards-core.js:53` `shouldEarnOnStatus = delivered||completed` → **earns + consumes** (the feature).
- `cancel-order.js:19` `TERMINAL_SUCCESS = {delivered,completed}` → **not-cancelable**.
- `sweep-pending.js:27` `HEAL_TERMINAL_STATUSES` incl `completed`; `sweepConsumeRecovery` incl `completed`.
- dispatch `getPickupQueue` done-set (:3417) excludes `completed`; dispatch modal cancel-guard (:4390) excludes `completed`.
- functions `mirrorStatusToHistory` (:2147) — status-agnostic → propagates `completed` to `user_orders` (feeds A1/A2).
- functions `onOrderCancelled` (:2569) — fires only on `cancelled` → ignores `completed`.
- functions `sendOrderStatusNotifications` (:3160) — early-returns unless `{out_for_delivery,delivered,cancelled}` → `completed` silent (no WhatsApp).
- functions `logOrderLifecycle` (:3276) — logs the transition + `timelineStampKey('completed')='completed_at'` (valid, harmless, useful).
- tracking status mirror (:3111) — propagates `completed` to `order_tracking.status` (feeds the tracker T1–T3).

## 4. Backfill
Pickup-scoped, **dry-run-first** script: `order_type==='pickup'` AND non-terminal status → `completed`. Cannot touch a delivery order. Retroactive earn/consume fires per order — **idempotent** (earn via `earn_${orderId}`; consume state-machine idempotent; `sweepConsumeRecovery` includes `completed`) → safe on re-run. Accepted (launch = test orders, low stakes); printed as a conscious write.

## 5. Money & delivery — verified sound (advisor money sweep)
Driverless pickup `completed` → `earnRewardsOnCompletion` → `creditEarnForOrder` (earn) + `settleRedemptionAtConfirm('consume')`, no driver/task guard; idempotent under KDS re-tap + backfill; cancel/reversal blocks `completed`. **Delivery/driver SDK byte-untouched** — `completeTask` writes `delivered` only for delivery tasks; task-level `completed` stays a task status, never the order terminal.

## 6. Invariants (owner hard constraint)
Change gated on `order_type==='pickup'`; delivery Completar = local `completedSet` (untouched); `completeDeliveryTask` unmodified; **`delivered` stays delivery-only**; no rules edit. Idempotent + fail-closed on `setOrderStatus` return. Backfill strictly pickup + non-terminal + dry-run-reviewed.

## 7. Lesson (baked in — from the re-gate)
Reusing an intended-but-**unwired** enum status = **audit EVERY terminal/active check** (buckets, action gates, estado maps, tracker steps, closed/history filters, inbound/outbound comms, cancel-gate, sweeper, leaderboard, status mirror, lifecycle stamps), not just earn+queue+stats — because unmapped statuses fall to a wrong default. Corollary: **run verification on the CURRENT build base** (the v3 gate ran stale and mis-reported the consume path + every line number).

## 8. Files touched (complete)
`xpizza-kitchen/index.html` (K1,K2) · `xpizza-dashboard/index.html` (D1–D8) · `xpizza-dispatch/index.html` (DI1–DI4) · `xpizza-track/index.html` (T1–T3) · `xpizza-orders/account.js` (A1) · `la-musa-orders/account.js` (A2) · `xpizza-functions/index.js` (F1) · backfill script. **NOT touched:** RTDB rules; `xpizza-delivery.js` (any copy); the driver app; all §3C machinery.

## 9. Testing
Per-consumer assertions where pure (bucket/pill/estado/tracker/inbound-filter for `completed`). **On-device proof:** pickup → KDS Completar → `status='completed'` → (a) earns + consumes (rewards ledger); (b) leaves dispatch En Fila, appears in closed search, detail pill "Recogido", topbar done +1; (c) dashboard: completed aggregate +1, "Recogido", NOT active, NO refund action; leaderboard/prep unchanged; (d) KDS 2nd device shows it Archivado (not Nuevo); (e) tracker shows terminal "Recogido" (not step-1); (f) "Mis pedidos" shows "Recogido" (not "En preparación"); (g) customer text → not "active order"; no WhatsApp. Then: delivery Completar + driver "¡Entregado!" path verified unchanged. Backfill: dry-run pickup-only list reviewed; retro-earn noted.

## 10. Gating & deploy
Advisor **codex DESIGN re-gate** on v4 (should CONFIRM — matrix is complete-by-construction; look for any 12th consumer). → writing-plans → build → **codex-on-diff money-adjacent** (KDS `completed` write triggers earn/consume; D1 cancel-gate; F1 functions). Deploy: `xpizza-kitchen/` (2 Netlify sites), `xpizza-dashboard/`, `xpizza-track/`, `xpizza-orders/` + `la-musa-orders/` (their sites), **and a functions deploy** ([[prod-functions-deployed-state]]/[[functions-env-management]]). **Fold into the rewards launch.**

## 11. Out of scope
`delivered_at`/`picked_up_at` for pickups; delivery-path change; a distinct new status; Phase-2 comms.
