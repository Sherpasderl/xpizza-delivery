# Handoff to Advisor — Rewards Batch A **PLAN RE-GATE** (R6 · FINAL)

**Branch:** `docs/rewards-batch-a-plan` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md` (R6).

Convergence: R1→8 → R2 6/8 → R3 core VALIDATED → R4 5 → R5 2 → **R6 = two mechanical edits** (codex handed the exact edits). Everything else confirmed clean — untouched.

## The 2 edits
**#1 — `materialize.js` (scheduled-free path).** `createOrder` writes `free_order` onto the immediate task, but a scheduled order's driver tasks are built at **materialization**, not create. So `materialize.js` (`:61+`, which builds the released delivery tasks) must **copy `order.free_order` onto the released scheduled delivery tasks** — else the scheduled-free path leaks a phantom "A COBRAR L0" onto the driver. Add a **scheduled-free test**.

**#2 — A1 gate-ordering → the exact safe sequence** in `chargeOnlineOrder`:
1. auth / validate / uid
2. reprice (redemption)
3. `$0` / sub-min → typed non-payable / free-path response *(return here)*
4. [payable only] existing non-PixelPay gates → reserve → acquire (`:1060/1138/1170`)
5. [payable only] PixelPay config / return-base reads → charge (`resolvePixelPayConfig`/`resolveReturnBase` moved here from `~799/812`)

So the `$0`/sub-min response is reached before ANY PixelPay config read, reserve, or acquire; the config/return-base reads move to the payable tail.

## Confirmed clean — untouched
A-F factura chain (#3/#4), #5 (`paymentStatus` summary), #6, #7, #8, the driver `free_order` seam (call-site exclusions + `computeShiftCash`, `isCashPayment` byte-identical), the scheduled-$0 `createOrder` lifecycle.

Plan committed on `docs/rewards-batch-a-plan`. Both edits are mechanical / codex-specified — expecting the clean **APPROVED** on the final re-gate. On approval → build: functions-first (A-F factura chain + `createOrder` free-order path + `chargeOnlineOrder` reorder + `materialize.js`, money-gated) → forms (A2/A3/A5/A6) → the `xpizza-driver` AAB (sequenced before/with the flip), each SHA back for code-gates.
