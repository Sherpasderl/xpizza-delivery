# Hosted Payment Plan (PixelPay) — X Pizza
_Pivot from browser-AUTH+server-capture → PixelPay **Hosted Payment Gateway**, forced by Ficohsa allowing only "Venta Directa". Drafted 2026-06-15. **Rev 5 — Codex-APPROVED (5 rounds); see HOSTED-PAYMENT-REVIEW-LOG.md.**_

## Goal
Money-safe online card payment via PixelPay **Hosted Payment** (redirect): the **server creates a charge with a server-set amount** (`api/v2/transaction/hosted/other`), the customer pays on PixelPay's hosted checkout (card + 3DS by PixelPay), the **async authenticated `_callback` delivers the authoritative paid amount + payment_hash**, and the order materializes **only after server verification**. The browser never controls the amount.

## Authority model (the spine — read first)
**Only two signals are authoritative:**
1. A **verified + authenticated `paid` callback** (the ONLY way money is confirmed).
2. **`expired_at`** elapsing (the ONLY way a checkout becomes non-payable).

Everything else — the `_cancel` redirect, a `failed`-status callback, the `_complete` redirect — is **non-authoritative telemetry** and must NEVER (a) confirm money, (b) terminate an attempt, or (c) free the order for a second payable checkout. A hosted checkout stays **payable until `expired_at`** (the customer can retry a declined card on the same checkout), so we keep exactly **one live checkout per order** until it is paid or expires.

## Endpoints
- **Prod:** `POST https://hn.ficoposonline.com/api/v2/transaction/hosted/other` (`json=true` → `{success,url}`).
- **Sandbox:** `…/api/v2/transaction/hosted/sandbox` (keys `1234567890`/`@s4ndb0x-…`; simulator: success/fail/execute-callback/cancel). Sandbox doesn't require `_client_signature`; **prod does**.

## Hosted attempt record (`/payment_attempts/{attemptId}`)
`hosted_state` — complete enum, each outcome maps to exactly one:
| state | meaning | terminal? |
|---|---|---|
| `creating` | CAS-claimed, hosted/other in flight | recoverable |
| `created` | checkout live + **payable until `expires_at`** | no |
| `paid` | verified+authenticated paid callback → materialized | **terminal (money in)** |
| `expired` | past `expires_at`, no paid callback **and** no possibility of payment | terminal → a NEW attempt may now be created |
| `manual_reconciliation` | ambiguous (paid-but-lost-callback possible; verify-fail; stale-creating-no-callback) | needs dispatcher |
| `cancel_pending` | order cancelled before any paid callback (no uuid) → auto-void if a paid callback later arrives | no |
| `void_pending`/`voided`/`refund_pending` | post-paid reversal | per existing void path |

Fields: `hosted_order_id`=`${order_id}-${attemptId}`, `hosted_checkout_url`, `hosted_created_at`, `hosted_expires_at`, `poll_token`, `webhook_secret_ok` (auth flag), `payment_uuid` (P-, only after paid callback), `paid_amount_cents`, `hosted_callback_verified`, `payment_hash_verified`. **Telemetry flags (NOT states):** `customer_cancel_seen`, `last_failed_callback_at`.

## Fields → hosted/other (form / query string)
`_key`, `_client_signature`=HMAC-SHA3-512(secret,`app_key|order_id|app_url`) [prod], `_amount`=**server total (decimal HNL)**, `_order_id`=`${order_id}-${attemptId}`, `_currency`=HNL, `_first_name`,`_last_name`,`_email` (§Email), `_complete`,`_cancel`, **`_callback`=`…/pixelPayWebhook?secret=<PIXELPAY_WEBHOOK_SECRET>`** (auth, below), `_order_content` (opt), **`expired_at`** (charge TTL, e.g. 45 min), `json=true`. **Omit `_tax_amount`**.

