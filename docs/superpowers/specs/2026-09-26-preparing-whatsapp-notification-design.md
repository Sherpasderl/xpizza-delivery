# Proactive "preparing" WhatsApp notification — Design (Fix A) · REV 2 (post codex plan gate + advisor stale-tree catch)

**Date:** 2026-09-26 · **Surface:** `xpizza-functions/` (Cloud Functions) + `whatsapp.js` template. **NOT money/pricing/factura**, but a new trigger on the live order path → codex-gate. **Base (code): `origin/main` @ `bcf5ff0`** (build worktree `~/Downloads/xpizza-preparing`; docs tip adds no code).

> **REV 2 — process correction.** My REV-1 source anchors and two "corrections" came from a **stale checkout** (`/Users/xavierlacayo/xpizza-lamusa` @ `0830a6a`, the factura branch — ~600 lines behind `bcf5ff0`). The advisor caught it. Re-verified against `bcf5ff0`: (1) **`whatsapp.isSendConfirmed` DOES exist** (whatsapp.js:161, exported :338) → we USE it (not `result != null`, not `result && result.id`); (2) **`close_fulfilled` DOES write `status:'completed'`** (resolve-manual.js:159→222) → restored as the silent-terminal example; (3) all line anchors below are now `bcf5ff0`. The **build worktree was always at `bcf5ff0`**, so the build base is unaffected — only my verification/anchors were stale.

## Problem (root-caused from `bcf5ff0`)

Customers WhatsApp asking *"¿dónde está mi pedido?"* **during preparation.** `sendOrderStatusNotifications` (index.js:4090) sends a customer WhatsApp on exactly **`new`**, **`out_for_delivery`**, **`delivered`**, **`cancelled`**, and *explicitly* skips `preparing`/`ready` (in-code, index.js:4177-4179: *"preparing/ready … would be too noisy"*). After "recibido," a delivery customer hears nothing until "va en camino" — a 20–30 min silence, exactly when they message a human in WhatsApp.

## Goal

One well-timed WhatsApp at the **`preparing`** transition (kitchen taps *Empezar*): readiness ETA. One message, not noise. Both brands, both order types.

## Design — a NEW trigger, the money sender FROZEN

`notifyPreparing`, a **separate** `onValueWritten('/orders/{orderId}/status')` trigger firing only on `→ preparing`, modeled on `notifyPickupReady` (index.js:4375). `sendOrderStatusNotifications` stays **byte-for-byte unchanged** (codex re-confirmed byte-identical to `bcf5ff0`).

