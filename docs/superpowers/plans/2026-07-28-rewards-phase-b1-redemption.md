# Rewards Phase B1 — Redemption (money-path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`). **This is the money-path — every task gets a codex money-gate; nothing deploys unreviewed.**

**Goal:** Let a logged-in customer redeem a reward at checkout — X. Pizza a free pizza (at 8 punches), La Musa a free tier item — with the discount **computed + applied server-side**, points **debited atomically via a reservation**, and everything **reconciling with the money/factura/fingerprint machinery**.

**Architecture:** A pure discount calculator + versioned config drives an impure **reservation lifecycle** (reserve → consume-on-completion → release-on-failure, keyed by `order_id` + canonical redemption fingerprint) tied to the payment-attempt lifecycle. The discount enters the existing pricing as an explicit priced line so `orderBreakdownCents` AND `buildFacturaRecord` reconcile. Redemption is **all-or-nothing, verified-uid-required, non-payable on any failure**. Reversal on refund via the shared `cancelOrderCore`.

**Design authority:** `docs/superpowers/specs/2026-07-27-rewards-loyalty-design.md` (codex design-gate APPROVED R1→R3). Read its **Redemption (Phase B)** + **Money invariants** sections first — this plan implements them; that spec is the source of truth for the rationale. UI = the approved mockup (screens 4–5), built in Phase **B2** (separate plan); B1 is backend-only and testable via the emulator.

**Tech Stack:** Node 22 Firebase gen2, RTDB, Admin SDK; existing `menu-pricing`/`order-money`/`factura`/`pixelpay-hosted-charge`/`pixelpay-confirm`/`cancel-order-core`; the reservation mirrors the `payment_attempts`/`active_attempt_id` pattern; Phase-A `rewards-core.js`/`rewards-earn.js` (LIVE) are the ledger substrate.

## Global Constraints
- **LOCKED config (owner):** X. Pizza — punch, **card_size 8**, reward = **cheapest pizza in the cart made free** (requires ≥1 pizza), welcome 2 (Phase A, live). La Musa — points, tiers **500/1000/1500/2500/3500** (pick one eligible item free per tier), earn 10 pts/30 L, welcome 100 (live). Config is **versioned** (`REDEMPTION_CONFIG_VERSION`); redemptions record the version.
- **MONEY INVARIANTS (gate hardest — from the spec):** discount ALWAYS server-computed from the server-priced cart; client sends a `redeem` REQUEST only (never amount/balance/eligibility); **redeem requires a VERIFIED `customer_uid`** (NOT the fail-open-to-guest attribution); **all-or-nothing** — any failure (unverified uid, insufficient balance, ineligible cart, config mismatch, fingerprint mismatch) returns a **non-payable 409/400**, never a payable full-price checkout after a reward was requested; reserve is **debit-first + idempotent by `order_id`** AND bound to canonical `{order_fingerprint, redemption_result, config_version}` (same-order_id reuse only on exact match); consume/release tied to the order/attempt lifecycle (online → hosted TTL; cash → age/status); **balance never negative**; discount reconciles in `total_cents/subtotal_cents/tax_cents` AND factura; refund returns points once. `isCashPayment` + existing money/fingerprint/tax logic **byte-intact except the documented discount line**.
- `user_rewards`/`reward_welcome` remain Admin-SDK-written ONLY. No new client write surface.
- No prune; both driver+payment code present on deploy. Emulator (Java on PATH) before rules deploy.
- Redemption is INVISIBLE until B2 (UI) ships — a `redeem` field simply isn't sent yet, so B1 is inert in production until the forms send it. Safe to ship B1 first + soak.

