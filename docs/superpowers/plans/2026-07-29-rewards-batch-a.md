# Rewards Batch A — Redemption Correctness + Payment-Page Order Summary (build plan)

_Executor build plan for advisor plan-gate. Off `main` (`f6cfee0` — has B: hero/glass-chip header, Mis premios panes, La Musa ~10% tier retune, polish-r2). Forms + two functions fixes. A1 needs a DESIGN-gate first; the rest are codex-on-diff / money-gated per SHA._

## Why this batch exists
Redemption (B1 money-path + B2 UI) is LIVE-INERT on main and mid-**canary** (owner uid allowlisted). The **atomic go-live flip is HELD** until Batch A lands. The canary proved the money spine intact (reserve/consume/release correct via RTDB inspection) but surfaced a fix cluster: one real 0-total-online money-path gap (A1) + display/edge errors (A2–A5) + a missing payment-page order summary (A6). After Batch A is gated + re-merged → **re-canary** the 0-total-online path + display surfaces → **THEN** the atomic flip (`config/redemption_enabled` + `config/rewards_public/redemption_live` = true).

## Invariants (all tasks)
- **Server-authoritative money**: every displayed discounted total comes from the server quote (`redeemAdjustedTotal()` → `getRedeemQuoteTotalCents()`), NEVER client-computed. A2/A3/A5/A6 are display-only.
- **All-or-nothing** (B1): any redemption failure → non-payable / release the hold, never a silent stuck or full-price checkout. A1 must preserve this.
- **Guest byte-identical**: guests send no `body.redeem`, see no discount lines, get the normal summary.
- `account.js` **byte-identical past CONFIG** — `rewards-parity.guard.test.js` green every SHA.
- Build ON TOP of main (has B) to avoid `account.js`/`index.html` conflicts.

## Sequencing / gates
1. **A1 DESIGN-GATE first** — money-path (place a confirmed order without a PixelPay charge). Design A articulated below; advisor design-gates it before A1 is built.
2. Build task-by-task, **functions first then forms** (so the forms can rely on the corrected server behavior):
   - **A1** (functions, MONEY-GATE) → **A4** (functions, money-adjacent) → **A2 / A3 / A5** (forms, display) → **A6** (forms, display).
3. Advisor codex-gates each SHA. Flip stays HELD until all gated + re-merged + re-canaried.

---

## A1 — 0-total online → free-checkout bypass  [MONEY-PATH · design-gate + money-gate]

**Problem (canary):** when a redemption zeroes the online order total (La Musa free item is the whole order; X. Pizza free pizza is the only item), the online path can't open a PixelPay checkout (PixelPay can't charge L0) → **"checkout not created"** → customer stuck. Money was otherwise correct (reserve happened); this is a real placement gap.

