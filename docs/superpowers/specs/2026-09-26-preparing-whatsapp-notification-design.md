# Proactive "preparing" WhatsApp notification — Design (Fix A) · REV 1 (post codex plan gate)

**Date:** 2026-09-26 · **Surface:** `xpizza-functions/` (Cloud Functions) + `whatsapp.js` template · **Type:** customer comms on the live order lifecycle. **NOT money/pricing/factura**, but a new trigger on the live order path → codex-gate like every build. **Base (code): `origin/main` @ `bcf5ff0`.** This branch's tip `4046eea` adds only the spec/plan/relay docs — code is identical to `bcf5ff0`.

> **REV 1** folds in the codex plan-gate REVISE deltas. Two codex citations were inaccurate and are corrected here: `whatsapp.isSendConfirmed` **does not exist** (pickup uses `result != null`; we adopt a stricter `result && result.id`), and `resolve-manual.js` does **not** write `'completed'` (the coverage/stale-status point still holds and is adopted).

## Problem (root-caused from source + live behavior)

Customers WhatsApp the restaurant asking *"¿dónde está mi pedido?"* **while the order is still in preparation.** Source-confirmed: `sendOrderStatusNotifications` (index.js:3404) sends a customer WhatsApp on exactly **`new`**, **`out_for_delivery`**, **`delivered`**, **`cancelled`**, and *explicitly* skips `preparing`/`ready` (in-code: *"preparing/ready … would be too noisy"*, index.js:3491-3494). So after "recibido," a delivery customer hears nothing until "va en camino" — a 20–30 min silence, exactly when they get anxious and message a human, in WhatsApp (not the tracker they've left).

## Goal

One well-timed WhatsApp at the **`preparing`** transition (kitchen taps *Empezar*): *"we started cooking, here's the readiness ETA."* One message — not noise. Both brands, both order types.

## Design — a NEW trigger, the money sender FROZEN

Add `notifyPreparing`, a **separate** `onValueWritten('/orders/{orderId}/status')` trigger firing only on `→ preparing`, modeled on the proven `notifyPickupReady` (index.js:3688). `sendOrderStatusNotifications` stays **byte-for-byte unchanged** (codex re-confirmed byte-identical to `bcf5ff0`).

**Trigger flow (explicit exits — mirror `notifyPickupReady` index.js:3688–3787):**
1. **Guard:** `if (after !== 'preparing' || before === after) return;`
2. **Marker in a SEPARATE top-level tree** — `db.ref('preparing_notifications/' + orderId)` (**interpolated**, never the literal `{orderId}`; never under `/orders`). Rationale: **six** whole-order-node `onValueWritten('/orders/{orderId}')` watchers exist at `bcf5ff0` — `materializeOnConfirm` (2036), `allocateFacturaOnSale` (2071), `allocateDisplayNumberOnSale` (2138), `voidFacturaOnCancel` (2260), `notifyStaffOnNewOrder` (2644), `autoAssignOnOrderCreate` (4574) — a mark under the order would re-fire all six. **Nothing** watches `/preparing_notifications`, and this trigger watches `/orders/{id}/status`, so it cannot self-fire. Marker isolation **holds**.
3. **Load order once** (single read). Read error → guarded `read_error_at` stamp + `return` (no claim/send). Missing → `skip('order_missing')`.
4. **Eligibility** (guarded skip-stamps): `customer_phone` present; `restaurant_id ∈ SUPPORTED_WHATSAPP_RESTAURANTS` (**restaurant identification is fail-closed** — an unknown/absent id skips); `isEnabledForRestaurant(db, rid)` truthy. **NOT gated on `order_type`.** Note on the enablement gate's own semantics (`isEnabledForRestaurant`, whatsapp.js:169): **x_pizza deliberately fails OPEN** (read error → enabled, byte-identical to legacy); **la_musa fails CLOSED** and additionally requires its `identity/whatsapp_enabled === true` plus its 3 env settings (incl. the tracking base). We call the existing gate as-is — this note is accuracy, not a new behavior.
5. **STALE-STATUS GUARD (new — codex pt 4):** a delayed/redelivered `preparing` event can land on an order whose **current** status has already moved on (ready / out_for_delivery / delivered / completed / cancelled). Since the event's `after` is not proof of the live value, after loading the order check its **current** `order.status`: if it is **not** `'preparing'`, `skip('stale_status')` — never send "estamos preparando" on an order that's already past prep. (Residual best-effort: a status change between our read and `sendMessage` is an accepted, low-probability race — same class `notifyPickupReady` accepts.)
6. **Claim → start → send → record** (at-most-once, mark-before-send):
   - `claimed_at` transaction: present → abort (lost claim → `return`, **no auto-reclaim**); absent → win.
   - await `send_started_at` **before** `sendMessage`; if that write throws → `return` **without** sending (a `claimed_at`-only node is provably unsent).
   - **ETA read is inside the handler's own try** (codex pt 2): `restaurants/<rid>/prep_eta_min` `.once('value')` can reject — catch it and fall back; then `resolvePrepEtaMin(value)` (pure) maps value→number.
   - build `body = tplPreparing({...})` (wrapped so a construction error can't throw out of the handler).
   - send; record **`sent_at` only when `result && result.id`** (a real provider message id — **stricter than pickup's `result != null`**, because `sendMessage` returns `{}` on an unreadable HTTP-200, whatsapp.js:137, which `!= null` would mis-mark sent); otherwise `send_unresolved_at`. Never `sent_at` on `null`/`{}`/thrown.
7. **Never-throws is NOT inherited (codex pt 2)** — "mirror pickup" doesn't prove it: template construction, `initializeApp`/handle, and the enablement call sit outside pickup's inner try, and our ETA read adds a failure point. So the handler wraps init/template/config-read/unexpected work to **always resolve**; the only writes are to `/preparing_notifications/<orderId>` (marker-only).

### ETA source — config-driven, brand-agnostic (NOT the shadow predictor)

- Read `restaurants/{restaurantId}/prep_eta_min`; `resolvePrepEtaMin(value)` (pure): finite `> 0` → that number; else the **single neutral** `DEFAULT_PREP_ETA_MIN = 25` (no per-brand `if` in code — brand-agnostic tenet; test asserts no brand literal). The **DB read itself is caught in the handler** (a pure resolver can't catch a rejected read) → fallback 25.
- **Seed** config: `x_pizza → 20`, `la_musa → 30`. Tunable live, zero deploy. Predictor is **out of scope** (shadow-only); it later drops into this same slot.

### Template — `tplPreparing`, readiness wording (no dispatch promise)

New shared `tplPreparing({ customerName, etaMinutes, orderType, trackingToken, restaurantId })` in whatsapp.js, using existing brand-agnostic helpers (`brandFor`/`itemsEmojiFor`/`trackingUrl`), byte-parallel across brands. **Readiness wording only** — a prep-stage ETA cannot promise dispatch (codex pt 5):
- **pickup:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — estará listo para recoger en ~{eta} min."*
- **delivery:** *"👨‍🍳 ¡Manos a la obra! Estamos preparando tu pedido — estará listo en ~{eta} min. Te avisamos apenas salga en camino."* (the existing `out_for_delivery` "va en camino" then covers dispatch — we never imply it *arrives* or *leaves* in {eta}).
- tracking link appended when `trackingToken` present.

## Riskless / no-regression (diff-prove)

- **`sendOrderStatusNotifications` BYTE-UNCHANGED** vs `bcf5ff0`. Added cost per `preparing` transition: one order read, the enablement/config reads, the claim transaction, marker writes, and the provider call (not "only one read").
- **No `/orders` write** from the new trigger — marker lives in `/preparing_notifications/`; cannot re-fire the six order-node watchers.
- **No money/pricing/factura/validateOrderPayload change.** Additive + fail-open — a failed/absent/duplicate send never affects the order.
- **Both brands** (shared engine + lifecycle).

## Coverage — honest scope (codex pt 4)

The KDS *UI* sequences NUEVO→Empezar→EN PREPARACIÓN→Completar→Listo (a `nuevo` card's only action is `empezar`), so **kitchen-driven** orders pass through `preparing`. This is **UI sequencing, not a DB invariant**: `listo()`/the shared status writer don't require `prev==='preparing'`, DB rules don't enforce it, and drivers can write `out_for_delivery`/`delivered` directly (and other actions write terminal statuses). Honest promise: **for the kitchen-prep path, the message fires exactly once per order**; orders that skip prep entirely simply don't get it (and aren't in a silent *prep* window). The stale-status guard (§5) prevents a late `preparing` event from mis-firing on an order that has since moved on.

## Testing (codex pt 6 — real handler tests, not structural strings)

Structural/string-ordering assertions cannot prove concurrency/failure/marker properties. Ship:
- **Emulator handler tests** modeled on `test/pickup-ready.emulator.test.js`: (a) two concurrent/redelivered `→preparing` events → **exactly one** confirmed send + **distinct per-order markers**; (b) each failure exit (missing order, no phone, unsupported rid, whatsapp-disabled, claim lost, `send_started_at` write failure, **ETA-read rejection → fallback 25**, **stale-status → suppressed**); (c) provider `{}` and `null` and thrown → `send_unresolved_at`, never `sent_at`; (d) **zero `/orders` writes** (assert only `/preparing_notifications/<id>` touched).
- **Pure/golden:** `tplPreparing` copy for pickup vs delivery (readiness wording), ETA interpolation, tracking-link presence/absence, both brands; `resolvePrepEtaMin` value/absent/NaN/≤0 → number/fallback; **no brand literal** in whatsapp.js prep-eta code.
- **Regression:** `sendOrderStatusNotifications` byte-unchanged vs `bcf5ff0`; full functions suite EXIT 0.
- **Smoke (NOT a status rewrite):** a real `new → preparing` transition sends one message; an *identical* status rewrite produces **no event** (so "rewrite and confirm no double-send" is vacuous — the real double-send guard is the concurrent/redelivered emulator test above).

## Out of scope
- **Fix B** (AI WhatsApp status-responder) — sequenced after this ships.
- Predictor-driven ETA (drop-in to the same config slot once graduated).
- Any change to `ready`/`out_for_delivery`/`delivered`/`cancelled` sends.
