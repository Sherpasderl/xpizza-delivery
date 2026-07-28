# DESIGN — Rewards / Loyalty program (per-brand), the flagship profile-creation incentive

**Status:** DESIGN (pre-gate). Off live `main` `8d67291`. Money-touching (redemption) → codex design-gate before any build; phased so the money-path piece is isolated + gated hardest.

## Goal
A per-brand loyalty program that is *the* headline reason to create a profile. Research-backed structure (see session notes): **free food beats discounts** (allure-of-free + goal-gradient), **first reward reachable in ~2–3 orders** with a **day-one welcome bonus** (pre-stamped-card effect), **kept simple**. Two brands, two menu realities → two reward tables on ONE engine.

## Per-brand mechanics (owner-tunable; these are the starting model)
- **X. Pizza (pizza-only menu) → punch-card → free pizza** (the Domino's mono-menu model). Earn **1 punch per pizza** on a completed order; **free pizza at N punches** (start N≈9–12; a free pizza per 9 bought ≈ 10% of pizzas / ~2–3% of revenue in real food cost — owner tunes N). **Welcome bonus: pre-credit 1–2 punches** on profile creation → first free pizza feels ~3 orders away. Redeemed free pizza = the cheapest eligible pizza in the cart made free (server-chosen, so it can't be redeemed on a pizza-less order).
- **La Musa (broad menu) → points-per-Lempira → free-item tiers** (the Pizza Hut/Papa John's model). Earn **1 point per L1** on a completed order. **Tier 1 (~2 orders, ≈1,400 pts) → a free side/appetizer**; higher tiers → entrée. **Welcome bonus: starter points.** Redeemed item = a specific menu item made free at its tier.
- Both: **simple, visible** (points/punches on the chip, live "ganás X" on the cart, progress-to-next-reward), and rewards is the lead benefit on the post-order profile-claim card.

## Data model (server-authoritative — the anti-fraud spine)
New top-level node, **server-written only** (mirrors `user_orders`):
```
user_rewards/{uid}/{restaurant_id}: {
  balance: <number>,                 // punches (x_pizza) or points (la_musa)
  lifetime: <number>,                // cumulative earned (for tiers/analytics; never decremented)
  updated_at: <ts>,
  ledger/{entryId}: {                // append-only audit (earn + redeem), for support + reconciliation
    type: 'earn'|'redeem'|'welcome'|'clawback', delta: <±number>, order_id?, ts, note?
  }
}
```
**RTDB rules:** `user_rewards/$uid` → `.read: auth.uid === $uid`, **`.write: false`** (Admin-SDK only; a client can NEVER grant itself points — the whole fraud surface closes here). NOT under `user_profiles` (that node is owner-writable). Account deletion nulls `user_rewards/{uid}` (extend `account-lib.js` like `user_orders`).

## Earn engine (Phase A — additive, NOT money-path)
- **Trigger: on order COMPLETION, idempotent, per-brand, customer_uid required.** Reuse the proven mark-before-send pattern (`notifyPickupReady`/order-received): a status trigger credits `user_rewards` when an order reaches its completed state, guarded by a per-order marker (`orders/{id}/rewards_earned_at`, transaction claim) so it credits at-most-once. Guests (no `customer_uid`) → no-op. Amount = punches (count pizzas in the order's priced items) for x_pizza / points (order subtotal in L) for la_musa — computed from the SERVER-side order record, never client input.
  - **OPEN (gate): earn on `delivered` (only truly-completed orders earn; no clawback needed) vs earn at paid/materialize (`status:'new'`, simpler/reliable but needs clawback on cancel/refund).** Lean: earn on `delivered` for delivery + the pickup-completed state — no clawback surface. Confirm the exact completed-status per order_type in the gate.
- **Welcome bonus:** credited once, on first profile creation (or first completed order under the profile), via a `welcome` ledger entry + marker so it can't be farmed by re-creating.
- Earning mutates only `user_rewards` (a number) — **no money, no order total, no payment.** Low-risk; ship + verify first.

## Redemption (Phase B — THE money-path; hardest gate)
The only money-touching part. Flow:
1. At checkout, the client may REQUEST a redemption (e.g. `redeem: {type:'free_pizza'}` for x_pizza, `{type:'free_item', item_id}` for la_musa). Client input is a REQUEST only — never a trusted amount/balance/discount.
2. Server (in `createOrder` / `chargeOnlineOrder`, at the `computeServerTotal` point) **validates atomically**: read `user_rewards/{uid}/{rid}` balance (server-side), confirm ≥ the reward's cost, confirm the reward is applicable to THIS cart (x_pizza: cart contains ≥1 pizza → free = the cheapest pizza's price; la_musa: the tier item is present or allowed), compute the discount **server-side**, and in ONE atomic transaction **deduct the balance + stamp the redemption on the order** (`orders/{id}/redemption: {type, points_spent, discount_cents, item}`) — reject if the balance moved (CAS). Never trust a client-supplied discount.
3. The charged total = `computeServerTotal(items) − server-computed discount` (floored at 0 / a min). For online, the PixelPay charge uses the discounted total. `total_cents`/`subtotal_cents` reflect it; the fingerprint includes the redemption so a replay can't double-apply.
4. **Idempotency + no double-spend:** the balance deduct is a transaction (CAS on balance); the order carries the redemption once; a retry/re-submit can't deduct twice (order already stamped, or the attempt fingerprint guards it).
5. **Clawback on cancel/refund:** if a redeemed order is cancelled/refunded, the deducted points are returned (a `clawback` ledger entry) — wire into the existing `cancelPaidOrder`/refund path.
- **Money invariants (gate hard on these):** discount is ALWAYS server-computed from the server-priced cart; a client can never set the discount, the balance, or redeem more than it has; redemption is atomic + idempotent (no double-spend, no double-apply); a redemption never makes the total negative; a free-pizza redemption requires a pizza in the cart (else no-op/reject); refund path returns points. Keep `isCashPayment` and the existing money/fingerprint logic byte-intact except the documented discount subtraction.

## UI (Phase C — presentation)
- **Rewards pane** in the account sheet (reuse the `acct-pane` pattern): balance, progress-to-next-reward bar, "cómo funciona." Read-only from `user_rewards` (marker-gated, fail-open).
- **Chip:** show punches/points next to the name.
- **Cart:** live "ganás X puntos / +1 pizza gratis en N" line (client estimate; server is authoritative at earn).
- **Checkout redemption control:** "Usar mi pizza gratis" / "Canjear premio" toggle → sets the `redeem` request; the review shows the server-applied discount (re-priced server-side, like all totals).
- **Profile-claim card (from the account-creation work):** rewards becomes the headline benefit ("Creá tu perfil y empezá con 2 pizzas para tu pizza gratis" / "ganá puntos en cada pedido").
- Both forms byte-identical past CONFIG; per-brand copy/tables via CONFIG + the server reward config. No cheap emoji in chrome.

## Phasing (each its own plan + gate + deploy)
- **Phase A — Earn engine + ledger + rules + welcome bonus.** Backend-only, additive, no money-path. Rules (`user_rewards` server-only) + emulator. Ship + verify (points accrue, guests no-op, at-most-once).
- **Phase B — Redemption at checkout.** The money-path. Heaviest codex money-gate. Per-brand reward config + server discount + atomic deduct + clawback. Functions + rules.
- **Phase C — UI + profile-claim integration.** Both forms. Design-gate the visuals, codex-on-diff the build.
- Rationale: earning is safe (a number); redemption is where money lives — isolate + gate it hardest; UI last so it renders real balances. Never advertise rewards before Phase A+B are live (no promising points that don't accrue/redeem).

## Open decisions for the design-gate (+ owner inputs)
1. **Earn trigger:** on `delivered`/completed (no clawback) vs on paid/materialize (needs clawback). [lean: on completion]
2. **Exact thresholds** (owner, tunable): X. Pizza N-punches-per-free-pizza + welcome pre-punches; La Musa points-per-tier + welcome points. Model to "~2–3 orders to first reward."
3. **Free-pizza redemption rule:** cheapest pizza in cart made free (proposed) vs a fixed pizza. Cap 1 redemption/order?
4. **Expiration** of points/punches (none for v1? or 6–12 mo)? Simpler = none for v1.
5. **Earn base:** x_pizza punches = count of pizzas; la_musa points = subtotal (pre/post extras?). Confirm base excludes any delivery fee/tax.
6. **Cross-order abuse:** min order for earn? one welcome-bonus-per-phone (tombstone-guarded, like OTP)?
7. **Build model per phase:** Phase A/C (lower-risk) on Fable OK; **Phase B (money-path) → recommend the stronger model**; codex-gates all regardless. [owner call]

## Non-negotiables (carry into every phase)
- `user_rewards` is Admin-SDK-written ONLY; client never writes it (whole fraud surface).
- Redemption discount is ALWAYS server-computed from the server-priced cart; atomic deduct; idempotent; never negative; refund returns points.
- Guest checkout unchanged; both forms byte-identical past CONFIG; money/fingerprint/`isCashPayment` byte-intact except the documented discount.
- Reuse proven patterns (mark-before-credit, per-restaurant config, lazy-SDK account); no new trust.
