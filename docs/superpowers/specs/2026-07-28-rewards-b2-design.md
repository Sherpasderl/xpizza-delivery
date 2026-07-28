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
  - Server **computes the discount** (`computeRedemption` → `applyRedemptionToPricing`), applies it to the actual charge/order, or returns a **typed 409/401** (`rewards_disabled`, `login_required`, `redemption_invalid`, `reward_unavailable`, `redemption_reserve_failed` — its `reason` may be `insufficient` —, `redemption_pricing_failed`). ALL-OR-NOTHING: any failure → **non-payable, nothing written/charged**, never a silent full-price redeem.
  - ⚠️ **The order handlers do NOT return the priced breakdown to the client.** `createOrder` returns `{ok, order_id, tracking_token}`; `chargeOnlineOrder` returns checkout metadata only. `priced`/`canonical`/discount total are computed **internally** and never exposed. → **B2 MUST add a read-only server QUOTE endpoint** (§5.1) so the UI can render the review discount (screen 5) from the server's number without ever client-computing a discount.
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
8. **Deploy is owner-gated with explicit go**; functions deploy BEFORE forms (the quote endpoint must exist before the UI calls it); forms git-CD from `main`; the go-live flip is a separate manual owner action after the canary passes, and it is a **SINGLE ATOMIC multi-location update** setting `config/redemption_enabled` and `config/rewards_public/redemption_live` together (never sequentially) — so UI-live and server-live can never diverge; rollback is the same atomic update in reverse (§10).

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

- **Read balance:** subscribe/read `user_rewards/{uid}/{rid}` with the customer's Firebase auth → chip + pane + cart earn line. Read-own; no new backend. (Render nothing until auth resolves — never flash a wrong/empty balance.)
- **Eligibility (client convenience only):** X. Pizza `available ≥ card_size`; La Musa `available ≥ tier.cost`. Decides whether to *offer* redeem; the server re-checks authoritatively.

### 5.1 The server QUOTE endpoint (NEW — the only way to show a server-authoritative discount pre-checkout)
The live order handlers do NOT return the priced breakdown (§2). To render screen 5 (the struck-through review) WITHOUT the client ever computing a discount, B2 adds a **new read-only HTTPS function** — `quoteRedemption` (working name):
- **Input:** `body.items` (the cart), `body.redeem` (`{}` xp / `{level,item_id}` lm), header `X-Firebase-ID-Token`.
- **Gate:** `redemptionEnabled(db, uid)` (§6.2) + verified non-guest uid — same authorization as the intake.
- **Compute:** reuse the EXACT B1 pure functions `computeRedemption` → `applyRedemptionToPricing` (the same code the intake runs) — **no reserve, no order, no DB write, no side effects.**
- **Returns:** on success `{ ok:true, discount_cents, total_cents (discounted), free_item:{name}, subtotal_cents, tax_cents }`; on failure the **same typed errors** as the intake. Read-only preview.
- **UI use:** when the customer selects a reward, call `quoteRedemption` → render screen 5 from its numbers. Because the quote and the order-submit run the SAME server compute, the previewed total equals the charged total. If the quote fails, show the typed message and don't offer the reward.
- **Deploy note:** this is a NEW export (functions 46 → 47) — additive, no prune; starts with no special env (DB-only); money-gated as the read-only preview of the money path.

### 5.2 Redeem submit (the authoritative action)
- The existing order POST gains `body.redeem` when a reward is selected. `X-Firebase-ID-Token` already sent. NO other change to the request shape. The server **recomputes authoritatively** (the quote was display-only) and reserves+charges the discounted total.
- **Response handling:**
  - **Success:** the order is placed/charged at the discounted total (already previewed via the quote). Proceed to the success screen.
  - **Typed 409/401 → clean message, never a raw error:**
    - `reward_unavailable` (La Musa 86) → "Ese premio no está disponible ahora" + drop that item from the picker.
    - `login_required` → prompt login.
    - `redemption_invalid` / `redemption_pricing_failed` / `redemption_reserve_failed` (incl. `reason:'insufficient'`) → "No pudimos aplicar el premio, intentá de nuevo".
    - `rewards_disabled` → shouldn't surface (affordance flag-gated) → hide the affordance.
