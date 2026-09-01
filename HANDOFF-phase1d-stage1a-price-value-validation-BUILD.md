# BUILD RELAY — Phase 1d Stage 1a: fail-closed PRICE-VALUE validation (money + fiscal guard)

**To:** executor session · **From:** advisor. **Program:** Sherpa platform 1d (spec `docs/superpowers/specs/2026-08-31-phase1d-...-design.md`, R4-SOUND). This is the **first staged slice** of 1d — the fail-closed guard the grill flagged as blocker #3. **Additive + INERT on current data** (every live price is a positive-integer lempira value, so these guards never fire today → zero behavior change). It is the precondition that makes the later authority-flip safe: once the catalog is authoritative (Stage 2), a portal fat-finger of a `0`/corrupt price must **reject the order + misvalue nothing on the factura**, not silently compute a wrong/zero total.

## 🔴 Type: MONEY-CRITICAL + FISCAL-adjacent (`pricedLineItems` is the FACTURA line pricer). Heaviest codex money+fiscal gate. Owner deploys. Build LOCAL-ONLY.

## Base
Fresh worktree off **`origin/main` @ `e8b43c9`** (confirm `git rev-parse origin/main` = e8b43c9). Branch `feat/phase1d-stage1a-price-value-validation`. Commit LOCAL-ONLY.

## The gap (verified from source)
- `computeServerTotal` (menu-pricing.js:141) validates key + qty, then `total += menu[key] * qty` — **no check `menu[key]` is a positive integer**; extras: `extraPrices[eid]` added unchecked.
- `pricedLineItems` (factura/pricing.js:12) validates name + qty, then `menuPrices[name] * qty * 100` — **no value check**; extras: `extraPrices[ename] * 100` unchecked.
- Reader `catalog/catalog-firestore.js:33` rejects `!Number.isInteger(v.price) || v.price < 0` — **allows `0`**.

## The change — one rule, applied in THREE places, IDENTICALLY

**The rule:** a usable price is `Number.isInteger(price) && price > 0`. Anything else (`0`, negative, `NaN`, non-integer, `undefined`) is a corrupt/tampered value → **reject**, never compute.

1. **`computeServerTotal` (menu-pricing.js)** — immediately after the key-exists check, before `total += menu[key] * qty`:
   ```js
   const price = menu[key];
   if (!Number.isInteger(price) || price <= 0) {
     return { total: NaN, error: `invalid price for ${key}` };
   }
   ```
   And for each extra, after the eid-exists check, before adding `extraPrices[eid]`: the same guard → `return { total: NaN, error: \`invalid price for extra ${eid}\` }`.

2. **`pricedLineItems` (factura/pricing.js)** — the SAME rule, before `lineGrossCents = menuPrices[name] * qty * 100`:
   ```js
   const price = menuPrices[name];
   if (!Number.isInteger(price) || price <= 0) {
     return { items: null, error: `invalid price for ${name}` };
   }
   ```
   And for each extra, before `lineGrossCents += extraPrices[ename] * 100`: the same guard → `return { items: null, error: \`invalid price for extra ${ename}\` }`.

   🔒 **LOCKSTEP (critical):** `pricedLineItems` MIRRORS `computeServerTotal` exactly (the factura line-gross sum MUST equal the server total). The value-rule MUST be byte-identical in both — a value that rejects in one MUST reject in the other, or you get an order that prices but can't factura, or a factura that misvalues. Same predicate (`!Number.isInteger(price) || price <= 0`) in both. State the lockstep in the handback.

3. **Reader `catalog/catalog-firestore.js:33`** — tighten `v.price < 0` → `v.price <= 0` (reject `0` too); update the message to `price not a positive integer` and the line-22 comment accordingly. This validateDoc is shared by the flat layout AND a version's docs (line 27) AND is called by `readVersionDocs` inside `publishVersion` verify (catalog-publish.js:162) — so this ALSO enforces `> 0` at PUBLISH time (a version with a `0` price fails the pre-flip verify → the pointer flip is blocked). No separate publish change needed; confirm this propagation in the handback.