## File Structure
- **Create `xpizza-functions/rewards-redeem-config.js`** — versioned per-brand redemption config + eligible-item tables + validators. Pure.
- **Create `xpizza-functions/rewards-redeem.js`** — pure `computeRedemptionDiscount(...)` (validate request against server-priced cart → discount_cents + canonical result, or a typed refusal).
- **Create `xpizza-functions/rewards-reserve.js`** — impure reservation lifecycle: `reserveRedemption`, `consumeRedemption`, `releaseRedemption`, keyed by `order_id`; + a stale-reservation sweep helper.
- **Modify `xpizza-functions/order-money.js`** (or a thin `applyDiscount` helper) — thread a server discount through the breakdown so `subtotal+tax===total` holds with the discount.
- **Modify `xpizza-functions/factura/*`** — represent the discount as a zeroed/priced line so `line_gross` foots to the discounted `subtotal_cents`.
- **Modify `xpizza-functions/index.js`** — `createOrder` (cash) + `chargeOnlineOrder` (online) redemption integration; fingerprint includes the canonical redemption.
- **Modify `xpizza-functions/pixelpay-confirm.js`** — consume the online reservation at `confirmAndMaterialize`; release on the failure/expiry outcomes.
- **Modify `xpizza-functions/cancel-order-core.js`** — clawback a consumed redemption (idempotent by `order_id`+redemption_id).
- **Tests:** `rewards-redeem.test.js` (pure), `rewards-reserve.emulator.test.js`, `redemption-money.test.js` (golden: total/subtotal/tax + factura reconcile), integration emulator cases for createOrder/charge/materialize/cancel.

---

