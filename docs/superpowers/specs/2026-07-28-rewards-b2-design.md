# Rewards Phase B2 — Customer Redemption UI + Activation — Design

**Date:** 2026-07-28
**Status:** Design (advisor-drafted, owner-approved verbally) → codex design-gate → executor writes implementation plan → build (task-by-task, codex-on-diff) → deploy + canary → global flip
**Surface:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (order forms, git-CD from `origin/main`) + their `account.js`; a small rules addition (`database.rules.json`, emulator-verified) + one additive backend tweak (`rewards-redeem-config.js`).
**Type:** Customer-facing UI (both brands) + the activation infrastructure that turns the live-inert B1 redemption money-path ON.

---

## 1. Goal

Ship the full customer-facing rewards experience — the 7 approved mockup screens — wired to the **already-live, inert** B1 redemption backend, and activate redemption safely (canary smoke test → global flip). After B2, a logged-in customer can see their accrued points and redeem a reward at checkout; the server computes every discount; guests are byte-identical to today.

**This phase ACTIVATES real money movement.** The redemption money-path (B1, Tasks 1–10) is deployed and dormant behind `config/redemption_enabled` (currently `null`/OFF). B2 builds the UI that drives it and flips it on.

## 2. Locked upstream facts (do not re-derive)

- **B1 backend is LIVE + INERT** (`origin/main @ 4eaf13a`). Contract:
  - Client sends `body.redeem` + header `X-Firebase-ID-Token` (a verified `customer:true` uid) to `createOrder` (cash) / `chargeOnlineOrder` (online).
  - Server **computes the discount** (`computeRedemption` → `applyRedemptionToPricing`), returns the **discounted breakdown** on success, or a **typed 409/401** (`rewards_disabled`, `login_required`, `redemption_invalid`, `reward_unavailable`, `insufficient`, `redemption_reserve_failed`, `redemption_pricing_failed`). ALL-OR-NOTHING: any failure → non-payable, never a silent full-price redeem.
  - Server stamps `orders/{id}.redemption = canonical`.
  - Flag gate: `redemptionEnabled(db)` reads `config/redemption_enabled` (strict `=== true`, fail-safe OFF). Flag OFF ⇒ every redeem → 409 `rewards_disabled`.
- **The 7-screen UI mockup is OWNER-APPROVED** (artifact ef637a1b — chip, Mis premios pane, cart earn line, checkout redemption, review discount line, success badge, profile-claim card). **B2 builds it EXACTLY as approved.** No re-design. Owner aesthetic standard: NO crammed icons/text, perfect alignment, seamless — verify before/after each screen.
- **Locked reward config** (`rewards-redeem-config.js`, `config_version 1`): X. Pizza punch-card `card_size 8`, welcome 2, redeem = cheapest pizza in cart (server-chosen). La Musa points tiers 500/1000/1500/2500/3500 (pick 1 free item per tier). Earn config (Phase A, live): X. Pizza 1 punch/pizza + welcome 2; La Musa 10 pts / 30 L + welcome 100.
- **Data model:** `user_rewards/{uid}/{restaurant_id}` = `{ balance, reserved, lifetime, config_version, ledger, reservations }`. Rule: `.read` own (`auth.uid === $uid`), `.write:false` (Admin-only). `available = balance − reserved`.
- **Form foundation exists:** both forms already send `X-Firebase-ID-Token` (the logged-in token) on order requests, and `account.js` owns the logged-in customer context (login, profile, saved addresses). B2 extends this — it does NOT rebuild auth.
- **Forms are byte-identical past `CONFIG`** (X. Pizza ↔ La Musa). Every B2 UI addition MUST hold that invariant: brand differences (punch-card vs points/tiers, copy, palette) live in `CONFIG`; the mechanism past CONFIG is identical.

## 3. Global Constraints (non-negotiable)

