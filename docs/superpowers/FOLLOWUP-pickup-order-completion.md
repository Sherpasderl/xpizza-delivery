# FOLLOW-UP (next phase): Pickup order lifecycle has no completion — full fix scope

**Surfaced:** 2026-07-31, by the dispatch redesign's new En Fila "Recoger" visibility. Xavier: "if we're going to fix something, we fix it all the way — scope full fix, fold into next phase." **NOT a Phase-1 item** (Phase 1 is client-read-only; this is a write-path/lifecycle fix). Do NOT band-aid the dispatch queue (no time-window guessing) — En Fila honestly shows non-terminal pickups until this ships.

## The bug (confirmed from live data)

Order `PZX-260726-140358-K976W1PP` (order_type `pickup`, paid online L1432): **status = `ready`**, timeline has ONLY "Pedido recibido 26 jul" — **no `delivered_at`, no `picked_up_at`, no terminal transition.** It was physically collected weeks ago; the data never recorded it. It (and every collected pickup) lingers forever.

## Root cause

- Order status enum (`xpizza-delivery.js` `ORDER_STATUS`): `new / preparing / ready / out_for_delivery / delivered / cancelled`. There is **no `completed`/`picked_up` order status** (those are TASK statuses / a `picked_up_at` timestamp on the driver flow).
- The **only** transition to the terminal `delivered` is **driver delivery-task completion** (`xpizza-delivery.js:461`, on `completeDeliveryTask`). A **pickup-type order has no driver and no delivery task**, so that transition never fires.
- Therefore **customer-pickup orders never reach a terminal status** — they sit at `ready` after the kitchen marks them ready and the customer collects. Nothing in the platform represents "customer collected the pickup."
- Downstream blast radius (everything keys "done" off `status ∈ {delivered, cancelled}`): completed pickups are **also** invisible to `getDeliveredTodayCount`, the **Cerrados hoy** section, and delivered stats — not just the En Fila queue. The queue merely made the existing hole visible.

## Full fix (all the way)

**1. A completion action — the counter/kitchen marks the pickup handed over.**
- Home = the **KDS** (`lamusakitchendisplay` / kitchen-display repo) — the counter sees the customer collect it. Add an **"Entregado al cliente / Recogido"** action on pickup-type orders (the natural analogue of the driver's "Entregado"). (Optionally also a dispatch-side action, but the counter is the real observer.)

**2. The write — reuse the existing terminal state.**
- The action sets `orders/{id}/status = 'delivered'` + `orders/{id}/delivered_at = serverTimestamp()` (mirror `completeDeliveryTask`). Reusing `delivered` means **every downstream consumer already works** (queue exclusion, `getDeliveredTodayCount`, Cerrados, delivered stats) with zero further change. If a distinct pickup semantic is wanted, add `ORDER_STATUS.PICKED_UP` and thread it through ALL "done" predicates — but `delivered` reuse is DRY and lower-risk.
- **Server-authoritative / rules-guarded**, like the driver pickup/delivery completions — a callable fn or a transaction, not an unguarded client write. Guard: only `order_type:'pickup'` + non-terminal status may transition; idempotent.

**3. Money/gate posture.** A status→terminal transition (no charge/refund) — but it IS an order-lifecycle write → **own design gate + codex money-adjacent gate** ([[codex-gate-money-adjacent]]). Confirm it does NOT collide with the paid/refund axis (pickup orders are prepaid online or cash-at-counter; closing them must not touch `payment_status`).

**4. Backfill.** Existing stuck `ready` pickups (K976W1PP and siblings) — one-time script to mark genuinely-collected old pickups `delivered` (bounded by age / a manual confirm), OR accept they age out of a future time-scoped live view. Decide at build time.

**5. Dispatch cleanup (folds in here).** Once pickups reach `delivered`, `getPickupQueue` (excludes `delivered`) is correct. **Remove the dead `'completed'/'picked_up'` entries** from its `done` set (they reference non-existent order statuses) — left in place now so this rework owns the change, not a churn commit.

## Sequencing

Cross-repo (KDS UI + functions/rules + optional backfill), money-adjacent → **its own brainstorm → design gate → build → codex money-gate**, sequenced into the next work phase (independent of 1b/Phase-2/Phase-3; arguably before them since it's a live correctness hole). Not a Phase-1 blocker: Phase 1 correctly *shows* pickup orders; this ends their lifecycle.
