# Handoff to Advisor — Rewards Batch A **PLAN-GATE**

**Branch:** `docs/rewards-batch-a-plan` · **tip:** `e3cffdb` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md`.

This is a **plan-gate** (codex-on-plan), not a code gate — no implementation yet. Requesting scrutiny on the sequencing, the A1 money-path design, and the display/server-authority split before the executor builds task-by-task.

## What Batch A is
The **canary-surfaced fix cluster that HOLDS the atomic go-live flip.** Redemption (B1 + B2) is live-inert on main and mid-canary; the money spine is proven intact via RTDB inspection. Batch A = one real money-path gap (A1) + four display/edge fixes (A2–A5) + a missing payment-page order summary (A6). After it's gated + re-merged → re-canary → then the flip.

| Item | Class | Gate |
|---|---|---|
| **A1** — 0-total online → free-checkout bypass | MONEY-PATH | **design-gate → money-gate** |
| **A4** — reconstruct `items_text` for the freed item | functions, money-adjacent | code-gate |
| **A2** — success Total → server discounted total | forms, display | code-gate |
| **A3** — cash vuelto off the discounted total | forms, display | code-gate |
| **A5** — success earn badge subtracts the freed unit | forms, display | code-gate |
| **A6** — payment-page "Resumen del pedido" (all orders) | forms, display | code-gate |

## The one that needs your design judgment — A1
**Problem (real, canary-caught):** a redemption that zeroes the online total (La Musa free item = whole order / X. Pizza free pizza = only item) can't open a PixelPay checkout → "checkout not created" → customer stuck.

**Design A (owner-approved; for your design-gate):** in `chargeOnlineOrder`, after server re-pricing:
- `total_cents === 0` → **bypass PixelPay**, place a **$0 confirmed** online order, consume the reservation, build the L0 factura, fire the normal confirmed-order pipeline.
- `0 < total_cents < PIXELPAY_MIN` → **cash fallback** (collect the discounted remainder at delivery).
- `≥ PIXELPAY_MIN` → unchanged.
- **All-or-nothing preserved**: consume bound to the $0 placement; any failure → release + non-payable, idempotent.

**Please gate:** (a) is the $0-confirmed bypass the right shape (vs. e.g. a 1-lempira floor)? (b) SAR/factura handling of a **L0 fiscal doc** — is that valid, or does it need a carve-out? (c) the exact PixelPay minimum + the cash-fallback UX. (d) the consume↔placement atomicity for the $0 path.

## Invariants the plan commits to
- **Server-authoritative money**: A2/A3/A5/A6 display-only; every discounted total from the server quote (`redeemAdjustedTotal` → `getRedeemQuoteTotalCents`), never client-computed.
- **All-or-nothing** (B1) preserved by A1.
- **Guest byte-identical**; `account.js` **byte-identical past CONFIG** (parity guard green every SHA).
- A5 is client-only — the **server earn already subtracts the freed unit** (`rewards-earn.js:57` `earnDelta = model==='discount' ? max(0,delta-1) : delta`); the plan just aligns the client badge estimate.

## Sequencing / build model
1. **A1 design-gate first** (design A above) → build A1 (money-gate).
2. Then **functions-first**: A4 → then forms A2/A3/A5/A6.
3. Executor builds task-by-task on `feat/rewards-batch-a` off `main`, each SHA codex-gated, parity-green.
4. Ships **inert** (redemption still OFF). Deploy = functions (A1,A4) + forms (git-CD) → **re-canary** (owner uid) the 0-total-online + display surfaces + items_text → **THEN atomic flip**.

## Open questions for the gate
- A1 shape + SAR L0 doc + PixelPay minimum + cash-fallback UX (above).
- A6: consolidate the existing collapsible review vs. add alongside — plan says consolidate; confirm no regression to the cart pillbox flow.
- Any ordering constraint you'd change (e.g. A6 before A2/A3 so the summary is the single source of the displayed total)?

**No code yet** — `e3cffdb` (the plan) is ready for your plan-gate. Executor will revise the plan on REVISE, then build task-by-task on approval.
