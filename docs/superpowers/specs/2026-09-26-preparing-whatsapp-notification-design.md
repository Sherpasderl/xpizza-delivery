# Proactive "preparing" WhatsApp notification — Design (Fix A)

**Date:** 2026-09-26 · **Surface:** `xpizza-functions/` (Cloud Functions) + `whatsapp.js` template · **Type:** customer comms on the live order lifecycle. **NOT money/pricing/factura**, but it's a new trigger on the live order path → codex-gate like every build. Base: `origin/main` @ `bcf5ff0`.

## Problem (root-caused from source + live behavior)

Customers WhatsApp the restaurant asking *"¿dónde está mi pedido?"* **while the order is still in preparation**. Source-confirmed: `sendOrderStatusNotifications` (index.js:3404) sends a customer WhatsApp on exactly these transitions — **`new`** (¡Pedido recibido!), **`out_for_delivery`**, **`delivered`**, **`cancelled`** — and *explicitly* skips `preparing`/`ready` (in-code comment: *"preparing/ready … don't notify the customer (would be too noisy)"*, index.js:3491-3494). So after "recibido," a delivery customer hears nothing until "va en camino" — a 20–30 min silent window that is exactly when they get anxious and message a human. A progress bar can't fix this: they've closed the page and are on WhatsApp, not the tracker. The fix must reach them **in WhatsApp**, during prep.

## Goal

One well-timed WhatsApp at the **`preparing`** transition (kitchen taps *Empezar*): *"we started cooking, here's your ETA."* A single message — not noise — that removes the reason to ask. Both brands, both order types.

## Coverage is clean (KDS-enforced)

The KDS card sequence is hard-wired **NUEVO → Empezar → EN PREPARACIÓN → Completar → Listo** (xpizza-kitchen/index.html `headerTap`: a `nuevo` card's only action is `empezar`; `Completar`/`listo` is rendered only for `op === 'prep' || 'listo'`). A ticket **cannot reach `ready` without passing through `preparing`**, so every kitchen-prepared order hits this transition. (A non-KDS jump straight to `out_for_delivery` — e.g. a driver grabbing a still-`new` order — still sends the existing "va en camino," so there's no silent window there either.)

## Design — a NEW trigger, the money sender FROZEN

Add `notifyPreparing`, a **separate** `onValueWritten` trigger on `/orders/{orderId}/status`, firing only on `→ preparing`. Modeled **exactly** on `notifyPickupReady` (index.js:3666), which is the codebase's proven "add a customer notification without touching the gated money sender" pattern. `sendOrderStatusNotifications` stays **byte-for-byte unchanged**.

1. **Guard first:** `if (after !== 'preparing' || before === after) return;`
2. **Marker in a SEPARATE top-level tree** — `/preparing_notifications/{orderId}`, **never under `/orders`** (four triggers watch the whole order node: materializeOnConfirm, allocateFacturaOnSale, voidFacturaOnCancel, autoAssignOnOrderCreate — a mark under the order would re-fire them; no trigger watches `/preparing_notifications`, and this trigger watches `/orders/{id}/status`, so it can't self-fire). Same isolation as `notifyPickupReady`.
3. **At-most-once, mark-before-send:** transaction `claim` on `claimed_at` is the sole redelivery/concurrency authority; await `send_started_at` **before** `sendMessage` (so a `claimed_at`-only node is provably unsent). Honest terminal states: `sent_at` only on a confirmed non-null provider return; else `send_unresolved_at` (a null return may mean the customer already got it → never auto-resend).
4. **Eligibility (fail-closed on restaurant):** order exists, `customer_phone` present, `restaurant_id ∈ SUPPORTED_WHATSAPP_RESTAURANTS`, `isEnabledForRestaurant`. **NOT gated on `order_type`** — both delivery and pickup get it (the template varies the copy, not the send). Guarded diagnostic skip-stamps for each ineligibility.
5. **Never throws** (no retry config; a throw only marks the invocation failed with no benefit) — mirrors `notifyPickupReady`.

### ETA source — config-driven, brand-agnostic (NOT the shadow predictor)

The message says *"listo en ~X min."* X comes from **config**, not code branching and not the ready-time predictor:
- Read `restaurants/{restaurantId}/prep_eta_min` (a per-merchant FACT → CONFIG, per the brand-agnostic tenet).
- **Single neutral code fallback** if absent/unreadable (e.g. `DEFAULT_PREP_ETA_MIN = 25`) — NO per-brand `if (rid === …)` in code.
- **Seed** the config: `x_pizza → 20`, `la_musa → 30` (top of the 25–30 range — under-promise so the message never sets a clock we miss). Tunable live, zero deploy.
- The shadow ready-time predictor is **out of scope** for v1 (it's shadow-only, never customer-facing, graduation-gated — a wrong "~5 min" is worse than silence). It becomes a drop-in upgrade to this same config slot once graduated, with no change to the customer-facing shape.

### Template — `tplPreparing`, copy varies by order_type

New shared `tplPreparing({ customerName, etaMinutes, orderType, trackingToken, restaurantId })` in whatsapp.js, using the existing brand-agnostic helpers (`brandFor`, `itemsEmojiFor`, `trackingUrl`) — byte-parallel across brands:
- **pickup:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — listo para recoger en ~{eta} min."*
- **delivery:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — en ~{eta} min sale hacia vos."* (then the existing `out_for_delivery` "va en camino" fires — so we never imply it *arrives* in {eta}).
- Tracking link appended when `trackingToken` present (same idiom as the other templates).

## Riskless / no-regression (must hold — diff-prove)

- **`sendOrderStatusNotifications` BYTE-UNCHANGED** — the money-adjacent delivery/cancel/received sender is untouched; the only added cost is one extra order read per `preparing` transition (identical tradeoff `notifyPickupReady` already accepted).
- **No `/orders` write from the new trigger** — the marker lives in `/preparing_notifications/`; nothing this trigger does can re-fire materialize/factura/assign.
- **No money/pricing/factura/validateOrderPayload change.** Additive + fail-open: a failed/absent send never affects the order.
- **Both brands** parity (shared engine, shared lifecycle) — this genuinely applies to both (unlike the x_pizza-only pickup-only modal).

## Testing

- **Pure/decision:** `tplPreparing` copy for pickup vs delivery, ETA interpolation, tracking-link presence/absence, brand helpers — golden strings both brands.
- **Notify-trigger behavior** (mirror `notify-pickup-ready` tests): fires only on `→ preparing`; at-most-once under redelivery (claim); mark-before-send ordering; fail-closed on unsupported restaurant / whatsapp-disabled / missing phone; never throws; `sent_at` only on confirmed send, else `send_unresolved_at`.
- **Config:** `prep_eta_min` read from `restaurants/<rid>`; single neutral fallback when absent; NO per-brand literal in code (assert absence).
- **Regression guard:** `sendOrderStatusNotifications` byte-unchanged vs `bcf5ff0`; full functions suite EXIT 0.

## Out of scope
- **Fix B** (the AI WhatsApp status-responder for when they ask anyway) — sequenced after this ships.
- **Predictor-driven ETA** — later, drop-in to the same config slot once the shadow predictor graduates.
- Any change to `ready`/`out_for_delivery`/`delivered`/`cancelled` sends.