## Webhook authentication (R3-2)
The `_callback` URL embeds a secret query param `?secret=<PIXELPAY_WEBHOOK_SECRET>` (server-only). The webhook **rejects any callback lacking the correct secret** before taking ANY action. Paid callbacks are *additionally* bound by `payment_hash`; non-paid callbacks (failed) rely on the secret + are telemetry-only regardless. A forged callback (no secret) thus cannot close, fail, or alter an attempt.

## Flow
1. Order form → `POST chargeOnlineOrder` (cart + customer).
2. **chargeOnlineOrder:** validate → server `total_cents` → create/lookup PENDING order + attempt.
   - **CAS-claim** in ONE atomic write: `hosted_state=creating` + the deterministic `hosted_order_id=${order_id}-${attemptId}` + `hosted_created_at` + `hosted_expires_at` + `poll_token` **before** calling PixelPay (R2-1).
   - **One live checkout per order (I10/R3-1/R4):** if a prior attempt is `created` and **not past `expires_at`** → return its existing `hosted_checkout_url` (double-submit reuses it; never a 2nd payable checkout). If `creating` → "in_progress". If a prior attempt is **`paid`** → return **`already_paid`** (NEVER a new checkout). A **new** attempt+checkout is created **ONLY** when `order.status=='pending_payment'` **AND** the prior attempt is a **non-money terminal** (`expired`/abandoned, or a failed-create that never produced a payable checkout) — **never** after `paid`, `cancelled`, or any `voided`/`refund_pending` (those mean the order is closed/reversed).
   - Compute `_client_signature`; **POST hosted/other** (separate hosted client) → on `{success,url}` persist `hosted_checkout_url`, `hosted_state=created` → return `{checkout_url, order_id, poll_token}`.
   - **Crash gap (R1-4/R2-2):** dies after PixelPay created the checkout but before persisting URL → attempt stays `creating` but `hosted_order_id` is already stored → a later paid callback still verifies + recovers (materialize, or auto-void if `cancel_pending`). Stale `creating` with NO callback past `expires_at`+window → `manual_reconciliation`. Never blind re-create.
