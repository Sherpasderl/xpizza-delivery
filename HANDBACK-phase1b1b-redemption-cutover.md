# HANDBACK — Phase 1b-1b: redemption cluster reads the guarded catalog (WHOLESALE)

**Branch:** `feat/phase1b1b-redemption-cutover` @ **`e6a960d`** · worktree `~/Downloads/xpizza-1b1b` · base `origin/main @ bdba00d` · **LOCAL-ONLY.** 2 commits.

## Verification
| Suite | Result |
|---|---|
| `npm test` (full, incl. the new 17-assertion suite) | **exit 0**, 1228 assertions |
| `test:pricing-cutover` — emulator PIN-E (real reader) | **8/8** (was 6; +2 for 1b-1b) |
| `test:catalog-parity` | **12/12** |
| `test:catalog-rules` | **12/12** |

## The 5 cuts — every direct table read is gone
Grep confirms **no `MENU_BY_RESTAURANT.` / `EXTRAS_BY_RESTAURANT.` reads remain** anywhere in the redemption cluster; all route through the shared `resolvePriceTables` (now exported from `menu-pricing.js`, so PIN B has exactly one definition).
1. `rewards-redeem.js` `laMusaPriceCents` — menu **and** extras
2. `rewards-redeem.js` `computeXPizza`
3. `rewards-redeem-pricing.js` `applyRedemptionToPricing` → `applyXPizza`
4. `rewards-redeem-config.js` `isLaMusaEligible` (membership)
5. `rewards-redeem-config.js` `eligibleKeys`
Plus `isLaMusaEligible` threaded from `computeLaMusa`, and both intake `computeServerTotal` calls.

## The 4 seams
`resolveRedemptionForOrder` (cash reserve) · `prepareRedemption` (online) · **the classifier** `computeIncomingFingerprint` · **`quoteRedemption`** (new to the resolver — resolves its own guarded tables so a quote prices on the same source as the order it previews).

## GRILL-FIX #1 — store == compare
Two guards, because one alone is weak:
- **Behavioural:** the redemption fingerprint is demonstrably **sensitive to the table source** — a diverged table changes it. That is what makes sharing one resolved object load-bearing rather than decorative.
- **Structural:** `index.js` is asserted to pass `tables: pricingTables` at **exactly three** seams. A future edit that resolves tables twice reintroduces the drift *loudly*, in a test, instead of as a false 409 in production.

## GRILL-FIX #2 — hard contract
All four production seams throw on **absent** and on **mistagged** tables; asserted per seam. Optional `tables` survives only in the pure calculators, for the legacy unit tests. Two legacy classifier tests now pass tables — their redemption branch exercises a production seam and correctly tripped the contract, which is the contract working.

## FISCAL parity (the owner-approved cut)
Redeemed X. Pizza `factura_items` **and** `desc_rebaja_cents` are byte-identical catalog-vs-code, with the comped line present and marked `redeemed` — asserted both as a pure test and end-to-end off the **real Firestore read** in the emulator. **The non-redeem factura path (`pricedLineItems` / `MENU_PRICES`) is byte-untouched** — verified by diff. That remains 1b-2.

## Non-vacuity — one sentinel per cut site
A catalog-vs-code comparison passes trivially if `tables` is ignored — the tautology that bit the 1a parity test and the 1b-1 money proof. Each site is proven to actually consult the tables: a sentinel price drives `price_cents`, `cost_pts` and the factura comped line; a dish present **only** in the tables is eligible while one absent from them is **not**; `eligibleKeys` enumerates the tables.

## Emulator PIN-E (8 cases)
Redemption and the redeemed factura computed off the **real Firestore-read** catalog equal the code-fed path, with the tables identity-proven to have come from Firestore. And under a **diverged** catalog the whole cluster prices on CODE with a parity alarm — no split-brain even in the failure mode.

## Heartbeat
`pricing_catalog_hit` now logs on the catalog-served branch, **sampled** at most once per restaurant per minute — never per order. This is what makes the prove-in-prod window meaningful: without it, "zero alarms" reads identically whether the catalog served every order or the read never ran.

## Additive
`git diff origin/main` is **empty** for `factura/`, both order forms, and `firestore.rules`. `menu-pricing.js` changes by **one line** (the `resolvePriceTables` export). No code tables pruned — they remain the fallback.

## ⚠️ Two things for the gate
1. **Dead imports.** `MENU_BY_RESTAURANT` / `EXTRAS_BY_RESTAURANT` are now unused in `rewards-redeem.js`, `rewards-redeem-config.js` and `rewards-redeem-pricing.js` (only the `require` line references them). I left them **deliberately** — the DoD says additive/no-prune and removing them is outside the relayed scope. A codex grill will likely flag them; say the word and I'll strip them in a one-line follow-up.
2. **Deploy-gate gap persists** (unchanged from 1b-1). The emulator money proof is bound into `firestore.predeploy`, and this deploy is scoped to **functions** — so it will not run automatically. `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:pricing-cutover` must be a named manual step before deploying.

## Deploy scope
`--only functions:createOrder,functions:chargeOnlineOrder,functions:quoteRedemption` — `quoteRedemption` is newly in scope because it now resolves catalog tables.

## Prove-in-prod (before 1b-2)
Zero `payment_catalog_*` alarms, **`pricing_catalog_hit` present in the logs** (the positive signal), and a real redemption priced correctly end to end: points debit, add-free line, and the factura rebaja.
