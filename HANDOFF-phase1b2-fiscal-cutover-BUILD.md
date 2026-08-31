# BUILD RELAY — Phase 1b-2: NON-redeem X. Pizza factura pricing reads the Firestore catalog

**To:** executor · **From:** advisor (spec owner-approved + fiscal-signed-off + codex design-grilled SOUND). **Spec:** `docs/superpowers/specs/2026-08-31-phase1b2-fiscal-cutover-money-design.md`. **FISCAL-CRITICAL — X. Pizza only** ([[fiscal-representation-owner-gate]] — owner signed off the source-move; value byte-identical via parity). Heaviest codex money+fiscal gate before ANY push; never self-approve.

## ⚠️ BUILD BASE
Fresh worktree off **`origin/main` @ current** (fetch + confirm — 1b-1b + Lap Cheong + menus-CI landed). Branch `feat/phase1b2-fiscal-cutover`. **Commit LOCAL-ONLY.** **Re-anchor every line number** (they shifted).

## What & why
1b-1b moved the REDEEMED X. Pizza factura value to the guarded catalog (live+proven). 1b-2 moves the **NON-redeem** factura value — the last code-table read on the fiscal path. Thread the SAME `pricingTables` 1b-1 resolves into the factura `pricedLineItems` call. **No price VALUE change** (parity guard: catalog only when byte-== code, else code + alarm → the factura asserts byte-identical numbers).

## The cut — exactly two sites (X. Pizza-only-reached) + one import
- **🔒 GRILL NOTE — add the import (codex-flagged, required):** `resolvePriceTables` is exported from `menu-pricing.js` but NOT currently imported in index.js. Add it to the menu-pricing destructure (~`index.js:254`, alongside `MENU_BY_RESTAURANT, computeServerTotal, summaryLines, …`).
- **The 2 sites — `index.js:786` and `:1210`** (re-anchor): both are the NON-redeem branch `… : (usesPlatformFactura(restaurantId) ? pricedLineItems(body.items, MENU_PRICES, EXTRA_PRICES) : {items:null})`. Replace with the guarded tables via the shared PIN-B resolver:
  ```js
  const { menu, extraPrices } = resolvePriceTables(restaurantId, pricingTables);   // catalog when ==code, else code (fail-safe); PIN-B asserts rid match
  … usesPlatformFactura(restaurantId) ? pricedLineItems(body.items, menu, extraPrices) : { items: null } …
  ```
- **X. Pizza-only guaranteed** (codex-CONFIRMED): both sites gated by `usesPlatformFactura` (only x_pizza; la_musa → `{items:null}`) → `pricingTables` there is always x_pizza. `pricedLineItems(items, menuPrices, extraPrices)` already takes the tables — no signature change.
- **`pricingTables` is already in scope** in both handlers (1b-1; `buildRewardStamp(..., pricingTables)` sits right above :786). Use it; do NOT re-resolve.

## 🔒 PINs / invariants
- **PIN B:** `resolvePriceTables(restaurantId, pricingTables)` asserts `pricingTables.restaurantId === restaurantId` → fail-closed on cross-brand. Guards a future regression.
- **Fail-safe, NO drop:** `pricingTables` is always a code-tagged object (post-1b-1b resolvePricingTables never returns null); `resolvePriceTables(null)` → code default. Catalog trouble → code x_pizza tables, factura still prices. The factura site MUST NOT throw/drop on catalog trouble (it's not a hard-contract seam).
- **KEEP `MENU_PRICES`/`EXTRA_PRICES`** — they're the code fallback the resolver returns; retiring them is 1d.
- **DO NOT touch:** the redeemed-factura branch (`redemptionPriced ? …`, 1b-1b), the la_musa `{items:null}` branch, `orderBreakdownCents`/ISV split — all BYTE-UNCHANGED (codex-CONFIRMED the factura source doesn't feed any fingerprint/idempotency/reserve).

## Tests (all required)
- **Non-vacuous factura parity:** `pricedLineItems` with the guarded catalog tables → byte-identical `items`/`factura_items`/line-cents vs the code x_pizza tables, representative X. Pizza cart. **Sentinel** (a table-only price drives the factura line cents → proves the tables are used, not ignored).
- **PIN B:** factura tables whose `restaurantId` ≠ x_pizza → throws/fails-closed.
- **Backward-compat:** `pricedLineItems` unchanged for any caller not passing catalog tables.
- **Emulator PIN-E** (extend the pricing-cutover suite): real Firestore reader → non-redeem X. Pizza factura values == code; a diverged catalog price → code + `catalog_parity_mismatch` (falsifiable, factura never mispriced).
- Full `npm test` EXIT 0; redeemed-factura (1b-1b) + La Musa factura tests UNCHANGED.

## Gate & deploy
LOCAL-ONLY → advisor + **heaviest codex money+fiscal grill**. Deploy (owner, post-gate): scoped `--only functions:createOrder,functions:chargeOnlineOrder` (the two factura builders; `quoteRedemption` does NOT factura; `functions:` per fn; env-gate; gcloud-verify each; **required manual emulator money-proof**). **Then prove-in-prod:** a real X. Pizza NON-redeem factura prints the right line values off the catalog + `pricing_catalog_hit` heartbeat + zero `payment_catalog_*`/`pricing_resolver_failed` — validated against the printed SAR doc ([[factura-integration]]) — before 1c. Handback DoD: branch@SHA, the import + 2 sites, PIN B, the factura-parity + sentinel + PIN-E tests, additive/no-prune, redeemed/la_musa/ISV byte-unchanged statement, npm test EXIT 0.