**Trigger flow (explicit exits — mirror `notifyPickupReady` index.js:4375–4485):**
1. **Guard:** `if (after !== 'preparing' || before === after) return;`
2. **Marker in a SEPARATE top-level tree** — `db.ref('preparing_notifications/' + orderId)` (**interpolated**; never under `/orders`). Rationale: **six** whole-order-node `onValueWritten('/orders/{orderId}')` watchers exist at `bcf5ff0` — `materializeOnConfirm` (2634), `allocateFacturaOnSale` (2673), `allocateDisplayNumberOnSale` (2740), `voidFacturaOnCancel` (2864), `notifyStaffOnNewOrder` (3257), `autoAssignOnOrderCreate` (5264) — a mark under the order would re-fire all six. Nothing watches `/preparing_notifications`, and this trigger watches `/orders/{id}/status`, so it cannot self-fire. Isolation holds.
3. **Load order once.** Read error → guarded `read_error_at` + return. Missing → `skip('order_missing')`.
4. **Eligibility** (guarded skip-stamps): `customer_phone`; `restaurant_id ∈ SUPPORTED_WHATSAPP_RESTAURANTS` (**restaurant identification fails closed**); `isEnabledForRestaurant(db, rid)` (whatsapp.js:190). **Not gated on `order_type`.** Accuracy note on the enablement gate itself: **x_pizza deliberately fails OPEN** (`return await isEnabled(db)`, whatsapp.js:193 — read error → enabled, legacy-identical); **la_musa fails CLOSED** and additionally requires `identity/whatsapp_enabled === true` + its env (incl. tracking base). We call the gate as-is.
5. **STALE-STATUS GUARD (codex pt 4):** a delayed/redelivered `preparing` event can land on an order whose **current** status has moved on. Concrete silent-terminal writers beyond the KDS exist — e.g. `close_fulfilled` writes `status:'completed'` (resolve-manual.js:159→222), and drivers write `out_for_delivery`/`delivered` directly. So after loading the order, if `order.status !== 'preparing'` → `skip('stale_status')` (never "estamos preparando" on an order already past prep). Residual read→send race accepted (same class `notifyPickupReady` accepts).
6. **Claim → start → send → record** (at-most-once, mark-before-send):
   - `claimed_at` transaction: present → abort (lost → return, **no auto-reclaim**); absent → win.
   - await `send_started_at` **before** `sendMessage`; that write throws → return without sending (claimed-only node is provably unsent).
   - **ETA read inside the handler's own try** (codex pt 2): `restaurants/<rid>/prep_eta_min` `.once('value')` can reject → catch → `resolvePrepEtaMin(value)` (pure) maps value→number (fallback on absent/invalid).
   - build `body = tplPreparing({...})` (wrapped).
   - send; **record `sent_at` only when `whatsapp.isSendConfirmed(result)` (whatsapp.js:161)** — the tested helper: accepts UltraMsg's `sent:true`/`"true"` **or** a real message `id`, and rejects an `error` body or a bare `{}` (`sendMessage` returns `{}` on an unreadable HTTP-200, whatsapp.js:137). This is the documented bar ("callers MUST gate on this, never on `res != null`"); we do **not** copy `notifyPickupReady`'s lax `result != null` (index.js:4468 — pickup's latent weakness), and we do **not** hand-roll `result && result.id` (which would false-negative a legit `sent:true` with no id). Otherwise → `send_unresolved_at`.
7. **Never-throws is NOT inherited (codex pt 2):** template construction, init, and the enablement call sit outside pickup's inner try, and our ETA read adds a failure point → the handler wraps init/template/config-read/unexpected work to **always resolve**; only writes are to `/preparing_notifications/<orderId>`.

### ETA source — config-driven, brand-agnostic (NOT the shadow predictor)

- Read `restaurants/{restaurantId}/prep_eta_min`; `resolvePrepEtaMin(value)` (pure): finite `> 0` → that number; else the **single neutral** `DEFAULT_PREP_ETA_MIN = 25` (no per-brand `if`; test asserts no brand literal). The **DB read is caught in the handler** → fallback 25.
- **Seed** `x_pizza → 20`, `la_musa → 30`. Tunable live. Predictor out of scope (drops into this slot later).

### Template — `tplPreparing`, readiness wording (no dispatch promise, codex pt 5)

New shared `tplPreparing({ customerName, etaMinutes, orderType, trackingToken, restaurantId })` in whatsapp.js, using `brandFor`/`itemsEmojiFor`/`trackingUrl` (byte-parallel, brand-agnostic). Readiness only:
- **pickup:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — estará listo para recoger en ~{eta} min."*
- **delivery:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — estará listo en ~{eta} min. Te avisamos apenas salga en camino."* (existing `out_for_delivery` "va en camino" covers dispatch; we never imply arrival/departure in {eta}).
- tracking link appended when `trackingToken` present (as `tplPickupReady`, whatsapp.js:323).

## Riskless / no-regression (diff-prove)

- **`sendOrderStatusNotifications` (index.js:4090) BYTE-UNCHANGED** vs `bcf5ff0`. Added cost per `preparing` transition: one order read + enablement/config reads + the claim transaction + marker writes + the provider call (not "only one read").
- **No `/orders` write** from the new trigger — marker in `/preparing_notifications/`; cannot re-fire the six order-node watchers.
- **No money/pricing/factura change.** Additive + fail-open.
- **Both brands.**

## Coverage — honest scope (codex pt 4)

The KDS *UI* sequences NUEVO→Empezar→prep→Completar→Listo, so **kitchen-driven** orders pass through `preparing` — but this is **UI sequencing, not a DB invariant**: the shared status writer doesn't require `prev==='preparing'`, DB rules don't enforce it, drivers write `out_for_delivery`/`delivered` directly, and `close_fulfilled` writes `completed` silently (resolve-manual.js:159→222). Honest promise: **for the kitchen-prep path, one message per order**; orders that skip prep don't get it (and aren't in a silent *prep* window). The stale-status guard (§5) blocks a late `preparing` event from mis-firing on an already-advanced order.

## Testing (codex pt 6 — real handler tests)

- **Emulator handler tests** modeled on `test/pickup-ready.emulator.test.js`: (a) two concurrent/redelivered `→preparing` events → **exactly one** confirmed send + **distinct per-order markers**; (b) each failure exit (missing order, no phone, unsupported rid, whatsapp-disabled, claim lost, `send_started_at` write failure, **ETA-read rejection → fallback 25**, **stale-status → suppressed**); (c) provider `{}` and `null` and thrown and a bare `{sent:true}` → assert `isSendConfirmed` classification (`sent_at` on confirmed incl. `sent:true`, `send_unresolved_at` on `{}`/`null`/thrown/error-body); (d) **zero `/orders` writes**.
- **Pure/golden:** `tplPreparing` pickup vs delivery (readiness), ETA interpolation, tracking-link presence/absence, both brands; `resolvePrepEtaMin` value/absent/NaN/≤0; **no brand literal** in whatsapp.js prep-eta code.
- **Regression:** `sendOrderStatusNotifications` byte-unchanged vs `bcf5ff0`; full suite EXIT 0.
- **Smoke:** a real `new → preparing` sends one message (an *identical* status rewrite produces **no event** — so "rewrite and confirm no double-send" is vacuous; the real guard is the concurrent/redelivered emulator test).

## Out of scope
- **Fix B** (AI status-responder) — after this ships.
- Predictor-driven ETA (same config slot, once graduated).
- Any change to `ready`/`out_for_delivery`/`delivered`/`cancelled` sends.
