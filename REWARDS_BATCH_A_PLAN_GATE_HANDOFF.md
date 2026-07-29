# Handoff to Advisor — Rewards Batch A **PLAN RE-GATE** (R5)

**Branch:** `docs/rewards-batch-a-plan` · **base:** `main` (`f6cfee0`).
**Plan:** `docs/superpowers/plans/2026-07-29-rewards-batch-a.md` (R5).

Convergence: R1→REVISE(8) → R2 6/8 → R3 core design VALIDATED → R4 = 5 completeness fixes → **R4 re-gate: down to 2** (A-F factura, #5 paymentStatus, scheduled-$0 lifecycle, #7/#8 all confirmed clean). **R5 = the last two seams.** No code until this clears.

## The 2 (grounded)
**#1 — driver seam (the phantom cash order).** A `$0` order marked `cash` avoids cash-owed (total 0) but the driver's cash surfaces key only on `payment_method==='cash'`, so it renders "A COBRAR L0" + a vuelto widget + a +1 in the cuadre. Fix:
- Persist **`free_order:true` on the order AND the driver tasks** (`createOrder` writes both).
- In `xpizza-driver`: add `&& !order.free_order` at the active-card "A COBRAR"/vuelto (`index.html:2282`), queue-card cash render (`index.html:2518`), and `computeShiftCash`'s filter (`cash-helpers.js:52`) → suppress vuelto, "Nada que cobrar," exclude from cuadre. **`isCashPayment(pm)` (`:41`) stays byte-identical** (standing cross-repo invariant with POS/dispatch); the exclusion is at the call sites, not inside it. Update `cash-helpers.test.js`.
- (This is exactly why the marker is `cash + free_order`, not a `free` enum — the surfaces must honor the flag.)

**#2 — config-read ordering (guard fires too late).** The defensive post-reprice `$0` guard alone doesn't help because PixelPay config + return-base are read **before** repricing (`index.js:~799` `resolvePixelPayConfig` / `~812` `resolveReturnBase`; reprice `:843`) → a stale/direct `$0` request 500s on the config read first. Fix: **move those two reads BELOW the reprice and BELOW the `$0`/sub-min typed guard** (identity/availability/schedule/zone/rate-limit gates stay before). So: gates → reprice → `$0`/sub-min → typed non-payable/free-path **before any PixelPay config read/reserve/acquire** → else resolve config + charge.

## Confirmed clean — untouched
A-F factura chain (#3/#4: `rewards-redeem-pricing.js` gross+discount → both build-records → renderer → goldens), #5 (`paymentStatus` poll-token-gated summary), the scheduled-$0 `createOrder` lifecycle, #7 (cash change+guard), #8 (Stage-2 renderer).

## Scope note (new in R5)
The driver-side #1 lands in **`xpizza-driver`** — a separate Capacitor app with its own release (AAB → Play Store). The plan says ship the driver update **before/with** the flip so a free order never renders "A COBRAR L0" on a live driver.

## For the re-gate
- Confirm the driver-side exclusion at the call sites + `computeShiftCash` filter (keeping `isCashPayment` byte-identical) is the intended shape.
- Confirm the config-read move (below reprice + guard, non-payment gates preserved).

Plan committed on `docs/rewards-batch-a-plan`. Executor revises again on REVISE, else builds on approval (functions-first → forms → driver).
