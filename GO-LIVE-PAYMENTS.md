# X Pizza — PixelPay Payments Go-Live Checklist
_Online card payments (browser 3DS AUTH + server CAPTURE). Created 2026-06-10. Tracks PR #2 (`feature/pixelpay-online-payment`)._

## Already done & verified (in sandbox)
- [x] **Architecture designed + cross-model (Codex) reviewed**, then proven against the live PixelPay sandbox — see `PAYMENT-PLAN.md`, `PAYMENT-REVIEW-LOG.md`, `payments-probe/FINDINGS.md`.
- [x] **Payment Cloud Functions deployed in `PIXELPAY_MODE=sandbox`**: `chargeOnlineOrder`, `confirmOnlinePayment`, `pixelPayWebhook`, `sweepStalePending`, `reconcilePayments`, `resolveManualReconciliation`, `materializeOnConfirm`, `cancelPaidOrder`, `refundReconciler`. (Cloud Scheduler + Pub/Sub auto-enabled.)
- [x] **End-to-end validated (sandbox, no real money):** server e2e (auth→capture→verify→materialize→idempotent); **browser 3DS** (challenge iframe, success, decline → clean fallback); **cancel/refund** (confirm → cancel → voided + refunded; public secret rejected 401).
- [x] **38 unit tests** green (`npm test`) + a self-review pass (closed a double-charge window, a privilege-escalation, added confirm rate-limit).
- [x] **`RECON_SECRET`** generated, in `.env`, deployed (gates `cancelPaidOrder` + `resolveManualReconciliation` — dispatcher-only, never the public secret).

> The functions are live in **sandbox** mode. The **static apps** (order form + readers) are NOT live yet — Netlify deploys from `main`, so they go live when PR #2 merges. **No real money moves until `PIXELPAY_MODE=production` (step 5).**

---

## 1. 🔴 Pin the production void/refund signature  *(the one unverified piece)*
The sandbox accepts void with `x-auth-key` + `x-auth-hash` only, so the **production** void signature is UNVERIFIED. Without it, **refunds/voids will fail in production** (→ `refund_pending`, retried by `refundReconciler`, surfaced to the dispatcher — money is tracked, not lost, but not auto-refunded).
- [ ] Confirm with PixelPay the exact production void contract: `void_signature = SHA-512(auth_user | pixelpay_order_id | secret)` and `x-auth-user = SHA-512(merchant_email)` — or get the correct formula. (Code: `pixelpay.js` `voidSignature`/`platformUser`, `pixelpay-client.js` `voidTransaction`.)
- [ ] Verify a **void + a settled refund** against the production/live account (small real charge, then reverse) once creds are in (step 4).
- [ ] If PixelPay's void differs, update `pixelpay-client.js` / `pixelpay.js` and re-test.

## 2. Test the narrowed cancel RTDB rule (Firebase Rules Playground)
The Stage-2 rule blocks a **client** from cancelling a paid online order (forcing it through `cancelPaidOrder`). Never validated in the simulator (no Java emulator locally).
- [ ] In the Firebase Console → Realtime Database → Rules **Playground**, simulate `orders/{id}/status = 'cancelled'` as a dispatcher on an order with `payment_method:'online'` + `payment_status:'confirmed'` → expect **DENIED**. Confirm a normal cash-order cancel is still **ALLOWED**.
- [ ] `cd xpizza-functions && npm run deploy:rules` (syncs `xpizza-reference/database.rules.json` → deploys). Reconcile live == repo.

## 3. Merge PR #2 → `main`
- [ ] Review the diff on GitHub, then **merge** `feature/pixelpay-online-payment` → `main`.
  - Makes `main` the source of truth **and** triggers Netlify to rebuild every static app (carries the readers `filterLiveOrders` fix + the new order-form payment UX).

