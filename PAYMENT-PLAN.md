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
- **I7** Confirm **only** on a PixelPay-authoritative match of `order_id` + `payment_uuid` +
  `amount_cents` + `currency(HNL)` + merchant + final-success **+ the ACTIVE `attempt_id`**.
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
- **`attempt_id`** = server-minted idempotency key, persisted under `/payment_attempts/{attempt_id}`
  with `{order_id, status:'active', total_cents, created_at}`, sent to PixelPay as its idempotency
  key, and reused for retries + status lookups. If PixelPay has **no** idempotency-key support, the
  fallback is **one active attempt + a mandatory status-lookup before any retry**.
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
  upsert /payment_attempts/A (active); charge PixelPay(amount_cents, token, order_id, attempt_id=A, callback_url)
  approved(sync) → CONFIRM ; declined → A=declined, payment_status=failed ; 3ds → return challenge

pixelPayWebhook (authoritative):  verify → re-fetch txn → match predicate(I7) → CONFIRM | fail
sweepStalePending:  query PixelPay → approved(lost webhook)→CONFIRM | terminal→fail | active→leave
CONFIRM:  persist verified pay-data into attempt FIRST → claim payment_status=confirmed → atomic materialize
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
state, no charge; **fingerprint-mismatch** → 409. Then upsert `/payment_attempts/{attempt_id}` (active —
recreate from the pointer if missing) and charge.

### B. `pixelPayWebhook` (HTTPS) — authoritative confirmer
- **`/webhook_events/{event_id}` state machine** = `processing → done | failed`; mark `done` **only after**
  confirm/refund handling succeeds; unfinished events stay **retryable** (don't suppress a retry of an
  event we haven't finished) (#7).
- Verify **raw-body HMAC signature** (constant-time) + **timestamp tolerance** (reject stale), fail-closed.
- **Re-fetch the transaction from PixelPay** and CONFIRM only on the full I7 predicate **including the
  ACTIVE `attempt_id`** (#8). Mismatch / non-active attempt → **void/refund** (I8), alert, never `new`.

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
Past TTL, query PixelPay by `attempt_id`/`order_id`: **approved** (active attempt) → CONFIRM; **approved
but non-active attempt** → void/refund; **terminal** → `failed`; **still active** (pending/requires_action)
→ **leave** (never expire a live 3DS).

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

### I. Reconciliation & alerting (#15)
Daily **`reconcilePayments`**: PixelPay ledger vs RTDB → alert on each invariant breach (paid-not-`new`,
`new`-online-without-confirmed, duplicate payment per order_id, aged `refund_pending`, webhook failures).

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

## PixelPay integration contract (confirmed from docs 2026-06-09)
- **SDK:** `@pixelpay/sdk-core` (browser JS). Settings/Card/Billing/Item/Order models;
  SaleTransaction/StatusTransaction/VoidTransaction/CardTokenization requests; Transaction/Tokenization
  services; TransactionResult/CardResult entities.
- **Architecture = browser SDK + server signature** (because `sale.withAuthenticationRequest()` 3DS is
  **client-only**, but signing must be server-side):
  1. `chargeOnlineOrder` (server): validate → write `pending_payment` order + **active attempt** → compute
     **`x-client-signature = HMAC-SHA3-512(secret, app_key|order_id|app_url)`** → return
     `{endpoint, app_key, sha512(secret), x-client-signature, order fields, order_callback}` to the client.
     **It does NOT call PixelPay.**
  2. Client SDK: tokenize card → token; `SaleTransaction(token, order)` + `withAuthenticationRequest()`
     (in-page 3DS) → `TransactionResult{payment_uuid, payment_hash}`. Card data → PixelPay only.
  3. Server CONFIRM — **never trusts the client**: verify `payment_hash == MD5(order_id|key_id|secret)`
     **AND** re-fetch signed `getStatus(payment_uuid)` and match amount/currency/approved (I7) before
     materializing. The `order_callback` **webhook is just a nudge** to run the same server confirm.
- **Amounts = decimal LEMPIRAS, not centavos.** `order_amount` = inclusive grand total (charged);
  `order_tax_amount` = ISV portion (informational). Convert internal `total_cents` → lempiras at the
  boundary. *(Sandbox-verify PixelPay charges `order_amount` and does NOT add `order_tax_amount`.)*
- **`getStatus` & `void` keyed by `payment_uuid`** (from the Sale response) → store it on the attempt
  at first response (required for the sweep/reconciler).
- **Void (same-day):** `setupPlatformUser(SHA-512(merchant_email))` → `x-auth-user`;
  `void_signature = SHA-512(auth_user|order_id|secret)`; `VoidTransaction{payment_uuid, void_reason,
  void_signature}`; server-only. Settled-refund availability TBD.
- **No explicit idempotency key** — dedup rests on `order_id` + our charging-lock / one-active-attempt.
- **Crypto (Node `crypto`):** `x-client-signature` = HMAC-SHA3-512; `payment_hash` = MD5; `void_signature`
  = SHA-512 — all server-side with the raw secret.
- **Security to confirm w/ PixelPay:** the browser flow ships `sha512(secret)` via `setupCredentials`;
  per-order signature limits reuse — confirm whether a tighter browser integration exists.

## Risks / open questions (pin from PixelPay docs at build)
- SDK tokenization + in-page 3DS API; idempotency-key support (else the one-active-attempt+status-lookup
  fallback); **webhook raw-body signature scheme + secret provisioning**; status-query + void/refund endpoints
  & settled-refund availability; centavos-vs-decimal + currency code; that the claim→persist-attempt→confirm
  ordering and the recovery trigger can't double-materialize under concurrency (recovery trigger is
  marker-guarded).

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
