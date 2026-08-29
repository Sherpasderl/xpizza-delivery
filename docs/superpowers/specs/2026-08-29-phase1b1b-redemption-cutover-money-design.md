# SPEC — Phase 1b-1b: redemption-cluster pricing reads the Firestore catalog (WHOLESALE, money-critical)

**Date:** 2026-08-29 · **Program:** Sherpa platform ([[sherpa-platform-initiative]]). **Follows 1b-1** (order-total cutover, ✅ prove-in-prod PASSED 2026-08-29). **Surface:** the entire rewards pricing call graph. **MONEY-CRITICAL** (factura rebaja + La Musa points wallet + X. Pizza add-free value) → heaviest codex money-grill + advisor; never self-approve ([[codex-gate-money-adjacent]]). Build LOCAL-ONLY. **Owner directive (2026-08-29): build the ROBUST version — cut the whole cluster's table dependency, no temporary half-cut ([[prefer-robust-over-bandaid]]).**

## Goal & invariant
Thread the **guarded catalog `tables`** (the `{restaurantId, menu, extras}` object 1b-1 already resolves) through the ENTIRE rewards pricing graph, so the redemption path reads prices AND keys from the catalog (guarded, parity-checked) instead of the in-code `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT`. **No price VALUE changes** — same parity guard as 1b-1 (catalog only when byte-== code, else code + alarm). All-or-nothing → no split-brain: the SAME resolved `tables` feed order-total (1b-1) AND redemption, so they always agree; on any divergence both fall back to code together.

## The robust scope — the guarded `tables` carry keys AND prices
`tables.menu` is `{key: price_cents}`, so it is BOTH the key set and the price source. The robust cut moves EVERY `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` read in the cluster to `tables` — leaving the rewards path with ZERO in-code-table dependency (so 1d retires the code tables cleanly, no stragglers). The 5 sites:
| # | Site | Reads | Kind |
|---|---|---|---|
| 1 | `rewards-redeem.js:35-36` `computeLaMusa`/`laMusaPriceCents` | `.la_musa` menu+extras | price + key |
| 2 | `rewards-redeem.js:55` `computeXPizza` | `.x_pizza[name]` | price |
| 3 | `rewards-redeem-pricing.js:39` `applyRedemptionToPricing` | `.x_pizza` menu+extras (`pricedLineItems`) | price |
| 4 | `rewards-redeem-config.js:51` (membership: is-id-a-dish) | `hasOwnProperty(.la_musa, id)` | key |
| 5 | `rewards-redeem-config.js:65` `eligibleKeys` | `Object.keys(.la_musa)` | key |
| (6) | `rewards-redeem-intake.js:53,105` `computeServerTotal(items, rid)` | already table-aware (1b-1) | pass `tables` |

## Honest boundary — business rules are NOT table reads (stay in config; schema-v2 is a separate follow-on)
`X_PIZZA_REDEEM_ELIGIBLE` (individual-vs-NY), `isXPizzaEligible`, and the `beer_` alcohol-exclusion convention are **classifications**, not `{key,price}` table data — 1a's catalog schema doesn't encode them, so they legitimately stay in config. Moving them into the catalog (per-item `eligible`/`category`/`alcohol` metadata) is a genuine single-source-of-truth win but requires a **catalog schema v2** — a distinct enrichment effort, flagged as its own follow-on, NOT faked into 1b-1b. (This is not a half-cut: after 1b-1b the rewards path reads no in-code TABLE; only business RULES remain in config, where rules belong.)

