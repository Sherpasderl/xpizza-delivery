# FOLLOW-UP (next phase): Pickup order lifecycle has no completion — full fix scope

**Surfaced:** 2026-07-31, by the dispatch redesign's new En Fila "Recoger" visibility. Xavier: "if we're going to fix something, we fix it all the way — scope full fix, fold into next phase." **NOT a Phase-1 item** (Phase 1 is client-read-only; this is a write-path/lifecycle fix). Do NOT band-aid the dispatch queue (no time-window guessing) — En Fila honestly shows non-terminal pickups until this ships.

## The bug (confirmed from live data)

Order `PZX-260726-140358-K976W1PP` (order_type `pickup`, paid online L1432): **status = `ready`**, timeline has ONLY "Pedido recibido 26 jul" — **no `delivered_at`, no `picked_up_at`, no terminal transition.** It was physically collected weeks ago; the data never recorded it. It (and every collected pickup) lingers forever.

## Root cause

- Order status enum (`xpizza-delivery.js` `ORDER_STATUS`): `new / preparing / ready / out_for_delivery / delivered / cancelled`. There is **no `completed`/`picked_up` order status** (those are TASK statuses / a `picked_up_at` timestamp on the driver flow).
- The **only** transition to the terminal `delivered` is **driver delivery-task completion** (`xpizza-delivery.js:461`, on `completeDeliveryTask`). A **pickup-type order has no driver and no delivery task**, so that transition never fires.
- Therefore **customer-pickup orders never reach a terminal status** — they sit at `ready` after the kitchen marks them ready and the customer collects. Nothing in the platform represents "customer collected the pickup."
- Downstream blast radius (everything keys "done" off `status ∈ {delivered, cancelled}`): completed pickups are **also** invisible to `getDeliveredTodayCount`, the **Cerrados hoy** section, and delivered stats — not just the En Fila queue. The queue merely made the existing hole visible.

## Full fix (all the way) — CONTAINED to the KDS (footprint corrected 2026-07-31)

The KDS ALREADY owns order-status writes: `XPD.setOrderStatus` drives `empezar→preparing` and `listo→ready` (tested; `xpizza-kitchen/avail-write.test.mjs` — "setOrderStatus writes ONLY orders/{id}.{status}"). The **"Completar"** action, though, is a **LOCAL archive** (`completedSet.add(id)`, `xpizza-kitchen/index.html:~2082`) that deliberately does NOT write `/orders.status` — correct for DELIVERY (the driver's "¡Entregado!" swipe writes `status='delivered'`, `xpizza-delivery.js:489`), but a PICKUP order has no driver, so "Completar" archives it locally while `order.status` stays `ready` forever. **That's the whole bug, at the source.**

**1. The change — make "Completar" close pickup orders on the server.**
- In the KDS Completar handler (`xpizza-kitchen/index.html`, the `completedSet.add(id)` beat ~2082): when `order.order_type === 'pickup'`, ALSO `await XPD.setOrderStatus(id, ORDER_STATUS.DELIVERED)` (+ `delivered_at`). Delivery orders keep today's behavior (local bump only; the driver owns their terminal transition). Reuses the existing `setOrderStatus` machinery — no new action, no new UI.
- Reusing terminal `delivered` means **every downstream consumer already works** (queue exclusion, `getDeliveredTodayCount`, Cerrados, delivered stats) with zero further change. A distinct `PICKED_UP` status would mean threading it through ALL "done" predicates — `delivered` reuse is DRY and lower-risk.
- Idempotency/guard: only transition a non-terminal pickup; don't re-write if already `delivered`/`cancelled`.

**2. RTDB rules — a CHECK, likely a small tweak.**
- The kitchen already writes `preparing`/`ready` to `/orders/{id}/status`. **Verify** whether the rules whitelist specific statuses (would need `delivered` added for the kitchen role) or allow any authenticated-kitchen status write (then no change). ⚠ RTDB rules have no child-count fn and only the emulator catches issues — run the emulator before any rules deploy ([[rtdb-rules-no-numchildren]]).
- If `setOrderStatus` is extended to stamp `delivered_at`, sync the **byte-identical `xpizza-delivery.js`** across all 5 surface copies (the one real "spread"). Prefer stamping `delivered_at` in the KDS caller if it avoids touching the shared SDK.

**3. Money/gate posture.** A status→terminal transition (no charge/refund) — but it IS an order-lifecycle write → **own design gate + codex money-adjacent gate** ([[codex-gate-money-adjacent]]). Confirm it does NOT collide with the paid/refund axis (pickup orders are prepaid online or cash-at-counter; closing them must not touch `payment_status`).

**4. Backfill.** Existing stuck `ready` pickups (K976W1PP and siblings) — one-time script to mark genuinely-collected old pickups `delivered` (bounded by age / a manual confirm), OR accept they age out of a future time-scoped live view. Decide at build time.

**5. Dispatch cleanup (folds in here).** Once pickups reach `delivered`, `getPickupQueue` (excludes `delivered`) is correct. **Remove the dead `'completed'/'picked_up'` entries** from its `done` set (they reference non-existent order statuses) — left in place now so this rework owns the change, not a churn commit.

## Sequencing

**Contained to the KDS** (`xpizza-kitchen/index.html` Completar handler + an RTDB-rules check; possibly a synced `xpizza-delivery.js` helper for `delivered_at`). **Dispatch needs no change.** Order-lifecycle write → still gets **codex money-adjacent gate** ([[codex-gate-money-adjacent]]) + the RTDB emulator before any rules deploy ([[rtdb-rules-no-numchildren]]), but it's a tight change, not a sprawling cross-surface build. Sequence into the next work push alongside Phase 2 (independent of it). Not a Phase-1 blocker.
