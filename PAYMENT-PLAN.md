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
- **`payment_status`**: `pending` → `confirmed` | `failed` | `refunded` | `refund_pending` |
  `manual_reconciliation` (paid-but-lost-capture-response → dispatcher verifies vs ledger). (Cash/COD:
  not set / `n/a`.)
- **`payment_attempts/{attempt_id}.status`**: `active` (auth pending) → `capturing` (claim held) →
  `captured` (confirmed) | `declined` | `abandoned` | `converted` (to COD) | `voided` | `refunded`.
  **The attempt record is the charge source of truth.** `active`/`capturing` are attempt/lock concepts,
  **not** `order.status`.

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
- **I7** Confirm **only** on a **server `doCapture` response** (`response_approved` +
  `transaction_approved_amount`==`amount_cents` (lempiras) + `currency(HNL)`) bound to the **active attempt's
  `pixelpay_order_id`** via the capture-response `payment_hash == MD5(pixelpay_order_id|auth_key|secret)`.
  The server sets the captured amount; `getStatus` is liveness-only, never the confirm authority.
- **I8** A non-active attempt (abandoned/converted/cancelled) whose `payment_uuid` PixelPay later reports
  captured/paid is **voided/refunded, never materialized**. An uncaptured auth simply expires (no money).

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
  attempt reuses it (natural dedup). The browser **auth** uses it as `order.id`, and CONFIRM binds the captured
  `payment_uuid` to the **active attempt's** `pixelpay_order_id` via the **`doCapture`-response** `payment_hash`
  (server-obtained, never client-supplied — see §B). *(Whether PixelPay enforces unique `order.id` is TBD — the
  reconciler voids any duplicate captured `payment_uuid` per `pixelpay_order_id`.)*
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
          ← chargeOnlineOrder NEVER calls PixelPay; the browser runs the AUTH with PUBLIC key+hash (3DS client-only)

browser SDK: setupSandbox()/setupCredentials → doAUTH(order.id=pixelpay_order_id) + withAuthenticationRequest() → in-page 3DS
             → TransactionResult{payment_uuid}  (an AUTH HOLD, not a capture; best-effort report to server; webhook is durable)

CONFIRM (authoritative = SERVER doCapture, NOT getStatus — sandbox-proven 2026-06-10):
  trigger: client-POST payment_uuid | webhook nudge | sweep. Resolve the ACTIVE attempt.
  server doCapture(payment_uuid, transaction_approved_amount = our total in lempiras)  [key+hash, server-to-server]
    → capture RESPONSE is authoritative + server-obtained:
         response_approved===true  &&  transaction_approved_amount===our total  &&
         payment_hash===MD5(active.pixelpay_order_id|auth_key|secret)   ← binding from OUR capture call, never the client
    → ALL hold → CONFIRM ; else (declined / amount>auth / hash-mismatch) → VOID + fail, never materialize  [I7/I8]
  (getStatus(payment_uuid)=liveness only: paid/voided/refunded — used by sweep/reconcile, NOT to confirm.)
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
calls PixelPay** — the browser SDK runs the **3DS auth** with the public key+hash (3DS is client-only). The
browser may best-effort POST its `payment_uuid` back, but it is not trusted (the server captures + verifies).

