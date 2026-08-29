# BUILD RELAY — Phase 1b-1b: redemption-cluster pricing reads the Firestore catalog (WHOLESALE)

**To:** executor · **From:** advisor (spec owner-approved + codex design-grilled). **Spec:** `docs/superpowers/specs/2026-08-29-phase1b1b-redemption-cutover-money-design.md` — read it; this pins the build. **MONEY + FISCAL-CRITICAL.** Owner directive = ROBUST, no half-cut. Heaviest codex money-gate before ANY push; never self-approve ([[codex-gate-money-adjacent]], [[fiscal-representation-owner-gate]]).

## ⚠️ BUILD BASE
Fresh worktree off **`origin/main` @ current** (fetch + confirm — main moved: N3 + RTDB-egress Stage 1 landed). Branch `feat/phase1b1b-redemption-cutover`. **Commit LOCAL-ONLY.** **Re-anchor every line number.**

## What & why
1b-1 cut the ORDER-TOTAL to the guarded catalog `tables` (`{restaurantId, menu:{key:price}, extras}`) — ✅ prove-in-prod PASSED. 1b-1b threads the SAME resolved `pricingTables` through the ENTIRE redemption graph so redemption prices (AND keys) come from the catalog too — all-or-nothing, no split-brain. **No price VALUE changes** (parity guard: catalog only when byte-== code, else code + alarm).

## The cut — 5 direct table reads → threaded `tables` (prices AND keys)
`tables.menu` is `{key: price_cents}` = both the key set and prices. Move each to `tables`:
1. `rewards-redeem.js:35-36` (`computeLaMusa`/`laMusaPriceCents`) — `.la_musa` menu+extras.
2. `rewards-redeem.js:55` (`computeXPizza`) — `.x_pizza[name]`.
3. `rewards-redeem-pricing.js:39` (`applyRedemptionToPricing`) — `.x_pizza` menu+extras (`pricedLineItems`).
4. `rewards-redeem-config.js:51` (membership: is-id-a-dish) — `hasOwnProperty(.la_musa, id)`.
5. `rewards-redeem-config.js:65` (`eligibleKeys`) — `Object.keys(.la_musa)`.
Plus `isLaMusaEligible` (called from `computeLaMusa`) takes/passes `tables`; and the intake `computeServerTotal(items, rid)` calls (`rewards-redeem-intake.js:53,105`) pass `tables` (already table-aware from 1b-1).
- Pure fns gain a trailing `tables` param; provided → `tables.menu`/`tables.extras`; omitted → today's `MENU_BY_RESTAURANT[rid]` (**backward-compat, protects existing pure unit tests**).

## 🔒 GRILL-FIX #1 — the CLASSIFIER seam (blocking; the 4th seam)
`computeIncomingFingerprint` (`createorder-classify.js:59`, wired at `index.js:557-560`) calls `prepareRedemption` to price a redemption cash order's **idempotency fingerprint**. **Thread `tables: pricingTables` into the classify deps** so the classifier prices redemption on the SAME source as the reserve/order. Without it: order reserves on catalog, dedup fingerprint prices on code → on divergence `store_fp != compare_fp` → **false-409 → DOUBLE ORDERS** (breaks the F1 store==compare invariant bundle #1 hardened). The SAME `pricingTables` MUST feed classifier + reserve + order-total.

## 🔒 GRILL-FIX #2 — HARD CONTRACT at production seams (no silent split-brain)
Optional `tables` stays optional ONLY for legacy pure-unit tests. The **production seams** — `prepareRedemption`, `resolveRedemptionForOrder`, `quoteRedemptionCore`, AND the classifier's `prepareRedemption` dep — **REQUIRE a non-null, restaurant-tagged `tables`: absent → THROW/fail-closed.** A missed thread must be a LOUD failure, never a silent code fallback.

## 🔒 PIN B — cross-brand
Every helper asserts `tables.restaurantId === restaurantId`; mismatch → throw. `computeXPizza` x_pizza-only, `computeLaMusa` la_musa-only; single-restaurant order/quote.

## Thread from the 4 handler/classifier seams
- `createOrder` (`resolveRedemptionForOrder` `:724`) + `chargeOnlineOrder` (`prepareRedemption` `:1026`) — both ALREADY resolve `pricingTables` (1b-1); add `tables: pricingTables`.
- **Classifier** (`index.js:557-560` → `computeIncomingFingerprint`) — add `tables: pricingTables` to the deps (GRILL-FIX #1).
- **`quoteRedemption`** (`onRequest` `:5514` → `quoteRedemptionCore` `:5535`) — NEW to the resolver: add `resolvePricingTables(restaurantId)` and thread into **BOTH** `computeServerTotal` calls it reaches (`:105` + `:107`-via-prepare).

## 🔒 FISCAL (owner-approved 2026-08-29 — [[fiscal-representation-owner-gate]])
`applyRedemptionToPricing` produces the redeemed X. Pizza factura value (`factura_items` + `desc_rebaja_cents`, consumed at `build-record.js:57`). Owner EXPLICITLY signed off to include it (robust) — the redeemed factura value is byte-IDENTICAL (parity guard), only the source moves. **Non-redeem factura `pricedLineItems` (`index.js:768/:1192`, `MENU_PRICES`) stays on CODE — do NOT touch (1b-2).** Required test: redeemed `factura_items`+`desc_rebaja` byte-identical catalog-vs-code.

## Heartbeat (fold in)
Add to the 1b-1 resolver (`catalog/pricing-tables.js` `getPricingTables`, `tablesEqual`-true branch): **sampled** `console.log('pricing_catalog_hit', { restaurantId })` (1-per-cache-refresh or 1-in-N, never per-order). Durable positive "catalog served" signal.

## Tests (all required)
- Pure fns with `tables` byte-identical vs code, both brands; **non-vacuous sentinel per site** (distinct table-only value proves tables used).
- **store==compare:** classifier + reserve/order price the same redemption → identical fp under the same tables.
- **Hard-contract:** each production seam without tables → THROWS.
- **PIN B:** cross-brand → throws.
- **Backward-compat (pure only):** `tables` omitted → byte-identical today (existing rewards tests green).
- **Quote↔order parity:** quote and intake price the same redemption identically (both `computeServerTotal` calls threaded).
- **Factura parity:** redeemed X. Pizza `factura_items`+`desc_rebaja` byte-identical catalog-vs-code.
- **Emulator PIN-E:** real Firestore reader → redemption on catalog at parity; mutated catalog → mismatch → code + alarm.
- Full `npm test` EXIT 0; non-redeem factura tests UNCHANGED.

## Gate & deploy
LOCAL-ONLY → advisor + **heaviest codex money-grill**. Deploy (owner, post-gate): scoped `--only functions:createOrder,functions:chargeOnlineOrder,functions:quoteRedemption` (`functions:` per fn; env-gate; gcloud-verify each; **run the emulator money-proof manually** per the 1b-1 predeploy-gap lesson). Then prove-in-prod (zero `payment_catalog_*` + `pricing_catalog_hit` present + a real redemption priced right: points debit / add-free / factura rebaja) BEFORE 1b-2. Handback DoD: branch@SHA, the 5 cuts + 4 seams, the 2 grill-fixes, PIN B, the fiscal parity test, the hard-contract throws, non-vacuous sentinels, emulator PIN-E, additive/no-prune, npm test EXIT 0.