## 🔒 Guards / invariants
- **INERT on current data:** every live x_pizza + la_musa price is a positive integer → these guards never fire → order/factura pricing is byte-identical before/after. Prove with a before/after equality test on the real menus.
- **Fiscal representation UNCHANGED for valid data:** the factura asserts the exact same values for every real order; this only REJECTS a value that cannot occur today. Not a change to what the factura asserts (no [[fiscal-representation-owner-gate]] decision needed) — but it IS on the factura pricer, so codex fiscal-grill it.
- **No shape/contract change:** `resolvePriceTables`/`requireTables`/PIN B (restaurant-tagged tables) and the return shapes (`{total, error}` / `{items, error}`) are UNCHANGED. The fail path uses the EXISTING error-return convention (NaN/null + error string), so every existing caller's error handling already covers it.
- Resolver `getPricingTables` parity-gate, snapshot/fallback, cache — **UNTOUCHED** (those are Stage 1b / Stage 2). This slice is ONLY the three value-guards.

## Tests
- **computeServerTotal**: injected table with a `0` / negative / `NaN` / non-integer price for a cart item → `{total: NaN, error: /invalid price/}` (rejects, does NOT compute); same for a corrupt EXTRA price. A valid table → totals UNCHANGED (regression-lock the current x_pizza + la_musa carts).
- **pricedLineItems**: same matrix → `{items: null, error: /invalid price/}` for corrupt menu/extra price; valid → line_gross UNCHANGED.
- **LOCKSTEP test**: one injected table with a corrupt value → BOTH `computeServerTotal` and `pricedLineItems` reject the SAME cart (neither computes). This is the guard against divergence.
- **Reader**: a doc (flat + version) with `price: 0` → `catalog_bad_doc` throw; `price: 1` → accepted. And a version containing a `0`-price item fails `publishVersion` verify (blocked flip) — an emulator or a `readVersionDocs`-level test.
- **Regression-lock (inert proof):** the real current menus price byte-identically before/after (add if not already covered by `menu-pricing.test.js` / `factura/pricing.test.js`).
- `node --check`; full `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` green (watch `menu-pricing.test.js`, `factura/pricing.test.js`, `catalog/catalog.test.js`, `catalog-schemav2.test.js`, `factura-catalog-cutover.test.js`, `rewards-redeem-pricing.test.js`).

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money+FISCAL gate** (confirm: identical rule in both calculators = lockstep; inert on current data; fiscal representation unchanged for valid data; reader `>0` propagates to publish verify; no money-path regression; error-return convention matches existing callers).
- Deploy (owner, post-gate): the guards live in code used by createOrder / chargeOnlineOrder / confirmOnlinePayment / the factura pricer — deploy the affected functions (per deploy discipline: from `~/Downloads/xpizza-delivery/xpizza-functions` after `git fetch`+confirm `main==origin/main`; gcloud-verify). Prove-in-prod: a real cash order + a real card order + a factura all price identically (the guard is inert) — plus a `pricing_catalog_hit` heartbeat (incl. the still-pending **la_musa** first heartbeat — this slice is a good moment to confirm it).

## Handback DoD
Branch@SHA (off e8b43c9); the 3-file diff (both calculators + the reader); the LOCKSTEP statement (byte-identical predicate in both calculators); the inert-on-current-data proof (before/after menu pricing equality); the reader→publish-verify propagation note; the test matrix (corrupt-value reject in both + reader/publish + regression-lock) with output; `node --check` + full suite green.

## Context: where this sits in 1d (for your planning)
Stage 1a = THIS (value guard, additive/inert). **Next slices (separate relays):** Stage 1b = auto-snapshot generation + RTDB mirror written into the publish batch (serialized-publish + mirror-ack + max-version-distance) — additive infra, not yet the fallback. Stage 2 = the flip (checkout-confirm displayed==charged, resolver → catalog-authoritative [drop `tablesEqual`], retire code tables → snapshot). The spec's version-aware-cache requirement (blocker #1) is ALREADY satisfied by 1c-b2's `catalog/catalog.js` — verify-only, nothing to build.

---
*Relay artifact (advisor→executor). Stage 1a of the staged 1d build — the fail-closed value guard, additive + inert, gated money+fiscal.*
