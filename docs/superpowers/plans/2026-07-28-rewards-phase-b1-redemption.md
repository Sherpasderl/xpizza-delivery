# Rewards Phase B1 — Redemption (money-path) Implementation Plan  ·  R2 (codex plan-gate 13 findings incorporated)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Steps use `- [ ]`. **This is the money-path — every task gets a heavy codex money-gate; nothing deploys unreviewed.**

**Goal:** Let a logged-in customer redeem a reward at checkout — **X. Pizza: discount the cheapest pizza already in the cart to free** (total drops); **La Musa: add a chosen tier item to the order free** (0-price line, total unchanged) — everything computed + applied server-side, points debited via an atomic reservation, full reconciliation with money/factura/fingerprint/earn.

**BASE (plan-gate #8 — critical):** branch **off `main`** (currently `3c4d3e4`, where Phase A — `rewards-core.js`, `rewards-earn.js`, `user_rewards`/`reward_welcome` rules — is LIVE). NOT off `feat/rewards-design` (predates the Phase-A merge, lacks the substrate). Merge the design+plan docs to main first (or cherry-pick this plan) so the executor has both the code base and the plan.

**Architecture:** two per-brand redemption *models* (X. Pizza discount-existing / La Musa add-free) share ONE **reservation lifecycle** (reserve → consume-on-completion → release-on-any-failure, keyed by `order_id` + canonical fingerprint) mirroring `payment_attempts`. Redemption is **all-or-nothing, verified-uid-required, non-payable on any failure**, gated by a **`redemption_enabled` server flag (default OFF)**.

**Design authority:** `docs/superpowers/specs/2026-07-27-rewards-loyalty-design.md` (design-gate APPROVED R1→R3). Read its Redemption + Money-invariants sections. UI = approved mockup screens 4–5, built in Phase **B2** (separate plan). B1 is backend-only, emulator-testable, **inert in prod until the flag is flipped for B2**.

## Global Constraints
- **LOCKED config (owner):** X. Pizza — punch, **card_size 8**, reward = **cheapest pizza already in cart → free** (requires ≥1 pizza), welcome 2 (Phase A live). La Musa — points, tiers **500/1000/1500/2500/3500**, reward = **chosen eligible tier item ADDED free** (0-price), earn 10 pts/30 L, welcome 100 (live). Config is a **static module** with `REDEMPTION_CONFIG_VERSION` (plan-gate #11 — the spec's "versioned RTDB config" is deferred; B1 = code config + version constant; redemptions record the version; a `config_version` mismatch mid-flight → non-payable).
- **`redemption_enabled` flag (plan-gate #13):** server config (RTDB `config/redemption_enabled`, default FALSE). When false, a `redeem` request is IGNORED (order proceeds normally, no discount) — B1 ships truly inert. B2 flips it true at launch. Unreadable/absent → false.
- **MONEY INVARIANTS (gate hardest):** discount ALWAYS server-computed from the server-priced cart; client sends a `redeem` REQUEST only; **redeem requires a VERIFIED `customer_uid`** (NOT fail-open-to-guest); **all-or-nothing** — any failure → non-payable 409/400, never a payable checkout after a reward was requested; reserve is **debit-first + idempotent by `order_id`** + bound to canonical `{order_fingerprint, redemption_result, config_version}` (same-order_id reuse only on exact match); **balance never negative**; **one redemption per order**; discount reconciles in `total_cents/subtotal_cents/tax_cents` AND factura; consumed points refunded once on cancel. `isCashPayment`/tax-split/fingerprint/factura byte-intact except the documented line.
- **Earn interaction (plan-gate #12):** you do NOT earn on the redeemed free unit. X. Pizza punch-earn EXCLUDES the freed pizza unit; La Musa points-earn is naturally correct (free item = 0-price line, 0 subtotal contribution) — assert both.
- `user_rewards`/`reward_welcome` Admin-SDK-written ONLY; no new client write surface. No prune; emulator before rules deploy.

## File Structure
- Create `rewards-redeem-config.js` (versioned config + tier tables + `redemptionEnabled(db)`) · `rewards-redeem.js` (pure two-model calculator) · `rewards-reserve.js` (reservation lifecycle) · a `applyRedemptionToPricing` helper.
- Modify `index.js` (createOrder cash, chargeOnlineOrder online + both fingerprint sites), `pixelpay-confirm.js` (consume/hold/release outcomes), `cancel-order-core.js` (clawback/resolve), `rewards-earn.js` (exclude freed unit), factura pricing/build-record (line representation), `database.rules.json` (reservation child shape).

---

## Task 0: Preflight — verify Phase A substrate is present (plan-gate #8)
- [ ] On the build base confirm `rewards-core.js`, `rewards-earn.js`, the `earnRewardsOnCompletion` export, and `user_rewards`/`reward_welcome` rules all EXIST. Absent → STOP (wrong base; rebase onto `main`). Gate check only, no commit.

## Task 1: `rewards-redeem-config.js` — versioned config + enabled flag
**Produces:** `REDEMPTION_CONFIG_VERSION` (1); `REDEMPTION_CONFIG` = `{ x_pizza:{kind:'punch',cost:8,reward:'discount_cheapest_pizza'}, la_musa:{kind:'points',tiers:[{level:1,cost:500,items:[bebidas/acompañamientos ids: soft_01..04, beer_01..08, rice_white, rice_chinese, papas_fritas]},{level:2,cost:1000,items:[dimsum_01..05, starter_01..03, soup_01..03]},{level:3,cost:1500,items:[noodle_01/_sin/_pollo/_camaron, noodle_03, rice_01, rice_04, crudo_02, crudo_03, special_05]},{level:4,cost:2500,items:[noodle_02, rice_02, rice_03, starter_04..06, crudo_01, special_02]},{level:5,cost:3500,items:[special_01, special_04]}]} }` (owner-tunable default from the mockup brackets); accessors `getTier`, `itemInTier`; and `async redemptionEnabled(db) → bool` (reads `config/redemption_enabled`, default+fail-safe false).
- [ ] Tests: shape, `itemInTier` true/false, x_pizza cost 8, version numeric, `redemptionEnabled` defaults false. Implement. Green. **Commit** — `feat(rewards): redemption config + enabled flag (default off)`.

## Task 2: `rewards-redeem.js` — pure two-model discount calculator (plan-gate #4/#5)
**Produces:** `computeRedemption({ redeem, items, restaurantId }) → { ok:true, model, cost, discount_cents, freeItem, canonical } | { ok:false, reason }`; `items` = SERVER-priced cart.
- **X. Pizza (`discount_cheapest_pizza`):** require ≥1 pizza in `items` (else `ok:false 'no_eligible_item'`). `model:'discount'`; `discount_cents = cheapest pizza UNIT price cents`; `freeItem = { line_key:<cheapest pizza>, unit:true }` (a SINGLE unit is freed — never a whole qty>1 line); `cost:8`.
- **La Musa (`free_item`, `item_id`, `level`):** validate `itemInTier(la_musa,level,item_id)` (else `ok:false 'ineligible_item'`). `model:'add_free'`; the item is ADDED at price 0 → `discount_cents = 0` for the charged total (0-price line, NOT a reduction of paid items); `freeItem = { item_id, price_cents:menuPrice, added:true }`; `cost = tier.cost`. (It need NOT be in the cart — it's added.)
- `canonical = { restaurant_id, model, type, config_version, cost, discount_cents, free_item_key }`. Never trusts client price/cost; malformed → `ok:false 'bad_request'` (never throws). One-per-order enforced by the reservation, not here.
- [ ] Tests: xp with pizzas → discount = cheapest unit, single-unit free; pizza-less → ok:false; lm valid tier → model add_free, discount 0, freeItem added; wrong-tier → ok:false; garbage → ok:false; canonical carries config_version+model. Implement. Green. **Commit** — `feat(rewards): two-model redemption calculator (xp discount-cheapest / lm add-free)`.

## Task 3: `rewards-reserve.js` — reservation lifecycle (THE money spine)
**States:** `reserved → consumed | released`; plus **`held_paid`** for paid-but-not-materialized manual/held cases (plan-gate #3). Keyed by `order_id`, Admin-SDK, idempotent.
- `reserveRedemption(db,{uid,rid,orderId,cost,canonical,orderFingerprint,configVersion,now}) → {ok,reason?}` — transaction on `user_rewards/{uid}/{rid}`: reuse `reservations/{orderId}` ONLY if `{order_fingerprint,canonical,config_version}` all match (else `reservation_conflict`, no debit); require `available=balance-reserved ≥ cost` (else `insufficient`); move `cost`→`reserved`, write record (state `reserved`, `attempt_id:null`) + `reserve` ledger. **deleted_uids (plan-gate #7): the single-node txn CANNOT read deleted_uids atomically — mirror Phase-A: pre-read guard AND post-commit recheck that compensates (null the recreated node / release) if tombstoned.**
- `attachAttempt(db,{uid,rid,orderId,attemptId,hostedExpiresAt,now})` — set the reservation's `attempt_id`/`hosted_expires_at` AFTER a claimed acquire (plan-gate #1).
- `consumeRedemption(...)` — `reserved|held_paid → consumed`: realize the debit (`balance-=cost; reserved-=cost`), `redeem` ledger. Idempotent, never negative.
- `markHeldPaid(...)` — `reserved → held_paid` (money captured, awaiting dispatcher resolve). Idempotent. (plan-gate #3)
- `releaseRedemption(...)` — `reserved → released` (return to available). **Refuses `held_paid`/`consumed`.** Idempotent.
- `sweepStaleReservations(db,{now})` — release `reserved` orphans: online → past `hosted_expires_at`; cash → order age with no `completed`/`cancelled` (+ dispatcher-audit if still live). Never touches `held_paid`/`consumed`.
- [ ] Emulator: reserve debits available + record+ledger; same-order same-canonical idempotent; same-order DIFFERENT fingerprint → conflict no debit; insufficient → no debit; deleted-uid pre-guard AND post-commit-race → node purged, points not stranded; consume once realizes debit (never neg), 2nd no-op; markHeldPaid then consume/clawback exactly once; release returns to available, refuses held_paid/consumed; sweep releases reserved orphan only. Implement (mirror payment_attempts + Phase-A atomic-node/mark). Green. **Commit** — `feat(rewards): reservation lifecycle (reserved/held_paid/consumed/released + sweep)`.

## Task 4: Discount as a reconciling line (plan-gate #4/#10)
**One legal representation, `line_gross_cents >= 0` always:**
- **X. Pizza (discount):** SPLIT the cheapest pizza's cart line into a **0-price free unit** + the paid remainder (qty−1 at full price). `discountedTotal = total − unitPrice`. Then `orderBreakdownCents(discountedTotal, rid)` + the split-line `items` foot: `Σ line_gross_cents === subtotal_cents === total_cents` (xp ISV incl.). **Never zero a whole qty>1 line or a line with extras.**
- **La Musa (add-free):** APPEND a 0-price line for the free item. `total` unchanged; `Σ line_gross === subtotal` holds (0 added).
- [ ] Goldens (plan-gate #10 — hardened): **X. Pizza** redeemed → `sum(line_gross_cents) === total_cents`, ALL bases ≥ 0, qty/description sane, CAI/factura fields unchanged. **La Musa** redeemed → NO platform-factura allocation entered (la_musa skips it), 0-price line present, subtotal = paid items. Non-redeemed (either brand) → byte-identical to today. Implement `applyRedemptionToPricing`. Green. **Commit** — `feat(rewards): redemption as a non-negative reconciling line (xp split-unit / lm add-free), goldens`.

## Task 5: `createOrder` (cash) — reserve at create, consume at completion (plan-gate #6)
- [ ] `body.redeem` present AND `redemptionEnabled(db)`: require verified `customer_uid` (NOT guest fail-open) → else 401 non-payable, no order. `computeRedemption` (T2) on server-priced items; `reserveRedemption` (T3). Any `ok:false` → 409 non-payable, no order. Success: `applyRedemptionToPricing` (T4) → discounted breakdown; stamp `orders/{id}/redemption = canonical`. **Do NOT consume at create** — cash is `reserved` until the completion state; **the completion path (`earnRewardsOnCompletion`/delivered/completed) consumes**; cancel releases/claws back. Flag off or no redeem → today's behavior byte-for-byte.
- [ ] Emulator: cash+redeem+enabled → discounted total, reservation reserved, stamped, factura reconciles; delivered → consumed once; cancel-before-complete → released; insufficient → 409 no order; guest+redeem → 401; flag OFF + redeem → normal full-price (ignored); no-redeem → unchanged. Implement. **Commit** — `feat(rewards): cash redemption (reserve-at-create, consume-at-completion, verified-uid)`.

## Task 6: `chargeOnlineOrder` (online) — pre-acquire reserve + attach + release-every-outcome (plan-gate #1/#2/#9)
- [ ] Compute `computeRedemption`+`canonical` **BEFORE both fingerprint sites** (read-only classifier ~805 AND authoritative ~873) so classify/reuse can't misclassify (plan-gate #9); the `payment_fingerprint` INCLUDES the canonical redemption. Require verified uid + enabled (else 401 / ignore). `reserveRedemption` BEFORE `acquireHostedAttempt`; after a CLAIMED acquire, `attachAttempt`. **Release on EVERY post-reserve non-payable outcome** — `acquireHostedAttempt` conflict/closed/in_progress/already_paid/item_unavailable/error AND hosted-create failure after claim — EXCEPT `reuse` (preserve the existing reservation for the same order+fingerprint) (plan-gate #2). Charged `total_cents` uses the discounted breakdown (T4). Any redeem failure → non-payable 409, no attempt/URL.
- [ ] Emulator: online+redeem → discounted amount, reserved+attempt attached, fingerprint carries redemption, classify+acquire parity (not misclassified); each acquire/create failure branch → released (no leak); `reuse` → preserved; two different rewards same order → no cross-reuse; failure → 409. Implement. **Commit** — `feat(rewards): online redemption reserve/attach + release-every-outcome + canonical fingerprint`.

## Task 7: Consume/hold/release at confirm + manual paths + sweep (plan-gate #3)
- [ ] `confirmAndMaterialize`: fresh materialize (`outcome:'confirmed'`) → `consumeRedemption`. `scheduled_confirm_invalid`/`held_closed_at_materialize` (captured, `manual_review`) → **`markHeldPaid`** (NOT release — paid discounted; dispatcher resolves). Attempt expired/failed / cancelled-during-confirm (unpaid) → `releaseRedemption`. Hosted-webhook paid-evidence-during-manual → `markHeldPaid`. Wire `sweepStaleReservations` into an existing scheduled sweep.
- [ ] Emulator: paid → consumed once (re-materialize no double); expired → released; manual_review-after-capture → held_paid (not released); swept orphan → released. Implement. **Commit** — `feat(rewards): consume at materialize, held_paid for manual, release on unpaid failure + sweep`.

## Task 8: Clawback + manual-resolve on refund/cancel (plan-gate #3)
- [ ] `cancelOrderCore`: `consumed`/`held_paid` redemption on refund/cancel → return points (`clawback`), **idempotent by `order_id`** (refund_pending/recoverStaleCancel/reconciler retries can't double-return). `reserved` (unpaid) → `releaseRedemption`. Manual-resolve finalizing a `held_paid` order to a SALE → `consumeRedemption`; to a REFUND → clawback. Composes with the Phase-A earn reversal (both keyed by order_id).
- [ ] Emulator: redeemed+paid refunded → returned once, retry no double; held_paid→refund → returned once; held_paid→sale → consumed; reserved-unpaid cancel → released; non-redeemed → no-op. Implement. **Commit** — `feat(rewards): redemption clawback/resolve in cancelOrderCore (idempotent)`.

## Task 9: Earn excludes the redeemed free unit (plan-gate #12)
**Files:** `rewards-earn.js` (earn amount) + tests.
- [ ] X. Pizza punch-earn counts purchased pizzas EXCLUDING the freed unit (read `orders/{id}/redemption`; `model==='discount'` → −1 punch). La Musa points-earn on `subtotal_cents` already correct (free item = 0-price, not in subtotal) — add an assertion. Confirm the Phase-A cancel/refund earn-reversal reverses the ADJUSTED (excluding-free) amount.
- [ ] Emulator: xp order of 3 pizzas with 1 redeemed-free → earns 2 punches (not 3); lm redeemed order earns on paid subtotal only; refund reverses the adjusted amount. Implement. **Commit** — `feat(rewards): earn excludes the redeemed free unit`.

## Task 10: Rules + no-prune + suite + money golden gate + push
- [ ] Reservation records under `user_rewards/{uid}/{rid}/reservations/*` — already `.write:false`; confirm container `.validate` admits the child shape; emulator: client can't read/write another uid's reservations. `redeem` body validated + discarded (never persisted as trusted). Exports (only a new sweep export if added, +1 no-prune). `node --check` all.
- [ ] Money self-audit (assert each): server-computed discount · verified-uid · all-or-nothing non-payable · one-redemption-per-order · reservation idempotent + fingerprint-bound · balance ≥ 0 · consume/release/held_paid exactly-once across ALL payment outcomes · earn excludes free unit · subtotal+tax===total AND factura reconcile · refund returns once · flag-off ⇒ inert · non-redeem orders byte-identical.
- [ ] Full `npm test` + emulator suites green. Push `feat/rewards-phase-b1` (**OFF MAIN**); report SHA + per-task commits + emulator/golden + exports before/after. **No deploy/merge.**

---

## Self-Review
- **Plan-gate coverage:** base-off-main+preflight (#8, T0), two models (#4/#5, T2/T4), reservation deleted_uids TOCTOU (#7, T3), held_paid/manual state (#3, T3/T7/T8), pre-acquire reserve + attach (#1, T3/T6), release-every-outcome (#2, T6), fingerprint before both sites + parity (#9, T6), factura goldens + La Musa no-platform-factura (#10, T4), cash reserve-not-consume (#6, T5), config static+version (#11, T1), earn-excludes-free (#12, T9), redemption_enabled inert (#13, T1/T5/T6). Plus the spec's Phase-B invariants + the 4 R2 refinements.
- **Placeholder scan:** tier→item lists (T1) = concrete owner-tunable default; cash age window (T3) = a policy to set at build.
- **Type consistency:** `canonical` shape identical across T2/T3/T6/T7/T8; reservation keyed by `order_id`; states `reserved|held_paid|consumed|released` used consistently.

## Handoff
Advisor is sole gate-runner. Executor builds `feat/rewards-phase-b1` **off `main`**, **task-by-task on Opus 4.8**, pushes each SHA. Advisor runs a heavy codex money-gate per task. Owner deploys functions + rules (emulator-first, complete-env/both-code/zero-prune, verify revisions) with **`redemption_enabled` FALSE** — B1 soaks inert until **Phase B2 (checkout UI, mockup screens 4–5, separate plan)** ships and the flag is flipped.
