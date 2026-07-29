# Handoff to Advisor — Rewards Batch A **PLAN RE-GATE** (R4)

**Branch:** `docs/rewards-batch-a-plan` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md` (R4).

R3 re-gate = **REVISE, core design VALIDATED** (codex: the scheduled-$0 `createOrder` lifecycle is sound; #7/#8 not regressed). **R4 = the 5 implementation-completeness fixes** — file scope + one defensive server guard, no design change. No code until this clears.

## The 5 (grounded to verified file:line)
1. **#1 — free marker.** `free` isn't a valid method (`ALLOWED_PAYMENT_METHODS=['cash','card_delivery','online']`, blanked at `index.js:231/309`). Use **`payment_method:'cash' + free_order:true`**; the flag drives every consumer — forms submit routing, driver "nothing to collect", the factura comp path. (A1)
2. **#2 — defensive `chargeOnlineOrder` server guard.** The client reroute isn't a server invariant — `chargeOnlineOrder` still reprices to 0/reserves/sends 0 to PixelPay (`index.js:843/1060/1138/1170`). Add: post-reprice `total_cents===0` → typed non-payable/free-path **before reserve/acquire/PixelPay**; sub-min → before PixelPay. (A1)
3. **#3 — A-F must include `rewards-redeem-pricing.js`.** The redeemed line is emitted at `line_gross_cents:0` (`:47`), so build-record can't print gross L299. It must emit **gross display cents + discount cents** while keeping the net identity (`subtotal+tax===total`). (A-F)
4. **#4 — the duplicate factura producer.** `xpizza-factura/src/build-record.js` also emits net base / `desc_rebaja:0` → **update it too**, or mark non-runtime + fix goldens. (A-F)
5. **#5 — #6 needs a server change.** `paymentStatus` returns only coarse state (`index.js:1476/1485`); "server-confirmed wins on return" requires it to return a **poll-token-gated summary** (`total_cents`, `redemption`, scheduled fields). Added `index.js` to #6's files. (#6)

## Untouched (validated / resolved)
#7 (cash change + `cash_tendered` guard), #8 (Stage-2 renderer, cart pillbox untouched), the scheduled-$0 `createOrder` lifecycle, and earlier #2/#5.

## Sequencing (unchanged shape)
Money-gated core (**A-F** factura chain incl. pricing + both build-records + renderer + goldens; **A1** createOrder $0 + cash/free_order marker + defensive `chargeOnlineOrder` guard) → **A4** (items_text) → **#6** (`paymentStatus` summary + forms) → **A2/A5** → **A3** → **A6**. Ships **inert** → re-canary → atomic flip.

## For the re-gate
- Confirm `cash + free_order:true` (not a new enum) is the intended marker + all consumers named.
- Confirm the A-F producer chain (`rewards-redeem-pricing.js` gross+discount → both build-records → renderer → goldens) is complete.
- Confirm `paymentStatus` returning a poll-token-gated summary is acceptable (vs. another return channel).

Plan committed on `docs/rewards-batch-a-plan`. Executor revises again on REVISE, else builds task-by-task (functions-first) on approval.
