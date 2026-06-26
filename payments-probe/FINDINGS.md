# PixelPay sandbox probe — findings (2026-06-09/10)

Run against the live sandbox (`pixelpay.dev`) with the real `@pixelpay/sdk-core` v2.5.2.
`npm i @pixelpay/sdk-core@2.5.2` then `node probe-*.js`. No real money (sandbox).

## Probe 1 — sale + getStatus  (`probe-sale-status.js`)
- SALE (test card 4111…1111, amount=1) → SUCCESS. Sale response (TransactionResult) HAS:
  `payment_uuid`, `payment_hash`, `response_approved`, `transaction_approved_amount`.
- **getStatus(payment_uuid) returns ONLY** `{ status: "paid", attemps, history }` —
  **NO amount, NO order id, NO payment_hash, NO response_approved.**
- Raw status call needs `env:"sandbox"` in the BODY (else the sandbox key is treated as a
  prod key → 400 "El valor KEY es inválido"). Headers: `x-auth-key` + `x-auth-hash` only.
- ⇒ getStatus CANNOT verify amount or bind a uuid to our order. It is good only as a
  liveness/state check (paid / later voided / refunded).

## Probe 2 — auth + server-capture  (`probe-auth-capture.js`)  ← the fix
- AUTH (browser path, no-3DS in node) → `payment_uuid` + `payment_hash`.
- CAPTURE runs SERVER-SIDE (`CaptureTransaction = {payment_uuid, transaction_approved_amount}`,
  no card, key+hash) with a **server-set amount**.
- Capture RESPONSE is authoritative + server-obtained: `response_approved:true`,
  `transaction_approved_amount` (= what the server captured), and
  **`payment_hash` == `MD5(pixelpay_order_id|auth_key|secret)`** (verified equal).
- ⇒ Server controls the amount (tamper → capture fails, no loss) and gets the binding
  hash from its OWN call (defeats the client-supplied-hash replay). Webhook → pure nudge.

## Implication
The approved "browser doSale → getStatus confirm" design is NOT amount/binding-safe
(getStatus too thin). Switch to **browser doAuth (3DS) + server doCapture (authoritative
confirm)**; getStatus = liveness; webhook = nudge. Needs plan update + Codex re-review.

## Still to sandbox-pin
- Capture > auth is rejected (standard processor invariant — verify).
- Amount unit (decimal lempiras assumed); void signature keying; refund/settled-void.

## Probe 3 — lost-capture-response recovery  (`probe-recapture-recovery.js`)
- auth → capture #1 (success, returns payment_hash + amount) → capture #2 on the SAME uuid:
  **412 PreconditionalResponse "Error al encontrar el cobro", data=null.**
- ⇒ Re-capture is NOT idempotent and does NOT re-return the verifiable result. With getStatus
  also thin, a capture that succeeds at PixelPay but whose response we lose CANNOT be reverified.
- **Hard rule:** "paid but lost capture response" → `payment_status: manual_reconciliation`
  (dispatcher checks the PixelPay ledger), NEVER auto-materialize to `new`. A `capturing` claim
  (+ capturing_started_at + payment_uuid) set BEFORE doCapture distinguishes crash-before-capture
  (safe to capture) from crash-after-capture (manual reconcile).

## Stage-4 sub-stage 1 — pixelpay-client.js live pins  (`verify-pins.js`)
Drives the real server client against the live sandbox. PIXELPAY_MODE=sandbox. All PASS:
- **PIN 1 — capture authoritative + bound:** `capture()` → 200; `verifyCaptureResult` ok
  (response_approved + transaction_approved_amount==total + payment_hash==MD5(order|key|secret)).
- **PIN 2 — status enum:** auth → `authorized`; after capture → `paid`. (Liveness states.)
- **PIN 3 — capture > auth REJECTED:** auth=1, capture=2 → `402 "El monto enviado es mayor
  al monto autorizado"`. The amount-safety invariant holds. ✅
