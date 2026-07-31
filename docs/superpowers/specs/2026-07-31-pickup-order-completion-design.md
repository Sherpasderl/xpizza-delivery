# Pickup-order completion — design spec (v3: `completed`, on current main, + missed terminal/active consumers)

**Date:** 2026-07-31 · **Status:** REVISED per advisor codex re-gate (REVISE). Supersedes the dispatch-branch spec (`2a9c377`). **Base = current `origin/main` `c09fe12`** (post-rewards-v2 merge) — the consume path (`settleRedemptionAtConfirm`) lives there; the dispatch branch is stale for this work. Built on worktree **`feat/pickup-completion`**. Awaiting advisor DESIGN re-gate on this v3.
**One-line:** when the KDS "Completar" fires on a **pickup** order → write `status='completed'`, and wire `completed` into the four terminal/active checks that currently only know `delivered`. Earns rewards + consumes redemption (already wired on main). **Delivery + driver path byte-untouched; `delivered` stays delivery-only.**

## 1. Problem
Pickup orders (`order_type:'pickup'`) never reach a terminal status → **never earn rewards** (whole channel, incl. X. Pizza pickup-only 18″), linger in dispatch En Fila, invisible to completed-stats. Must close **before/with the rewards redemption launch**.

## 2. Decision — `status='completed'` (NOT `delivered`)
`completed` is the codebase's intended-but-never-written terminal-fulfilled-without-delivery status. On main it earns+consumes; `delivered` is delivery-only and would misfire driver/customer paths.

## 3. Why `completed` (source-verified on main `c09fe12`)
1. **Earns + consumes, wired — no NEW money logic.** `earnRewardsOnCompletion` (`xpizza-functions/index.js`, trigger `/orders/{id}/status`) gates on `shouldEarnOnStatus = delivered||completed` (`rewards-core.js`) → `creditEarnForOrder` + `settleRedemptionAtConfirm(...,'consume')`. (On the stale dispatch branch consume didn't exist — the re-gate's ① finding proves the build MUST be on main.)
2. **Silent to customer:** `sendOrderStatusNotifications` early-returns unless status ∈ `{out_for_delivery,delivered,cancelled}` (`index.js:3160`) → `completed` sends no WhatsApp.
3. Dispatch `getPickupQueue` already excludes `completed`; leaderboard is `delivered`-only; cancel-gate blocks `completed`; sweeper treats it terminal. (Confirmed clean.)

## 4. ⚠ The crux — `completed` is not yet wired into 4 terminal/active checks (re-gate ②③)
Reusing an intended-but-**unwired** status means every "is this order done/active?" check that keys on `delivered` must learn `completed`, or a completed pickup is mis-treated. Codex found 4 (located by LOGIC on main — its line numbers were from the stale branch):

1. **[MONEY — highest priority] Dashboard `actionConfig` cancel gate** (`xpizza-dashboard/index.html`, the `if (o.status !== 'delivered' && !inReconFlow)` universal-cancel block, ~:1720). `completed !== 'delivered'` → it offers **Cancelar/Reembolsar on a fulfilled pickup**. **Fix:** guard `o.status !== 'delivered' && o.status !== 'completed' && !inReconFlow`.
2. **Dashboard `statusBucket`** (`index.html:1442`): only `cancelled`/`delivered`/`pending_payment` are non-active; everything else → `'active'`, so `completed` → shows **active**. **Fix:** bucket `completed` as terminal (own `'completed'` bucket, consistent with §5 aggregate stats — not `'active'`).
3. **KDS status→estado map** (`xpizza-kitchen/index.html`, `else if (o.status === 'delivered') estado='Archivado'`, ~:2755): `completed` falls to the `else → 'Nuevo'`, so a server-completed pickup **reappears as a NEW ticket on any KDS device without the local `completedSet`**. **Fix:** `else if (o.status === 'delivered' || o.status === 'completed') estado='Archivado'`.
4. **[FUNCTIONS] WhatsApp inbound status-check** (`xpizza-functions/index.js:3738`, the active-order filter `o.status !== 'delivered' && o.status !== 'cancelled'`): a customer texting after pickup gets a "your order is active, here's tracking" reply for a done order. **Fix:** `&& o.status !== 'completed'`. **This makes the change touch functions → a functions deploy is required** (contra the earlier "no functions change" claim). Deploy must include the full fn set ([[prod-functions-deployed-state]]) + env care ([[functions-env-management]]).

