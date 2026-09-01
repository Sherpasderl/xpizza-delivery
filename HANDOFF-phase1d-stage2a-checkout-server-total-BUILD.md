# BUILD RELAY — Phase 1d Stage 2a: checkout shows the SERVER total before pay (displayed == charged)

**To:** executor session · **From:** advisor. **Why:** the customer's displayed checkout total is CLIENT-computed for a normal order (`redeemAdjustedTotal()` → `calcTotal()`, the sum of client bundle prices). Redemptions already show the server total (`quoteRedemption`); card's PixelPay page shows the server amount; but **cash confirms on the client total**. Today this is invisible (catalog==code==bundle, parity), but **post-2c-flip** a portal edit can make the catalog diverge from the still-deployed bundle — and on a price INCREASE the customer would see the old (lower) price and be charged the new (higher) one. 2a closes that: at the pay step, fetch a **read-only server quote** (priced on the SAME resolver the order uses) and display THAT. **INERT today** (client==server ⇒ same number); load-bearing post-flip. **Fail-open** (a quote outage falls back to the client total — checkout never blocks; the order re-prices authoritatively at order time regardless).

## 🔴 Type: MONEY-adjacent (checkout total DISPLAY + a new pricing-READ endpoint) but NOT authoritative — the order path (createOrder/chargeOnlineOrder) still re-prices; 2a only makes the DISPLAY match. Codex money gate. Build LOCAL-ONLY.

## Base
Fresh worktree off `origin/main @ 6f5ba89` (or the latest main). Branch `feat/phase1d-stage2a-checkout-server-total`. Server = a new endpoint in `index.js`; client = both forms' `__REWARDS_PARITY__` block (byte-identical).

## Server — new `quoteOrder` endpoint (model it on `quoteRedemption`, index.js:5565)
A read-only, no-write, no-reserve server quote for a NON-redemption cart:
```
exports.quoteOrder = onRequest({ region:'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory:'256MiB', maxInstances: 10 }, async (req,res) => {
  POST-only; resolveRestaurantId(body.restaurant_id);
  const tables = await resolvePricingTables(restaurantId);          // SAME source as the order — displayed==charged by construction
  const { total, error } = computeServerTotal(body.items, restaurantId, tables);
  if (error) return res.status(200).json({ ok:false, error });      // fail-SOFT: client falls back to its own total, never blocks
  const bd = orderBreakdownCents(total, restaurantId);              // the SAME breakdown the order charges (total_cents/subtotal_cents/tax_cents)
  return res.status(200).json({ ok:true, total_cents: bd.total_cents, subtotal_cents: bd.subtotal_cents, tax_cents: bd.tax_cents });
});
```
- **Rate-limit it** (public endpoint) — reuse `checkRateLimit` with a dedicated bucket (a per-IP window like the other public endpoints); a quote is cheap but must not be a free amplifier.
- **No auth required** (a quote is not user-specific for a non-redemption cart) — but do NOT trust any client price; it prices only from `resolvePricingTables` + `computeServerTotal` (the 1a value-guard applies).
- **NOT authoritative:** this endpoint writes nothing and reserves nothing; the binding total is still `createOrder`/`chargeOnlineOrder`'s own `computeServerTotal` at order time. `quoteOrder` exists so the customer SEES that number first.

