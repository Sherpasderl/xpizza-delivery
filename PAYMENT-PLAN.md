# Plan: Wire PixelPay online card payment into the X Pizza order flow
_Locked via grill — by Claude + Xavier · revised after Codex Rounds 1–2_

## Goal
Add **online card payment (PixelPay)** alongside cash and card-on-delivery, turning the
fire-and-forget `createOrder` into a **money-safe, idempotent payment state machine** robust to:
(1) paid-but-no-order, (2) order-but-declined, (3) double-submit, (4) webhook before/after order,
(5) 3DS abandoned. Cardholder data never touches our servers (PixelPay SDK tokenization). Cash /
card-on-delivery unchanged. ISV 15% tax-inclusive; the order carries the tax breakdown for the
separate factura/SAR system.

## State model & enums (E — three orthogonal axes, never cross-tested)
- **`order.status`** (operational): `pending_payment` → `new` → `preparing` → `ready` →
  `out_for_delivery` → `delivered`; or `cancelled`. Cash/COD start at `new`. *(KDS/dispatch/driver
  show only `new`+.)*
- **`payment_status`**: `pending` → `confirmed` | `failed` | `refunded` | `refund_pending`. (Cash/COD:
  not set / `n/a`.)
- **`payment_attempts/{attempt_id}.status`**: `active` → `approved` | `declined` | `abandoned` |
  `converted` (to COD) | `voided` | `refunded`. **The attempt record is the charge source of truth.**
`charging` is an attempt/lock concept, **not** an `order.status`.

## Money-safety invariants
- **I1** order record exists before any charge.
- **I2** `order.status==='new'` (live: tasks + on KDS) **iff** `payment_status==='confirmed'` w/ verified
  `payment_reference` (or cash/COD).
- **I3** ≤ one successful charge per order — enforced by a persisted **idempotency key** + a single
  **active** attempt, not by `order_id` alone.
- **I4** Exactly-once side effects (tasks, tracking, WhatsApp-received, factura, auto-assign) via durable
  markers/outbox.
- **I5** Confirmation converges (sync / webhook / sweep → one materialized state; re-runs no-op).
- **I6** No money on a dead order — void/refund or tracked `refund_pending`; nothing silently lost.
- **I7** Confirm **only** on a PixelPay-authoritative `getStatus(payment_uuid)` (`response_approved` +
  `transaction_approved_amount`==`amount_cents` + `currency(HNL)`) bound to the **active attempt's
  `pixelpay_order_id`** (via `payment_hash`, and the raw status order field if present).
- **I8** A non-active attempt (abandoned/converted/cancelled) that PixelPay later approves is
  **voided/refunded, never materialized**.

## Canonical money type
`total_cents` (integer **HNL centavos**) is the single source of truth for charge + all comparisons.
Tax-inclusive derivation (fixed so they sum): `tax_cents = round(total_cents − total_cents/1.15)`,
`subtotal_cents = total_cents − tax_cents`. `computeServerTotal` returns `total_cents`; client amount
never trusted. PixelPay calls use the unit PixelPay expects (pin centavos-vs-decimal at build).

## Identifiers, idempotency, fingerprint
- **`order_id`** = `PZX-YYMMDD-HHMMSS-<8 chars from crypto.randomBytes>` (CSPRNG; kills the 1-sec
  collision).
- **`attempt_id`** = server-minted id, persisted under `/payment_attempts/{attempt_id}` with
  `{order_id, status:'active', total_cents, pixelpay_order_id, payment_uuid?, created_at}`.
- **`pixelpay_order_id`** = **`${order_id}-${attempt_id}`** — the per-attempt identifier sent to PixelPay
  as `order.id` (binds a sale to ONE attempt — finding 1). Each attempt is a DISTINCT PixelPay order, so a
  late approval from an old/converted attempt or a second sale is distinguishable; a retry of the SAME
  attempt reuses it (natural dedup). The browser sale uses it as `order.id`, and CONFIRM binds the queried
  `payment_uuid` to the **active attempt's** `pixelpay_order_id` via the **`getStatus`-returned** `payment_hash`
  (never a client-supplied one — see §B). *(Whether PixelPay enforces unique `order.id` is TBD — the reconciler
  voids any duplicate approved `payment_uuid` per `pixelpay_order_id`.)*
