# Hosted Payment — Go-Live Runbook
_Branch `feature/pixelpay-hosted-payment`. Drafted 2026-06-16, while awaiting the bank's final AUTH answer._

## Decision gate (which path?)
- **Bank APPROVES Autorización y Captura** → do NOT use this. Restore the AUTH build
  (`git checkout backup-auth-capture-2026-06-15` / branch `feature/pixelpay-online-payment`) and follow
  the existing **`GO-LIVE-PAYMENTS.md`**. Hosted stays the fallback.
- **Bank's answer is FINAL "Venta Directa only"** → follow THIS runbook.
- **Prereq:** the driver/Capacitor session stays **parked** (no `functions/` edits or deploys) until step 3 merges. ✅ (parked 2026-06-16)

## 0. Pre-flight (no real money)
- [ ] `openssl rand -hex 32` → set **`PIXELPAY_WEBHOOK_SECRET`** in `xpizza-functions/.env` (the same value auto-appends to the `_callback` URL).
- [ ] Confirm `.env`: `PIXELPAY_KEY_ID`, `PIXELPAY_SECRET`, `PIXELPAY_PUBLIC_KEY`, **`PIXELPAY_APP_URL` = the endpoint** (`https://hn.ficoposonline.com`), `PIXELPAY_MODE=sandbox` (for the e2e first).
- [ ] `cd ~/Downloads/xpizza-hosted/xpizza-functions && npm test` → 18 hosted tests green.

## 1. Deploy SANDBOX + full browser e2e (#9)
- [ ] `npm run deploy` (sandbox mode). Overwrites the live AUTH functions — the backup tag preserves them.
- [ ] Local order form → place an **online** order → it redirects to `/hosted/sandbox` → click **"Simular pago exitoso"** then **"Ejecutar callback"** → confirm: order **materializes** (`status:new`, `payment_status:confirmed`), reaches KDS/dispatch, return page shows **"¡Pago confirmado!"**.
- [ ] Also exercise: **failed** scenario (order stays pending), **cancel** scenario (return shows "cancelado"), and a **cancel-then-paid** (auto-void). Clean up sandbox test orders after.

## 2. Flip to PRODUCTION
- [ ] `.env`: `PIXELPAY_MODE=production` (hosted sends the real total as `_amount`; no sandbox 1–14 mapping).
- [ ] `npm run deploy`. **No portal webhook config needed** — hosted sends `_callback` (with the secret) per charge.

## 3. Merge LAST (this is what exposes online pay to customers)
- [ ] Production functions must already be live (step 2) **before** this. Then merge `feature/pixelpay-hosted-payment` → `main` → Netlify rebuilds the order form (redirect) + reader guards.

## 4. Go-live smoke (one small real charge)
- [ ] Real online order → redirect → pay with a real card (3DS) → return shows "¡Pago confirmado!"; order materializes; **captured amount == order total**.
- [ ] **Cancel + refund** it via the dashboard **Pedidos** action → voided same-day (`refunded`). (Verifies the prod void signature + merchant email.)
- [ ] A **declined/abandoned** attempt → no order materializes; sweep handles it (→ `manual_reconciliation` after expiry+grace, not a false charge).

## 5. Monitor (first days)
- [ ] `firebase functions:log` for `hosted_verify_fail`, `hosted_stale_no_callback`, `hosted_cancel_void`, `manual_reconciliation`, `reconcile_breaches`.
- [ ] `sweepStalePending` (5 min) + `reconcilePayments` (daily) run clean. Spot-check the PixelPay portal ledger vs RTDB for the first orders.

## Rollback
- Fastest: revert the order form to cash-only (redeploy) — cash/pickup unaffected.
- `PIXELPAY_MODE=sandbox` + redeploy → no real charges.
- The AUTH build stays restorable (`backup-auth-capture-2026-06-15`) if the bank later enables AUTH.

## Known follow-ups
- ~~Optional customer **email field** on the order form.~~ ✅ done (`9408a48`).
- ~~Remove now-dead `runPixelPayAuth` / `pollConfirm` / `validateCardForm`.~~ ✅ done (`9408a48`).
- ~~Dashboard **"abandon"** action for genuinely-abandoned `manual_reconciliation` orders.~~ ✅ done (`05d94db`).
- _(none open — build is feature-complete; only the gated sandbox e2e + go-live remain.)_