## 5. Build — the full change set (base = main `c09fe12`)
1. **KDS** `xpizza-kitchen/index.html`: (a) Completar handler — **only when `order.order_type==='pickup'`**, also `await XPD.setOrderStatus(id,'completed')` (honor return: `false`/throw → no local bump, surface error; idempotent — skip if already terminal); (b) the §4.3 status→estado `completed→Archivado` fix. Delivery Completar (local `completedSet`) + `completeDeliveryTask` **byte-untouched**.
2. **Dashboard** `xpizza-dashboard/index.html`: §4.1 (actionConfig cancel gate) + §4.2 (statusBucket terminal) + the AGGREGATE stats inclusion — add `completed` to the "completed today" count, `completedOrders`, `completedSeries`, and active-exclusion; close-label reads **"Recogido"** for `completed`; **LEAVE `delivered`-only** the driver leaderboard, delivery-count, and prep-time metrics (deliberate orders-completed vs driver-deliveries split).
3. **Functions** `xpizza-functions/index.js`: §4.4 — add `&& o.status !== 'completed'` to the inbound status-check active filter (`:3738`). No other functions logic changes (earn/consume already handles `completed`).
4. **Backfill** — pickup-scoped, dry-run-first: `order_type==='pickup'` AND non-terminal → `completed`. Cannot touch a delivery order. Retroactive earn/consume fires per order (idempotent via `earn_${orderId}` — verified by the re-gate); accepted (test orders, low stakes) but printed as a conscious write.

## 6. Invariants (owner hard constraint)
Delivery/driver path byte-untouched: pickup-only branch; delivery Completar unchanged; `completeDeliveryTask` unmodified; **`delivered` stays delivery-only**; no rules edit. Idempotent + fail-closed on the `setOrderStatus` return. Backfill strictly pickup + non-terminal + dry-run-reviewed.

## 7. Lesson (bake in — from the re-gate)
**Reusing an intended-but-unwired status = audit EVERY terminal/active check, not just earn+queue+stats.** Enumerate all consumers that branch on `status ∈ {delivered,cancelled,...}` (dashboard buckets/actions, KDS estado map, inbound/outbound comms, cancel-gate, sweeper, leaderboard) and confirm each treats the new status correctly. The `delivered`→`completed` reversal fixed the *choice*; this step fixes the *wiring*.

## 8. Testing
- **Pure:** KDS branch predicate + idempotency; dashboard bucket/action for `completed`; the inbound filter for `completed`.
- **On-device:** pickup → KDS Completar → `status='completed'` → leaves En Fila; earn credited + redemption consumed (rewards ledger); dashboard shows it **completed / "Recogido"**, NOT active, NO cancel/refund action; KDS on a 2nd device shows it **Archivado** (not Nuevo); a customer text → NOT "active order" reply; **no WhatsApp** sent; driver leaderboard/metrics unchanged. Delivery Completar + driver "¡Entregado!" path verified unchanged.
- **Backfill:** dry-run pickup-only list reviewed; confirm no delivery `order_id`; note retro-earn.

## 9. Gating & deploy
- Advisor **codex DESIGN re-gate** on this v3 (confirm the 4 consumer fixes are correct + complete + no 5th missed; delivery path untouched).
- writing-plans → build → advisor **codex-on-diff money-adjacent** (KDS `completed` write triggers earn/consume; the actionConfig money-gate; functions inbound change).
- Deploy: `xpizza-kitchen/` (2 Netlify sites, explicit `--site`), `xpizza-dashboard/` (its site), **and a functions deploy** ([[prod-functions-deployed-state]]/[[functions-env-management]]). **Fold into the rewards launch.**

## 10. Out of scope
`delivered_at`/`picked_up_at` for pickups; delivery-path change; a distinct new status; Phase-2 comms.
