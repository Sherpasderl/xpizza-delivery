# REVISE — Phase 1b-1b (codex money-grill, 1 blocking): resolvePricingTables must never return null (fail-safe to code, don't drop a redemption order)

**Branch:** `feat/phase1b1b-redemption-cutover` @ f46c61b. Advisor audit PASS + heaviest codex money-grill = **6/6 CONFIRMED (no mispricing, store==compare, fiscal parity, non-vacuity, hard-contract complete, reserve/consume clean); 1 REVISE below.** Fix LOCAL-ONLY → re-verify → light advisor + codex re-gate of the delta.

## The finding (advisor-flagged + codex-CONFIRMED — availability regression, ship-blocker)
`resolvePricingTables` (`index.js:287`) returns **`null`** on a catastrophic resolver failure (its outer `catch`). The order-total path treats `null` as code (fail-safe, proceeds — `computeServerTotal(..., null)` / `summaryLines(..., null)` → code default). But the redemption hard contract (`requireTables`, GRILL-FIX #2) **THROWS on `null`**, so on that same failure a REDEMPTION order is **dropped**:
- Cash redemption: `requireTables` in `computeIncomingFingerprint` (`createorder-classify.js:56`) runs BEFORE its local `try` → the throw propagates out of `index.js:556` → order dropped.
- Reserve: `resolveRedemptionForOrder` throws (`rewards-redeem-intake.js:91`).
- Online: `prepareRedemption` throws (`rewards-redeem-intake.js:47`).
- Quote: catches → 500.

This regresses 1b-1's guarantee ("fail-safe to code on any catalog trouble, NEVER drop an order" — [[no-regression-hard-rule]]). And the drop is **unnecessary**: `null` means the whole-order resolver failed and the order-total already uses code, so redemption on code in the SAME request is consistent — no split-brain (both code). Near-unreachable (getPricingTables is designed never to throw; null only on a cold-start resolver-construction failure) but a real fail-CLOSED-drop where fail-safe-to-code is correct.

## The fix — resolvePricingTables returns a CODE-TAGGED object, never null
`index.js:287` `resolvePricingTables` outer `catch`: instead of `return null`, return the code-tagged fallback (mirror the resolver's own `codeFor` fallback shape so it's identical to a normal code-serve):
```js
async function resolvePricingTables(restaurantId) {
  try { return await pricingResolver().getPricingTables(restaurantId); }
  catch (e) {
    console.error('resolvePricingTables: unexpected', e && e.message);
    try { paymentAlert(getDatabase(), 'pricing_resolver_failed', { restaurantId, error: String(e && e.message).slice(0,200) }); } catch (_) {}   // surface the catastrophic case (best-effort)
    return { restaurantId, menu: MENU_BY_RESTAURANT[restaurantId], extras: EXTRAS_BY_RESTAURANT[restaurantId] || {} };   // code-tagged → requireTables passes → redemption prices on code, order PROCEEDS
  }
}
```
- Now `pricingTables` is ALWAYS a valid restaurant-tagged object (catalog on parity, code otherwise, code on catastrophic). `requireTables` passes → redemption prices on code (consistent with the order-total) → **order proceeds, never dropped.**
- **Do NOT weaken `requireTables`** — it MUST still throw on `null`/`undefined`. A genuine MISSED THREAD (a seam a future edit forgets to pass tables to) passes `undefined` → still throws loudly (the contract's purpose). This fix removes the ONLY legitimate source of null (the fail-safe), so the only remaining null/undefined at a seam IS a bug — exactly what the contract should catch.
- The alarm (`pricing_resolver_failed`, distinct from the resolver's `catalog_read_*`) surfaces the catastrophic case in the prove-in-prod window; best-effort (never breaks pricing). Optional but recommended.
- The fallback shape MUST equal the resolver's `codeFor(rid)` code-serve (`{restaurantId, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid]}`) so a code-tagged-catastrophic and a code-tagged-parity-fallback are indistinguishable downstream.

## Test to add
- `resolvePricingTables` (or a unit around it): force `getPricingTables` to THROW → `resolvePricingTables` returns a code-tagged `{restaurantId, menu, extras}` (NOT null); a redemption order under it prices on code and PROCEEDS (no throw, no drop). Prove a cash redemption's `computeIncomingFingerprint` does NOT throw when the resolver catastrophically fails.
- Regression: a genuine missed thread (call a production seam with `undefined` tables) STILL throws `pricing_tables_required` (the contract intact).
- Existing 1228 + PIN-E 8/8 + rewards-catalog-cutover sentinels stay green; full `npm test` EXIT 0.

## Unchanged / do NOT touch
Everything else is codex-CONFIRMED: the 5 cuts, the 4 seams, GRILL-FIX #1 (same-object threading, store==compare), PIN B, the fiscal parity (redeemed factura table-fed + non-redeem untouched), the non-vacuity sentinels, reserve/consume. `requireTables` stays strict.

## Also (non-blocking, owner-noted)
Dead `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` imports now remain in 3 redemption files (left per additive/no-prune DoD). NOTE: this REVISE's fix RE-USES `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` in index.js (the code-tagged fallback) — but those specific dead imports are in the rewards-*.js files, not index.js. Leave the rewards-file dead imports for a 1d cleanup (harmless); codex may flag — that's expected.

## Gate
Re-run → handback the `f46c61b..<new>` delta (resolvePricingTables + 1-2 tests) for a light advisor + codex re-verify. Deploy posture unchanged: scoped createOrder + chargeOnlineOrder + quoteRedemption, manual emulator money-proof, prove-in-prod before 1b-2.
