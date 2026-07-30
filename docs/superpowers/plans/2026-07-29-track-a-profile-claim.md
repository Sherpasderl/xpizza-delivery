# Track A — Profile-Claim Completion (build plan · for advisor gate)

_Additive account-creation UX. Money path UNTOUCHED → code-gate. Ships INDEPENDENTLY of the rewards flip. Both brands. Mockup 315bc6e2 + the tracker screenshot. Branch `feat/track-a-profile-claim` off `main` (`4811267`)._

## The one design decision (advisor to gate): soft-fill transport tracker → order form

**GATED: (b) — token-gated lookup. No phone in a shareable URL. APPROVE-WITH-CHANGES (codex thread 019fb102 confirmed the mechanism sound: token entropy ~6×10²⁰, `.order_id===order_id` binding correct, OTP-gating → leaked token non-hijacking). 3 must-fix folded in below.**

### Must-fix (folded in)
- **MF1 — token in the URL FRAGMENT, not the query.** Deep-link → `orders.{brand}.hn/?claim=<order_id>#t=<token>`. The `#fragment` is never sent to servers or in `Referer` → the token never hits Netlify logs nor leaks to Google Fonts (`index.html:7`) / Maps (`:1336`) / Firebase (`account.js:26`). Read it from `location.hash`; do the hash-read + `history.replaceState` in an **inline `<head>` script BEFORE any third-party resource loads**. Add `Referrer-Policy: strict-origin-when-cross-origin` to BOTH `netlify.toml`. `order_id` stays in the query (not a capability).
- **MF2 — set `has_profile` INSIDE the shared `buildMaterializeUpdates()`** (`materialize.js:111`), conditioned on `order.customer_uid` — NOT only at named call sites. That builder also feeds manual reconciliation (`resolve-manual.js:59`), pixelpay-confirm (`:286`), and scheduled-release (`:58`); missing it there → a profiled customer's online/manual/scheduled order wrongly shows the guest card. Immediate createOrder path: set it on the resolved server `customer_uid` (after `attachCustomerAttribution`). Guest omission stays conditional → guest `order_tracking` byte-identical.
- **MF3 — per-IP throttle on `claimPrefill`** — reuse the existing rate-limit bucket (`index.js:330` def / `:517` enforcement). `maxInstances` is concurrency, not a rate limit; this returns phone PII → throttle replay/harassment on a leaked link.
- Minor: `claimPrefill` strict string compare + reject missing `order_id` as 403. Fix the stale `generateTrackingToken` comment (`index.js:160` says 64-char alphabet; it's actually 54).
- NOT doing the masked-phone/server-OTP redesign (codex nice-to-have) — after MF1 the token never leaks, residual elevation is bounded (customer's own phone, OTP-hijack-proof). Owner deferred.

Grounding (verified in code):
- The tracker reads **public** `order_tracking/{token}` (`xpizza-track/index.html:689` `onValue`). Its schema (`create-order-build.js` / `materialize.js`) has `customer_name` but **NO `customer_phone` and NO `customer_uid`**. So the tracker can neither tell guest-vs-profile nor read the phone today.
- Option (a) puts the phone in the deep-link URL → shareable/loggable. Rejected.
- Option (b): the deep-link carries only `order_id` + the **`tracking_token` the tracker already holds** (the customer's own capability, already in their tracker link) — nothing new is exposed. The order form resolves the phone via a **token-gated Cloud Function** (admin-SDK read of `orders/{id}`), so the phone is never in a URL or a public node.

**Why (b) is safe + minimal:** the `tracking_token` is already the read capability for this order (it gates `order_tracking`). The new function only returns the order's OWN `{phone, name}` and only when `order_tracking/{token}.order_id === order_id` (token↔order bound). Actual account creation is still OTP-gated (a leaked token can't hijack — the OTP goes to the phone). Phone exposure is strictly less than option (a) (never in a shareable/logged URL).

## Mechanism (b)

1. **New function `claimPrefill`** (`onRequest`, region us-central1, cors) — input `{ order_id, token }`:
   - Read `order_tracking/{token}` (admin). Reject (403) unless it exists AND `.order_id === order_id` (token bound to this order).
   - Return `{ ok:true, name: orders[order_id].customer_name || '', phone: orders[order_id].customer_phone || '' }`. Nothing else (no address/items/uid). 404 if the order is gone.
   - Rate-limit-light (maxInstances low); no writes; read-only.
2. **`has_profile` flag on `order_tracking`** (additive, PROFILED-only → guests byte-identical): the tracker needs guest-vs-profile for card visibility without a function call. Set `order_tracking/{token}.has_profile = true` **only when the order has a `customer_uid`**:
   - createOrder immediate path: after `attachCustomerAttribution` (which stamps `customer_uid`), set it on the `updates` `order_tracking/{token}` node when `customer_uid` present.
   - `materialize.js` (online + scheduled release): set it from `order.customer_uid` on the built `order_tracking` node.
   - **Guests omit the field** → guest `order_tracking` byte-identical (golden tests unaffected). Tracker treats `has_profile !== true` as guest → card shows.
   - Boolean only — no PII in the public node.

## Part 1 — Success-screen soft-fill (order form · `account.js`, byte-identical past CONFIG)

- **`openLoginSheet(prefill?)`** (`account.js:812`): today it clears the phone input (`inp.value=''`). Add an optional `prefill` arg: when `{phone}` given, set the phone input to it (formatted) + enable the CTA; stash `prefill.name` in a module-level `_prefillName` that the **name pane** (shown after OTP for a NEW profile) pre-fills. **When `prefill` is absent → clears exactly as today.** Existing callers — Entrar chip (`:105`), cart nudge (`:236`) — pass nothing → **byte-identical**.
- **Success claim card** (`renderSuccessRewards`, `account.js:462`): its `onclick` → `openLoginSheet({ phone: env.claimPhone, name: env.claimName })`. `renderSuccessRewards`'s env has no phone/name today → thread them in from the **index.html call site** (`window.__ACCOUNT.renderSuccessRewards({ …, claimPhone: currentOrder.customer_phone, claimName: currentOrder.customer_name })`). Same-session (order just placed) → `currentOrder` in memory → **no transport needed** here.
- Guest → soft-filled create; one tap → OTP, no re-type. Logged-in success (the earn badge, not the claim card) unaffected.

## Part 2 — Tracker profile-claim card (`xpizza-track/index.html`)

- Additive card BELOW the existing driver/status block (do NOT restyle existing UI). Content per mockup: heading **"Guardalo para reordenar"**, copy **"Creá tu perfil y reordená este pedido cuando quieras, en un toque."**, two ✓ lines **"Reordenar en un toque"** / **"Direcciones e historial guardados"**, button **"Crear mi perfil"**.
- **Guest-only:** render only when `data.has_profile !== true`; hide otherwise.
- **Brand-aware deep-link** (reuse the `data.restaurant_id` brand mapping already in `applyRestaurantBrand`): button → `https://orders.xpizza.hn/?claim=<order_id>&t=<token>` (x_pizza) / `https://orders.lamusa.hn/?claim=<order_id>&t=<token>` (la_musa). Tracker is read-only → deep-links out, no OTP duplication.
- Icons per the design rule (monochrome line ✓, NO cheap emoji in chrome — [[no-cheap-emoji-in-form-chrome]]).

## Part 3 — Deep-link handler (order form · `index.html`)

- New `handleProfileClaim()` (mirrors the existing `handlePaymentReturn()` `?pay=` pattern, `index.html:2636`; called on load alongside it at `:3689`): read `?claim=<order_id>&t=<token>`; if present, `fetch(CLAIMPREFILL_URL, {order_id, token})` → on `{ok, phone, name}`, `openLoginSheet({phone, name})` (soft-filled create sheet). Fail-open: any error → open the create sheet empty (never block). Strip the params from the URL after handling (history.replaceState) so a reload/back doesn't re-trigger.
- If the customer is already logged in on this device → skip (no claim prompt).

## Invariants / verification

- **`account.js` byte-identical past CONFIG** — `rewards-parity.guard` 4/4 (openLoginSheet + renderSuccessRewards changes mirrored; the prefill logic is brand-agnostic).
- **Additive only** — no restyle of the tracker status/driver UI or the success/login layout; guest `order_tracking` byte-identical (`has_profile` omitted for guests → `create-order-build` / `materialize-snapshot` goldens unaffected).
- **Both brands**; deep-link origin brand-mapped.
- **Money path UNTOUCHED** — no pricing/redemption/factura/cash change. `claimPrefill` is read-only + token-gated.
- Tests: `create-order-build` / `materialize-snapshot` goldens green (additive `has_profile` only on the attributed case); a `claimPrefill` emulator test (token-bound → returns phone; wrong/missing token → 403; guest vs profiled).

## Files
`xpizza-functions/index.js` (new `claimPrefill` + `order_tracking.has_profile` at the createOrder write site) · `xpizza-functions/create-order-build.js` + `materialize.js` (+ `attachCustomerAttribution`) for the `has_profile` flag · `xpizza-orders/account.js` + `la-musa-orders/account.js` (`openLoginSheet(prefill)` + `_prefillName` + name-pane prefill) · `xpizza-orders/index.html` + `la-musa-orders/index.html` (`renderSuccessRewards` env + `handleProfileClaim`) · `xpizza-track/index.html` (guest-only card + brand deep-link).

## Sequencing
1. `claimPrefill` + `has_profile` flag (functions) → 2. Part 1 (account.js prefill + success env) → 3. Part 3 (order-form deep-link handler) → 4. Part 2 (tracker card). Each a code-gate SHA. Nothing merged/deployed until gated.