- **Redeem-failure fallback is a CLIENT workflow, not a server behavior (per gate).** The server returns non-payable 401/409 and writes/charges NOTHING on a failed `body.redeem`. So on any redeem failure the client MUST: (a) clear the pending `redeem`, (b) surface the typed message, and (c) let the customer **re-submit as a full-price order** — a **fresh submit with a clean/regenerated `order_id`/idempotency identity** (never reuse the failed submit's identity). "Continue without the reward" = this fresh full-price submit, never a partial or same-id retry.

## 6. Activation infrastructure

Three small additive pieces, built first (they gate the UI and enable the canary):

### 6.1 Client-readable live flag (precise rules — RTDB cascade)
- **New path** `config/rewards_public/redemption_live` (boolean). RTDB read grants are additive downward (a child `.read` grant applies even when the ancestor `config` expression is false; an ancestor grant can't be revoked by a child) — so grant read at **exactly** `config/rewards_public` (readable by any auth'd user), and add **`"$other": { ".read": false }` under `rewards_public`** so the public node can NEVER accumulate other (sensitive) config later. Do NOT widen `config` itself. `.write` stays staff-only. **Emulator-verified** (customer CAN read `config/rewards_public/redemption_live`; customer CANNOT read any other `config/*`; the rest of the staff-only config rule intact).
- The redeem affordance (§4.4) renders only when this is `true` (OR the canary marker, §6.3). Display surfaces (§4.1–4.3) ignore it.
- Client-side half of the flip; the server-side authorization stays `config/redemption_enabled` (§6.2).

### 6.2 Backend allowlist (canary) — the exact call-site change
- `redemptionEnabled` extends to `redemptionEnabled(db, uid)`: returns `config/redemption_enabled === true` **OR** (`uid` given AND `config/redemption_allowlist/{uid} === true`). Read the global flag first, allowlist second; keep strict `=== true`; **fail-closed OFF on any read error**; back-compatible (`uid` absent ⇒ global-flag-only). `config/redemption_allowlist` is **staff-only** (inside the existing staff-only `config` rule — customers can't read it).
- **Call-site (must change exactly):** `prepareRedemption` currently calls `redemptionEnabled(db)` BEFORE it has `customerUid`. Reorder so `customerUid` is validated first, then call `redemptionEnabled(db, customerUid)` — from BOTH the cash (`resolveRedemptionForOrder`) and online (`prepareRedemption` in `chargeOnlineOrder`) paths, and from the new `quoteRedemption`. The uid is the SERVER-verified token uid (`customer:true`, tombstone-checked); a client-supplied uid is never used — so the allowlist can only ever enable the allowlisted verified account, never broaden.

### 6.3 UI canary marker
- Read-own `user_rewards/{uid}/{rid}/canary: true` — **Admin/console/server-written ONLY** (`user_rewards` is `.write:false`; a client cannot set it). A boolean child does not violate the UID-node object `.validate` (object-only). The affordance renders if `redemption_live === true` OR `my user_rewards.canary === true`. Read-own ⇒ no other customer's browser sees it.

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

1. **Activation infra (backend)** — the `quoteRedemption` read-only endpoint (§5.1) + `redemptionEnabled(db, uid)` allowlist tweak + the exact call-site reorder in both intake paths (§6.2) [money-gated, additive, 47 exports] + the `config/rewards_public/redemption_live` + `redemption_allowlist` rules (§6.1, RTDB-emulator-verified) + the canary marker convention. *(Ships inert: `redemption_live` OFF, allowlist empty; the endpoint 409s until the flag/allowlist.)*
2. **Display surfaces** — chip + Mis premios pane + cart earn line (read `user_rewards`), both brands, byte-identical past CONFIG. *(Flag-independent; safe once logged-in reads work.)*
3. **Checkout redemption** — the redeem affordance (X. Pizza "Usar" only when a server-priceable pizza is in the cart; La Musa tier picker hiding any tier item that isn't currently priceable/available so the server never has to reject it) + the `quoteRedemption` call → the discounted struck-through review + `body.redeem` on submit + the typed-409 handling + the clear-and-fresh-full-price-resubmit fallback (§5.2). Gated on `redemption_live`/canary.
4. **Success badge + profile-claim card** — post-order earn-badge + guest profile-claim.
5. **Parity + polish pass** — X. Pizza ↔ La Musa byte-identical-past-CONFIG audit; owner aesthetic review (no cramming, alignment) on every screen before/after.

## 10. Deploy + go-live (owner-gated)

1. Functions deploy FIRST (the `quoteRedemption` export + the `redemptionEnabled(db,uid)` allowlist change + the rules addition): `firebase deploy --only functions` (47 exports, no-prune, both driver+payment, complete env) + `--only database` for the rules (emulator-verified first). Then merge B2 forms → `main`; forms deploy git-CD (`redemption_live` still OFF → redeem affordance invisible to all; display surfaces live). *(Functions-before-forms so the quote endpoint exists before any UI can call it.)*
2. **Canary smoke test** on the owner's account: set `config/redemption_allowlist/{ownerUid} = true` + the read-own `user_rewards/{ownerUid}/{rid}/canary` marker (both Admin/console-written). On the LIVE forms, verify end-to-end (advisor verifies each step against prod state — `user_rewards` ledger, order records, PixelPay). **Cover B1's full state surface, not just the happy path:**
   - **Display surfaces** render clean (chip real balance, pane, cart earn line) — no cramming; **quote** returns the right discount for both brands.
   - **Cash — normal:** redeem → quote discount = order discount → reserve → complete → **consume**; another → **cancel** → **release/reverse** (no points lost, no free discount).
   - **Cash — scheduled:** a scheduled cash redemption → held through the slot → release → materialize → consume; and one **cancelled before release** → reversal.
   - **Online — normal:** discounted total = PixelPay charge → reserve→attach→consume-at-confirm → factura reconciles; **refund** → reversal credits back `debit_applied`.
   - **Online — exceptional paid states:** a **manual-reconciliation** order (paid-during-resolve → `held_paid`) resolved BOTH ways — **abandon/refund** (release, no credit) and **materialize→sale** (consume); a **scheduled online** confirm→hold→release; verify **held_closed_at_materialize** → hold.
   - **Sweeps backstop:** confirm an abandoned online redemption's hold is reclaimed by the stale-reservation sweep (leave one checkout unpaid past `hosted_expires_at`), and a consume-recovery case is a no-op-safe.
   - **Guest** (private window): redemption invisible, quote refuses (no verified uid), checkout byte-identical to today.
3. Canary passes → remove the allowlist entry + canary marker → **atomic flip:** a SINGLE multi-location update `{ config/redemption_enabled: true, config/rewards_public/redemption_live: true }` (both set in one write so there is no window where UI-live ≠ server-live). **Rollback** is the same single update setting both `false`/removed. → **redemption live for all**, already proven end-to-end. *(Because the flip is atomic, there is never a window where a customer sees redeem+409, nor where a crafted `body.redeem` could redeem before the UI reveals it.)*

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
