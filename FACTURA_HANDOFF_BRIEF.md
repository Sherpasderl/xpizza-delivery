# Brief — Factura (SAR) integration → for order-form / audit session

**Date:** 2026-06-26
**Branch:** `feature/factura-integration` (pushed to origin; built on top of the merged `main`,
so it already includes the hosted-payment + driver work). **Not merged to main, not deployed.**
**For:** the session that built the order form — now acting as advisor/auditor for this work.

---

## What this session built & validated

A complete SAR fiscal-document subsystem for X. Pizza (legal entity Sherpa S. de R.L.,
RTN 05019024114145), isolated in a new `xpizza-factura/` directory plus deploy-safe copies
under `xpizza-functions/factura/`.

- **Hardware-validated end-to-end today** on the Surface Pro + Epson TM-T20IV. Real flow
  proven: order → `allocateFacturaNumber` (live Firebase) → `/facturas` → print agent →
  printed paper, with **sequential numbers (00000001 → 00000002)**, correct ISV math,
  `SON:` amount-in-words, `CAMBIO`, two copies, clean cut. Currently in **`FACTURA DE
  PRUEBA`** temp mode (placeholder CAI; the real SAR CAI swap is later and zero-code).
- Allocation is a **single DB trigger** (`allocateFacturaOnSale`) keyed off order *state*
  (`status:new` + online→`payment_status:confirmed`) — covers cash, card-delivery, and
  **all** online materialize routes; **decoupled from the hosted-payment-vs-auth-capture
  choice**. Cancellation → `voidFacturaOnCancel` trigger. Logic is concurrency-safe +
  fail-closed (TDD, 88 automated tests).
- **3 firebase `null-first` transaction bugs** found on-device and fixed (allocation
  reservation, print-claim, plus a Windows USB `LIBUSB_ERROR_NOT_SUPPORTED` from Linux-only
  libusb calls); the test fake now models firebase's null-first so they can't regress.
  Printer PID is **`0E39`** (the `-SP` variant, not the `0202` default).

Plan/specs in-repo: `FACTURA_PLAN.md`, `docs/adr/0003` (allocation lifecycle / fail-closed),
`docs/adr/0004` (facturas nested per restaurant), `CONTEXT.md` glossary, full review
transcript in `FACTURA_PLAN-REVIEW-LOG.md`, Surface setup in `xpizza-factura/SETUP.md`.

---

## What's planned to integrate into YOUR order form (`xpizza-orders/index.html`) — please audit

Two additive UI blocks + payload fields. No changes to your payment UI.

1. **RTN block** — checkbox `#rtn-toggle` ("Necesito factura con RTN") after the email
   field, revealing `#razon-social` + `#rtn-cliente` (14-digit). Helpers added:
   `toggleRtn()`, `rtnIsValid()`; validated in `processPayment()` *before* `buildOrder()`.
2. **Cash-change picker** — `#cash-change-panel` after the pay-options, shown **only when
   `selectPay('cash')`** (hidden for online; `selectPay` toggles it). Quick-pick chips
   (`renderChangeChips` / `setCashTendered`) + free numeric entry + `onCashTenderedInput()`
   live "tu cambio" hint.
3. **`buildOrder()` payload additions** to `currentOrder`: `razon_social`, `rtn_cliente`
   (from the toggle), and `cash_tendered` (cash only, only if ≥ total).

**Server contract (functions side, for reference):** `validateOrderPayload` now reads
`razon_social` (sanitized) + `rtn_cliente` (server-re-validated `/^\d{14}$/`, else `''`);
`createOrder` and the online pending-order writer now persist `items[]` (structured priced
lines: `{qty, description, line_gross_cents}`), `cash_tendered_cents` (server-validated ≥
`total_cents`, else defaults to exact/no-change), `restaurant_id:'x_pizza'`,
`factura_status:'not_due'`.

---

## Audit asks

- Confirm the RTN + cash-change blocks **don't regress the hosted-payment flow** —
  specifically the `#cash-change-panel` vs `#pixelpay-panel` toggling inside `selectPay`,
  and the dead `_origBuildOrder` "override" (verified never used / doesn't bypass
  `buildOrder`, but please sanity-check).
- Confirm the `buildOrder` `currentOrder` shape additions are compatible with your
  charge/materialize payload expectations.
- Sequencing risk: **merging to main republishes the order-form site via Netlify before the
  functions deploy** — old functions safely ignore the new payload fields, but flag if you'd
  sequence differently.

---

## Status / next

Built + tested + hardware-validated. **Pending: production deploy** — merge
`feature/factura-integration` → main, then `npm run deploy:rules` + `firebase deploy --only
functions` (adds the 2 triggers; all functions live in one `index.js` codebase, so they
deploy together — no pruning of driver/payment functions). Re-sync `main` first (concurrent
sessions). Optional: NSSM auto-start service for the print agent on the Surface so live-order
facturas print without a manual agent window.