## Client — both forms, in the `__REWARDS_PARITY__` block (keep it byte-identical)
1. **Fetch the server quote at the pay step.** On entering `s2` (x_pizza:2189 "render the order summary on entering the pay step") AND on any cart/pay edit at that step (the existing `renderStage2Summary` hooks at ~1854/1864), if NO redemption is pending, POST the current cart to `quoteOrder` (debounced). Stash the returned `total_cents`.
2. **Prefer the server quote in the displayed total.** Extend the display precedence (the non-redeem branch of `redeemAdjustedTotal()`): redemption quote → **server order-quote** → `calcTotal()` (client). i.e. `getRedeemQuoteTotalCents() ?? getServerQuoteTotalCents() ?? calcTotal()`. Because `redeemAdjustedTotal()` already feeds the Stage-2 summary total, the `pixelpay-amount`, and the cash tender basis, all three then show the SERVER total automatically.
3. **FAIL-OPEN, always.** Any quote failure/timeout/`ok:false`/stale-cart → `getServerQuoteTotalCents()` returns null → display falls back to `calcTotal()` (today's behavior). A quote must NEVER block or delay checkout perceptibly (bound the fetch; don't await it on the critical tap — show client total immediately, then reconcile to the server total when it lands, the same pattern the redemption quote uses).
4. **Staleness:** the quote is keyed to the exact cart it priced; if the cart changed after the quote was requested, ignore the stale response (don't show a total for a different cart). Re-quote on change.

## 🔒 Guards / invariants
- **INERT today:** client total == server total under parity, so the displayed number is unchanged today. Prove with a real cart: `quoteOrder.total_cents` == `orderBreakdownCents(computeServerTotal(cart))` == what `createOrder` would charge.
- **displayed == charged by construction:** `quoteOrder` prices via `resolvePricingTables` + `computeServerTotal` — the SAME functions the order path uses — so the quoted number is exactly what the order will charge (for the same cart + tables version).
- **NOT authoritative / no new trust:** the client still sends no trusted price; the order re-prices. `quoteOrder` writes nothing. A compromised/spoofed quote can only affect DISPLAY, and the order-time re-price is the real charge (unchanged).
- **Parity:** the fetch + the `redeemAdjustedTotal` extension go in the `__REWARDS_PARITY__` block, byte-identical in both forms (the `rewards-parity.guard.test.js` must stay green). The `quoteOrder` URL const + fetch helper are brand-agnostic.
- **Fail-open never blocks checkout** (seamless-UX): a quote outage degrades to today's client-total display; the order still succeeds + charges correctly.
- Money/order path (`createOrder`/`chargeOnlineOrder`/`confirmOnlinePayment`) — UNCHANGED (they already re-price). 2a adds a read endpoint + a display source, nothing on the write path.

## Tests
- **`quoteOrder`**: a cart → `{ok:true, total_cents}` == `orderBreakdownCents(computeServerTotal(cart, rid, resolvePricingTables))`.total_cents (the order-path number); a bad/unknown-item cart → `{ok:false}` (soft); rate-limit enforced.
- **displayed==charged:** for a cart, `quoteOrder.total_cents` equals what `createOrder` computes for the same cart (share a fixture).
- **Fail-open:** quote `ok:false`/network-fail → the client display uses `calcTotal()`; checkout still completes.
- **Precedence:** redemption pending → redemption quote (unchanged); non-redeem + quote present → server quote; non-redeem + quote absent → `calcTotal()`.
- **Parity guard green** (`rewards-parity.guard.test.js`); both forms' parity block byte-identical.
- **Stale-cart:** a quote for cart A, then cart edited to B → the A total is not shown for B.
- `node --check`; wire any new server test into `package.json`; full suite green.

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **codex money gate** (quoteOrder prices on the same resolver as the order [displayed==charged]; writes/reserves nothing; not authoritative [order re-prices]; fail-open never blocks; parity byte-identical; rate-limited; INERT today).
- Deploy (owner, post-gate): functions deploy (the new `quoteOrder`) — a single-fn `--only functions:quoteOrder` is safe (adds a function; verify it doesn't prune — deploy from a full-export checkout) → then git-CD both forms. Prove-in-prod: a real cash order + a real card order show a total identical to today (inert), and that number equals the charged/factura total; a forced quote failure still lets checkout complete on the client total.

## Handback DoD
Branch@SHA; the `quoteOrder` endpoint + its rate-limit; the both-forms parity-block diff (fetch + `redeemAdjustedTotal` precedence + fail-open + stale-cart guard); the displayed==charged test (quote == order-path total, shared fixture); the fail-open + precedence + parity-guard tests with output; the INERT proof; full suite green.

## Context — Stage 2 remaining
2a (THIS) + 2b (snapshotFor ladder) are the two preconditions for **2c (the flip)**. Independent of 2b, so they build in parallel. After both land + prove (and the la_musa heartbeat + RTDB-rules verify), 2c is the small irreversible cutover: wire `snapshotFor`, drop `tablesEqual`, retire `menu-pricing.js`, on a frozen menu.

---
*Relay artifact (advisor→executor). Stage 2a — the checkout server-total quote, INERT today + fail-open, so the flip can make the catalog authoritative without ever charging a customer more than they saw.*