### B. Confirm path — **server `doCapture` is the authority** (sandbox-proven 2026-06-10)
> The browser does a 3DS **AUTH** (hold), not a sale. `getStatus(payment_uuid)` was probed and returns
> only `{status, attemps, history}` — **no amount, no order id, no payment_hash** — so it canNOT verify the
> charge. The **server's own `doCapture` call** is the authoritative confirmer: the server sets the captured
> amount, and the capture **response** (server-obtained) returns `response_approved`, `transaction_approved_
> amount`, and `payment_hash == MD5(pixelpay_order_id|auth_key|secret)`. See `payments-probe/FINDINGS.md`.
- **`/webhook_events/{event_id}` state machine** = `processing → done | failed`; mark `done` **only after**
  confirm/void handling succeeds; unfinished events stay **retryable** (#7).
- The webhook/client-POST is just a **nudge** carrying a *claimed* `payment_uuid`; nothing in the payload is
  trusted (no signature needed — still add a shared-secret query param, like `onIncomingWhatsApp`).
- **Confirm = capture, then verify the capture response (all server-side):**
  1. Resolve the **active** attempt; if `payment_status==='confirmed'` already → no-op (idempotent). Read the
     attempt's `captured` guard — **never capture twice** (see idempotency below).
  2. `getStatus(payment_uuid)` first as a cheap pre-check: if already `paid` (captured by a prior run that
     crashed before we recorded it) skip to verify/recover; if `voided/declined` → fail; if auth-pending →
     capture.
  3. `doCapture(payment_uuid, transaction_approved_amount = total_cents→lempiras)` `[POST api/v2/transaction/
     capture, {payment_uuid, transaction_approved_amount}, headers key+hash]`.
  4. **Verify the capture response** (server-obtained — the client never supplies these): `response_approved
     === true` && `transaction_approved_amount === our total` (HNL) && **`payment_hash ===
     MD5(active.pixelpay_order_id | auth_key | secret)`**.
- **Why this is binding-safe (defeats Codex's replay):** the `payment_hash` comes from **our** capture call's
  response for the `payment_uuid` we captured — not paired by the client. A mismatched `payment_uuid` (an auth
  for some *other* order B) either **can't be captured for our amount** (capture > B's auth → declined → no
  money moves) or, if B's auth ≥ our amount, the capture returns `payment_hash(B) ≠ payment_hash(A)` → binding
  fails → we **immediately VOID that capture** (refund_pending on failure) and never materialize (I7/I8).
- **Amount-safe:** the **server** sets the captured amount, so a tampered browser auth can't make us capture
  the wrong amount; an under-auth just makes capture fail (no loss). *(Sandbox-pin that capture > auth is
  rejected — standard processor invariant.)*
- **Idempotency + lost-capture recovery (Codex gate, sandbox-resolved 2026-06-10):** before capturing, a
  **transaction on `/payment_attempts/{id}`** sets a `capturing` claim with **`capturing_started_at` + the
  `payment_uuid` being captured**; only the claim-winner calls `doCapture`; the verified result is then
  persisted (`status:'captured'`). **A 2nd `doCapture` on an already-captured uuid returns `412 "Error al
  encontrar el cobro"` with NO data (probed)** — so re-capture CANNOT recover the result, and `getStatus` is
  too thin to verify amount/binding. Therefore recovery is split by the claim:
  - attempt **not** `capturing` (no `doCapture` was sent) → safe to capture now.
  - attempt `capturing`, result missing → look up `getStatus(payment_uuid)`: still an **uncaptured auth** →
    (re)capture (no money moved yet); **`paid`** → a capture succeeded but we lost the verifiable response →
    route to **`payment_status:'manual_reconciliation'`** (dispatcher verifies against the PixelPay ledger;
    materialize-by-hand or refund) — **NEVER auto-materialize to `new`** (can't reverify amount/binding);
    **voided/declined** → `failed`.
  Because the server set the capture amount = our total, a stray `paid` is almost certainly our amount, but we
  refuse to *assume* it — manual reconciliation is the safe sink for this sub-second crash window.
- **Inline duplicate guard (I3):** the attempt-lock already caps one active attempt per order; if a *second*
  captured `payment_uuid` ever appears for the same `pixelpay_order_id` (e.g. two auths both captured), the
  loser is **voided/refunded in-path** + alerted; daily `reconcilePayments` is the backstop.

### C. CONFIRM / materialize — durable-ordered, atomic, recoverable, exactly-once
1. **Persist the verified capture result first** into `/payment_attempts/{attempt_id}` (`status:'captured'`,
   `payment_uuid`, `payment_reference` (`transaction_reference`), `amount_cents`, `captured_at`) — **before**
   touching the order (#1). This is written only after the §B capture-response verification passes. The
   recovery trigger reads from here.
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
Call `chargeOnlineOrder` → use the returned config to set up the PixelPay SDK (`setupSandbox()` /
`setupCredentials`) and run **`doAuth(order(id=pixelpay_order_id)) + withAuthenticationRequest()`** (in-page
3DS) with the customer's card (SDK-encrypted; **no raw card on our servers**). On auth success → **POST the
`payment_uuid` to a `confirmOnlinePayment` endpoint** (best-effort; webhook is the durable trigger) and
**poll the order's payment_status** (never re-run the auth). Pay button disabled in flight. **Delete** the
old raw-card `/api/pixelpay-charge` path + demo shortcut. Failure/abandon → "Pago no completado" → **retry
card / cash / card-on-delivery** (§F).

### F. Cash/COD fallback (#4) — attempt-aware
The fallback marks the failed online **attempt `converted`** and creates the live cash order via an
explicit **`convertFailedOnlineToCOD`** path with a **fresh `order_id`** (no `createOrder` idempotency
collision). A **late PixelPay approval for a `converted`/`abandoned` attempt → void/refund, never
materialize** (I8) — handled by the webhook/sweep attempt-status check.

### G. `sweepStalePending` (sched ~5 min) — capture/void backstop
For attempts with a **recorded `payment_uuid`** (client-POST or webhook) that are past a short TTL and still
not confirmed: `getStatus(payment_uuid)` → if an **uncaptured auth** still live → run the §B **capture-confirm**
(the lost-nudge recovery); if **already `paid`** but no verified capture result was persisted → **`manual_
reconciliation`** (NOT auto-materialize — getStatus can't reverify amount/binding, and re-capture returns 412;
see §B); if **`voided/declined/expired`** → mark attempt `failed`. An attempt with **no recorded `payment_uuid`** can't be
looked up (the SDK has no by-`pixelpay_order_id` lookup; gap #4) — its **auth simply expires server-side at
PixelPay (no capture = no money moved)**, so it's a *missed order*, not a *lost charge*; surface it to the
daily reconcile + dispatcher alert. **Never** expire a live in-page 3DS mid-flow.

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
Functions: `chargeOnlineOrder`, `confirmOnlinePayment` (client-POST nudge → capture), `pixelPayWebhook`,
`cancelPaidOrder`, `convertFailedOnlineToCOD` (HTTPS);
`sweepStalePending`, `reconcilePayments`, `refundReconciler`, `outboxWorker` (sched/trigger);
`materializeOnConfirm` + retriggered auto-assign (DB triggers). Refactor `createOrder`'s order+tasks+tracking
into shared `materializeLiveOrder()`. New RTDB subtrees (default-deny): `/payment_attempts`,
`/webhook_events`, `/outbox`, `/refund_attempts`, `/payment_tracking`. Rules: narrow dispatcher order writes
(#13). Readers: live-status filter (#6). Client: payment UX. Move WhatsApp-received into the outbox.

## Key decisions & tradeoffs
Encrypted card (no raw card on our servers); pending-first (I1); **browser 3DS AUTH + server `doCapture` as
the authoritative confirm** (server sets the amount; binding via the capture-response `payment_hash`) + sweep
backstop; 3DS in-page; **attempt-record idempotency / capturing-claim** (I3,I8); auto-void/refund + reconciler;
fail→cash via convert path; atomic materialize + recovery trigger + outbox (I4,I5); canonical centavos; charge
server total only; narrowed RTDB write rules (#13).

## PixelPay integration contract (read from `@pixelpay/sdk-core` v2.5.2 source, 2026-06-09)
- **SDK:** `@pixelpay/sdk-core` (browser JS). Settings/Card/Billing/Item/Order models;
  SaleTransaction/StatusTransaction/VoidTransaction/CardTokenization requests; Transaction/Tokenization
  services; TransactionResult/CardResult entities.
- **No server signing:** the SDK has **NO `x-client-signature`/HMAC/SHA3** (only MD5 for `auth_hash`/
  `payment_hash`, SHA-512 for `void_signature`). SDK auth = **`x-auth-key` + `x-auth-hash`** only
  (`base/ServiceBehaviour.js`). The browser runs its part with the **public** key+hash; the raw secret is
  needed only server-side for `payment_hash` verification + `void_signature`.
- **Architecture = browser 3DS AUTH (hold) + SERVER `doCapture` (authoritative). Sandbox-proven 2026-06-10
  (`payments-probe/`).** Why not "browser sale → getStatus confirm": `getStatus(payment_uuid)` returns only
  `{status, attemps, history}` — **no amount, no order id, no payment_hash** — so it can't verify a charge.
  `doCapture` runs **server-side** with a **server-set amount** and its **response** carries everything we need.
  1. `chargeOnlineOrder` (server): validate → write `pending_payment` order + **active attempt** (mint
     `pixelpay_order_id = ${order_id}-${attempt_id}`) → return
     `{mode, endpoint, app_key (x-auth-key), auth_hash (x-auth-hash), order(id=pixelpay_order_id, amount,
     tax, currency:HNL), order_callback}` — **no signature**, does NOT call PixelPay. `auth_hash` is the
     portal hash used VERBATIM (sandbox `MD5(secret)` / prod "Public key" `SHA-512(secret)`; never re-derived).
     *(Stage 3b currently returns a vestigial `client_signature` — remove it when reconciling 3b.)*
  2. Client SDK: encrypts card (SDK fetches merchant RSA key `api/v2/merchant/public_key`, ships via
     `x-auth-secure`) → **`AuthTransaction(order(id=pixelpay_order_id))` + `withAuthenticationRequest()`**
     (in-page 3DS) → `TransactionResult{payment_uuid}` = an **AUTH HOLD** (no capture). Card data → PixelPay
     only. Browser best-effort POSTs `payment_uuid` to the server; the webhook is the durable channel.
  3. Server CONFIRM (authoritative): `doCapture(payment_uuid, transaction_approved_amount = total→lempiras)`
     (`POST api/v2/transaction/capture`, body `{payment_uuid, transaction_approved_amount}`, headers key+hash).
     The capture **response** (server-obtained `TransactionResult`) must satisfy: `response_approved===true`
     && `transaction_approved_amount===our total` && **`payment_hash === MD5(active.pixelpay_order_id |
     auth_key | secret)`** (binding from OUR call, not the client). Else → **VOID** + fail (never materialize).
     `getStatus` is **liveness only** (sweep/reconcile: paid/voided/refunded), never the confirm authority.
- **Amount-safe + binding-safe (sandbox-verified):** server sets the captured amount (tamper → capture fails,
  no loss); the binding `payment_hash` is from the server's own capture response (defeats the client-supplied-
  hash replay Codex flagged). Capture-`>`-auth must be rejected — **sandbox-pin** (standard processor invariant).
- **Amounts = decimal LEMPIRAS.** `order_amount`/capture amount = inclusive grand total; `order_tax_amount` =
  ISV portion (informational). Convert `total_cents`→lempiras at the boundary. *(Sandbox-verify the unit + that
  `order_amount` isn't increased by `order_tax_amount`.)*
- **`capture`/`getStatus`/`void` keyed by `payment_uuid`.** Durably capture `payment_uuid` from the
  client-POST and/or webhook nudge (two independent channels). **OPEN (gap #4):** the SDK has no lookup by
  `pixelpay_order_id` — if BOTH channels are lost, an auth with no recorded `payment_uuid` is invisible to the
  sweep until ledger reconciliation; an uncaptured auth simply **expires** (no money moved), so this is a
  *missed order*, not a *lost charge*.
- **Void (same-day):** `setupPlatformUser(SHA-512(merchant_email))` → `x-auth-user`;
  `void_signature = SHA-512(auth_user|pixelpay_order_id|secret)`; `POST api/v2/transaction/void` body
  `{payment_uuid, void_reason, void_signature}` headers key+hash+user; server-only. Settled-refund
  availability TBD. *(Confirm whether void's signature expects `pixelpay_order_id` or the bare order id —
  sandbox-verify.)*
- **No explicit idempotency key** — dedup rests on `pixelpay_order_id` (unique per attempt) + the attempt
  lock + a **`capturing` claim** (one capture per attempt); duplicate captured `payment_uuid`s are voided (§B/§G/§I).
- **Crypto (Node `crypto`):** `payment_hash` = MD5(`pixelpay_order_id|auth_key|secret`) — **verified against
  the live sandbox capture response 2026-06-10**; `void_signature` = SHA-512(`auth_user|pixelpay_order_id|
  secret`); `auth_user` = SHA-512(merchant_email) — server-side with the raw secret. **No HMAC-SHA3 /
  x-client-signature** (the SDK doesn't use it). *(`pixelpay.js`'s HMAC-SHA3 helper is unused — drop later.)*
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
- **RESOLVED by live sandbox probe (2026-06-10, `payments-probe/`):** endpoints `auth`/`capture`/`status`/
  `void` under `api/v2/transaction/`; auth = `x-auth-key`+`x-auth-hash` (+`x-auth-user` for void); requests
  need **`env:"sandbox"`** in the body. `getStatus(payment_uuid)` → only `{status, attemps, history}` (NO
  amount/order/hash) ⇒ **not a confirm authority**. **Server `doCapture` IS authoritative** — response gives
  `response_approved` + `transaction_approved_amount` + `payment_hash == MD5(pixelpay_order_id|auth_key|
  secret)` (binding verified equal in sandbox). Webhook signature scheme MOOT (nudge-only; add shared-secret
  query param as defense-in-depth). No x-client-signature.
- **RESOLVED (probe 3):** a 2nd `doCapture` on an already-captured uuid → **412 "Error al encontrar el cobro",
  no data**. So re-capture is NOT a recovery path; **lost-capture-response → `manual_reconciliation`, never
  `new`** (hard rule). The `capturing` claim (+`capturing_started_at`+`payment_uuid`) distinguishes crash-
  before-capture (safe to capture) from crash-after (manual reconcile).
- **STILL OPEN — sandbox-pin during Stage 4 build:** (1) **capture > auth is rejected** (the amount-safety
  invariant — must verify, not just assume); (2) `getStatus` `status` enum values (paid/declined/voided/
  refunded/…) for the liveness/sweep logic; (3) void's `void_signature` keying (`pixelpay_order_id` vs bare
  id) + `x-auth-user` format; (4) amount unit (decimal lempiras) confirmed by an approved capture; (5) does an
  uncaptured auth expire on its own (assumed — confirms the "missed order not lost charge" claim).
- Concurrency: that capturing-claim → persist-capture → confirm-claim → materialize ordering and the recovery
  trigger can't double-capture or double-materialize (capturing-claim + materialized marker guarded).

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
