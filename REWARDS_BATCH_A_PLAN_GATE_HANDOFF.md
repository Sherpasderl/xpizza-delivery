# Handoff to Advisor — Rewards Batch A **PLAN RE-GATE** (R3)

**Branch:** `docs/rewards-batch-a-plan` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md` (R3).

R1→REVISE (8) → R2 resolved **6/8** (codex-traced, left as-is) → **R3 = the three changes you asked for.** No code until this clears.

## R2 confirmed resolved — untouched in R3
#2 (PixelPay reads below $0/sub-min, non-PixelPay gates intact) · #5 (recovery-visible state machine) · #7 (cash change + `cash_tendered` guard → `redeemAdjustedTotal`, `index.html:2412–2456`) · #8 (dedicated Stage-2 renderer, cart pillbox untouched). #1/#3 backend edits superseded by the pivot below.

## R3 change 1 — A1 PIVOT: $0 via `createOrder`, not `chargeOnlineOrder`
Owner-directed, simpler. The canary proved `createOrder` places a $0 order correctly (reserved, scheduled→held), so route $0 there and skip the online path — which **drops** the reconciler edit (#1), the PixelPay read-reordering (#2), the new recovery predicate (#3), the `free_checkout` online state, and the codex-flagged new $0-online forms handler (`index.html:2526`).
- **Total-driven method availability:** total `0` → grey both, "Confirmar pedido gratis", submit to `createOrder` with a **free marker** (distinct from cash → driver "nothing to collect", accounting right); `0<total<min` → cash only; `≥min` → both.
- **Money-safety:** grey-out is optimistic (client reads quote); `createOrder` re-prices + rejects if total ≠ 0 → forms re-enable payment. Never a >0 no-payment order.
- **Lifecycle:** reuse the proven cash path — reserve at create → scheduled→held → consume at completion; cancel-before-release → `reverseRedemptionForOrder` (`cancel-order-core.js:181`). No new backend state.
- **Files:** forms (`selectPay`/`processPayment` availability + free-submit) + `createOrder` intake ($0 re-price guard). Still money-gate, far less surface.

## R3 change 2 — #4 factura specifics  [MONEY-GATE]
Codex found the R2 wording unachievable: `build-record.js:51–58` stores the **net** `base_cents`, and `xpizza-factura/src/renderer.js:96–98` prints it as PRECIO → a comped line prints **PRECIO L0.00**, not L299. (The `DESC. Y REB. OTORG` line already exists, `renderer.js:104`, fed 0 today.)
- **Item line prints the GROSS** (Margherita PRECIO L299); `desc_rebaja_cents` = comped value; **totals foot on the NET** (`base = gross − rebaja`, ISV on net, comped ISV 0, `subtotal+tax===total`; fully-comped → 0/0/0 issues).
- Update **`build-record.js` + the duplicated `xpizza-factura/renderer.js` + golden tests**; reconcile with `orderBreakdownCents`. La Musa unchanged (Soft POS owns its doc; comp in ledger + order record).

## R3 change 3 — #6 mandatory (both, not OR)
Persist the server quote (total/discount/free-item) into the stashed order at redirect **AND** on the online return prefer the **server-confirmed** `total_cents`/`redemption` (server wins; stash is fallback). Detect **`o.redemption || o.redeem`** (`index.html:2945`). Shared infra for A2/A5.

## Sequencing (unchanged shape)
Money-gated core (**A-F** factura + **A1** createOrder $0) → **A4** (items_text) → forms (#6 infra → **A2/A5** → **A3** → **A6**). Ships **inert** → **re-canary** → atomic flip.

## For the re-gate
- Confirm the A1 pivot (createOrder $0 + free marker + optimistic-grey-out/server-reprice-guard) is the intended shape.
- Confirm the A-F gross-PRECIO + net-base factura math.
- Confirm #6 (persist AND server-wins).

Plan committed on `docs/rewards-batch-a-plan`. Executor revises again on REVISE, else builds task-by-task (functions-first, A-F + A1 money-gated) on approval.