3. Browser **redirects** to `checkout_url`. 4. Customer pays on PixelPay's hosted page (card + 3DS).
5. **Signals (only #a is authoritative):**
   - **a. authenticated `paid` callback** → §6.
   - **b. `_cancel` redirect** → set `customer_cancel_seen=true` (telemetry); attempt **stays `created` and payable until `expires_at`** — a late paid callback is still accepted (R3-1).
   - **c. authenticated `failed`-status callback** → record `last_failed_callback_at` (telemetry); attempt **stays `created`** (customer can retry the card on the same checkout); does NOT terminate (R3-2).
   - **d. `_complete` redirect** → UX only; the status page polls by `order_id`/`poll_token`.
6. **Webhook (money authority), paid callback:** reject if `?secret` is wrong (R3-2). Parse JSON or form-encoded; extract `ref/order`,`uuid` (P-),`status`,`amount`,`payment_hash`. Verify ALL: `ref==attempt.hosted_order_id` (reject superseded, I3) **AND** `payment_hash==MD5(hosted_order_id|key_id|secret)` **AND** `status=="paid"` **AND** `toCents(amount)==order.total_cents`.
   - Verified → materialize idempotently; persist `payment_uuid`,`paid_amount_cents`,`hosted_callback_verified`,`payment_hash_verified`,`hosted_state=paid`. If `cancel_pending` → auto-void (never materialize).
   - **Return code (R2-3):** verified+durable → 2xx; **permanent** fail (amount/hash/binding mismatch) → durably record `manual_reconciliation`+alert → **2xx**; **transient** (DB/handler) → **non-2xx** (PixelPay retries 3×/15min).
7. **Sweep (hosted-specific):** `created`/`creating` past `expires_at`+window with no paid callback → `manual_reconciliation` (NOT `failed` — paid-but-lost is possible; I6). `expired` only when we can be sure no payment occurred (kept for the genuinely-abandoned majority; for a low-volume shop, dispatcher dismisses these).

## Money-safety invariants
- **I1** Server sets `_amount`; customer can't change it. **I2** Verify `toCents(callback.amount)==order.total_cents`.
- **I3** `payment_hash==MD5(hosted_order_id|key_id|secret)` + `ref==attempt.hosted_order_id` bind to THIS attempt; `hosted_order_id` persisted in the CAS claim pre-call.
- **I4** Materialize once (`materialized_at`); retries idempotent. **I5** Webhook 2xx after durable (paid OR permanent-fail-recorded); non-2xx only transient; `_complete` UX-only.
- **I6** No-callback is ambiguous → `manual_reconciliation`, never `failed`.
- **I7** Single create-claim; deterministic+pre-persisted `hosted_order_id` → paid callback recovers a crashed `creating`; never blind re-create.
- **I8** Amount/binding mismatch → `manual_reconciliation`+alert, never auto-confirm.
- **I9** Cancel of an active hosted attempt **with no uuid** → `cancel_pending` (+order `cancelled`), NOT refunded; a later paid callback → auto-void. With a P- uuid → void via `void_signature`.
- **I10** Exactly **one live (payable) checkout per order**: double-submit reuses the live URL. A new checkout is allowed **only while `order.status=='pending_payment'` AND** the prior attempt is a **non-money terminal** (`expired`/abandoned or failed-create). `paid` → `already_paid` (never a new checkout); `cancelled`/`voided`/`refund_pending` → order closed, no new checkout. Never two payable checkouts (R3-1, R4).
- **I11** Every outcome maps to exactly one `hosted_state`.
- **I12** **Only a verified+authenticated `paid` callback and `expired_at` are authoritative.** `_cancel`/`failed`/`_complete` are telemetry — they never confirm money, terminate an attempt, or free a second checkout (R3-1, R3-2). All callbacks require the `_callback` secret.

## What changes / reused / removed
**New:** `pixelpay-hosted.js` (separate hosted client; form/query fields; sandbox+prod pinned by tests); hosted-specific sweep + reconcile (keyed on `hosted_callback_verified`/`paid_amount_cents`/`payment_hash_verified`); `PIXELPAY_WEBHOOK_SECRET`.
**Changed:** `chargeOnlineOrder` (CAS-claim w/ pre-persisted hosted_order_id + one-live-checkout reuse → hosted/other → URL); order form (redirect; email field+fallback; remove SDK card form/3DS iframe/`doAuth`); webhook (secret auth, verify paid callback, JSON+form, return-code policy, telemetry-only non-paid); `cancelPaidOrder` (no-uuid active hosted → `cancel_pending`); `_complete` status page (poll by token).
**Reused:** `clientSignature`, pending-order creation, materialize, **void** on P- uuid, dashboard Pedidos + dispatcher actions.
**Removed:** `doAuth`, `doCapture`, capture verification, in-page SDK card flow, auth/capture-specific sweep/reconcile branches.

## Email (R1-12)
Add an optional email field to the order form (customer receipt); blank → fall back to a valid merchant address (`pedidos@xpizza.hn`). `_email` must always be a valid email.

## Build / test
1. **Pin the real callback shape + content-type** via the sandbox simulator's "execute callback" BEFORE coding the verifier.
2. Unit: `_client_signature` KAT, `toCents`, payment_hash verify, callback parse (JSON+form), **webhook-secret reject**, create-claim idempotency / one-live-checkout, cancel-race, `hosted_state` map.
3. Sandbox e2e: success / failed-callback-then-retry-pays / `_cancel`-then-late-paid / callback-retry / stale-creating-recovered-by-paid-callback / forged-callback-rejected.
4. Go-live smoke: one small prod `/hosted/other` charge + a real void.

## Out of scope
AUTH+Capture (bank-denied); in-page card entry (hosted = redirect).
