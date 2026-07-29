# Rewards Batch A — Redemption Correctness + Payment-Page Order Summary (build plan · R7 · APPROVED — BUILD REFERENCE)

_**Plan-gate APPROVED** (R1→8 → R2 6/8 → R3 core VALIDATED → R4 5 → R5 2 → R6 mechanical → **R7 text-only fix, no re-gate**: A1 `chargeOnlineOrder` config reads go after the $0 guard but BEFORE any write, so a payable order proves PixelPay signable before opening a hosted attempt — R6 had config after reserve/acquire, corrected). Off `main` (`f6cfee0`). A1 + Factura money-gated. **Now building task-by-task on `feat/rewards-batch-a`; advisor code-gates each SHA; advisor verifies the real A1 ordering at the A1 code-gate.**_

**Confirmed clean / validated — DO NOT re-touch:** A-F factura (#3/#4), #5 (`paymentStatus` poll-token-gated summary), the scheduled-$0 `createOrder` lifecycle, #7 (cash change + guard), #8 (Stage-2 renderer). Earlier #2/#5 remain resolved.

## Why this batch exists
Redemption (B1 + B2) is live-inert on main, mid-**canary**; money spine proven intact via RTDB inspection. The **atomic go-live flip is HELD** until Batch A lands. Batch A = the free-$0-checkout money-path state (A1), the factura comp representation (A-F), and the display/edge fixes (A2–A6). After gated + re-merged → **re-canary** → **then flip**.

## Invariants (all tasks)
- **Server-authoritative money**: every displayed discounted total comes from the server (live quote `redeemAdjustedTotal()`→`getRedeemQuoteTotalCents()` while the quote is in memory; the **persisted server total** on the online-return path — see A2/#6). Never client-computed.
- **Recovery-visible, not atomic** (was "all-or-nothing" — reframed per #5): the redemption lifecycle is a state machine where every exception either **releases the hold before the order is written**, or leaves the reservation in a **recovery-visible** state that the sweep consumes/releases. No silent stuck or full-price-charge state.
- **Guest byte-identical**; `account.js` **byte-identical past CONFIG** (parity guard green every SHA).
- Build ON TOP of main (has B).

## Sequencing / gates
1. **Money-gated core:** **A-F** (factura comp representation, functions) + **A1** (`createOrder` $0 intake guard + forms payment-availability/free-submit). Gate together or A-F→A1.
2. **A4** (functions, items_text — code-gate).
3. **#6 online-return infra** — the `paymentStatus` poll-token-gated summary (functions, code-gate) + the forms stash/read → then **A2** + **A5** → **A3** → **A6** (forms). Each codex-on-diff.
4. Ships **inert**. Deploy = functions + forms → **re-canary** (owner uid): $0-order-via-createOrder, sub-min→cash-only, scheduled-$0 (held→consume), factura gross+rebaja line, all display surfaces, items_text → **THEN atomic flip**.

---

## A1 — $0 order via `createOrder` (total-driven payment availability)  [MONEY-GATE]  · PIVOT, supersedes #1/#2/#3

**Problem (canary):** a redemption that zeroes the online total can't open a PixelPay checkout (can't charge L0) → "checkout not created."

**Pivot (owner-directed, R3):** don't force the $0 order through the online charge path at all. The canary already proved the **`createOrder` (cash) path places a $0 order correctly** (reserved, scheduled→held). Route $0 there and skip `chargeOnlineOrder` entirely. This drops ALL of the R2 online-$0 surface — the `free_checkout` online state, the `reconcilePayments` breach edit (#1), the PixelPay read-reordering (#2), the new `sweepConsumeRecovery` predicate (#3), and the codex-flagged new $0-online forms handler (`index.html:2526`).

**Design — total-driven payment-method availability** (client reads the server quote):
- **server total `=== 0`** → grey out BOTH payment methods, show **"Confirmar pedido gratis"**, submit to **`createOrder`** as **`payment_method:'cash' + free_order:true`** (#1 — R4). `free` is NOT a valid method: `ALLOWED_PAYMENT_METHODS = ['cash','card_delivery','online']` and anything else is blanked (`index.js:231/309`), and no consumer (forms/factura/driver labels) knows `free`. So **reuse the `cash` enum + a `free_order:true` flag** that drives the behavior. **No PixelPay, no `chargeOnlineOrder`.**
- **`0 < total < PIXELPAY_MIN`** (rare / likely unreachable) → grey out **online**, cash only.
- **total `>= PIXELPAY_MIN`** → both methods, unchanged.

**The `free_order` flag — persist + honor on EVERY cash consumer (R5 · #1 · the driver seam).** A `$0` order marked `cash` avoids cash-owed (total 0) but, because the driver's cash surfaces key ONLY on `payment_method==='cash'`, it renders as a **phantom cash order** — an "A COBRAR L0" card, a vuelto widget, and a +1 in the cuadre count. So the flag must be persisted AND honored:
- **Persist `free_order:true` on the ORDER and the driver TASKS.** `createOrder` writes both for immediate orders; **`materialize.js` must copy `order.free_order` onto the RELEASED scheduled delivery tasks** (`materialize.js:61+` — a scheduled order's tasks are built at materialization, not at create, so without this the scheduled-free path leaks a phantom "A COBRAR L0" onto the driver). Add a **scheduled-free test**.
- **Driver app** (`xpizza-driver`, separate Capacitor app / own release): at every cash surface that keys on `payment_method==='cash'` — active-card "A COBRAR" + vuelto (`index.html:2282`), queue-card cash render (`index.html:2518`), and `computeShiftCash`'s order filter (`cash-helpers.js:52`) — add a **`&& !order.free_order`** exclusion so `free_order:true` is NOT cash-collection: **suppress the vuelto**, label **"Nada que cobrar,"** and **exclude it from the cash counts / cuadre**. **Keep `isCashPayment(pm)` (`cash-helpers.js:41`) BYTE-IDENTICAL** (it's the standing cross-repo invariant with POS/dispatch — [[pos-premium-cierre]]); the `free_order` exclusion lives at the call sites + `computeShiftCash`'s filter, NOT inside `isCashPayment`. Update `cash-helpers.test.js`. _(This is why the marker is `cash + free_order`, not a `free` enum: the driver surfaces must honor the flag — a bare `free` method would just blank/mislabel.)_
- **Factura** comp path (A-F) keys on redemption/`free_order`; **accounting/reconcile** reads the flag. Cash's `cash_tendered`/vuelto is a no-op at total 0.

**#2 — `chargeOnlineOrder` gate ordering (R7 — exact safe sequence).** A post-reprice `$0` guard alone fires too late: PixelPay config + return-base are read BEFORE repricing (`index.js:~799` `resolvePixelPayConfig` / `~812` `resolveReturnBase`; reprice `:843`), so a stale/direct `$0` request 500s on the config read first. FIX — reorder `chargeOnlineOrder` to exactly:
1. **auth / validate / uid**
2. **reprice** (redemption)
3. **`$0` / sub-min → typed non-payable / free-path response** (return here — before any config read OR write)
4. **non-PixelPay gates** (identity / availability / schedule / zone / rate-limit)
5. **PixelPay config / return-base reads** (`resolvePixelPayConfig` / `resolveReturnBase`, moved from `~799/812`) — **fail-fast BEFORE any write** (preserves the "never open an attempt we can't sign" invariant)
6. **reserve / acquire** (`:1060/1138/1170`)
7. **charge**

So the `$0`/sub-min response is reached before any config read/reserve/acquire (a free order never touches PixelPay config), AND on the payable path the config is proven signable BEFORE the reserve + hosted attempt (config after the $0 guard, but before any write). R6 had config after reserve/acquire — corrected in R7.

**Money-safety (preserve all-or-nothing / #5 — recovery-visible):** the grey-out is **optimistic** (client reads the quote). **`createOrder` re-prices server-side** and, if the total isn't actually 0 (stale quote / reward invalidated), **rejects and the forms re-enable payment** — never silently places a `> 0` order without payment.

**Lifecycle (reuse the proven cash path — codex-VALIDATED):** reserve at `createOrder` → (scheduled → **held**; release only materializes, no consume) → **consume at completion**; cancel-before-release **reverses via `reverseRedemptionForOrder`** (`cancel-order-core.js:181`, disposition `refund`, idempotent by `reverse_${orderId}`). **No new free_checkout online state, no reconciler extension, no new recovery predicate.**

**Files:**
- **Forms** (`xpizza-orders/index.html` + `la-musa-orders/index.html`): `selectPay`/`processPayment` availability + cash+`free_order:true` submit routing.
- **`xpizza-functions/index.js`**: `createOrder` intake (accept `free_order:true`, persist on the order AND tasks, $0 re-price guard); `chargeOnlineOrder` — **reorder to the exact safe sequence** (#2/R7: auth/validate/uid → reprice → $0/sub-min return → non-PixelPay gates → PixelPay config/return-base → reserve/acquire → charge).
- **`xpizza-functions/materialize.js`** (`:61+`): copy `order.free_order` onto the released scheduled delivery tasks + a scheduled-free test (the scheduled-free driver path).
- **`xpizza-driver`** (separate app / own release): `index.html` (active `:2282` + queue `:2518` — `&& !order.free_order` → suppress vuelto, "Nada que cobrar", no cash amount) + `cash-helpers.js` (`computeShiftCash` filter `:52` excludes `free_order`; **`isCashPayment` `:41` UNCHANGED / byte-identical**) + `cash-helpers.test.js`.
**Verification:** $0 quote → both greyed + "Confirmar pedido gratis" + `createOrder` places a cash+`free_order` reserved order (persisted on order+tasks, no PixelPay) → consume at completion; **stale quote** → `createOrder` rejects + forms re-enable; **direct/stale `chargeOnlineOrder` $0** → typed non-payable BEFORE the PixelPay config read/reserve/acquire (#2); **driver** → free_order shows "Nada que cobrar", no vuelto, excluded from cuadre (tests); scheduled-$0 → reserved→held→consume; cancel-$0 → `reverseRedemptionForOrder`. Normal cash/online unchanged.
**Gate:** money-gate (+ driver `isCashPayment` invariant — keep byte-identical to POS/dispatch, see [[pos-premium-cierre]]).

## A-F — Factura: comp representation (full-value items + explicit rebaja)  [MONEY-GATE]  · addresses #4

**Problem/decision (advisor #4, owner-confirmed SAR reading).** Do **NOT** skip the factura on redeemed orders. The X. Pizza **platform** factura for **all** redeemed orders shows **full-value items + an explicit "Desc. y Reb. Otorg" line** for the comped value (comped Margherita → **-L299**).
- Per SAR ("descuentos efectivos que consten en la Factura no forman parte de la base gravable"): the discount **leaves the base gravable** → **ISV computes on the net**; the comped portion's ISV = **L0**. **Total = the paid amount.** A fully-comped order → **base 0 / ISV 0 / total 0**, and the factura **still issues** (records the item for inventory + the comp value for accounting/audit).
- This **changes B1's factura representation**: today the discount is baked into 0-price lines with `desc_rebaja_cents:0`; now → **full-value line items + an explicit rebaja line** (`desc_rebaja` = comped value), preserving the golden **ISV identity** (`subtotal + tax === total`, all footing on the *net* base).
- **La Musa unchanged** — Soft Restaurant POS owns its fiscal doc; the comp is recorded in the rewards ledger + order record for reconciliation, not the platform factura.

**The producer chain (R4 — #3, the real remaining gap).** The redeemed X. Pizza `order.items` (→ factura) comes from **`rewards-redeem-pricing.js`**, which emits the free line as **`{ ..., line_gross_cents: 0 }`** (`rewards-redeem-pricing.js:47`, `factura_items = [freeLine, ...paid]` @54) — it asserts Σ`line_gross_cents` === the discounted total. `build-record.js` **cannot print gross L299 from a 0-line**. So A-F starts here: **`rewards-redeem-pricing.js` must emit/retain the GROSS display cents + the DISCOUNT cents** on the redeemed line (e.g. `line_gross_cents` = gross + `line_discount_cents` = comped), while keeping the **net** identity (Σ net === discounted `total_cents`, `subtotal+tax===total`).

**Then both build-records + renderer (R4 — #4, the duplicate):**
- **`xpizza-functions/factura/build-record.js`** (`:51–58` net `base_cents`, `:86` `desc_rebaja_cents:0`) → item prints GROSS, `desc_rebaja_cents` = Σ comped, gravado base = net.
- **`xpizza-factura/src/build-record.js`** — the **DUPLICATE producer** (also net `base_cents` / `desc_rebaja_cents:0`) → **update it too, OR mark it non-runtime and fix its goldens.** (Name it so codex verifies both.)
- **`xpizza-factura/src/renderer.js:96–98`** prints `L(it.base_cents)` as PRECIO (→ L0.00 today) + the existing `DESC. Y REB. OTORG` line (`:104`, fed 0) → print the GROSS as PRECIO + the real rebaja.

**Result:** redeemed X. Pizza factura = **gross item PRECIO (L299)** + `desc_rebaja` = comped value + **base gravable = net** + ISV on net + comped ISV L0 + golden **`subtotal + tax === total`**; fully-comped → **0/0/0 and issues**. La Musa `factura_items:null` unchanged.
**Files:** `rewards-redeem-pricing.js` (gross+discount on the redeemed line) + `xpizza-functions/factura/build-record.js` + `xpizza-factura/src/build-record.js` (duplicate) + `xpizza-factura/src/renderer.js` + the **golden tests for all**; reconcile with `orderBreakdownCents`.
**Verification (golden/unit):** the above output; non-redeem factura byte-identical; both build-records + goldens consistent.
**Gate:** money-gate (factura money-math).

## A4 — reconstruct `items_text` for the freed/added item  [functions · code-gate]

**Problem:** `items_text` (KDS/driver/WhatsApp) shows the freed item at full price on a redeemed order ([[items-text-pricing-decoupling]]).
**Fix:** server-reconstruct `items_text` from the priced `items[]` + redemption result at intake so the freed unit reads free (X. Pizza) / the added 0-price tier item is reflected (La Musa). Narrow to the redemption case; non-redeem byte-identical.
**Files:** `xpizza-functions/index.js` (intake where `items_text` is built) + `rewards-redeem-pricing.js`.
**Verification:** redeemed order `items_text` reflects the freed/added item; non-redeem unchanged (guard).
**Gate:** code-gate (money-adjacent).

## #6 — online-return persistence  (shared infra for A2 + A5)

**Problem (advisor #6):** after the PixelPay redirect+return the in-memory `_redeemQuote` is gone; the success screen rebuilds `currentOrder` from `stashedOrder` (client full total, `index.html:2556–2587`), so `redeemAdjustedTotal()` can't work post-return, and detection uses `!!o.redeem` (`index.html:2945`) — but the **server stamps `o.redemption`, not `o.redeem`**.
**Fix (foundation A2/A5 build on) — MANDATORY both (R3, not OR):**
1. **Persist the server quote** (`total_cents`, `discount_cents`, `free_item`) into the **stashed order** (`xpizza_pending_pay`) BEFORE the PixelPay redirect, **AND**
2. **On the online return, prefer the SERVER-CONFIRMED order's `total_cents`/`redemption`** (server wins over the stashed client values). **This requires a SERVER change (R4 — #5):** `paymentStatus` today returns only coarse state (`state`/`scheduled_for`/`tracking_token`, `index.js:1476/1485`) and direct `orders` reads aren't public — so **`paymentStatus` must return a poll-token-gated safe summary** (confirmed `total_cents`, the `redemption` summary, scheduled fields) that the return page reads. The stash is the fallback if the summary is momentarily absent.
3. **Detection:** everywhere the success/earn path tests redemption, use **`o.redemption || o.redeem`** (server stamps `o.redemption`, not `o.redeem` — `index.html:2945`).
**Files:** `xpizza-functions/index.js` (`paymentStatus` poll-token-gated summary — #5) + `xpizza-orders/index.html` + `la-musa-orders/index.html` (stash-at-redirect + return path 2556–2587; read the server summary; detection at 2945).

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

## R6 — two mechanical edits (everything else confirmed clean)
| R6 | Fix | Where |
|---|---|---|
| #1 | **`materialize.js` copies `order.free_order` onto the released scheduled delivery tasks** + a scheduled-free test — closes the phantom-cash gap on the scheduled-free path (createOrder only writes the immediate task) | A1 / `materialize.js:61+` |
| #2 | **A1 gate-ordering → exact safe sequence (R7)**: auth/validate/uid → reprice → `$0`/sub-min typed return → non-PixelPay gates → PixelPay config/return-base → reserve/acquire → charge (config BEFORE any write) | A1 `chargeOnlineOrder` |
| ✅ | A-F (#3/#4), #5 `paymentStatus`, #6, #7, #8, the driver `free_order` seam, the scheduled-$0 lifecycle | confirmed clean — untouched |

## Findings → resolution map (original 8, for the re-gate)
| # | Finding (cited) | R3 status |
|---|---|---|
| 1 | `reconcilePayments` flags $0-no-PixelPay (`index.js:1676`) | **SUPERSEDED by A1 pivot** — no $0 online path, so no reconciler edit |
| 2 | PixelPay reads before repricing (`index.js:799`) | R2 resolved (leave); **moot** under the pivot (no $0/sub-min branch in `chargeOnlineOrder`) |
| 3 | scheduled-$0 not recoverable (`rewards-reserve.js:288/295`) | **SUPERSEDED by A1 pivot** — cash path already handles scheduled (held→consume); no new predicate |
| 4 | factura must issue reflecting the comp (SAR) | **A-F, revised R3**: gross item PRECIO + `desc_rebaja` line, net gravado base, ISV on net, 0/0/0 issues; update `build-record.js` + `xpizza-factura/renderer.js` + goldens; La Musa unchanged; money-gate |
| 5 | reframe all-or-nothing | **recovery-visible** via the reused cash lifecycle (reserve→held→consume; cancel→`reverseRedemptionForOrder`); optimistic grey-out + server re-price guard |
| 6 | online-return: quote gone, `o.redeem` vs `o.redemption` (`index.html:2556–2587,2945`) | **#6, MANDATORY both (R3)**: persist server quote at redirect AND server-confirmed wins on return; detect `o.redemption \|\| o.redeem` |
| 7 | `cash_tendered` guard uses full `calcTotal()` (`index.html:2412–2456`) | R2 resolved (leave): both change + guard → `redeemAdjustedTotal`; server re-validates |
| 8 | A6 renderer (`index.html:2526` old handler) | R2 resolved (leave): dedicated Stage-2 renderer; cart pillbox/`updateCartReviewBody` untouched |

**Confirmed sound (advisor, no change):** `redeemAdjustedTotal`/`getRedeemQuoteTotalCents` correct while the quote is live; quote endpoint runs the same pricing; server earn already subtracts the freed unit (A5 = client alignment only, once `o.redemption` detection is fixed).

## Deploy & go-live
Functions (A1, A-F, A4) + forms (A2/A3/A5/A6) → **inert** → **re-canary** (owner uid): $0-online, sub-min→cash, scheduled-$0, factura comp line, items_text, all display surfaces → verified vs prod → **atomic flip** `{config/redemption_enabled:true, config/rewards_public/redemption_live:true}`.

## Deploy note (R5)
The `free_order` driver-honoring (#1) lands in **`xpizza-driver`** — a separate Capacitor app with its own release (AAB → Play Store, [[sherpa-driver-playstore]]). The driver update should ship **before/with** the flip so a free order never renders "A COBRAR L0" on a live driver. Functions + forms (git-CD) + driver release → inert → re-canary → atomic flip.

## Handoff
Advisor re-gates THIS plan. On approval → executor builds task-by-task on `feat/rewards-batch-a` off `main`, functions-first (A1+A-F money-gated, A4), then forms, then the `xpizza-driver` free_order honoring, parity-green, byte-identical past CONFIG (+ driver `isCashPayment` byte-identical invariant). Related: [[rewards-loyalty-program]], [[items-text-pricing-decoupling]], [[factura-integration]], [[pos-premium-cierre]], [[sherpa-driver-cash-feature]].