## 4. 🔴 Set production credentials
In `xpizza-functions/.env` (gitignored — never committed):
- [ ] `PIXELPAY_SECRET=` → the **masked "Secret Key"** from the portal (NOT the public key).
- [ ] `PIXELPAY_MERCHANT_EMAIL=` → the authorized merchant-user email (for void `x-auth-user`).
- [ ] Already set: `PIXELPAY_ENDPOINT=https://hn.ficoposonline.com`, `PIXELPAY_KEY_ID=FH3005019504`, `PIXELPAY_PUBLIC_KEY=7e70…` (the SHA-512), `RECON_SECRET`.
- [ ] **Sanity check the secret:** `node -e "console.log(require('crypto').createHash('sha512').update(process.env.PIXELPAY_SECRET).digest('hex'))"` must equal `PIXELPAY_PUBLIC_KEY`. If not, the secret is wrong.

## 5. 🔴 Flip to production + deploy functions
- [ ] In `.env`: `PIXELPAY_MODE=production` (and ensure `PIXELPAY_SANDBOX_AMOUNT` is irrelevant — production always charges the real total).
- [ ] `cd xpizza-functions && npm run deploy`.
- [ ] Confirm `chargeOnlineOrder` now returns `mode:"production"` + the **real** amount (not L1).

## 6. Configure the PixelPay webhook
- [ ] In the PixelPay portal: **Activar Webhook** → set the URL to
  `https://us-central1-xpizza-delivery.cloudfunctions.net/pixelPayWebhook`.
- [ ] *(Optional, defense-in-depth)* set `PIXELPAY_WEBHOOK_SECRET` in `.env` + append `?secret=<value>` to the webhook URL (the webhook is nudge-only and re-verifies via capture, so this is hardening, not required).

## 7. 🔴 Production smoke test (one small real charge)
With a **real card** and a **small/cheap menu item**:
- [ ] Place an **online** order → 3DS challenge appears → completes → success screen.
- [ ] Confirm the order **materializes** (`status:new`, `payment_status:confirmed`) and reaches KDS / dispatch (if delivery).
- [ ] Confirm the **captured amount == the order total** (no tax double-add; decimal lempiras) — check the attempt/`payment_reference`.
- [ ] **Cancel + refund it** via `cancelPaidOrder` (RECON_SECRET) → confirm `payment_status:refunded` and the money returns (verifies step 1). If it lands `refund_pending`, the prod void signature still needs work.
- [ ] Verify a **declined** card shows "tarjeta rechazada" and never reaches KDS/dispatch.

## 8. Post-launch monitoring (first days)
- [ ] Watch `firebase functions:log` for `manual_reconciliation`, `refund_pending`, `capture_mismatch`, `reconcile_breaches` alerts (also written to `/dispatcher_alerts`).
- [ ] Confirm `sweepStalePending` (5 min) + `reconcilePayments` (daily) + `refundReconciler` (hourly) run without errors.
- [ ] Spot-check the PixelPay portal ledger vs RTDB for the first handful of real orders.

---

## Rollback
- **Fastest:** set `.env` so the order form can't start online payments — or revert the order form's payment button to cash/COD only and redeploy the order form. Cash/pickup/card-on-delivery are unaffected (separate `createOrder` path).
- **Functions:** `PIXELPAY_MODE` back to `sandbox` (no real charges) + redeploy. In-flight authorized-but-uncaptured holds simply expire (no money moved).

## Known follow-ups (NOT blockers)
- [ ] **Orders / order-history view** — no unified all-orders view exists (dashboard is analytics-only). See `orders-view-followup` memory. Lets you look up paid/refunded/cancelled orders + would give the dispatcher UI the cancel/refund actions.
- [ ] **`MAKE_SECRET` rename** — it's the generic public bearer now (not Make.com); rename to e.g. `ORDER_API_SECRET` (touches `.env` + order form + 4 functions) as a deliberate change.
- [ ] **`convertFailedOnlineToCOD`** — not built; the order form regenerates `order_id` on retry and the sweep abandons stale failed online orders, so it's covered for now.
- [ ] **Dispatcher UI** for `cancelPaidOrder` / `resolveManualReconciliation` (currently API-only; fold into the Orders view).
