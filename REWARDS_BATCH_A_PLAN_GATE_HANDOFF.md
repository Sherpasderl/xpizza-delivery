# Handoff to Advisor — Rewards Batch A **PLAN RE-GATE** (R2)

**Branch:** `docs/rewards-batch-a-plan` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md` (R2).

**R1 plan-gate → REVISE (8 findings). All 8 addressed** — resolution map is in the plan (bottom) with cited file:line. Re-submitting for the re-gate. **No code until this clears.**

## What changed R1 → R2

**A1 is now a first-class `free_checkout` state with an explicit recovery-visible state machine** (not "atomic"):
- **#1** — `free_checkout:true` marker + `reconcilePayments` breach-skip when `free_checkout && total_cents===0` (`index.js:1676`). Non-zero confirmed-without-payment still breaches.
- **#2** — PixelPay config/return-URL reads moved BELOW the $0/sub-min branches (charge path only) (`index.js:799`).
- **#3** — scheduled-$0 HANDLED (not carved): consume-at-placement for all $0 free_checkout incl. scheduled + recovery predicate `confirmed && free_checkout && reserved` (not gated on `consumeEligible`, `rewards-reserve.js:288/295`). Carve-out offered only as a fallback if you prefer a smaller v1.
- **#5** — reframed as reserve → place → consume-best-effort → recovery-sweep; every exception releases-pre-order or is **recovery-visible**.

**#4 — Factura REVISED into its own money-gated task A-F** (do NOT skip): X. Pizza platform factura on all redeemed orders = full-value items + explicit "Desc. y Reb. Otorg" rebaja line; SAR → discount leaves the base gravable, ISV on net, comped ISV L0, fully-comped issues at 0/0/0; changes B1's baked-0-line representation, preserves the golden ISV identity. La Musa unchanged (POS-owned; comp in ledger + order record).

**#6 — online-return persistence** (shared A2/A5 infra): the in-memory quote is gone after the PixelPay redirect, so persist the server quote (total/discount/free-item) into the stashed order at redirect (server-confirmed wins on return), and detect **`o.redemption || o.redeem`** (server stamps `o.redemption`, not `o.redeem` — `index.html:2556–2587,2945`).

**#7 — cash seam:** fix BOTH the displayed change AND the `cash_tendered` submit guard (`index.html:2456`, currently `>= calcTotal()` full price) to use `redeemAdjustedTotal()`.

**#8 — A6:** dedicated Stage-2 summary renderer sourcing the server quote; leave the cart pillbox / `updateCartReviewBody` untouched.

## Sequencing / gates (unchanged shape)
Functions money-gated first (**A1** + **A-F**) → **A4** (code-gate) → forms (#6 infra → **A2/A5** → **A3** → **A6**). Ships **inert** → **re-canary** (owner uid: $0-online, sub-min→cash, scheduled-$0, factura comp line, items_text, display surfaces) → **atomic flip**.

## For the re-gate
- Confirm A1's `free_checkout` state machine + the recovery predicate cover the scheduled-$0 path (vs. the carve-out fallback).
- Confirm A-F's factura math (ISV on net, comped ISV 0, 0/0/0 issue) is the intended SAR representation.
- Confirm the #6 persistence approach (stash-at-redirect + server-confirmed-wins-on-return).

**Plan committed on `docs/rewards-batch-a-plan`** — ready for the re-gate. Executor revises again on REVISE, else builds task-by-task on approval.
