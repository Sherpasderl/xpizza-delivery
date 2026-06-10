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
