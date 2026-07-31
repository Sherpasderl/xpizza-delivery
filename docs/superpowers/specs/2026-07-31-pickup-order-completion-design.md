# Pickup-order completion — design spec

**Date:** 2026-07-31 · **Status:** design LOCKED (Xavier), ready for writing-plans.
**One-line:** when the KDS "Completar" fires on a **pickup** order, publish its completion by writing `status='delivered'`, so dispatch/Cerrados/stats read it as done. **Delivery orders and the driver path are not touched.**

## 1. Problem

Customer-pickup orders (`order_type:'pickup'`) never reach a terminal status, so they linger forever — in the new dispatch **En Fila → Recoger** queue, and (pre-existing) invisible to `getDeliveredTodayCount` / **Cerrados hoy** / delivered stats. Confirmed live: order `PZX-260726-140358-K976W1PP` sits at `status:'ready'`, collected weeks ago, no terminal transition.

## 2. Root cause (verified)

- Order status enum (`xpizza-delivery.js ORDER_STATUS`): `new / preparing / ready / out_for_delivery / delivered / cancelled`. **No `completed`/`picked_up` order status** (those are TASK statuses / a `picked_up_at` timestamp on the driver flow).
- The **only** transition to terminal `delivered` is **driver delivery-task completion** (`xpizza-delivery.js:461` `completeDeliveryTask`, writes `status='delivered'` + `delivered_at`). **A pickup order has no driver and no delivery task → that transition never fires.**
- The KDS **"Completar"** action is a **device-local archive only** — `completedSet` ← `localStorage.xpizza_kds_completed` (`xpizza-kitchen/index.html:1586`, saved `:1645`); it writes **nothing** to the DB ("ONLY empezar→preparing and listo→ready write /orders.status", `:2034`). So completing a pickup today leaves **zero trace in shared data** — nothing for dispatch to read.

## 3. Design

**Mechanism.** In the KDS "Completar" beat (`xpizza-kitchen/index.html`, the `completedSet.add(id)` path ~`:2082`), add a branch: **only when `order.order_type === 'pickup'`**, first `await XPD.setOrderStatus(id, 'delivered')`; treat its return per the existing contract (`true` = wrote → proceed with the local bump; `false` = ownership-skip → do NOT bump, surface the existing error path — mirror `commitStatusWrite`). Delivery orders never enter this branch.

**Why this is safe against the delivery path (hard invariant).**
- The branch is gated entirely on `order_type === 'pickup'`. **Delivery orders hit `false` → the KDS "Completar" runs exactly as today (local `completedSet` bump), byte-unchanged.**
- **`xpizza-delivery.js` `completeDeliveryTask` is NOT modified** — the seamless driver status path is untouched.
- **No RTDB rules change** (Option A). The delivery path depends on the `status` and `delivered_at` rules; this design edits neither.

**Grounding that makes it "just works" (verified):**
- `setOrderStatus(id, status)` writes any status via `update(ref(db,'orders/'+id), { status })` — no whitelist; `'delivered'` writes cleanly. La Musa KDS ownership guard returns `false` for non-`la_musa` orders (fine — a pickup belongs to its KDS → returns `true`). Writes **only `status`** (Option A — no `delivered_at`).
- **RTDB rules:** `orders/$id/status .write` already permits the **kitchen** role (any value; the only guard is `cancelled`-on-paid-online, which we don't hit). `orders/$id/delivered_at .write` does NOT permit the kitchen → so Option A (status only) is both the safe and the necessary choice; a `{status, delivered_at}` multi-path write would be atomically rejected.
- Dispatch reads `status`: `getPickupQueue` excludes `delivered` → completed pickups leave En Fila with **zero dispatch change**; Cerrados + delivered stats begin counting them.

**Decisions (locked):**
- **① Reuse `delivered`** (not a new `picked_up` status): every downstream "done" predicate already keys off `status ∈ {delivered,cancelled}`; `order_type` still distinguishes pickup for any "Recogido" labeling. A new status would mean threading it through every predicate — rejected (YAGNI + risk).
- **② Option A — write only `status='delivered'`** (no rules change, no SDK edit, no delivery-path edit). Trade-off accepted: pickups carry no `delivered_at` → Cerrados sorts them by `created_at` and they get no "Recogido" timeline stamp. (`getDeliveredTodayCount` keys off `created_at`, unaffected.) A `delivered_at`-for-pickups follow-up (needs a kitchen `delivered_at` rule) is out of scope.
- **③ Backfill** the already-stuck `ready` pickups: a one-time script **strictly scoped to `order_type==='pickup'` AND a non-terminal status** (`ready`/`preparing`/`new`), setting `status='delivered'`. Scope makes it physically unable to touch a delivery order. Bound by age or a dry-run list reviewed before the write.

## 4. Idempotency & errors

- **Idempotent:** only transition a non-terminal pickup; if `order.status` is already `delivered`/`cancelled`, do nothing (guard before the write).
- **Ownership-skip / write failure:** honor the existing `setOrderStatus` return contract — on `false` or throw, do NOT bump the card and surface the KDS's existing error path (no silent success).

## 5. Files / surfaces

- **`xpizza-kitchen/index.html`** — the one `order_type==='pickup'` branch in the Completar handler. *This is the entire behavioral change.*
- **Backfill script** (one-off, e.g. `scripts/backfill-pickup-completion.mjs` or a REST/admin one-shot) — pickup-scoped, dry-run first.
- **NOT touched:** `xpizza-delivery.js` (any copy), RTDB rules, `xpizza-dispatch/*`, the driver app.
- **Deploy:** `xpizza-kitchen/` is a per-folder Netlify site — deploys to **both** the `lamusakitchendisplay` (La Musa) and X. Pizza KDS sites; pass the explicit `--site` ([[netlify-deploy-mechanics]]). No functions/rules deploy.

## 6. Testing

- **Unit-ish:** the branch predicate + idempotency guard (pure — `order_type==='pickup' && !terminal(status)`), ideally extracted so it's testable without the DOM.
- **On-device (the real proof):** a pickup order in the KDS → tap **Completar** → it archives on the KDS AND `orders/{id}/status` becomes `delivered` in RTDB → it **leaves dispatch En Fila → Recoger** and appears in **Cerrados hoy**. Then verify a **delivery** order's Completar is unchanged (local bump only, `status` stays whatever the driver flow set) and the driver "¡Entregado!" path still writes `delivered`+`delivered_at`.
- **Backfill:** dry-run prints the pickup-only candidate list; confirm no delivery `order_id` appears before writing.

## 7. Gating

- **Codex money-adjacent gate** ([[codex-gate-money-adjacent]]) on the diff — order-lifecycle write. The gate must specifically confirm: the delivery/driver path is byte-untouched; the branch is pickup-only; no `cancelled`/payment axis touched; backfill is pickup-scoped.
- No rules deploy (Option A) → no RTDB-emulator step needed. (If a future `delivered_at`-for-pickups is ever done, THAT needs the emulator per [[rtdb-rules-no-numchildren]].)

## 8. Out of scope

`delivered_at` for pickups (needs a kitchen `delivered_at` rule); any delivery-path change; a distinct `PICKED_UP` status; Phase-2 comms.