- **Fingerprint** = stable hash over **canonical priced cart (item ids+qty+extras), customer, delivery
  lat/lng + address, order_type, total_cents** — **excludes** token/card/3DS/transient fields. A
  later call with the same `order_id` but a different fingerprint is **rejected (409)**.

## Order lifecycle (online)
```
chargeOnlineOrder:  (attempt_id minted UP FRONT)
  write order_tracking/{token} = {phase:'payment_pending'}     (pre-charge poll record)
  CLAIM via ONE transaction on the WHOLE orders/{id} node (checks all fields together):
    absent                                              → write {order.status:pending_payment,
                                                            payment_status:pending, fingerprint,
                                                            active_attempt_id:A}          (no tasks)
    order.status==pending_payment & fp-match & no active_attempt_id  → set active_attempt_id:A
    order.status==pending_payment & active_attempt_id set:
        attempt.status==active                          → REUSE, do NOT charge again        [I3]
        attempt.status==declined                        → set active_attempt_id:A (fresh attempt)
    payment_status==confirmed (order.status==new)        → return state, no charge
    fingerprint-mismatch                                 → 409
  upsert /payment_attempts/A {active, pixelpay_order_id = order_id + "-" + A}
  RETURN {mode, endpoint, app_key (x-auth-key), auth_hash (x-auth-hash),
          order(id=pixelpay_order_id, amount=lempiras, tax=ISV, currency=HNL, callback)}   ← NO signature
          ← chargeOnlineOrder NEVER calls PixelPay; the browser SDK runs the sale with PUBLIC key+hash (3DS client-only)

browser SDK: setupSandbox()/setupCredentials → doSale(order.id=pixelpay_order_id) + withAuthenticationRequest() → in-page 3DS
             → TransactionResult{payment_uuid, payment_hash, response_approved, transaction_approved_amount}
             (best-effort report to server; webhook is durable)

pixelPayWebhook / poll (authoritative): getStatus(payment_uuid) [key+hash] → response_approved && approved_amount==total;
             bind via the STATUS-RETURNED payment_hash == MD5(active.pixelpay_order_id|auth_key|secret)  (ignore client hash;
             sandbox-pin that status returns payment_hash or an order ref) → CONFIRM ; approved-but-mismatched → VOID/REFUND
sweepStalePending: lookup by captured payment_uuid (status takes payment_uuid only) → approved→CONFIRM | terminal→fail | active→leave
CONFIRM: persist verified pay-data into attempt FIRST → claim payment_status=confirmed → atomic materialize
```

## Approach

### A. `chargeOnlineOrder` (HTTPS) — orchestrator
Reuses `validateOrderPayload` (+ server `total_cents`, sanitize, radius, order_id charset), rate-limited.
**`attempt_id` is minted up front**; a single `transaction` on the **whole `orders/{id}` node** installs
`active_attempt_id` (the atomic charge lock) so two concurrent calls cannot mint two attempts (finding 1).
Claim cases in precise enum terms: **absent** → write `order.status:'pending_payment'`,
`payment_status:'pending'`, fingerprint, `active_attempt_id`; **`order.status=='pending_payment'` & fp-match
& no `active_attempt_id`** → install it (covers a crash between the pending write and the lock — finding A);
**`order.status=='pending_payment'` & `active_attempt_id` set** → `attempt.status=='active'` ⇒ REUSE (no
second charge), `=='declined'` ⇒ set a fresh `active_attempt_id`; **`payment_status=='confirmed'`** → return
state, no charge; **fingerprint-mismatch** → 409. Then upsert `/payment_attempts/{attempt_id}` (active, with
`pixelpay_order_id = ${order_id}-${attempt_id}` — recreate from the pointer if missing) and **return the
config to the browser (mode/endpoint/key/hash + order id/amounts — NO signature). `chargeOnlineOrder` NEVER
calls PixelPay** — the browser SDK runs the sale with the public key+hash (3DS is client-only). The browser
may best-effort POST its result back, but it is not trusted.