**Design A (owner-approved; for the advisor's design-gate):**
- In the online-charge path (`chargeOnlineOrder`), AFTER server re-pricing with the redemption, branch on the discounted `total_cents`:
  - **`total_cents === 0`** → **free-checkout bypass**: skip PixelPay entirely; place the order as a **$0 CONFIRMED** order (`payment_status:'confirmed'`, `payment_method:'online'`, amount 0), **consume** the redemption reservation, build the factura for a L0 doc (confirm SAR handling of a 0-total fiscal doc — likely a valid L0 line or a defined carve-out), and fire the confirmed-order pipeline (KDS / driver / WhatsApp) exactly as a paid online order.
  - **`0 < total_cents < PIXELPAY_MIN`** (PixelPay rejects sub-minimum charges) → **cash fallback**: the discounted remainder is collected at delivery as cash (steer the customer to cash with a typed message), rather than a failed online charge. [design-gate: confirm the exact PixelPay minimum + the fallback UX.]
  - **`total_cents ≥ PIXELPAY_MIN`** → unchanged (normal online charge on the discounted total).
- **All-or-nothing preserved**: the reservation consume must be bound to the $0 order placement; any failure → release the hold + non-payable, never a stuck confirmed-but-unconsumed state. Idempotent vs retries (order_id-keyed, like the existing consume).

**Files:** `xpizza-functions/index.js` (`chargeOnlineOrder`), `rewards-reserve.js`/`rewards-redeem.js` (consume at $0), `buildFacturaRecord` (L0 doc).
**Verification (emulator + unit):** $0 online redemption → confirmed order + `reserved→consumed` + factura + **no PixelPay call**; sub-min → cash fallback; failure mid-flow → hold released, non-payable; idempotent re-submit. Non-redeem + normal-discount online unchanged.
**Gate:** DESIGN-gate (design A) → then BUILD **money-gate**.

## A4 — reconstruct `items_text` for the freed/added item  [functions · money-adjacent]

**Problem:** `items_text` (read by KDS / driver / WhatsApp) still shows the freed item at full price — e.g. `1x Margherita (L299)` on a redeemed free order — because it's built from the client cart, not reconstructed from the priced redemption ([[items-text-pricing-decoupling]]). Staff see the wrong price/line.

**Fix:** server-reconstruct `items_text` from the priced `items[]` + the redemption result at intake, so the freed unit reads as free (X. Pizza freed pizza → 0 / "GRATIS") and the La Musa added 0-price tier item is reflected. Server-authoritative; the kitchen/driver see the truth. (Narrow to the redemption case; non-redeem `items_text` byte-identical.)
**Files:** `xpizza-functions/index.js` (`createOrder` + `chargeOnlineOrder` intake where `items_text` is built/stored) + the redemption pricing module (`rewards-redeem-pricing.js`).
**Verification:** unit/emulator — a redeemed order's stored `items_text` reflects the freed/added item; a non-redeem order's `items_text` is unchanged (guard).
**Gate:** code-gate (touches intake → money-adjacent, careful).

## A2 — success-screen Total shows the server discounted total  [forms · display]

**Problem:** the success receipt "Total" renders `o.total` (client `calcTotal()` full price), not the server-charged discounted / L0 total.
**Fix:** on a redeemed order, show the **server** total on the success receipt — route through `redeemAdjustedTotal()` / the cached quote total (the same T4-R1 pattern already used for `#pixelpay-amount`). Non-redeem shows `o.total` as today.
**Files:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (`showSuccess()` receipt total).
**Verification:** redeemed success screen shows the discounted/L0 total; guest/non-redeem unchanged.
**Gate:** code-gate (display-only).

## A3 — cash vuelto/change off the discounted total  [forms · display]

**Problem:** the cash "vuelto" (expected change) is computed off the full price, not the discounted total → wrong change shown.
**Fix:** route the cash vuelto/change calc through `redeemAdjustedTotal()` (server discounted total) at its sites. Same class as A2.
**Files:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (cash vuelto/change).
**Verification:** redeemed cash order vuelto uses the discounted total; non-redeem unchanged.
**Gate:** code-gate (display).

## A5 — success earn badge subtracts the freed unit  [forms · display]

**Problem:** the success earn badge shows `+1 sello` without subtracting the freed unit. The **server earn is already correct** (`rewards-earn.js:57` → `earnDelta = redemption.model==='discount' ? max(0, delta-1) : delta`); only the **client badge estimate** over-states.
**Fix:** in `renderSuccessRewards()`'s earn estimate, subtract the freed unit for a redeemed **discount-model** order (X. Pizza: `pizzaCount - 1`; La Musa `add_free`: unchanged — the free item is 0-price, absent from subtotal), mirroring the server `earnDelta`. `index.html` already passes `redeemed` + `pizzaCount` to the env.
**Files:** `xpizza-orders/account.js` + `la-musa-orders/account.js` (byte-identical `renderSuccessRewards`).
**Verification:** redeemed X. Pizza success badge = earn minus the freed pizza; La Musa unchanged; non-redeem unchanged.
**Gate:** code-gate (display).

## A6 — payment-page order summary on ALL orders  [forms · build-gate]

**Problem:** Stage 2 (payment) has **no order summary** — redemption shows only in the `#acct-redeem` widget; the cart pillbox + collapsible review both show full `calcTotal`, no discount line. (Owner caught that mockup screen-5 "REVISIÓN · DESCUENTO" was never built.)
**Fix:** add a payment-page **ORDER SUMMARY** above the payment methods on Stage 2, on **all** orders (DoorDash/UberEats pattern): header **"Resumen del pedido"** (match the success screen), items + **Envío** + (when redeeming) a struck-through **GRATIS** discount line (X. Pizza freed pizza / La Musa 0-price tier item) + the **server-quoted** discounted total (`redeemAdjustedTotal`, never client-computed). Reuse the `updateReview` / `.review-item` machinery; consolidate the old collapsible review. Both brands.
**Files:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (Stage 2 markup + `updateReview`); `account.js` for the redemption discount line (server quote).
**Verification:** Stage 2 shows the summary on every order; redeemed orders show the GRATIS line + server discounted total; guest/non-redeem shows the normal summary (no discount line); money-safe (display-only, discount from server quote).
**Gate:** code-gate (display-only; no separate design-gate — server total, display only).

---

## Deploy & go-live (owner-executed, post-gate)
- **Functions** (A1, A4) `firebase deploy --only functions` (both driver+payment, complete env, no-prune, verify export count) **+ forms** (git-CD). Ships **INERT** (redemption still gated OFF).
- After Batch A gated + re-merged → **RE-CANARY** (owner uid): the 0-total-online free-checkout (A1) + all display surfaces (A2/A3/A5/A6) + `items_text` (A4) → verified vs prod → **THEN the atomic flip** `{ config/redemption_enabled:true, config/rewards_public/redemption_live:true }`.

## Handoff
Advisor **design-gates A1 (design A)** first, then codex-gates each build SHA. Executor builds task-by-task on a `feat/rewards-batch-a` branch off `main`, functions-then-forms, parity-green, byte-identical past CONFIG. Related: [[rewards-loyalty-program]] (canary + held flip), [[items-text-pricing-decoupling]] (A4), the T4-R1 `redeemAdjustedTotal` plumbing (A2/A3/A6).
