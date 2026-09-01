# BUILD RELAY — Phase 1d Stage 1a EXTENSION: shared price-valid helper + close the completeness gap

**To:** executor session · **From:** advisor. **Extends** the gated-SOUND Stage 1a branch. The 1a gate (money+fiscal, SOUND) flagged 2 NON-BLOCKING completeness gaps: `summaryLines` and the **reward free-item valuation** still multiply raw prices without the `>0`-integer rule. They create **no live bypass today** (prod routes through the guarded resolver + `computeServerTotal`), but the reward valuation is genuinely MONEY, and both would be exposed once Stage 2 makes the catalog authoritative. This extension **normalizes the predicate into one shared helper** and applies it to **every** price-multiplying money/fiscal/display seam, so the whole surface is uniformly guarded before the flip — then it's ONE complete money-path deploy.

## 🔴 Type: MONEY-CRITICAL + FISCAL-adjacent (reward valuation → comped factura line). Codex money+fiscal gate. Owner deploys. Build LOCAL-ONLY.

## Base
**EXTEND the existing Stage 1a branch:** worktree `~/Downloads/xpizza-1d1a`, branch `feat/phase1d-stage1a-price-guard` @ `314de7f` (off origin/main e8b43c9). Add commits ON TOP (do not rebase/squash the gated 314de7f). Confirm `git rev-parse HEAD` = 314de7f before starting.

