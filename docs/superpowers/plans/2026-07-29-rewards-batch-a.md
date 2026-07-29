# Rewards Batch A — Redemption Correctness + Payment-Page Order Summary (build plan · R2)

_Executor build plan for advisor **re-gate** (R1 plan-gate → REVISE, 8 findings; all addressed below with cited file:line). Off `main` (`f6cfee0` — has B + polish-r2). Functions + forms. A1 + Factura are money-gated; the rest codex-on-diff. **No code until this clears.**_

## Why this batch exists
Redemption (B1 + B2) is live-inert on main, mid-**canary**; money spine proven intact via RTDB inspection. The **atomic go-live flip is HELD** until Batch A lands. Batch A = the free-$0-checkout money-path state (A1), the factura comp representation (A-F), and the display/edge fixes (A2–A6). After gated + re-merged → **re-canary** → **then flip**.

## Invariants (all tasks)
- **Server-authoritative money**: every displayed discounted total comes from the server (live quote `redeemAdjustedTotal()`→`getRedeemQuoteTotalCents()` while the quote is in memory; the **persisted server total** on the online-return path — see A2/#6). Never client-computed.
- **Recovery-visible, not atomic** (was "all-or-nothing" — reframed per #5): the redemption lifecycle is a state machine where every exception either **releases the hold before the order is written**, or leaves the reservation in a **recovery-visible** state that the sweep consumes/releases. No silent stuck or full-price-charge state.
- **Guest byte-identical**; `account.js` **byte-identical past CONFIG** (parity guard green every SHA).
- Build ON TOP of main (has B).

## Sequencing / gates
1. **Functions, money-gated first:** **A1** (free_checkout state) + **A-F** (factura comp representation) — these two are the money core and share the redeemed-order confirm/factura path; gate together or A-F→A1.
2. **A4** (functions, items_text — code-gate).
3. **Forms:** the shared **online-return persistence** (#6 infra) → **A2** + **A5** → **A3** → **A6**. Each codex-on-diff.
4. Ships **inert**. Deploy = functions + forms → **re-canary** (owner uid): $0-online, sub-min→cash, scheduled-$0, factura comp line, all display surfaces, items_text → **THEN atomic flip**.

---

## A1 — free_checkout as a first-class state  [MONEY-GATE]  · addresses #1, #2, #3, #5

**Problem (canary):** a redemption that zeroes the online total can't open a PixelPay checkout (can't charge L0) → "checkout not created" → stuck.

**The state machine (#5 — recovery-visible, not atomic).** In `chargeOnlineOrder`, redemption flows:
1. **reserve** (debit → `reserved`, keyed order_id) — BEFORE placement. Reserve fails → 409 non-payable, no order (release-not-needed, nothing reserved).
2. **reprice** → branch on discounted `total_cents`:
   - **`=== 0`** → **free_checkout**: place a `$0 confirmed` online order stamped **`free_checkout:true`** (+ `payment_status:'confirmed'`, `payment_method:'online'`, amount 0, `o.redemption` set) — **no PixelPay attempt**.
   - **`0 < total < PIXELPAY_MIN`** → **cash fallback**: release the online reserve, return a typed `sub_minimum_online → pay_cash` so the client re-submits as cash on the discounted remainder (cash has its own reserve path).
   - **`>= PIXELPAY_MIN`** → unchanged PixelPay charge on the discounted total.
   Placement failure BEFORE the order row is written → **release the hold** (release-pre-order).
3. **consume (best-effort)** — a `$0 free_checkout` order is confirmed at placement (no pending payment), so **consume the reservation AT PLACEMENT** (immediate AND scheduled — a $0 order has no materialization-payment step). Consume-write failure → order stays confirmed (free), reservation stays `reserved` but **recovery-visible**.
4. **recovery-sweep** — `sweepConsumeRecovery` gains a predicate so a missed $0 consume is recovered: **`confirmed && free_checkout && reserved` → consume** (this covers scheduled-$0 too — see #3). Cancel-before-materialize → existing `cancelOrderCore` clawback reverses (unchanged).

**#1 — reconciler.** A `$0 confirmed` order with no PixelPay would be flagged `confirmed_without_verified_payment` by `reconcilePayments` (`index.js:1676`). FIX: stamp **`free_checkout:true`** on the order, and extend the breach check to **skip when `free_checkout === true && total_cents === 0`** (i.e. "confirmed without a PixelPay charge is legitimate ONLY for a zero-total free_checkout"). Any non-zero confirmed-without-payment still breaches.

**#2 — read ordering.** PixelPay config + return-URL are resolved BEFORE repricing today (`index.js:799`, via `resolvePixelPayConfig`/`resolveReturnBase`). FIX: **move those reads BELOW the `$0`/`sub-min` branches** so they're resolved ONLY on the `>= PIXELPAY_MIN` charge path (a $0/sub-min order never touches PixelPay config).

**#3 — scheduled-$0 (HANDLED, not carved).** `consumeEligible` excludes `scheduled` (`rewards-reserve.js:288/295`), so a scheduled-$0 reservation would be neither consumed nor recovery-visible. FIX (per advisor's option A): **consume-at-placement for $0 free_checkout applies to scheduled too** (step 3 above), and the recovery predicate is **`confirmed && free_checkout && reserved`** (NOT gated on `consumeEligible`, so it catches scheduled). Result: scheduled-$0 consumes at placement + is recovery-visible; cancel-before-materialize → clawback. _(Fallback if the advisor prefers a smaller v1: reject a scheduled order that reprices to exactly $0 with a typed message and defer — but the handled path above is cleaner UX and is the recommendation.)_

**Files:** `xpizza-functions/index.js` (`chargeOnlineOrder` branch + read-ordering + `reconcilePayments:1676`), `rewards-reserve.js` (`sweepConsumeRecovery` predicate + consume-at-placement helper), `rewards-redeem.js`/intake (consume at $0).
**Verification (emulator):** $0-online → confirmed + `free_checkout:true` + reserved→consumed + **no PixelPay call** + reconciler no-breach; sub-min → online reserve released + `pay_cash` typed; scheduled-$0 → consume-at-placement + recovery predicate catches a forced missed-consume; failure pre-order → hold released; idempotent re-submit; cancel-$0 → clawback reverses. Normal-discount online unchanged.
**Gate:** money-gate.

## A-F — Factura: comp representation (full-value items + explicit rebaja)  [MONEY-GATE]  · addresses #4

**Problem/decision (advisor #4, owner-confirmed SAR reading).** Do **NOT** skip the factura on redeemed orders. The X. Pizza **platform** factura for **all** redeemed orders shows **full-value items + an explicit "Desc. y Reb. Otorg" line** for the comped value (comped Margherita → **-L299**).
- Per SAR ("descuentos efectivos que consten en la Factura no forman parte de la base gravable"): the discount **leaves the base gravable** → **ISV computes on the net**; the comped portion's ISV = **L0**. **Total = the paid amount.** A fully-comped order → **base 0 / ISV 0 / total 0**, and the factura **still issues** (records the item for inventory + the comp value for accounting/audit).
- This **changes B1's factura representation**: today the discount is baked into 0-price lines with `desc_rebaja_cents:0`; now → **full-value line items + an explicit rebaja line** (`desc_rebaja` = comped value), preserving the golden **ISV identity** (`subtotal + tax === total`, all footing on the *net* base).
- **La Musa unchanged** — Soft Restaurant POS owns its fiscal doc; the comp is recorded in the rewards ledger + order record for reconciliation, not the platform factura.

**Files:** `xpizza-functions/buildFacturaRecord` + `rewards-redeem-pricing.js` (the X. Pizza `discount` model — emit full-value lines + `desc_rebaja` instead of the 0-base split).
**Verification (golden/unit):** redeemed X. Pizza factura = full-value items + `desc_rebaja` = comped value, base gravable = net, ISV on net, comped ISV 0, `subtotal+tax===total`; fully-comped → 0/0/0 and issues; La Musa `factura_items:null` unchanged; non-redeem factura byte-identical. Reconcile with `orderBreakdownCents`.
**Gate:** money-gate (factura money-math).

## A4 — reconstruct `items_text` for the freed/added item  [functions · code-gate]

**Problem:** `items_text` (KDS/driver/WhatsApp) shows the freed item at full price on a redeemed order ([[items-text-pricing-decoupling]]).
**Fix:** server-reconstruct `items_text` from the priced `items[]` + redemption result at intake so the freed unit reads free (X. Pizza) / the added 0-price tier item is reflected (La Musa). Narrow to the redemption case; non-redeem byte-identical.
**Files:** `xpizza-functions/index.js` (intake where `items_text` is built) + `rewards-redeem-pricing.js`.
**Verification:** redeemed order `items_text` reflects the freed/added item; non-redeem unchanged (guard).
**Gate:** code-gate (money-adjacent).

## #6 — online-return persistence  (shared infra for A2 + A5)

**Problem (advisor #6):** after the PixelPay redirect+return the in-memory `_redeemQuote` is gone; the success screen rebuilds `currentOrder` from `stashedOrder` (client full total, `index.html:2556–2587`), so `redeemAdjustedTotal()` can't work post-return, and detection uses `!!o.redeem` (`index.html:2945`) — but the **server stamps `o.redemption`, not `o.redeem`**.
**Fix (foundation A2/A5 build on):**
1. **Persist the server quote** (`total_cents`, `discount_cents`, `free_item`) into the **stashed order** (`xpizza_pending_pay`) BEFORE the PixelPay redirect — OR read them back from the server-confirmed order / `paymentStatus` poll on return. Recommendation: stash the quote summary at redirect **and** prefer the server-confirmed order's `total_cents`/`redemption` on return (server wins).
2. **Detection:** everywhere the success/earn path tests redemption, use **`o.redemption || o.redeem`** (server stamps `o.redemption`).
**Files:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (stash-at-redirect + return path 2556–2587; detection at 2945).

## A2 — success-screen Total shows the server discounted total  [forms · display]  · addresses #6

**Fix:** on a redeemed order, the success receipt Total = the **server** total: same-session (cash / no redirect) → `redeemAdjustedTotal()` (quote live); online-return → the **persisted server total** from #6 (never the client `o.total` full price). Non-redeem unchanged.
**Files:** `showSuccess()` receipt total, both forms.
**Verification:** redeemed success (both cash same-session AND online-after-return) shows discounted/L0 total; guest/non-redeem unchanged.
**Gate:** code-gate (display).

## A5 — success earn badge subtracts the freed unit  [forms · display]  · addresses #6

**Fix:** the server earn is already correct (`rewards-earn.js:57` `earnDelta = model==='discount'?max(0,delta-1):delta`); align the **client badge estimate** only. In `renderSuccessRewards`, detect **`o.redemption || o.redeem`** (#6) and, for a `discount`-model redeemed order, subtract the freed unit (X. Pizza `pizzaCount-1`; La Musa `add_free` unchanged). Uses the persisted `o.redemption` model/free-item.
**Files:** `account.js` `renderSuccessRewards` (byte-identical) + the `index.html` env (`redeemed` ← `o.redemption||o.redeem`).
**Verification:** redeemed X. Pizza badge = earn minus freed pizza (cash + online-return); La Musa unchanged; non-redeem unchanged.
**Gate:** code-gate (display).

## A3 — cash: discounted change AND cash_tendered submit guard  [forms · display + client seam]  · addresses #7

**Problem (advisor #7):** `buildOrder` only submits `cash_tendered` when `ct >= calcTotal()` (full price) (`index.html:2456`), so a tender that's valid against the **discounted** total is dropped → the server defaults to exact and the customer's stated change is wrong.
**Fix:** route BOTH (a) the displayed vuelto/change AND (b) the **`cash_tendered` submit guard** through `redeemAdjustedTotal()` (the discounted total) — `if (isFinite(ct) && ct >= redeemAdjustedTotal()) currentOrder.cash_tendered = ct`. (Server still re-validates `cash_tendered >= server total`.)
**Files:** `index.html` `buildOrder` (2456) + the vuelto display, both forms.
**Verification:** redeemed cash order — a tender ≥ discounted total is submitted + change computed on the discounted total; non-redeem unchanged; server re-validation intact.
**Gate:** code-gate (display + client submit seam; server authoritative).

## A6 — dedicated Stage-2 order-summary renderer  [forms · display]  · addresses #8

**Problem:** Stage 2 has no order summary; redemption shows only in `#acct-redeem`. Owner wants mockup screen-5 ("Resumen del pedido" with the discount line).
**Fix (advisor #8):** add a **dedicated Stage-2 summary renderer** (or a parameterized `updateReview` variant) that sources the **server-quote total + discount line** — items + Envío + (redeeming) a struck-through **GRATIS** line + the server discounted total. Header "Resumen del pedido" (match success). **Leave the cart pillbox / `updateCartReviewBody` untouched** (do NOT overload the cart-review machinery). Both brands.
**Files:** `index.html` (new Stage-2 summary block + renderer) + `account.js` (redemption discount line from the server quote).
**Verification:** Stage 2 shows the summary on all orders; redeemed → GRATIS line + server discounted total; guest/non-redeem → normal summary, no discount line; cart pillbox flow unchanged (no regression).
**Gate:** code-gate (display-only).

---

## R1 findings → resolution map (for the re-gate)
| # | Finding (cited) | Task | Resolution |
|---|---|---|---|
| 1 | `reconcilePayments` flags $0-no-PixelPay (`index.js:1676`) | A1 | `free_checkout:true` marker + breach skip when `free_checkout && total_cents===0` |
| 2 | PixelPay config/return read before repricing (`index.js:799`) | A1 | move reads BELOW the $0/sub-min branches (charge path only) |
| 3 | scheduled-$0 not recoverable (`rewards-reserve.js:288/295`) | A1 | HANDLED: consume-at-placement for $0 (incl. scheduled) + recovery predicate `confirmed && free_checkout && reserved` (carve-out offered as fallback) |
| 4 | factura must issue reflecting the comp (SAR) | A-F | full-value items + explicit `desc_rebaja` line, ISV on net, comped ISV 0, issues at 0/0/0; La Musa unchanged; money-gate |
| 5 | reframe all-or-nothing | A1 | explicit state machine, **recovery-visible not atomic**; every exception releases-pre-order or is recovery-visible |
| 6 | online-return: quote gone, `o.redeem` vs `o.redemption` (`index.html:2556–2587,2945`) | #6/A2/A5 | persist server quote into stashed order (+ server-confirmed wins on return); detect `o.redemption || o.redeem` |
| 7 | `cash_tendered` guard uses full `calcTotal()` (`index.html:2456`) | A3 | fix BOTH displayed change AND the submit guard to `redeemAdjustedTotal()` |
| 8 | A6 renderer | A6 | dedicated Stage-2 renderer from server quote; leave cart pillbox/`updateCartReviewBody` untouched |

**Confirmed sound (advisor, no change):** `redeemAdjustedTotal`/`getRedeemQuoteTotalCents` correct while the quote is live; quote endpoint runs the same pricing; server earn already subtracts the freed unit (A5 = client alignment only, once `o.redemption` detection is fixed).

## Deploy & go-live
Functions (A1, A-F, A4) + forms (A2/A3/A5/A6) → **inert** → **re-canary** (owner uid): $0-online, sub-min→cash, scheduled-$0, factura comp line, items_text, all display surfaces → verified vs prod → **atomic flip** `{config/redemption_enabled:true, config/rewards_public/redemption_live:true}`.

## Handoff
Advisor re-gates THIS plan. On approval → executor builds task-by-task on `feat/rewards-batch-a` off `main`, functions-first (A1+A-F money-gated, A4), then forms, parity-green, byte-identical past CONFIG. Related: [[rewards-loyalty-program]], [[items-text-pricing-decoupling]], [[factura-integration]].
