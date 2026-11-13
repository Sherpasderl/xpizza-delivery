# PixelPay sandbox fixtures (D4 S0)

Recorded on 2026-11-12 against the PUBLIC sandbox (`https://pixelpay.dev`, its documented public test credentials). The owner ran the probe
`payments-probe/probe-d4-fixtures.js` with the existing gateway token (`x-gw-access-token`), which no session holds. No real money moved.
Every file was re-redacted through the schema allowlist `../redact-pixelpay.js`: only the listed fields survive, each type- or format-checked,
and messages survive only when they come from the catalogue of fixed system texts. Everything else is `<field>`. Each file carries a
`provenance` block.

The adapter's `EVIDENCE` matchers (`../../pixelpay-adapter.js`) are the exact envelope shapes these files show. `SDK-D4-PP-FIXTURES` replays
every one of them through the real impl.

## What the evidence proved
- **Amounts are NUMBERS** (`transaction_approved_amount: 1` for L 1.00), not 2-decimal strings.
- **Status by uuid carries NO amount and NO uuid**: it returns `{status, attemps, history}` with the words `authorized` and `paid`. Binding uses
  our journaled amount, and only for a VERIFIED uuid (CORE-Δ row 19).
- **Status after a void is HTTP 412 «Error al encontrar el cobro»**. This is never evidence of a void; only the void's own bound 200 counts.
- **A server token auth on a 3DS card IS challenged**: HTTP 202, `{payment_uuid, transaction_type: 'songbird', payload}`. That's Q3's decline path.
- **A decline** is 402 with `response_approved: false` and a 2-digit `response_code` (`05`).
- **A capture above the authorized amount is REFUSED**: 402 «El monto enviado es mayor al monto autorizado».
- **A duplicate provider `order_id` is ACCEPTED** (a second authorization), so idempotency is entirely ours. The code never resends.
- **A 29- and a 64-character `order_id` are accepted.**

## Sandbox-only quirks (NOT in the production code path)
- `customer_name` must have a first AND a last name.
- Only `order_amount` 1–14 produce defined outcomes (1 approves, 2 declines, …).
- An `example.com` email is refused at tokenization (422); a real-looking address is needed.
- The sandbox REJECTS a signed void (401). The adapter's void is mode-aware: unsigned in sandbox; production signs over the raw merchant
  email | `pp_ref` | secret and sends `x-auth-user`. The production void is unproven until the go-live smoke test (a charge, a void, then
  the panel).
- Every transaction call needs the gateway token (the token-less run was Cloudflare-challenged); tokenization through the SDK did not.

## The owner's status re-run (2026-11-12; two sandbox auths of L 1.00, no capture / void)
- **An unknown uuid ⇒ HTTP 412 «Error al encontrar el cobro»** (`status-unknown-uuid.json`). The first run's 403 at that step was a gateway quirk; «not found» is 412 across the board.
- **Status BY `order_id` does NOT work:** 412 even for a fresh approved authorization (`status-by-order-id.json`, `status-challenged-by-order-id.json`). Lost-auth recovery (no uuid) stays MANUAL (`manual_reconciliation` + an alert), never a resend. No automatic row.
- **A never-completed challenge uuid ⇒ 412** (`status-challenged-uuid.json`) ⇒ `inconclusive`, never evidence of a decline or an expiry. W3 keeps its sweeper / alert path to a person.
- Every status read maps 412 (and anything not a recorded 200 word) to `inconclusive`.