- **PIN 4 — void:** sandbox accepts void with **just key+hash + {payment_uuid, void_reason}**;
  `void_reason` must be **≥ 8 chars** (else 422). Providing a `void_signature`/`x-auth-user` is
  **REJECTED (401)** by the shared sandbox account (see `probe-void-authmodel.js`: variant F
  no-sig → 200; all signed variants → 401). After voiding an uncaptured auth, `getStatus` → null.

### Void implication (Stage 6 gate)
`voidTransaction()` is mode-aware: **sandbox** sends no signature; **production** sends
`void_signature` + `x-auth-user` — but that production formula is **UNVERIFIED** (the sandbox
can't validate it). Pin the production void signature against PixelPay docs / the live account
before relying on production void/refund.

### Still only amount=1 testable for success
Sandbox maps integer order_amount 1–14 to outcomes, so full-amount (e.g. 385.00) success isn't
sandbox-testable; the amount comparison IS numeric (PIN 3). Decimal-lempira unit assumed
(`parseAmount` → String(number)); confirm on the first real production capture.

## Stage-4 sub-stage 2 — live end-to-end confirm  (`verify-confirm-e2e.js`)
SDK 3DS-less AUTH → real `confirmOnlinePayment` (real pixelpay-client capture + verify +
materialize) over an in-memory RTDB. PASS:
- confirm outcome `confirmed`; order → `status:new`, `payment_status:confirmed`, `materialized_at`
  set, `payment_reference` from the capture; attempt → `captured`; delivery task + tracking created.
- 2nd confirm → `already_confirmed` (idempotent — no re-capture, which would 412).
- (Sandbox quirk: `customer_name` needs first + last name; amount=1 success path.)

## Void signature — PINNED (2026-06-10, from PixelPay "Cancelling Payments" doc + sandbox)
PixelPay docs (SDK Use Cases → Cancelling Payments) give the exact formula:
- `x-auth-user` header = `SHA-512(merchant_email)` (setupPlatformUser).
- `void_signature` = `SHA-512(merchant_email | order_id | secret)` — '|'-joined, **RAW email**
  (NOT the hashed auth_user); `order_id` = the PixelPay-facing id (our `pixelpay_order_id`).
- Sandbox void-authorized user = `sandbox@pixel.hn` (decoded from the doc), secret `@s4ndb0x-…`.
- BUG FOUND + FIXED: our code was signing `SHA-512(SHA-512(email)|order_id|secret)` (hashed email).
- Verified: corrected `voidTransaction` against the live sandbox → `200 "Transacción anulada
  exitosamente"`. Production runs the same path with the real merchant email + secret.

## Refund API & webhook payload — PINNED from docs + live capture (2026-06-10)
**No refund API.** SDK Requests doc lists only Sale/Auth/Capture/Void/Status/Tokenization — there is
NO RefundTransaction. Void reverses SAME-DAY only (auth holds last up to 15 days). So: same-day cancel →
void (works); a settled/next-day refund has no API → manual PixelPay-portal refund. Our refund_pending →
dispatcher flow is correct.

**Real order_callback payload** (captured live by pointing callback_url at the deployed pixelPayWebhook):
```
{"ref":"<pixelpay_order_id>", "uuid":"P-…", "status":"paid", "payment_hash":"…", "amount":1,
 "currency":"HNL", "items":[…], "customer_name":…, "customer_email":…, "transaction_id":…, …}
```
KEY: the order id is in **`ref`** (NOT `order`/`order_id` — the subscription-doc webhook used `order`),
and `uuid` is a **`P-…` scope DIFFERENT from our auth/capture `S-…` uuid**. So we key off `ref` (→ find our
attempt, use ITS stored uuid), never the callback's uuid. Our extractor was reading `order_id` and SILENTLY
failed on the real payload ("could not extract order id" in the logs) — now fixed to read `ref` first.
