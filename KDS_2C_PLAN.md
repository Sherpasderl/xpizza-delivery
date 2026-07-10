# Plan: KDS Phase 2c — Pickup-Ready WhatsApp
_Round 3 revision by Claude (incorporates Codex R1 1–8 + R2 1–5 + R3 1–3)_

## Goal
When a **pickup** order transitions to `status === 'ready'` (the KDS "Listo" tap), send the customer **one** WhatsApp — "tu pedido está listo para recoger" — via that restaurant's own UltraMsg instance, **at most once ever**, with **zero interference** to the existing notification/delivery/driver/factura/money machinery. Delivery orders are untouched (they notify on `out_for_delivery`). Design bias: a **missed** send is a recoverable operational nuisance; a **duplicate** customer message is the failure we refuse. So we mark-before-send, never auto-reclaim, and keep an **honest** record that never claims a send was safe-to-resend unless it provably never left the building.

## Approach
1. **New isolated trigger `notifyPickupReady`** — `onValueWritten({ ref: '/orders/{orderId}/status' })`, `region: 'us-central1'`. SEPARATE from `sendOrderStatusNotifications` (which stays byte-for-byte unchanged).
2. **Explicit early return, then eligibility classification.** FIRST line: `if (after !== 'ready' || before === after) return;` — a no-op status rewrite does nothing, before ANY diagnostic/claim/send work (this is NOT the redelivery guard; the §4 transaction is). Then load the order once and classify eligibility, ALL required:
   - order exists;
   - `order_type === 'pickup'` (EXPLICIT — missing/legacy/`delivery` ⇒ ineligible: wrong-channel fail-safe);
   - **`order.restaurant_id` is a SUPPORTED WhatsApp restaurant** (`x_pizza` or `la_musa`) — no `'x_pizza'` fallback, and unknown/typo IDs FAIL CLOSED (they must not route through X. Pizza's config via `resolveWhatsappConfig`'s non-`la_musa` default and send from the wrong number) → skip `no_restaurant_id` / `unsupported_restaurant` (Codex R2#4, R3#2);
   - `customer_phone` present;
   - `whatsapp.isEnabledForRestaurant(db, order.restaurant_id)` true.
3. **State tree — a SEPARATE top-level node, never under `/orders`.** `/pickup_ready_notifications/{orderId}` with an honest lifecycle:
   - `skipped_at` + `skipped_reason` — written when INELIGIBLE (`not_pickup` / `no_restaurant_id` / `unsupported_restaurant` / `no_phone` / `whatsapp_disabled` / `order_missing`). Diagnostic only; never claims, never sends. Written via a **guarded `transaction()` that ABORTS if `claimed_at` or `sent_at` already exists** — so a redelivered event reading changed order state can never stamp `skipped_at` onto an already-claimed/sent node (Codex R3#3). Interpretation precedence: **`sent_at`/`claimed_at` ALWAYS beat `skipped_at`.**
   - `claimed_at` — the transaction claim (won the right to send).
   - `send_started_at` — stamped **immediately before** the UltraMsg call.
   - `sent_at` — stamped **only** on a confirmed provider success (non-null `sendMessage` return).
   - `send_unresolved_at` — stamped when the send did NOT confirm (a `null` return OR a thrown error after `send_started_at`). **No fake error detail**: `sendMessage` swallows the reason internally, and a `null` covers preflight-reject, provider-reject, AND transport-unknown (the request may have reached UltraMsg and the customer may have received it) — so an unconfirmed send is **never** auto-labeled safe to resend (Codex R2#1/#2).
   Chosen as a separate tree (not `/orders/{id}/…`) because **four triggers watch the whole `/orders/{orderId}` node** (`materializeOnConfirm`, `allocateFacturaOnSale`, `voidFacturaOnCancel`, `autoAssignOnOrderCreate`); a mark under the order would re-fire all four. No trigger watches `/pickup_ready_notifications`, and `notifyPickupReady` watches `/orders/{id}/status`, so it cannot self-trigger. Mirrors the `logOrderLifecycle` isolation pattern.
4. **Claim → start → send → record (mark-before-send):**
   a. `transaction()` on `/pickup_ready_notifications/{orderId}/claimed_at`: value present ⇒ **abort** (already claimed); null ⇒ set `ServerValue.TIMESTAMP` and win. Sole redelivery/concurrency authority (Codex R1#2 — a redelivered `new→ready` event still carries `before='new'`; only the transaction stops the second send).
   b. Winner sets `send_started_at = ServerValue.TIMESTAMP` and **awaits that write; if it FAILS, abort WITHOUT calling `sendMessage`** (swallow/log). This guarantees the recovery invariant: `claimed_at`-only (no `send_started_at`) ⇒ `sendMessage` was never called ⇒ genuinely unsent (Codex R3#1).
   c. Build the message via a NEW `whatsapp.tplPickupReady({ customerName, trackingToken, restaurantId })`. If `order.tracking_token` is absent, the template **omits the tracking link** (never builds a URL from a bad token — Codex R1#4); the core "listo para recoger" message still sends.
   d. `let result = null; try { result = await whatsapp.sendMessage(order.customer_phone, body, order.restaurant_id); } catch (e) { result = null; }` — handles both `null`-return and throw.
   e. `result` non-null (confirmed success) ⇒ set `sent_at`. Otherwise ⇒ set `send_unresolved_at`. **Never** set `sent_at` on a null/thrown result (Codex R1#1).
   f. Never throw out of the trigger (no retry storm). No auto-reclaim of `claimed_at`.
5. **Honest recovery states — Admin-only view (Codex R1#3, R2#1/#3).** The recovery view is **Admin-SDK / Cloud Logging** (and, if built later, a dispatcher-gated *callable*) — NOT a direct client RTDB read, because the §7 rules deny ALL client reads, dispatcher included. Interpretation:
   - `sent_at` present ⇒ **confirmed sent**. Done.
   - `send_started_at` present, no `sent_at` (with or without `send_unresolved_at`) ⇒ **UNRESOLVED** — the attempt was made; the customer MAY have received it. A human verifies with the customer/provider before any resend. **Never** auto-safe.
   - `claimed_at` only, no `send_started_at` ⇒ died before the attempt ⇒ not sent ⇒ safe to resend after a human check.
   - `skipped_at` ⇒ ineligible; never attempted.
   (A structured `sendMessageDetailed()` separating preflight-reject from transport-unknown — enabling safe auto-resend of provably-unsent failures — is a documented **v2**.)
6. **Recall-safety.** Recall is local and never reverts `/orders/{id}/status` after ready, so status won't bounce `ready→x→ready`. Even if it did, the `claimed_at` guard (never cleared) makes a re-send impossible.
7. **Rules (Codex R1#6/#7).** In the CANONICAL `xpizza-reference/database.rules.json`, add explicit top-level `"pickup_ready_notifications": { ".read": false, ".write": false }` (Admin SDK bypasses; public, kitchen_staff, dispatcher, driver ALL denied — dispatchers otherwise hold broad grants). `npm run check:rules` (`sync:rules` → `assert-rules-synced` → guard test) regenerates + verifies the `xpizza-functions/database.rules.json` deploy artifact; wire a new guard assertion in. Deploy via `firebase deploy --only database`.
8. **Template.** `tplPickupReady` in `whatsapp.js`, per-restaurant via `resolveWhatsappConfig` (x_pizza hardcoded tracking base; la_musa env-driven, returns null when creds unset ⇒ `sendMessage` skips = fail-safe). Link only when `trackingToken` present. Unit-tested per restaurant.
9. **Deploy is zero-prune** — adds ONE function (`notifyPickupReady`, 36 → 37); `firebase deploy --only functions` must still carry every existing driver/payment/factura function (verify vs `functions:list`).

## Key decisions & tradeoffs
- **Separate trigger, not folded into `sendOrderStatusNotifications` (Codex R1#9).** Kept separate — freezes the LIVE, money-adjacent delivery/cancel + tracking-mirror path byte-for-byte; folding in the claim transaction + send-state machine + new template raises its blast radius. The only cost is one extra `order` read per `ready` transition — negligible vs regression risk on the live sender. (Reasoned rejection.)
- **Separate top-level tree, not on the order.** THE isolation call — avoids re-firing the four whole-node `/orders` triggers.
- **Two honest terminal-ish send states, not three.** `sent_at` (confirmed) vs everything-else-after-attempt = UNRESOLVED. The old "clean failure ⇒ safe resend" was unsafe because a `null` from `sendMessage` can mean the customer already got it (Codex R2#1). We never claim safe-to-resend once the attempt started.
- **Strict `restaurant_id` (no `'x_pizza'` fallback for the send).** A customer-facing message must go from the correct number or not at all.
- **Omit the tracking link when the token is absent** rather than block the message.

## Risks / open questions
- **Event redelivery / concurrency** — the `claimed_at` `transaction()` is the sole authority; proven by a double-invocation test asserting exactly one send.
- **Mid-attempt crash → UNRESOLVED** — inherent to any at-least-once system; made SAFE by `send_started_at` + forbidding auto-resend on unresolved.
- **`sendMessage` opacity** — it returns `null` for many failure modes without a distinguishable reason; v1 treats all post-attempt nulls as UNRESOLVED. Structured outcomes are a v2.
- **Whole-node order triggers** — four watch `/orders/{orderId}`; the separate tree sidesteps all. Any trigger on `/pickup_ready_notifications` would be a blocker (none exists).
- **Dispatcher grants** — the explicit top-level `false/false` must beat any ancestor grant; proven by the 4-client guard test.

## Tests (emulator + unit)
1. Pickup `ready` → exactly ONE `sendMessage`; `claimed_at` + `send_started_at` + `sent_at` set; zero writes to `/orders`, tasks, payments, factura.
2. **Double-invocation of the same `ready` event → exactly ONE send** (transaction authority — Codex R1#2).
3. **Delivery `ready` → NO claim, NO send**; pickup `ready` in the same suite → one send (wrong-channel guard — Codex R1#8).
4. **Send failure (`sendMessage` → null) → `send_unresolved_at` set, `sent_at` ABSENT** (no false-sent — Codex R1#1/R2#1); a thrown `sendMessage` → same.
5. Ineligible (missing `customer_phone` / `whatsapp_disabled` / non-pickup / missing `restaurant_id` / **unsupported/typo `restaurant_id`**) → `skipped_at` + correct reason, no claim, no send (Codex R1#5, R2#4, R3#2).
   - **Skip-guard:** a node already carrying `claimed_at`/`sent_at` is NOT overwritten by a later redelivered-and-now-ineligible invocation — `skipped_at` never lands on a sent node (Codex R3#3).
   - **Durable-start:** if the `send_started_at` write fails, `sendMessage` is not called — a `claimed_at`-only node is truthfully unsent (Codex R3#1).
6. Missing `tracking_token` → message sent WITHOUT a link (Codex R1#4).
7. No-op `ready→ready` rewrite → early return, nothing written (Codex R2#5).
8. Rules guard: public, kitchen_staff, dispatcher, driver all DENIED read+write on `/pickup_ready_notifications` (Codex R1#6); `check:rules` sync verified (Codex R1#7).
9. `tplPickupReady` per-restaurant snapshot (x_pizza / la_musa brand + link/no-link).

## Out of scope
- Delivery notifications, driver messaging, factura, any `/orders` or money write; changing `sendOrderStatusNotifications`, the tracking mirror, or any KDS client code.
- Auto-retry / auto-reclaim of a failed or unresolved send; a structured `sendMessageDetailed()`; a dispatcher "resend" UI/callable (all v2).
- Notifying on any non-`ready` status or any non-pickup order.