1. **Server is the authority on money.** The client NEVER computes or displays a self-derived discount total. Eligibility checks (show/hide the redeem affordance) are a client convenience; the discounted total shown in the review is ALWAYS the server's returned number. Any divergence → the server value wins.
2. **Redemption requires a verified non-guest `customer_uid`.** Guests cannot redeem; the guest checkout path stays **byte-identical to today** (no `body.redeem`, no behavior change).
3. **Display surfaces (chip, pane, cart earn line) are read-only** on `user_rewards` (read-own) and **flag-independent** — they render whenever a logged-in customer has a balance, regardless of `redemption_live`.
4. **The redeem affordance (screen 4) renders ONLY when redemption is live for this customer** — i.e. the client-readable `config/rewards_public/redemption_live === true` OR this customer's read-own canary marker is set. Never show a redeem control that can't complete (no "coming soon" state).
5. **No half-baked / crammed UI, ever.** Every state (loading, error, unavailable, ineligible) has a clean, aesthetic treatment matching the mockup. If a state can't be made clean, it isn't shown.
6. **Byte-identical past CONFIG** across the two brands (§2). **Guest byte-identical** to today (§2 in Global Constraints #2).
7. **The rules addition is RTDB-emulator-verified** (per the standing no-`numChildren()` rule — JSON/codex miss RTDB cascade semantics; only the emulator/deploy catches them). The `redemptionEnabled` change keeps its strict-`=== true` / fail-safe-OFF discipline.
8. **Deploy is owner-gated with explicit go**; forms git-CD from `main`; the go-live flag flip is a separate manual owner action after the canary passes.

## 4. Components — the 7 screens (both brands, differences in `CONFIG` only)

Build EXACTLY as the approved mockup. Below is the behavior + the brand-config split.

### 4.1 Header chip (screen 1)
- Shows the logged-in customer's balance: X. Pizza `[person] Xavier · 5/8 [gift]` (current-card punches / `card_size`, then a minimalist gift glyph); La Musa `· 380 pts`.
- Reads `user_rewards/{uid}/{rid}` (read-own). Hidden for guests. Live-updates on balance change (subscription or refresh on order completion).
- Tapping the chip opens the **Mis premios pane**.
- `CONFIG`: the count formatting (`n/card_size` vs `n pts`), the glyph, the copy.

### 4.2 Mis premios pane (screen 2)
- Hero progress: X. Pizza an **8-slot punch card** (filled/empty slots, "first free at 6, then every 8" mental model shown via the filled count toward the next reward); La Musa a **milestone bar** (Talkin-Tacos style, tiers 500→3500 marked, current points positioned).
- Read-only. Reachable from the chip.
- `CONFIG`: punch-card vs milestone-bar renderer, tier labels, copy.

### 4.3 Cart earn line (screen 3)
- In the cart, a line: **logged-in** → "ganás 1 sello" (X. Pizza) / "ganás X pts" (La Musa, computed from the cart subtotal at the earn rate — DISPLAY only; the server is authoritative at completion); **guest** → "Creá tu perfil y ganás X" (the earn-as-incentive-to-register nudge).
- `CONFIG`: earn unit (sello vs pts), the earn-rate for the display estimate, copy.

### 4.4 Checkout "Canjear premio" (screen 4) — the redeem affordance
- Renders ONLY when redemption is live for this customer (Constraint #4) AND the customer is **eligible** (X. Pizza `available ≥ card_size`; La Musa `available ≥ min tier cost`).
- **X. Pizza:** a single **"Usar"** action → redeem one free pizza (server picks the cheapest pizza in the cart). Requires ≥1 pizza in cart (server-enforced; the UI only offers it when a pizza is present).
- **La Musa:** a **tier picker** → the customer picks a tier they can afford, then picks one item from that tier's list. Only tiers with `available ≥ tier.cost` are offered; only currently-available (not-86'd) items are offered (see edge states).
- Selecting a reward sets the pending `redeem` payload (`{}` for X. Pizza; `{level, item_id, name}` for La Musa — `name` is the display string, server-sanitized, price/eligibility server-derived).
- On order submit, `body.redeem` + the token are sent; the server returns the discounted breakdown.
- `CONFIG`: "Usar" single-action vs tier-picker component, tier data, copy.

### 4.5 Review discount line (screen 5)
- After the server returns the discounted breakdown, the review shows the freed/added item as a **struck-through discount line** and the new (lower, or unchanged-for-La-Musa) total — rendered from the **server's** numbers.
- X. Pizza: the cheapest pizza struck-through, total drops by its base unit. La Musa: the added tier item at "GRATIS", total unchanged.
- `CONFIG`: copy; the mechanism is identical.

### 4.6 Success earn-badge (screen 6)
- Post-order success screen shows the earn ("+1 sello" / "+X pts"), and if a reward was redeemed, a confirming note.
- `CONFIG`: earn unit, copy.

### 4.7 Profile-claim card (screen 7)
- For **guests** post-order: a card that leads with the reward ("Creá tu perfil y guardá tus X pts / tu sello de este pedido") — the registration incentive. Deep-links to profile creation (existing `account.js` flow).
- The delivery vehicle referenced in [[profiles-profile-first-ux]] / the account-creation push.
- `CONFIG`: copy, the reward framing.

## 5. Wiring contract (client ↔ live B1 backend)

- **Read balance:** subscribe/read `user_rewards/{uid}/{rid}` with the customer's Firebase auth → chip + pane + cart earn line. Read-own; no new backend.
- **Eligibility (client convenience only):** X. Pizza `available ≥ card_size`; La Musa `available ≥ tier.cost`. Decides whether to *offer* redeem; the server re-checks.
- **Redeem submit:** the existing order POST gains `body.redeem` when a reward is selected. `X-Firebase-ID-Token` already sent. NO other change to the order request shape.
- **Response handling:**
  - **Success:** server returns the discounted breakdown (+ the redemption result). Render the struck-through review from the server total. Proceed to payment/confirmation with the server's total.
  - **Typed 409/401 → clean message, never a raw error:**
    - `reward_unavailable` (La Musa 86) → "Ese premio no está disponible ahora" + drop that item from the picker; let the customer pick another or continue without.
    - `login_required` → prompt login (redemption needs a verified account).
    - `redemption_invalid` / `redemption_pricing_failed` / `redemption_reserve_failed` → "No pudimos aplicar el premio, intentá de nuevo" + clear the pending redeem (order can proceed at full price).
    - `insufficient` → shouldn't surface (eligibility-gated) → same graceful clear.
    - `rewards_disabled` → shouldn't surface (affordance flag-gated) → hide the affordance + clear.
- **All-or-nothing:** if a redeem fails, the customer can still place the order at full price (the failure clears the redeem, it never blocks checkout). Matches the server's non-payable-on-redeem-failure being surfaced as a clean retry, not a dead end.

## 6. Activation infrastructure

Three small additive pieces, built first (they gate the UI and enable the canary):

### 6.1 Client-readable live flag
- **New path** `config/rewards_public/redemption_live` (boolean), made **customer-readable** via a scoped rules addition (a public sub-node under `config` that customers may read; the rest of `config` stays staff-only). Emulator-verified.
- The redeem affordance (§4.4) renders only when this is `true` (OR the canary marker, §6.3).
- This is the client-side half of the flip; the server-side gate stays `config/redemption_enabled`.

### 6.2 Backend allowlist (canary)
- `redemptionEnabled` becomes: `global config/redemption_enabled === true` **OR** `config/redemption_allowlist/{uid} === true` (staff-only path). Small additive change to `rewards-redeem-config.js`; keeps strict `=== true` + fail-safe OFF.
- Intake passes the already-resolved `customer_uid` to the check (signature extends `redemptionEnabled(db)` → `redemptionEnabled(db, uid)`, back-compatible: `uid` optional, absent ⇒ global-flag-only).
- Lets redemption work for ONLY the allowlisted test uid against real prod, pre-global-flip.

### 6.3 UI canary marker
- Read-own `user_rewards/{uid}/{rid}/canary` (Admin-written, staff sets it on the test account). The affordance renders if `redemption_live === true` OR `my user_rewards.canary === true`. Read-own ⇒ no other customer's browser sees it.

## 7. Guest vs logged-in

- **Logged-in:** full chip / pane / cart-earn / redeem (when live) / earn-badge.
- **Guest:** no chip / pane / redeem; cart earn line → "Creá tu perfil y ganás X"; post-order → profile-claim card. **Checkout byte-identical to today** — guests send no `body.redeem`, hit no redemption path.

## 8. Edge states (all handled cleanly — Constraint #5)

- **La Musa item 86'd** between load and redeem → server `reward_unavailable` → drop the item, message, let them re-pick.
- **Server reward ≠ client-shown** (e.g. cheapest pizza differs from what the UI guessed) → the server total is authoritative; the review reflects the server's freed item.
- **Balance changed** between pane-load and redeem (another concurrent order consumed it) → server `insufficient`/`redemption_invalid` → graceful clear; the order proceeds at full price.
- **Cart changed after selecting a reward** (item added/removed) → the redeem re-binds to the new order fingerprint server-side on submit; the UI re-sends the selection. If the reward is no longer valid (e.g. the only pizza was removed for X. Pizza) → clear the affordance.
- **Not-eligible-yet** (below threshold) → the affordance isn't shown; the pane shows progress toward it (goal-gradient).

## 9. Build phasing (task-by-task; each codex-gated; ships together)

Even though everything ships in one go-live, the BUILD is incremental + gated:

1. **Activation infra** — `redemption_live` public flag + `redemption_allowlist` rules (RTDB-emulator-verified) + `redemptionEnabled(db, uid)` allowlist tweak (money-gated, additive) + the canary marker convention. *(Ships inert: `redemption_live` OFF, allowlist empty.)*
2. **Display surfaces** — chip + Mis premios pane + cart earn line (read `user_rewards`), both brands, byte-identical past CONFIG. *(Flag-independent; safe once logged-in reads work.)*
3. **Checkout redemption** — the redeem affordance + La Musa tier picker + `body.redeem` wiring + the discounted struck-through review + the typed-409 handling. Gated on `redemption_live`/canary.
4. **Success badge + profile-claim card** — post-order earn-badge + guest profile-claim.
5. **Parity + polish pass** — X. Pizza ↔ La Musa byte-identical-past-CONFIG audit; owner aesthetic review (no cramming, alignment) on every screen before/after.

## 10. Deploy + go-live (owner-gated)

1. Merge B2 branch → `main`; forms deploy git-CD (`redemption_live` still OFF → redeem affordance invisible to all; display surfaces live).
2. **Canary smoke test** on the owner's account: set `config/redemption_allowlist/{ownerUid} = true` + the read-own canary marker. On the LIVE forms, verify end-to-end (advisor verifies each step against prod state):
   - Display surfaces render clean (chip shows real balance, pane, cart earn line) — no cramming.
   - **Cash redemption** (real order, no card): redeem affordance → server discount → struck-through review → discounted order → reserve → complete → **consume**; then cancel another → **release/reverse**.
   - **Online redemption** (real card, small amount): discounted total = PixelPay charge → reserve→attach→consume-at-confirm → factura reconciles; **refund** → reversal credits back.
   - **Guest** (private window): redemption invisible, checkout byte-identical.
3. Canary passes → remove the allowlist entry + canary marker → flip `config/rewards_public/redemption_live = true` + `config/redemption_enabled = true` → **redemption live for all**, already proven end-to-end.

## 11. Out of scope

- Any change to the B1 money-path logic (reserve/consume/reversal/sweeps) — B2 is UI + activation only; B1 is done + deployed.
- Rewards expiration (none v1).
- Loyalty marketing/advertising (separate; only after B2 live + soaked + reconciled).
- Non-order-form surfaces (KDS/driver/dispatch already read the structured order; no rewards UI there).

## 12. Testing

- Display surfaces: logged-in reads own balance; guest sees none; both brands render byte-identical past CONFIG.
- Redeem: server-total authoritative (never client-computed); each typed-409 → clean message; guest checkout byte-identical.
- Activation: rules addition emulator-verified (public flag customer-readable, allowlist staff-only, `user_rewards` spine intact — owner reads own, cross-account denied); `redemptionEnabled(db, uid)` strict/fail-safe preserved + back-compatible.
- Canary: the full §10 end-to-end (cash + online, both money paths, verified against prod).
- Byte-identical guards where feasible (the two forms past CONFIG).

---

*Mockup reference: the owner-approved 7-screen artifact (ef637a1b) — the locked visual direction; B2 ports it exactly. Related: [[rewards-loyalty-program]] (B1 complete + live-inert), [[profiles-profile-first-ux]] (the profile-claim delivery vehicle), [[seamless-customer-ux-priority]], [[no-cheap-emoji-in-form-chrome]].*