### B. `pixelPayWebhook` / confirm path — authoritative confirmer
- **`/webhook_events/{event_id}` state machine** = `processing → done | failed`; mark `done` **only after**
  confirm/refund handling succeeds; unfinished events stay **retryable** (don't suppress a retry of an
  event we haven't finished) (#7).
- The webhook/client-POST is just a **nudge** carrying a *claimed* `payment_uuid` (+ claimed
  `pixelpay_order_id`); **neither the payload's `payment_hash` nor its order id is trusted.** Everything used
  to confirm comes from **`getStatus(payment_uuid)`** (`POST api/v2/transaction/status`, headers key+hash):
  - **approval + amount** — `response_approved` === true && `transaction_approved_amount` === our total &&
    `currency:HNL`. (Authoritative; this is the whole point of getStatus.)
  - **`payment_uuid`↔`pixelpay_order_id` binding** — verify the **`payment_hash` RETURNED BY `getStatus`**
    equals `MD5(active_attempt.pixelpay_order_id | auth_key | secret)`. The hash is secret-keyed and comes
    from PixelPay's own status response for *that* `payment_uuid`, so it cannot be paired by the client.
  - **BINDING-REPLAY ATTACK this defeats (Codex):** pay A → get real `payment_hash(A)`; pay unrelated B for
    the right amount → get `payment_uuid(B)`; submit `payment_uuid(B)+payment_hash(A)` for A. If we trusted the
    *client* hash this confirms A on B's money. Using the **status-returned** hash, `getStatus(B)` returns
    `payment_hash(B)≠payment_hash(A)` → binding fails → no confirm.
  - **SANDBOX-PIN (hard gate for Stage 4):** confirm `getStatus(payment_uuid)` actually populates
    `payment_hash` (the `TransactionResult` entity has the field) **or** an order/reference field. If it
    returns **neither**, this architecture is **not confirm-safe** and needs a different PixelPay
    reference/lookup mechanism before launch.
  CONFIRM only when attempt is **active** + status-returned binding holds + approved + amount matches.
- **Any approved-but-mismatched charge** (wrong/non-active `pixelpay_order_id`, or amount/tax/currency/status
  mismatch) → **auto void/refund** (`refund_pending` if the void fails), **alert**, never `new` (I7/I8,
  re-check #1/#3). Rejecting confirmation is NOT enough — the customer may have been charged.
- **Inline duplicate-charge guard (primary control, re-check #3):** confirm/webhook/sweep all bind the
  winning `payment_uuid` to the attempt via a **transaction** on the attempt; if a *second* approved
  `payment_uuid` arrives for the same `pixelpay_order_id`, the loser is **voided/refunded immediately in
  that same path** (not left for the daily job). The daily `reconcilePayments` is only the **backstop** for
  duplicates that no live path saw (e.g. both results lost). This is where I3 is actually enforced.

### C. CONFIRM / materialize — durable-ordered, atomic, recoverable, exactly-once
1. **Persist verified pay-data first** into `/payment_attempts/{attempt_id}` (`status:'approved'`,
   `payment_uuid`, `payment_reference`, `amount_cents`, `captured_at`) — **before** touching the order
   (#1). The recovery trigger reads from here.
2. **Claim** via a `transaction` on the **whole `orders/{id}` node** (so order-node siblings are checked
   together): proceed only if `payment_status==='pending'` && `active_attempt_id===this attempt` &&
   `order.status !== 'cancelled'`; then set `payment_status:'confirmed'`. The **attempt's** status (the
   `cancelling`/`voided` claim lives on `/payment_attempts/{id}`, NOT on `order.status`) is checked via
   **read-then-transaction + post-transaction recheck** — RTDB can't atomically read `/payment_attempts`
   inside an `orders/{id}` transaction. Only the winner continues (I5). A non-active/cancelling attempt
   reaching here → **void/refund, never confirm** (I8).
3. **Atomic multi-path `update()`** (all-or-nothing) = **`materializeLiveOrder(order_type)`**, shared with
   the cash path: `orders/{id}` (`order.status:'new'`, `charged_at`, **`materialized_at`**) +
   **driver tasks ONLY for delivery** (`tasks/{id}_pickup`+`_delivery`, deterministic IDs; **pickup orders
   get no driver tasks and no auto-assign**) + `order_tracking/{token}` (`phase:'confirmed'`) + outbox
   enqueues (WhatsApp-received + factura).
4. **Recovery trigger** `onValueWritten orders/{id}`: if `payment_status==='confirmed'` && `materialized_at`
   missing → re-run materialization idempotently (#1, I5).
5. **Outbox worker** (trigger/sched): delivers WhatsApp/factura **at-least-once** with provider idempotency
   where available; states `pending/sent/failed`; factura consumer idempotent on `order_id` (#2). Factura
   signal = the `order.status→new` materialize (carries subtotal/tax/total/payment_method/payment_reference).
6. **Poll record:** EVERY terminal path updates `order_tracking/{token}.phase` —
   `confirmed`/`declined`/`converted`/`cancelled`/`refund_pending` — so the client poll never hangs (finding 4).

### D. Auto-assign retrigger (B) + readers filter (E/#6)
- Change auto-assign to fire on the **`order.status → new` transition with tasks present**
  (order_type delivery), unifying cash (`new` at create) + online (materialized `new`). Replaces the
  create-only `before!==null) return` trigger.
- **Hide non-live payment states from every reader** — `pending_payment`/`payment_failed`/etc. invisible
  to **KDS** (fix the `:1094` unknown→`'Nuevo'` default — explicit implementation test), dispatch,
  driver, dashboard, metrics. Driver shows confirmed online as **"PAGADO EN LÍNEA — no cobrar"** (trust
  `payment_status==='confirmed'`+reference only — I2).

### E. Client (order form)
PixelPay SDK tokenizes (card → PixelPay → `T-*`); **delete** the raw-card `/api/pixelpay-charge` path +
demo shortcut. Call `chargeOnlineOrder` (payload+token+order_id); pay button disabled in flight; in-page
3DS; **poll the pre-charge token** (never blind-retry the charge). Failure → "Pago no completado" →
**retry card / cash / card-on-delivery**.

### F. Cash/COD fallback (#4) — attempt-aware
The fallback marks the failed online **attempt `converted`** and creates the live cash order via an
explicit **`convertFailedOnlineToCOD`** path with a **fresh `order_id`** (no `createOrder` idempotency
collision). A **late PixelPay approval for a `converted`/`abandoned` attempt → void/refund, never
materialize** (I8) — handled by the webhook/sweep attempt-status check.

### G. `sweepStalePending` (sched ~5 min) — PixelPay-driven backstop
Past TTL, look the attempt up with PixelPay — **by the durably-captured `payment_uuid`** if we have one
(client-POST or webhook), **else by the active attempt's `pixelpay_order_id`** *(requires PixelPay status-
lookup-by-order-id; gap #4 — if unsupported, an attempt with no captured `payment_uuid` is undiscoverable
here and falls to daily ledger reconciliation — call this out at build)*: **approved** → CONFIRM; **approved
but non-active attempt / amount-mismatch** → **void/refund**; **terminal** → `failed`; **still active**
(pending/requires_action) → **leave** (never expire a live 3DS).

### H. Cancel + refund — race-guarded, reconciled (#10, #12, #13)
- **All paid/online cancellations go through `cancelPaidOrder` (Cloud Function).** RTDB rules **remove the
  broad dispatcher `orders/$id` write** so the client `cancelOrder` (RTDB-only) **cannot** mutate paid-online
  status — a parent-grant can't be "denied" by a child rule, so the grant itself is narrowed (#13).
- **Cancel-vs-confirm race (#10):** `cancelPaidOrder` sets a **`cancelling` claim** (txn) on the attempt;
  confirm and cancel converge through the attempt state machine. A charge in flight is **reconciled with
  PixelPay first**; an approval that lands after cancel → **void/refund, not `new`** (I8).
- Confirmed paid cancel → void(unsettled)/refund(settled) → `refunded` + immutable `/refund_attempts/*`;
  failure → `refund_pending`. **Refund reconciler** (sched) retries, surfaces a dispatcher queue, alerts on
  aged `refund_pending`. Refund/void after a factura printed → `nota_credito_needed` signal.

### I. Reconciliation & alerting (#15 + re-check #2)
Daily **`reconcilePayments`**: PixelPay ledger vs RTDB → alert on each invariant breach (paid-not-`new`,
`new`-online-without-confirmed, aged `refund_pending`, webhook failures). **Duplicate-charge backstop:** the
**primary** dedup runs inline in confirm/webhook/sweep (§B) — this daily pass only catches duplicate approved
`payment_uuid`s per `pixelpay_order_id` that **no live path saw** (e.g. both client-result and webhook lost):
keep the one matching the confirmed order, **void/refund every other** + alert. (I3 is enforced by the inline
guard; this is the safety net, not the control.)

### J. New/changed components
Functions: `chargeOnlineOrder`, `pixelPayWebhook`, `cancelPaidOrder`, `convertFailedOnlineToCOD` (HTTPS);
`sweepStalePending`, `reconcilePayments`, `refundReconciler`, `outboxWorker` (sched/trigger);
`materializeOnConfirm` + retriggered auto-assign (DB triggers). Refactor `createOrder`'s order+tasks+tracking
into shared `materializeLiveOrder()`. New RTDB subtrees (default-deny): `/payment_attempts`,
`/webhook_events`, `/outbox`, `/refund_attempts`, `/payment_tracking`. Rules: narrow dispatcher order writes
(#13). Readers: live-status filter (#6). Client: payment UX. Move WhatsApp-received into the outbox.

## Key decisions & tradeoffs
Tokenization (no raw card); pending-first (I1); webhook-authoritative + replay/amount/attempt verify (I7)
+ sweep backstop; 3DS in-page; **attempt-record idempotency** (I3,I8); auto-void/refund + reconciler;
fail→cash via convert path; immediate sale/capture; atomic materialize + recovery trigger + outbox (I4,I5);
canonical centavos; charge server total only; narrowed RTDB write rules (#13).

## PixelPay integration contract (read from `@pixelpay/sdk-core` v2.5.2 source, 2026-06-09)
- **SDK:** `@pixelpay/sdk-core` (browser JS). Settings/Card/Billing/Item/Order models;
  SaleTransaction/StatusTransaction/VoidTransaction/CardTokenization requests; Transaction/Tokenization
  services; TransactionResult/CardResult entities.
- **CORRECTION (supersedes the earlier "server signs" design):** the SDK has **NO `x-client-signature`,
  no HMAC, no SHA3** anywhere (only MD5 for `auth_hash`/`payment_hash` and SHA-512 for `void_signature`).
  `x-client-signature` is a **raw-API/Postman-only** auth path; the **SDK** path (what our browser uses)
  authenticates with just **`x-auth-key` + `x-auth-hash`** (`base/ServiceBehaviour.js`). So **the server
  does NOT sign the sale.** The browser runs the sale with the **public** key+hash; the server's only roles
  are (a) the pending-first state machine + (b) independent confirmation via `getStatus`. The raw secret is
  needed **only** for `void_signature` and the optional `payment_hash` check — *not* for the sale or status.
- **Architecture = browser SDK runs the sale with public credentials; server confirms independently:**
  1. `chargeOnlineOrder` (server): validate → write `pending_payment` order + **active attempt** (mint
     `pixelpay_order_id = ${order_id}-${attempt_id}`) → return
     `{mode, endpoint, app_key (x-auth-key), auth_hash (x-auth-hash), order(id=pixelpay_order_id, amount,
     tax, currency:HNL), order_callback}` to the client. **No signature.** It does NOT call PixelPay. (Every
     PixelPay-facing `order.id` is the **`pixelpay_order_id`**, never the bare internal `order_id`.)
     The browser configures the SDK via `setupSandbox()` (sandbox) or `setupCredentials(key, public_key)` +
     `setupEndpoint` (prod). **`auth_hash` is the portal-provided hash used VERBATIM** — sandbox `MD5(secret)`
     vs prod "Public key" `SHA-512(secret)`; never re-derived. *(Note: Stage 3b currently still returns a
     vestigial `client_signature` — to be removed when this is implemented.)*
  2. Client SDK: tokenize card (SDK fetches the merchant RSA key `api/v2/merchant/public_key` and ships
     encrypted card via `x-auth-secure`) → `SaleTransaction(order(id=pixelpay_order_id))` +
     `withAuthenticationRequest()` (in-page 3DS) → `TransactionResult{payment_uuid, payment_hash,
     response_approved, transaction_approved_amount, …}`. Card data → PixelPay only.
  3. Server CONFIRM — **never trusts the client**: `getStatus(payment_uuid)` (`POST api/v2/transaction/status`,
     body `{payment_uuid}`, headers key+hash) **is the authority for approval + amount** (`response_approved`
     === true && `transaction_approved_amount` === our total). **Binding uses the `getStatus`-RETURNED
     `payment_hash`** (the `TransactionResult` entity has the field): require it == `MD5(active_attempt.
     pixelpay_order_id | auth_key | secret)`. The **client/webhook `payment_hash` is ignored for binding** —
     trusting it enables a replay (pay A→hash(A); pay B→uuid(B); submit uuid(B)+hash(A)). **HARD SANDBOX-PIN:**
     getStatus must populate `payment_hash` (or an order/reference field); if it returns neither, the design is
     not confirm-safe and needs another reference mechanism. Confirm predicate: resolve attempt from claimed
     `pixelpay_order_id` → attempt **active** → status-returned `payment_hash` binds → `getStatus` approved +
     amount match → else **void/refund**. The `order_callback` **webhook is just a nudge** (safe even
     unauthenticated — getStatus re-verifies).
- **Amounts = decimal LEMPIRAS, not centavos.** `order_amount` = inclusive grand total (charged);
  `order_tax_amount` = ISV portion (informational). Convert internal `total_cents` → lempiras at the
  boundary. *(Sandbox-verify PixelPay charges `order_amount` and does NOT add `order_tax_amount`.)*
- **`getStatus` & `void` keyed by `payment_uuid`** (from the Sale response). **The `payment_uuid` must be
  durably captured** — the browser best-effort POSTs its `TransactionResult` to the server immediately, and
  the `order_callback` webhook carries it too. **OPEN (gap #4):** confirm PixelPay supports a status/list
  lookup **by `pixelpay_order_id`** (the SDK `status` request only takes `payment_uuid`). If it does NOT, a
  lost client-result *and* lost webhook leaves a paid order with **no `payment_uuid`** → sweep can't discover
  it until daily ledger reconciliation. Mitigation: persist `payment_uuid` on the attempt the instant any
  channel reports it; treat webhook + client-POST as two independent durable captures.
- **Void (same-day):** `setupPlatformUser(SHA-512(merchant_email))` → `x-auth-user`;
  `void_signature = SHA-512(auth_user|pixelpay_order_id|secret)`; `POST api/v2/transaction/void` body
  `{payment_uuid, void_reason, void_signature}` headers key+hash+user; server-only. Settled-refund
  availability TBD. *(Confirm whether void's signature expects `pixelpay_order_id` or the bare order id —
  sandbox-verify.)*
- **No explicit idempotency key** — dedup rests on `pixelpay_order_id` (unique per attempt) + our
  charging-lock / one-active-attempt; duplicate approved `payment_uuid`s are voided (see §B/§G/§I).
- **Crypto (Node `crypto`):** `payment_hash` = MD5(`pixelpay_order_id|auth_key|secret`); `void_signature`
  = SHA-512(`auth_user|pixelpay_order_id|secret`); `auth_user` = SHA-512(merchant_email) — server-side with
  the raw secret. **No HMAC-SHA3 / x-client-signature** (the SDK doesn't use it). *(`pixelpay.js` keeps its
  HMAC-SHA3 helper for now but it's unused on the SDK path — safe to drop later.)*
- **`auth_hash` (x-auth-hash) handling (re-check #5):** the portal-provided credential hash (prod "Public
  key" = `SHA-512(secret)`; sandbox = `MD5(secret)`) ships to the browser via `setupCredentials` — it is the
  SDK's primary auth credential (with `auth_key`), so by PixelPay's design it is **public SDK material**: a
  holder can submit a *sale* (money flows to the merchant; the cardholder must still enter a valid card), but
  it does NOT permit reads/voids (those need the raw secret / `x-auth-user`). **Use the portal value verbatim
  — do NOT re-derive it** (sandbox/prod derivations differ). Still: don't log it, don't store extra copies,
  restrict by **app URL / origin** if PixelPay supports it, and **confirm with PixelPay** it enables nothing
  beyond a browser sale (and whether it enforces unique `order.id` / origin pinning).

### Sandbox (verified 2026-06-09 — full test environment, no real money)
- **Endpoint** `https://pixelpay.dev` (`/api/v2/transaction/{sale,auth,capture,void}`,
  `/api/v2/tokenization/card[...]`). SDK: `settings.setupSandbox()`.
- **Public test creds:** `x-auth-key=1234567890`, `x-auth-hash=36cdf8271723276cb6f94904f8bde4b6`
  (= `MD5("@s4ndb0x-abcd-1234-n1l4-p1x3l")`), **sign with sandbox secret** `@s4ndb0x-abcd-1234-n1l4-p1x3l`.
  Carried in code as built-in constants behind `PIXELPAY_MODE=sandbox`; prod uses the `.env` creds.
- **Test cards:** VISA `4111111111111111` cvv 300, MC `5555555555554444` cvv 999, both exp `2512`.
- **Outcome is driven by `order_amount`:** `1`→success, `2`→declined, `6`→attempt-limit-exceeded,
  `8`→timeout, `9/10/11`→amount/limit exceeded, etc. (1–14) — lets us drive every failure branch.
- **3DS test cases:** only with sandbox case #1 (amount=1), swapping the card for the 3DS PANs
  (`4000000000001000` success, `…1018` failed, `…1075` lookup-timeout, `…1109` failed step-up, …).
- **Token TTL:** sandbox card tokens auto-delete 5h after creation (don't cache across a test session).

## Risks / open questions (pin from PixelPay docs / sandbox at build)
- **RESOLVED from SDK v2.5.2 source (2026-06-09):** status endpoint = `POST api/v2/transaction/status
  {payment_uuid}`; void = `POST api/v2/transaction/void {payment_uuid, void_reason, void_signature}`; auth =
  `x-auth-key`+`x-auth-hash` (+`x-auth-user` for void); **no x-client-signature** (SDK doesn't sign — server
  doesn't either); `payment_hash = MD5(pixelpay_order_id|auth_key|secret)` — bind using the **status-returned**
  hash, never the client's (Codex replay defense). **Webhook signature scheme is now MOOT** —
  the webhook is nudge-only and we re-verify via `getStatus`, so an unauthenticated/loosely-verified webhook
  is safe (still add a shared-secret query param as defense-in-depth, like `onIncomingWhatsApp`).
- **STILL OPEN — sandbox-pin before Stage 4 confirm is final:** (1) does the raw `getStatus` payload echo the
  order id / a reference, or is `payment_hash` the only `payment_uuid`→`pixelpay_order_id` binding? (2) does
  PixelPay accept a status/void lookup by `pixelpay_order_id` (gap #4 — the SDK request only takes
  `payment_uuid`)? (3) does void's `void_signature` use `pixelpay_order_id` or the bare order id? (4) amount
  unit (decimal lempiras assumed) + that `order_amount` is charged without adding `order_tax_amount`. (5) the
  signature `app_url`/origin expectation (carried over from Stage 3b).
- Concurrency: that claim→persist-attempt→confirm ordering and the recovery trigger can't double-materialize
  (recovery trigger is marker-guarded).

## Implementation notes (Codex R4 — not blockers, do at build)
- Cancellation is a claim on the **attempt** (`/payment_attempts/{id}`), never `order.status ===
  'cancelling'` — keep the enums separate in code.
- Any branch on `attempt.status` while transacting `orders/{id}` must use **read-then-transaction with a
  post-transaction recheck** (no cross-node atomic read in RTDB).
- Add an explicit test for the **`active_attempt_id` exists but the attempt record is missing** recovery
  path, so it recreates from the pointer and cannot mint a second attempt.

## Out of scope
Full SAR factura implementation (separate task; we emit signal + store data + `nota_credito_needed`);
saved-card vault, tips, partial capture/refund, multi-currency, payout dashboards; cash/COD flow changes
(beyond the shared materialize refactor).