## Integration — mirror 1b-1 (REVISED per codex design-grill 2026-08-29)
- The pure fns (`computeRedemption`→`computeXPizza`/`computeLaMusa`/`laMusaPriceCents`, `applyRedemptionToPricing`, `isLaMusaEligible` [called from `computeLaMusa`], and the config membership/`eligibleKeys` fns) gain a trailing **`tables`** param. When provided, use `tables.menu`/`tables.extras`; when omitted, fall back to today's `MENU_BY_RESTAURANT[rid]`.
- **🔒 GRILL-FIX #2 — HARD CONTRACT at the production seams (the optional default is a silent-split-brain foot-gun):** `tables` stays optional ONLY for legacy pure-unit tests. The **production intake seams** — `prepareRedemption`, `resolveRedemptionForOrder`, `quoteRedemptionCore`, AND the classifier's `prepareRedemption` dep (see #1) — **REQUIRE a non-null, restaurant-tagged `tables`**: absent/null in the production path → **throw/fail-closed** (a missed thread must be a LOUD failure, never a silent code fallback). Non-vacuous sentinel-table test at EVERY call site.
- **🔒 PIN B (carried from 1b-1):** when `tables` provided, assert `tables.restaurantId === restaurantId` in every helper; mismatch → throw/fail-closed. Single-restaurant order/quote; `computeXPizza` x_pizza-only, `computeLaMusa` la_musa-only.
- **Thread from FOUR handler/classifier seams** (grill: it's 5 direct table reads + intake internals + 4 seams, not "3 handlers"):
  - `createOrder` (`resolveRedemptionForOrder` `:724`) and `chargeOnlineOrder` (`prepareRedemption` `:1026`) — both ALREADY resolve `pricingTables` (1b-1); add `tables: pricingTables`; `rewards-redeem-intake` threads into `computeRedemption`/`applyRedemptionToPricing`/`computeServerTotal`.
  - **🔒 GRILL-FIX #1 — the CLASSIFIER seam (MISSED, blocking):** `computeIncomingFingerprint` (`createorder-classify.js:59`, wired at `index.js:557-560`) calls `prepareRedemption` to price a redemption cash order's **idempotency fingerprint**. Thread `tables: pricingTables` into the classify deps too — else the order reserves on catalog while its dedup fingerprint prices on code → on divergence they DRIFT → false-409 → **double orders** (breaks the F1 store==compare invariant). The SAME resolved `pricingTables` must feed the classifier, the reserve, AND the order-total.
  - **`quoteRedemption` (`onRequest` `:5514` → `quoteRedemptionCore` `:5535`)** — NEW to the resolver: resolve `pricingTables` for its `restaurantId` and thread it into **BOTH** `computeServerTotal` calls it reaches (`:105` + `:107`-via-prepare, grill) — else the customer's QUOTE prices from code while the ORDER prices from catalog (quote↔order split-brain).

## Heartbeat (deferred from 1b-1 — fold in here)
Add the sampled positive-confirmation log to the 1b-1 resolver (`catalog/pricing-tables.js` `getPricingTables`, the `tablesEqual`-true branch): `console.log('pricing_catalog_hit', { restaurantId })`, **sampled** (1-per-cache-refresh or 1-in-N, never per-order — log-spend). 1b-1b redeploys the order path, so it rides for free → durable positive "catalog served" signal in `functions:log` from here on, replacing the read-timestamp-correlation method.

## FISCAL scope (owner-approved 2026-08-29, [[fiscal-representation-owner-gate]])
`applyRedemptionToPricing` produces the redeemed X. Pizza **factura value** (`factura_items` + `desc_rebaja_cents`, consumed by `build-record.js:57`) — not just the order-total. The robust wholesale cut moves that value's SOURCE to the guarded catalog. **Owner explicitly signed off (chose "include in 1b-1b, robust"):** the redeemed factura value is byte-IDENTICAL (parity guard: catalog only when == code), so the factura ASSERTS unchanged numbers — only the source moves. The **NON-redeemed** factura `pricedLineItems` (`index.js:768/:1192`) stays on CODE this build → **1b-2** (fiscal stage). So after 1b-1b: redeemed-factura value on guarded catalog, non-redeemed still code; both parity-correct; 1b-2 unifies. A **factura-parity test** (redeemed `factura_items`+`desc_rebaja` byte-identical catalog-vs-code, X. Pizza) is REQUIRED.

## Money-safety invariants (assert)
No price VALUE change (parity guard) · fail-safe to code on read-fail/timeout/mismatch + alarm (unchanged) · redemption still fails-closed on unknown keys/ineligible items · tables restaurant-tagged + PIN-B asserted (no cross-brand) · **the SAME resolved `pricingTables` feed the classifier fingerprint AND the reserve AND the order-total AND the quote — store==compare holds (no F1 double-order drift)** · hard-contract: production seams THROW on absent tables (no silent code fallback) · `redemptionFingerprint`/reserve-consume lifecycle unchanged in VALUE (canonical binds the reserve; consume debits stored `rec.cost` — grill CONFIRMED table-agnostic post-reserve) · redeemed factura value table-fed + parity-tested (owner-approved); non-redeem factura pricedLineItems `:768/:1192` BYTE-UNCHANGED (1b-2) · business-rule config (`X_PIZZA_REDEEM_ELIGIBLE`, `beer_` alcohol) unchanged.

## Testing
- **Pure fns with `tables`:** `computeXPizza`/`computeLaMusa`/`laMusaPriceCents`/`applyRedemptionToPricing`/`eligibleKeys`/membership/`isLaMusaEligible` given guarded tables produce byte-identical output vs code tables (both brands). **Non-vacuous sentinel per site** (a distinct table-only value proves the tables are actually used, not ignored — required at EVERY call site incl. the classifier).
- **🔒 store==compare (F1 no-double-order):** `computeIncomingFingerprint` (classifier) and the reserve/order price the SAME redemption under the SAME tables → identical fingerprint. A test where classifier-on-catalog vs reserve-on-code would DIVERGE must be impossible (both threaded).
- **🔒 Hard-contract:** each production seam (`prepareRedemption`/`resolveRedemptionForOrder`/`quoteRedemptionCore`/classifier) called WITHOUT tables → **throws** (not a silent code fallback).
- **PIN B:** cross-brand tables → throws/fails-closed.
- **Backward-compat (pure tests only):** the pure fns with `tables` omitted → byte-identical to today (existing rewards unit tests stay green).
- **Quote↔order parity:** `quoteRedemptionCore` and the intake price the SAME redemption identically under the same tables (BOTH `computeServerTotal` calls threaded).
- **🔒 Factura parity (owner-approved fiscal move):** redeemed X. Pizza `factura_items` + `desc_rebaja_cents` byte-identical catalog-vs-code.
- **Emulator (reuse 1a/1b harness):** real Firestore reader → redemption prices off catalog on parity; mutated catalog → mismatch → code + alarm (falsifiable). PIN-E-style identity proof.
- Full `npm test` EXIT 0; NON-redeem factura `pricedLineItems` tests UNCHANGED (1b-2).

## Gate & deploy
LOCAL-ONLY → advisor + **heaviest codex money-grill**. Deploy (owner, post-gate): scoped `--only functions:createOrder,functions:chargeOnlineOrder,functions:quoteRedemption` (`functions:` per fn; env-gate [[functions-env-management]]; gcloud-verify each; required manual emulator money-proof per the 1b-1 predeploy-gap lesson). **Then prove-in-prod:** zero `payment_catalog_*` alarms across live REDEMPTION orders + `pricing_catalog_hit` heartbeat present + a real redemption priced correctly (factura rebaja / points debit / add-free) BEFORE 1b-2 (fiscal) is specced.

## Out of scope (this build)
Fiscal `pricedLineItems` (1b-2) · catalog schema v2 (eligibility/alcohol metadata — separate follow-on) · any price-value change · forms (1c) · code-table retirement + versioned-publish (1d).
