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

## 1. ✅ Production void/refund signature — PINNED & sandbox-verified
Resolved (2026-06-10) from PixelPay's "Cancelling Payments" doc + a live sandbox test:
- `x-auth-user` header = `SHA-512(merchant_email)`.
- `void_signature` = `SHA-512(merchant_email | pixelpay_order_id | secret)` — **'|'-joined, RAW email** (not the hashed auth_user). (Code: `pixelpay.js` `voidSignature`, `pixelpay-client.js` `voidTransaction`.)
- A captured payment was voided via the real client → `200 "Transacción anulada exitosamente"`.
- Production runs the SAME path with the real `PIXELPAY_MERCHANT_EMAIL` + `PIXELPAY_SECRET`, so it just needs correct prod creds (step 4). Still good practice:
  - [ ] Confirm one **real void/refund** during the step-7 smoke test (the only thing the sandbox can't prove is that *your* prod merchant email is the authorized void user).

## 2. Test the narrowed cancel RTDB rule (Firebase Rules Playground)
The Stage-2 rule blocks a **client** from cancelling a paid online order (forcing it through `cancelPaidOrder`). Never validated in the simulator (no Java emulator locally).
- [ ] In the Firebase Console → Realtime Database → Rules **Playground**, simulate `orders/{id}/status = 'cancelled'` as a dispatcher on an order with `payment_method:'online'` + `payment_status:'confirmed'` → expect **DENIED**. Confirm a normal cash-order cancel is still **ALLOWED**.
- [ ] `cd xpizza-functions && npm run deploy:rules` (syncs `xpizza-reference/database.rules.json` → deploys). Reconcile live == repo.

> ⚠ **ORDERING (important):** Production functions must go live **BEFORE** the merge. Merging (step 6)
> deploys the new order form — with the online-pay button — to the **live** site; if the functions are still
> in `sandbox` mode, real customers picking "online" would hit the test flow (L1 charges). So the sequence is:
> prod creds → flip production → webhook → **then** merge → smoke test.

## 3. 🔴 Set production credentials
In `xpizza-functions/.env` (gitignored — never committed):
- [ ] `PIXELPAY_SECRET=` → the **masked "Secret Key"** from the portal (NOT the public key).
- [ ] `PIXELPAY_MERCHANT_EMAIL=` → the authorized merchant-user email (for void `x-auth-user`).
- [ ] Already set: `PIXELPAY_ENDPOINT=https://hn.ficoposonline.com`, `PIXELPAY_KEY_ID=FH3005019504`, `PIXELPAY_PUBLIC_KEY=7e70…` (the SHA-512), `RECON_SECRET`.
- [ ] **Sanity check the secret:** `node -e "console.log(require('crypto').createHash('sha512').update(process.env.PIXELPAY_SECRET).digest('hex'))"` must equal `PIXELPAY_PUBLIC_KEY`. If not, the secret is wrong.

## 4. 🔴 Flip to production + deploy functions
- [ ] In `.env`: `PIXELPAY_MODE=production` (and ensure `PIXELPAY_SANDBOX_AMOUNT` is irrelevant — production always charges the real total).
- [ ] `cd xpizza-functions && npm run deploy`.
- [ ] Confirm `chargeOnlineOrder` now returns `mode:"production"` + the **real** amount (not L1).

## 5. Configure the PixelPay webhook
Payload format **pinned** from a live capture: order id is in `ref` (= our `pixelpay_order_id`), `status:"paid"`. The webhook is nudge-only (confirm re-verifies via capture), so it's safe + idempotent.
- [ ] In the PixelPay portal: **Activar Webhook** → set the URL to
  `https://us-central1-xpizza-delivery.cloudfunctions.net/pixelPayWebhook`.
- [ ] *(Optional, defense-in-depth)* set `PIXELPAY_WEBHOOK_SECRET` in `.env` + append `?secret=<value>` to the webhook URL (the webhook is nudge-only and re-verifies via capture, so this is hardening, not required).

> **Refunds:** PixelPay has **no refund API** — `Void` reverses **same-day** only (auth holds last ≤15 days). `cancelPaidOrder` voids a same-day charge; a **settled (next-day) refund must be done manually in the PixelPay portal** → our `refund_pending` state + the dispatcher queue surface these.

## 6. 🔴 Merge PR #2 → `main`  (LAST deploy step — this is what goes live to customers)
Production functions must already be live (steps 3–5) — see the ordering warning above.
- [ ] Review the diff on GitHub, then **merge** `feature/pixelpay-online-payment` → `main`.
  - Triggers Netlify to rebuild every static app: the **order form** (online-pay UX, now hitting production) + the readers' `filterLiveOrders` fix.
- [ ] Confirm Netlify rebuilt the order form + the 4 reader apps.

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
- [x] **Orders / order-history view** — BUILT (2026-06-10) as the dashboard "Pedidos" zone: searchable/filterable all-orders view (type/status/payment/date) + detail modal. See `orders-view-followup` memory.
- [x] **Dispatcher UI** for `cancelPaidOrder` / `resolveManualReconciliation` — BUILT (2026-06-10) into the Pedidos detail modal. Both functions now dual-auth (server `RECON_SECRET` OR a verified dispatcher Firebase ID token via `authorizeDispatcherAction`); the browser sends `getIdToken()`, never the secret. Deployed in sandbox mode; server auth gate verified (401 without a dispatcher token). NOTE: the dispatcher-token browser path still needs one real in-browser smoke test (mint a real ID token) — fold into the step-7 production smoke test.
- [ ] **`MAKE_SECRET` rename** — it's the generic public bearer now (not Make.com); rename to e.g. `ORDER_API_SECRET` (touches `.env` + order form + 4 functions) as a deliberate change.
- [ ] **`convertFailedOnlineToCOD`** — not built; the order form regenerates `order_id` on retry and the sweep abandons stale failed online orders, so it's covered for now.