## Task 1: `rewards-redeem-config.js` — versioned redemption config (pure)
**Files:** Create `rewards-redeem-config.js` + `.test.js`.
**Produces:** `REDEMPTION_CONFIG_VERSION` (start `1`); `REDEMPTION_CONFIG` =
```js
{ x_pizza: { kind:'punch', cost:8, reward:'cheapest_pizza' },
  la_musa: { kind:'points', tiers:[
    { level:1, cost:500,  items:['soft_01','soft_02','soft_03','soft_04','beer_01','beer_02','beer_03','beer_04','beer_05','beer_06','beer_07','beer_08','rice_white','rice_chinese','papas_fritas'] },
    { level:2, cost:1000, items:['dimsum_01','dimsum_02','dimsum_03','dimsum_04','dimsum_05','starter_01','starter_02','starter_03','soup_01','soup_02','soup_03'] },
    { level:3, cost:1500, items:['noodle_01','noodle_01_sin','noodle_01_pollo','noodle_01_camaron','noodle_03','rice_01','rice_04','crudo_02','crudo_03','special_05'] },
    { level:4, cost:2500, items:['noodle_02','rice_02','rice_03','starter_04','starter_05','starter_06','crudo_01','special_02'] },
    { level:5, cost:3500, items:['special_01','special_04'] } ] } }
```
(the tier→item lists are the owner-tunable default from the approved mockup's price brackets; `getTier(rid, level)`, `itemInTier(rid, level, itemId)` accessors.)
- [ ] **Step 1 (test-first):** assert config shape, `itemInTier('la_musa',1,'papas_fritas')===true`, `itemInTier('la_musa',1,'special_01')===false`, x_pizza cost 8, version is a number, unknown rid/level → safe null.
- [ ] **Step 2:** implement pure module. **Step 3:** green. **Commit** — `feat(rewards): versioned redemption config (per-brand tiers)`.

## Task 2: `rewards-redeem.js` — server discount calculator (pure)
**Files:** Create `rewards-redeem.js` + `.test.js`. **Consumes:** config (T1), `menu-pricing` (prices).
**Produces:** `computeRedemptionDiscount({ redeem, items, restaurantId }) → { ok:true, cost, discount_cents, canonical } | { ok:false, reason }` where `items` are the SERVER-priced cart items and `canonical = { restaurant_id, type, config_version, cost, discount_cents, eligible_item_key }`.
- x_pizza (`redeem.type==='free_pizza'`): find the cheapest pizza in `items` (every x_pizza item is a pizza; unit price from `menu-pricing`); ≥1 pizza required else `{ok:false, reason:'no_eligible_item'}`; `discount_cents = cheapestUnitPriceCents`, `cost=8`, `eligible_item_key = <that pizza name>`.
- la_musa (`redeem.type==='free_item'`, `redeem.item_id`, `redeem.level`): validate `itemInTier(la_musa, level, item_id)`; `discount_cents = menuPrice(item_id)*100`, `cost = tier.cost`, `eligible_item_key = item_id`. Item not in tier → `{ok:false, reason:'ineligible_item'}`.
- Never trusts any client price/discount/cost — all derived from server config + menu. Malformed request → `{ok:false, reason:'bad_request'}` (never throws).
- [ ] **Step 1 (tests):** x_pizza cart with pizzas → discount = cheapest unit; pizza-less cart → `ok:false`; la_musa valid tier item → discount = its price; wrong-tier item → `ok:false`; missing/garbage redeem → `ok:false`; canonical carries config_version.
- [ ] **Step 2:** implement. **Step 3:** green. **Commit** — `feat(rewards): pure server-side redemption discount calculator`.

## Task 3: `rewards-reserve.js` — reservation lifecycle (impure, THE money spine)
**Files:** Create `rewards-reserve.js` + `test/rewards-reserve.emulator.test.js`. **Consumes:** T2 canonical.
**Produces (all Admin-SDK, all keyed by `order_id`, all idempotent):**
- `reserveRedemption(db, { uid, rid, orderId, cost, canonical, orderFingerprint, configVersion, attemptId=null, now }) → { ok, reason? }` — ONE transaction on `user_rewards/{uid}/{rid}`: (a) if a reservation record for `orderId` exists → **reuse ONLY if `{order_fingerprint, canonical, config_version}` all match**, else `{ok:false, reason:'reservation_conflict'}`; (b) require `deleted_uids/{uid}` absent (mirror Phase-A guard) ; (c) require `available = balance - reserved ≥ cost`, else `{ok:false, reason:'insufficient'}`; (d) move `cost` into `reserved`, write `reservations/{orderId} = { cost, canonical, order_fingerprint, config_version, attempt_id, state:'reserved', at }` + a `reserve` ledger entry. Debit-first: the reservation exists before the order write, so a crash leaves a releasable orphan (never discounted-money-without-a-debit).
- `consumeRedemption(db, { uid, rid, orderId, now }) → { consumed }` — transaction: reservation must be `state:'reserved'`; flip to `state:'consumed'`, subtract `cost` from `balance` (the held `reserved` is realized: `balance -= cost; reserved -= cost`), write a `redeem` ledger entry. Idempotent (already consumed → no-op). Never negative.
- `releaseRedemption(db, { uid, rid, orderId, now, reason }) → { released }` — transaction: reservation `state:'reserved'` → return `cost` to available (`reserved -= cost`), `state:'released'`, `release` ledger entry. Idempotent. Consumed reservations are NOT released here (that's clawback).
- `sweepStaleReservations(db, { now })` — release `reserved` reservations whose order never materialized: online → past the attempt's `hosted_expires_at`; cash → order age/status policy (no `completed`/`cancelled` within the window) with a dispatcher-audit flag if the order is still live. (Wire into an existing sweep function.)
- [ ] **Step 1 (emulator tests):** reserve debits `available`, writes record+ledger; re-reserve same orderId+same-canonical → idempotent no-op; re-reserve same orderId+DIFFERENT fingerprint → `reservation_conflict` (no debit); insufficient available → `ok:false` no debit; deleted uid → no-op; consume realizes the debit once (balance drops, reserved clears), second consume no-op, never negative; release returns to available, second release no-op; consumed reservation not released by `releaseRedemption`; sweep releases an orphan reserved reservation.
- [ ] **Step 2:** implement (mirror `payment_attempts` claim semantics + the Phase-A atomic-ledger pattern). **Step 3:** green. **Commit** — `feat(rewards): redemption reservation lifecycle (reserve/consume/release/sweep, idempotent)`.

## Task 4: Discount as a priced line — money + factura reconciliation
**Files:** `order-money.js` (+ a helper) and `factura/pricing.js`/`build-record.js`; `redemption-money.test.js`.
**Approach (spec finding 3):** the discount reduces the charged total, and the order's stored priced `items` carry the redeemed item as a **zeroed line** (or a discount line) so both breakdowns foot.
- [ ] **Step 1:** define `applyRedemptionToPricing({ totalLempiras, pricedItems, discount_cents, eligible_item_key })` → `{ totalLempiras: total - discount, items: <items with the eligible line zeroed or a discount line appended> }` such that `Σ line_gross_cents === new subtotal_cents`. Then `orderBreakdownCents(discountedTotal, rid)` and `buildFacturaRecord` both reconcile.
- [ ] **Step 2 (golden tests):** for a redeemed x_pizza order (cheapest pizza free) AND a redeemed la_musa order (tier item free): assert `subtotal_cents + tax_cents === total_cents`; assert `buildFacturaRecord` line bases foot to the discounted `subtotal_cents`; assert a NON-redeemed order is byte-identical to today (no regression).
- [ ] **Step 3:** implement minimally; keep `isCashPayment`/tax-split logic byte-intact. **Commit** — `feat(rewards): discount as a reconciling priced line (total + factura golden-tested)`.

## Task 5: `createOrder` (cash) redemption integration
**Files:** `index.js` `createOrder` (~289 computeServerTotal, ~552 orderBreakdownCents). **Consumes:** T2/T3/T4.
- [ ] **Step 1:** when `body.redeem` present: **require a verified `customer_uid`** (the H2 `X-Firebase-ID-Token` path) — NOT the guest fail-open; missing/invalid → `res.status(401)` non-payable "login required", order NOT created. Compute the discount (T2) from the server-priced `items`; `reserveRedemption` (T3, `orderId`, `orderFingerprint`, no attempt for cash). **All-or-nothing:** any `ok:false` (insufficient/ineligible/conflict) → `res.status(409)` non-payable, order NOT created (client resubmits with/without the reward). On success: `applyRedemptionToPricing` (T4) → discounted breakdown; stamp `orders/{id}/redemption = canonical`. Cash order is committed at create → immediately `consumeRedemption` (the order is real; release only via cancel clawback).
- [ ] **Step 2 (emulator):** cash order + valid redeem → discounted total, points debited once, `redemption` stamped, factura reconciles; insufficient balance → 409, no order, no debit; guest (no verified uid) + redeem → 401, no order; a normal (no-redeem) cash order → unchanged.
- [ ] **Step 3:** implement. **Commit** — `feat(rewards): cash-order redemption (verified-uid, all-or-nothing, consume-at-create)`.

## Task 6: `chargeOnlineOrder` (online) redemption integration
**Files:** `index.js` `chargeOnlineOrder` (~805–951, fingerprint ~873, `acquireHostedAttempt`). **Consumes:** T2/T3/T4.
- [ ] **Step 1:** same verified-uid + compute-discount + **reserve** as T5, BEFORE deriving the charge — but for online **reserve only (do NOT consume)**, bound to `active_attempt_id`. The **PixelPay `payment_fingerprint` MUST include the canonical redemption** `{restaurant_id,type,config_version,cost,discount_cents,eligible_item_key}` so hosted-reuse can't collide two different rewards. The charged `total_cents` uses the discounted breakdown (T4). Any redeem failure → non-payable 409, NO payable URL returned.
- [ ] **Step 2 (emulator):** online order + redeem → discounted PixelPay amount, reservation `reserved` held (balance not yet dropped), fingerprint carries the redemption; two different reward requests for the same order do NOT reuse each other's checkout; redeem failure → 409 non-payable, no attempt created.
- [ ] **Step 3:** implement. **Commit** — `feat(rewards): online-order redemption reserve + canonical fingerprint (no consume until paid)`.

## Task 7: Consume on materialize / release on failure + sweep
**Files:** `pixelpay-confirm.js` (`confirmAndMaterialize`), the attempt-failure/expiry outcomes, and the sweep host.
- [ ] **Step 1:** in `confirmAndMaterialize`, on the FRESH materialize (the `outcome:'confirmed'` path, before/with the atomic order write): `consumeRedemption` for `orders/{id}/redemption` if present (idempotent by order_id). On the outcomes that abandon the order (attempt expired/failed, `held_closed_at_materialize`, cancelled-during-confirm) → `releaseRedemption`. Scheduled-held orders keep the reservation until release→materialize.
- [ ] **Step 2:** wire `sweepStaleReservations` into an existing scheduled sweep (alongside `sweepStalePending`/attempt cleanup). Emulator: a paid online order consumes once; an expired-attempt order releases; a swept orphan releases; re-materialize does not double-consume.
- [ ] **Step 3:** implement. **Commit** — `feat(rewards): consume redemption at materialize, release on failure/expiry + stale sweep`.

## Task 8: Clawback on refund/cancel (shared state machine)
**Files:** `cancel-order-core.js` (`cancelOrderCore`). **Consumes:** T3.
- [ ] **Step 1:** on a cancel/refund of an order carrying a CONSUMED `redemption`, return the points (a `clawback` on the redemption), **idempotent by `order_id`+redemption_id** so refund-reconciliation retries / `recoverStaleCancel` / `refund_pending` re-entry can't double-return. A still-`reserved` (unpaid) redemption → `releaseRedemption` instead. (This composes with the Phase-A earn reversal already in `cancelOrderCore` — both keyed by order_id, both idempotent.)
- [ ] **Step 2 (emulator):** a redeemed+paid order refunded → points returned once; retry → no double-return; a reserved-but-unpaid cancelled order → released; a non-redeemed order → no-op.
- [ ] **Step 3:** implement. **Commit** — `feat(rewards): redemption clawback in cancelOrderCore (idempotent)`.

## Task 9: Rules + emulator + no-prune
- [ ] **Step 1:** the reservation records live under `user_rewards/{uid}/{rid}/reservations/*` — already `.write:false` (Admin only); confirm the container `.validate` still admits the new child shape; NO new client-writable path (the `redeem` request is a request body field, validated + discarded server-side, never persisted as trusted). Emulator: client cannot read another uid's reservations, cannot write any reservation/balance.
- [ ] **Step 2:** confirm exports unchanged (no new export unless the sweep is a new scheduled fn — if so, +1, no prune). `node --check` all touched.
- [ ] **Step 3:** **Commit** — `feat(rewards): redemption rules coverage + no-prune check`.

## Task 10: Suite + money golden gate + push
- [ ] **Step 1:** full `npm test` green (incl. redemption-money golden + the pure calculators). Emulator suites: reserve lifecycle, createOrder/charge/materialize/cancel integration, rules.
- [ ] **Step 2:** money self-audit before push: (a) discount always server-computed; (b) verified-uid required on redeem; (c) all-or-nothing non-payable on failure; (d) no double-spend/double-apply (reservation idempotent + fingerprint); (e) balance never negative; (f) subtotal+tax===total AND factura reconcile with a discount; (g) refund returns points once; (h) `isCashPayment`/tax/fingerprint byte-intact except the discount line; (i) inert until B2 (no `redeem` sent).
- [ ] **Step 3:** push `feat/rewards-phase-b1`; report SHA + per-task commits + emulator + golden results + exports before/after. **No deploy/merge.**

---

## Self-Review
- **Spec coverage:** reservation lifecycle (T3), server discount (T2) + config (T1), factura/total reconciliation (T4), verified-uid + all-or-nothing (T5/T6), canonical fingerprint (T6), consume/release + sweep (T7), cash TTL (T3/T7), cancelOrderCore clawback (T8), rules + no client trust (T9), money golden gate (T10). All the spec's Phase-B money invariants + the 4 R2 refinements.
- **Placeholder scan:** the La Musa tier→item lists (T1) are a concrete owner-tunable default (from the mockup brackets), not a TODO; the cash-reservation-age window (T3) is a defined policy to set at build.
- **Type consistency:** `canonical` shape identical across T2/T3/T6; reservation keyed by `order_id` throughout; `computeRedemptionDiscount`/`reserve|consume|releaseRedemption` signatures stable.

## Handoff
Advisor is sole gate-runner. Executor builds `feat/rewards-phase-b1` **task-by-task on Opus 4.8** (money-path), pushes, reports each SHA. Advisor runs a **heavy codex money-gate per task or on the full diff** (the spec's invariants + codex's named implementation gates: reservation exact-match reuse, verified-uid non-payable, hosted-expiry release, cash stale release, cancel/refund idempotency, factura reconciliation). Owner deploys functions + rules (emulator-first; complete-env/both-code/zero-prune; verify revisions). **B1 is inert in prod until B2 (checkout UI) sends `redeem`** — safe to ship + soak first. **Phase B2 (checkout redemption UI, both forms, mockup screens 4–5) is a separate plan written after B1 is gated.**