## Change 1 — the shared helper (NEW leaf module `price-valid.js`)
A dependency-free leaf module (so `factura/pricing.js` stays standalone — no menu-pricing dep — and there's zero circular-require risk):
```js
'use strict';
// The ONE price-validity rule for the whole platform: a usable price is a POSITIVE INTEGER lempira
// amount. Zero, negative, NaN, non-integer, or undefined is corrupt/tampered. Every money/fiscal/display
// seam that multiplies a raw table price MUST gate on this — a single source of truth so the rule can
// never drift between the order total, the factura, the reward valuation, and the tracker summary.
function isValidPrice(p) { return Number.isInteger(p) && p > 0; }
module.exports = { isValidPrice };
```

## Change 2 — refactor the 1a calculators to the helper (BEHAVIOR-PRESERVING)
`!isValidPrice(price)` is EXACTLY the 1a inline predicate `!Number.isInteger(price) || price <= 0`. Replace the inline predicate at all 1a sites with `!isValidPrice(...)` — a pure DRY refactor, ZERO behavior change:
- `menu-pricing.js` `computeServerTotal`: `menu[key]`, la_musa `extraPrices[eid]`, x_pizza `extraPrices[ename]` → `if (!isValidPrice(price)) return { total: NaN, error: ... }` (same error strings).
- `factura/pricing.js` `pricedLineItems`: `menuPrices[name]`, `extraPrices[ename]` → `if (!isValidPrice(price)) return { items: null, error: ... }` (same error strings).
- Keep the **LOCKSTEP** comment; update it to point at the shared helper (the rule now literally cannot diverge — one function).

## Change 3 — guard `summaryLines` (menu-pricing.js, the tracker DISPLAY mirror)
`summaryLines` fails open to `null` on any validation miss (its existing convention — the tracker falls back to `items_text`). Add the SAME rule with that convention:
- Before `let lineL = menu[key] * qty;` → `if (!isValidPrice(menu[key])) return null;`
- la_musa extra, before `lineL += extraPrices[eid] * eqty;` → `if (!isValidPrice(extraPrices[eid])) return null;`
- x_pizza extra, before `lineL += extraPrices[ename];` → `if (!isValidPrice(extraPrices[ename])) return null;`
- Keep the "MIRRORS computeServerTotal" comment true — same validation set, `null`-convention.

## Change 4 — guard the REWARD free-item valuation (MONEY — this is the important one)
Replace the LOOSER `Number.isFinite` checks with `isValidPrice` on the LEMPIRA price (before `toCents`/`*100`):
- `rewards-redeem.js` `laMusaPriceCents` (~:42): `return (Number.isFinite(p) && p > 0) ? toCents(p) : null;` → `return isValidPrice(p) ? toCents(p) : null;`
- `rewards-redeem.js` `computeXPizza` (~:56): guard the lempira `unit` BEFORE `toCents` → `if (!isValidPrice(unit)) return { ok: false, reason: 'ineligible_item' };` then `const price_cents = toCents(unit);` (drop the now-redundant `Number.isFinite(price_cents)` check, or keep it as belt — your call, but the primary gate is on `unit`).
- `rewards-redeem-pricing.js` `applyXPizza` (~:52): BEFORE `const unitCents = menu[freeName] * 100;` → `if (!isValidPrice(menu[freeName])) return { ok: false, error: 'bad_free_item' };` (this one guard covers BOTH the `unitCents` (:52) and the `full = ...menu[freeName]*freeQty` (:63) uses — same `menu[freeName]`). The downstream reconciliation invariants (`discount_mismatch`/`reconcile_mismatch`/`discount_reconcile`/`rebaja_invariant`) stay UNCHANGED.

## 🔒 Guards / invariants
- **INERT on current data:** every live price is a positive integer → `isValidPrice` is true everywhere → order totals, facturas, reward valuations, and tracker summaries are byte-identical before/after. The `Number.isFinite → isValidPrice` tightenings are inert (integers are finite). Prove with before/after equality on real carts + real reward redemptions.
- **1a behavior preserved:** the calculator refactor is a pure predicate swap (`!isValidPrice` ≡ the 1a inline) — the entire 1a test suite (`price-value-guard.test.js`, the emulator publish-verify tests) MUST stay green unchanged.
- **Reward valuation is MONEY, fail-closed:** a corrupt free-item price now makes the redemption REJECT (`null` / `{ok:false}`) rather than value a comped factura line off a bad number. Fiscal representation for VALID data is unchanged (the comped-line value is identical for every real reward).
- **Completeness closure:** grep for every remaining raw price multiply (`* 100`, `* qty`, `* eqty`, `menu[`, `extraPrices[`, `Prices[`, `[freeName]`, `[name]`, `[eid]`) across the money/fiscal/reward/factura modules and CONFIRM each is either guarded by `isValidPrice` or derives from an already-guarded value (e.g. `pricedLineItems` output, `orderBreakdownCents` on an already-validated total). List them in the handback so the gate can verify no seam is left.
- **Diff-empty:** resolver `pricing-tables.js`, cache `catalog/catalog.js`, `catalog-publish.js`, `firestore.rules`, both order forms — UNCHANGED.

## Tests
- **`price-valid.test.js`** (NEW): `isValidPrice` truth table — accepts positive integers; rejects `0`, negative, `NaN`, non-integer float, `undefined`, string, `Infinity`.
- **Calculator refactor is behavior-identical:** the existing `price-value-guard.test.js` passes UNCHANGED (or extend it), proving the helper-based predicate == the 1a inline one.
- **summaryLines:** a corrupt menu/extra price (each shape) → `summaryLines(...)` returns `null` for BOTH brands and BOTH extra paths; valid data → summaries byte-identical to before.
- **Reward valuation:** `laMusaPriceCents` → `null` on a non-integer/0/negative price; `computeXPizza` → `{ok:false, reason:'ineligible_item'}`; `applyXPizza` → `{ok:false, error:'bad_free_item'}` on a non-integer/0 free-item price; VALID reward → identical comped-line value + all reconciliation invariants still foot. (Extend `rewards-redeem-pricing.test.js` / `rewards-redeem.test.js` / `reward-preview.test.js`.)
- **Inert regression:** real carts + a real X.Pizza free-pizza redemption + a real La Musa points redemption price/value identically before/after.
- `node --check`; full `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` green (esp. menu-pricing, factura/pricing, rewards-redeem*, reward-preview, catalog emulator suites). Wire `price-valid.test.js` into the `package.json` chain (explicit list — no glob).

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money+FISCAL gate** on the full `e8b43c9..HEAD` (1a + extension together): the calculator refactor is behavior-identical; summaryLines + reward valuation now guarded; reward-valuation fail-closes to reject (money); INERT on current data; fiscal representation unchanged for valid data; **completeness — no remaining unguarded price-multiply**; diff-empty guards hold.
- Deploy (owner, post-gate): the COMPLETE guard, ONE money-path deploy. FF-merge the branch → main (off e8b43c9), then deploy the affected functions from `~/Downloads/xpizza-delivery/xpizza-functions` (menu-pricing.js is shared by createOrder/chargeOnlineOrder/confirmOnlinePayment/quoteRedemption/factura — deploy the money/factura/redemption set or a full `--only functions`; per deploy discipline confirm `main==origin/main` first + gcloud-verify). Prove-in-prod: a real cash order, a real card order, a real X.Pizza free-pizza redemption + factura, and a La Musa points redemption all price/value identically (inert) — and catch the still-pending **la_musa `pricing_catalog_hit`** heartbeat.

## Handback DoD
Branch@SHA (on top of 314de7f); the `price-valid.js` module; the refactor diff (calculators → helper, behavior-identical); the summaryLines + reward-valuation guard diffs; the completeness grep (every raw price-multiply → guarded or derived-from-guarded, listed); the INERT before/after proof (carts + both redemption types); `price-valid.test.js` + extended suites with output; diff-empty proofs (resolver/cache/publish/rules/forms); `node --check` + full suite green.

---
*Relay artifact (advisor→executor). Extension of Stage 1a — one shared price-valid helper applied to EVERY money/fiscal/display price-multiply, closing the completeness gap before the Stage 2 authoritative flip.*
