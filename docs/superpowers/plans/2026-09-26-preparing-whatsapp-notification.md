# Proactive "preparing" WhatsApp — Implementation Plan (Fix A)

> **For the executor:** build task-by-task, LOCAL-ONLY, off `origin/main` @ `bcf5ff0`. Each task ends green + a commit. Advisor codex-gates this plan (pre-build) and the built diff. Spec: `docs/superpowers/specs/2026-09-26-preparing-whatsapp-notification-design.md`.

**Goal:** one WhatsApp on the `preparing` transition ("preparando — listo en ~X min"), both brands, both order types — closing the silent prep window that drives status-check WhatsApps. New trigger; the codex-gated money sender stays byte-unchanged.

## Global constraints
- **`sendOrderStatusNotifications` (index.js:3404) BYTE-UNCHANGED** vs `bcf5ff0` (diff-prove). The new trigger is fully separate.
- **Marker in `/preparing_notifications/{orderId}`** (top-level, NOT under `/orders`) — no re-firing the whole-order-node watchers.
- **Brand-agnostic:** ETA from `restaurants/<rid>/prep_eta_min`; single neutral code fallback; NO per-brand literal in code (test asserts absence). Both brands parity.
- **Fail-open, never throws, at-most-once, mark-before-send** — mirror `notifyPickupReady` exactly.

---

### Task 1 — `tplPreparing` template + pure ETA resolver (TDD)

**Files:** modify `xpizza-functions/whatsapp.js`; new `xpizza-functions/preparing-notify.test.js`.

- **Step 1 (RED):** write `preparing-notify.test.js`:
  - `tplPreparing({customerName, etaMinutes, orderType:'pickup', trackingToken, restaurantId})` → contains "preparando", "listo para recoger en ~20 min", brand emoji, tracking URL when token present; omits URL when absent. Golden strings for BOTH `x_pizza` and `la_musa` (uses `brandFor`/`itemsEmojiFor`/`trackingUrl` — brand-agnostic).
  - `tplPreparing({..., orderType:'delivery', etaMinutes:20})` → "en ~20 min sale hacia vos" (NOT "listo para recoger", NOT implying arrival).
  - `resolvePrepEtaMin(restaurantConfigValue)` (pure): finite positive number → that number; absent/NaN/≤0 → the single neutral `DEFAULT_PREP_ETA_MIN`. Assert the fallback is ONE constant, not per-brand.
- **Step 2:** run → fail (functions not defined).
- **Step 3 (GREEN):** add `tplPreparing` (copy-by-order_type, using existing helpers) + `resolvePrepEtaMin` to whatsapp.js; export both. `DEFAULT_PREP_ETA_MIN = 25` module constant.
- **Step 4:** run → pass. Assert `whatsapp.js` contains no `x_pizza`/`la_musa` prep-eta literal (config-driven).
- **Step 5:** commit — `feat(whatsapp): tplPreparing template + config-driven prep-ETA resolver`.

### Task 2 — `notifyPreparing` trigger (mirror `notifyPickupReady`)

**Files:** modify `xpizza-functions/index.js` (new export only; existing triggers untouched).

- **Step 1:** add `exports.notifyPreparing = onValueWritten({ ref: '/orders/{orderId}/status', region: 'us-central1' }, …)`, structured byte-for-structure on `notifyPickupReady`:
  - guard `if (after !== 'preparing' || before === after) return;`
  - `notifRef = db.ref('preparing_notifications/{orderId}')`; guarded `stamp`/`skip` diagnostics.
  - load order once; read-error → `read_error_at` stamp + return.
  - eligibility (fail-closed): `order` present; `customer_phone`; `restaurant_id ∈ SUPPORTED_WHATSAPP_RESTAURANTS`; `isEnabledForRestaurant`. **No `order_type` gate.**
  - claim `claimed_at` (transaction, sole authority) → lost → return.
  - await `send_started_at` before send.
  - resolve ETA: read `restaurants/<rid>/prep_eta_min` → `resolvePrepEtaMin(...)`.
  - `body = tplPreparing({ customerName, etaMinutes, orderType: order.order_type, trackingToken: order.tracking_token, restaurantId })`.
  - send; null-or-throw → `send_unresolved_at`; confirmed → `sent_at`. Never rethrow.
- **Step 2:** `node --check index.js`; **diff-prove `sendOrderStatusNotifications` byte-unchanged** vs `bcf5ff0` (grep the function absent from the index.js diff).
- **Step 3:** structural guard test `notify-preparing-structure.guard.test.js` — asserts: watches `/orders/{orderId}/status`; marker path is `preparing_notifications/` (NOT `orders/…`); claim-before-`send_started_at`-before-`sendMessage` ordering present; no `order_type ===` gate on the send; `sendOrderStatusNotifications` source unchanged (byte-compare vs a frozen copy or `git show bcf5ff0`).
- **Step 4:** commit — `feat(functions): notifyPreparing trigger — proactive prep-window WhatsApp (both brands, fail-open)`.

### Task 3 — seed config + wire tests + full suite

**Files:** `xpizza-functions/package.json` (chain); a seed note/script for `restaurants/<rid>/prep_eta_min`.

- **Step 1:** wire `preparing-notify.test.js` + `notify-preparing-structure.guard.test.js` into the npm `test` chain (after `whatsapp-config.test.js`).
- **Step 2:** document the config seed (owner applies at deploy, like the CAI/flag pattern): `restaurants/x_pizza/prep_eta_min = 20`, `restaurants/la_musa/prep_eta_min = 30`. (Fallback 25 means it's safe even before seeding.)
- **Step 3:** `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` → EXIT 0.
- **Step 4:** commit — `test(functions): wire preparing-notify tests + prep_eta_min config seed note`.

---

## Handback DoD (for the advisor gate)
- Branch@SHA off `bcf5ff0`; `sendOrderStatusNotifications` byte-unchanged (diff-proven); new trigger + template + pure resolver only.
- Tests red→green; full suite EXIT 0; both brands golden; config-driven (no per-brand literal — asserted).
- Fail-open / at-most-once / mark-before-send mirrored from `notifyPickupReady`; marker isolated in `/preparing_notifications/`.
- Deploy = single-fn `firebase deploy --only functions:notifyPreparing` (targeting one fn doesn't prune others) + seed `prep_eta_min` for both brands + smoke: place an order, kitchen taps Empezar → one "preparando ~X min" WhatsApp; verify no double-send on a status rewrite; verify the money sender's messages (recibido / va en camino / entregado) unchanged.

## Codex gate framing (advisor)
*New customer-notification trigger on the live order path: prove no double-send (claim + mark-before-send), fail-open (never throws, never affects the order), the money-adjacent `sendOrderStatusNotifications` is byte-unchanged, the marker can't re-fire the order-node watchers, ETA is config-driven/brand-agnostic, and both brands are covered.*
