# DESIGN — Rewards / Loyalty program (per-brand), the flagship profile-creation incentive

**Status:** DESIGN R2 (revised per codex design-gate R1 — 10 findings incorporated). Off live `main` `8d67291`. Money-touching (redemption) → phased so the money-path is isolated + gated hardest.

## Goal
A per-brand loyalty program that is *the* headline reason to create a profile. Research-backed: **free food beats discounts**, **first reward in ~2–3 orders** + a **day-one welcome bonus**, **kept simple**. Two brands, two menu realities → two reward tables on ONE engine + ONE server-authoritative ledger.

## Per-brand mechanics (owner-tunable starting model)
- **X. Pizza (pizza-only) → punch-card → free pizza** (Domino's mono-menu model). Earn **1 punch per pizza** on a completed order; free pizza at **N punches** (start N≈9–12; ~2–3% of revenue in real food cost — owner tunes N). **Welcome: pre-credit 1–2 punches.** Redeemed free pizza = the cheapest eligible pizza in the cart, **server-chosen** (rejects a pizza-less cart).
- **La Musa (broad menu) → points-per-Lempira → free-item tiers** (Pizza Hut/Papa John's model). Earn **1 pt per L1** on a completed order. **Tier 1 (~2 orders) → free side/appetizer**; higher → entrée. **Welcome: starter points.** Redeemed item = a specific menu item zeroed at its tier.
- Both **simple + visible**; rewards is the lead benefit on the post-order profile-claim card.

## Data model (server-authoritative — the anti-fraud spine)
Two NEW top-level, **Admin-SDK-written-only** nodes (mirror `user_orders` `.write:false`):
```
user_rewards/{uid}/{restaurant_id}: {
  balance, reserved,                 // available = balance - reserved (reserved = held by in-flight redemptions)
  lifetime,                          // cumulative earned; never decremented (drives tiers/analytics)
  config_version,                    // the reward-config version this balance was last reconciled against
  updated_at,
  ledger/{entryId}: { type:'earn'|'redeem'|'welcome'|'reserve'|'release'|'clawback',
                      delta, order_id?, redemption_id?, ts, note? }   // APPEND-ONLY audit
}
reward_welcome/{phone_hash}/{restaurant_id}: <ts>     // welcome-bonus tombstone, keyed by PHONE_HASH (survives profile deletion → un-farmable)
```
- **Rules:** `user_rewards/$uid` → `.read: auth.uid===$uid`, **`.write:false`**; container `.validate` rejects scalars (the addresses-node lesson); `reward_welcome` → `.read:false, .write:false` (server-only). Emulator tests: owner-read-own ✓, other-uid read denied, ALL client writes denied (balance/reserved/ledger/welcome). (finding 1/8)
- **Account deletion:** extend `account-lib.js` deletion updates to null `user_rewards/{uid}` (currently only `user_profiles`+`user_orders`) — add a test. `reward_welcome/{phone_hash}` is INTENTIONALLY NOT deleted (anti-farm; it holds no PII beyond the salted hash). (finding 8/9)
- **Reward config** (thresholds, welcome amounts, per-brand tables) lives server-side under a **versioned** `config/rewards/{restaurant_id}` (config_version bumps invalidate stale client displays; redemptions record the version). (finding 10)

## Earn engine (Phase A — additive, NOT money-path)
- **Trigger: on the order's real terminal completion state, per order_type, idempotent, customer_uid required.** Confirmed states: **delivery → `delivered`; pickup → `completed`** (both are the non-cancelable terminal states; `ready` is pre-collection and must NOT earn). Hook the existing `sendOrderStatusNotifications` status trigger (or a dedicated `onValueWritten('/orders/{id}/status')`), gated by a per-order marker `orders/{id}/rewards_earned_at` (transaction claim → at-most-once; sibling of `/status` so no self-retrigger). Guests (no `customer_uid`) → no-op. Amount computed from the SERVER order record only: x_pizza = count of pizzas in priced items; la_musa = order `subtotal_cents` (pre-tax, **excluding delivery fee**). (finding 5)
- **Earn is a ledger entry keyed by `order_id`** (idempotent). Even though delivered/completed orders are non-cancelable in the normal path, **refund/manual-adjustment can still occur** → a reversal path reverses the earn idempotently by `order_id` (see Clawback). "No clawback surface" was WRONG — real money systems refund post-completion. (finding 6)
- **Welcome bonus:** credited once per **phone_hash per brand** via the `reward_welcome/{phone_hash}/{rid}` tombstone (transaction claim), NOT a uid/profile marker (deletion frees the uid + phone_index → a uid marker is farmable). Credited on first login/profile-create for that phone. (finding 9)
- Earn mutates only `user_rewards` (a number + ledger) — **no money, no order total, no payment.**

## Redemption (Phase B — THE money-path; reservation lifecycle, hardest gate)
RTDB has **no cross-tree atomic transaction** — a `user_rewards` debit and an `orders` stamp cannot be one CAS. So redemption is a **reservation keyed by `order_id`**, not a claimed atomic cross-tree write (finding 1):

1. **Client sends a REQUEST only** — `redeem:{type:'free_pizza'}` (x_pizza) / `{type:'free_item', item_id}` (la_musa). Never a trusted amount/balance/discount.
2. **Reserve (debit-first, idempotent by order_id):** at intake (`createOrder` / `chargeOnlineOrder`), BEFORE computing the charge: transaction on `user_rewards/{uid}/{rid}` — verify `available ≥ cost` AND the reward applies to THIS server-priced cart (x_pizza: ≥1 pizza present → discount = cheapest pizza's cents; la_musa: tier item present/eligible), then move `cost` into `reserved` + write a `reserve` ledger entry keyed by `order_id` (re-entry with the same order_id REUSES it — no double-debit). If `available < cost` or ineligible → reject the redemption (order proceeds at full price with a clear message). (finding 1)
3. **Compute the discount SERVER-side** and represent it as an **explicit priced line** (a zeroed eligible item / a discount line) in the priced-items model so BOTH `orderBreakdownCents` (`subtotal_cents+tax_cents===total_cents`) AND `buildFacturaRecord` (`line_gross` foots to `subtotal_cents`) reconcile. Golden-test the total identity AND factura totals with a redemption. (finding 3)
4. **Charge the discounted total.** For online, `acquireHostedAttempt` runs AFTER the reserve; the **PixelPay fingerprint includes the canonical server redemption result** `{restaurant_id, type, config_version, points_spent, discount_cents, eligible_item_key}` (NOT the client blob, NOT just the amount) so hosted reuse can't collide two different rewards or spuriously conflict on ordering. The reservation binds to `active_attempt_id`/`hosted_expires_at`. (finding 2/4)
5. **Consume on completion / release on failure — tied to the attempt/order lifecycle (finding 2):**
   - **Consume:** at materialize (online paid) / order-completed → convert `reserved`→spent: `redeem` ledger entry, clear the reservation. Idempotent by `order_id+redemption_id`.
   - **Release:** on payment attempt expiry/failure, closed-at-materialize hold, or cancel-before-complete → return `reserved` to `balance` (`release` entry). A **sweep** releases reservations whose order never materialized within the attempt TTL (orphan-deduction recovery). (finding 1/2)
6. **Clawback (post-completion refund/cancel):** hook the SHARED **`cancelOrderCore`** state machine (not just the `cancelPaidOrder` HTTP wrapper), reversing BOTH any consumed redemption (return points) AND any earn credited for that order, **idempotent by `order_id+redemption_id`** so refund-reconciliation retries / `recoverStaleCancel` / `refund_pending` re-entry can't double-reverse. (finding 6/7)

**Money invariants (gate hardest):** discount ALWAYS server-computed from the server-priced cart; client sets no discount/balance/eligibility; reserve is debit-first + idempotent-by-order_id (never discounted-money-without-a-debit; orphan reservations released by sweep); never negative total; free-pizza requires a pizza in cart; fingerprint carries the canonical redemption; factura + `total_cents/subtotal_cents/tax` reconcile with the discount line; refund returns points once. `isCashPayment` + existing money/fingerprint logic byte-intact except the documented discount line.

## UI (Phase C — presentation, after A+B live)
Rewards pane (balance + progress bar + "cómo funciona"), points/punches on the chip, live "ganás X / +1 pizza gratis en N" on the cart (client estimate; server authoritative), a checkout **"Canjear premio"** control that sets the `redeem` request (review shows the server-applied discount, re-priced server-side), and rewards as the **headline** on the profile-claim card. Both forms byte-identical past CONFIG; per-brand via CONFIG + server config. No cheap emoji in chrome.

## Phasing (each its own plan + gate + deploy)
- **Phase A — Earn engine + ledger + rules + welcome + config + audit.** Backend-only, additive. **Ships ONLY with: hidden balances (no UI/marketing yet), an immutable append-only ledger, `config_version`, the phone_hash welcome tombstone (no farm hole), and a backoffice audit/export path** — because earned points are a real liability even before redemption exists (staff fake-order + welcome-farm are fraud value, not "just a number"). Rules + emulator. (finding 10)
- **Phase B — Redemption (money-path).** Reservation lifecycle + server discount line + factura/total reconciliation + canonical fingerprint + consume/release + `cancelOrderCore` clawback. Heaviest codex money-gate. Cash path (`createOrder`) and online path (`chargeOnlineOrder`+attempt lifecycle) each covered; consider B1(cash)/B2(online) sub-split if the diff is large.
- **Phase C — UI + profile-claim integration.** Both forms; renders real balances; rewards headlines the claim card.
- **No marketing/advertising of rewards until A+B are live + reconciled.** (finding 10)

## Open decisions (owner + confirm-in-build)
1. Exact thresholds (owner): X. Pizza N-per-free-pizza + welcome punches; La Musa points-per-tier + welcome points. Model to ~2–3 orders to first reward.
2. Free-pizza rule: cheapest-pizza-in-cart (proposed). Cap 1 redemption/order (proposed).
3. Expiration: none for v1 (simpler) vs 6–12mo. [lean none]
4. Earn base excludes delivery fee/tax — confirm la_musa uses `subtotal_cents`.
5. Min order for earn? (anti-abuse). One welcome per phone_hash (decided).
6. Build model per phase: A/C on Fable OK; **B (money-path) → stronger model recommended**; codex-gates all.

## Non-negotiables (every phase)
- `user_rewards` + `reward_welcome` are Admin-SDK-written ONLY; client never writes them.
- Redemption discount ALWAYS server-computed from the server-priced cart; debit-first reservation idempotent-by-order_id; consume/release tied to the order/attempt lifecycle; refund returns points once; never negative; factura + totals reconcile.
- Guest checkout unchanged; both forms byte-identical past CONFIG; money/fingerprint/`isCashPayment` byte-intact except the documented discount line.
- Immutable ledger + config_version + account-deletion coverage + emulator rules tests from Phase A.
