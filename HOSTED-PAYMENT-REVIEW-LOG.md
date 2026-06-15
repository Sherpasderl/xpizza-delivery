## Hosted Payment Plan — Codex Adversarial Review
MAX_ROUNDS=5. Plan: HOSTED-PAYMENT-PLAN.md

## Round 1 — Codex

**Findings**

1. [HOSTED-PAYMENT-PLAN.md:44](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:44) conflicts with the existing webhook behavior: [index.js:1127](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/index.js:1127) marks almost any non-throw outcome as `done` and [index.js:1131](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/index.js:1131) always returns 200, which would suppress PixelPay retries on DB/write/materialization failures. Fix: hosted webhook must return 2xx only after verified callback data and durable order/attempt updates, otherwise return non-2xx so PixelPay retries.

2. [HOSTED-PAYMENT-PLAN.md:34](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:34) says stale hosted orders can be swept/failed, but in hosted flow “no callback” can mean “paid but callback lost,” because no pre-callback `payment_uuid` exists. Fix: after `expired_at + callback_retry_window`, move unresolved hosted attempts to `manual_reconciliation`, not `failed`, unless a PixelPay-side authoritative unpaid/cancelled signal is available.

3. [HOSTED-PAYMENT-PLAN.md:47](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:47) leaves double-submit unresolved, and the current reuse path [pixelpay-charge.js:69](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/pixelpay-charge.js:69) would let `chargeOnlineOrder` call `hosted/other` again unless the new code explicitly persists/reuses the first hosted URL. Fix: store `hosted_checkout_url`, `hosted_created_at`, `hosted_expires_at`, and exact `_order_id`, and return the existing live URL for retries.

4. [HOSTED-PAYMENT-PLAN.md:21](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:21) has a crash gap after `hosted/other`: if PixelPay creates a payable checkout but the function dies before saving/returning the URL, retry can create another payable checkout. Fix: add a hosted-create state machine with a single “creating/created” claim and treat unknown post-create failures as manual review unless PixelPay documents idempotency for `_order_id`.

5. [HOSTED-PAYMENT-PLAN.md:25](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:25) says verify `amount == order.total`; comparing JS numbers or formatted strings is unsafe. Fix: parse callback amount as decimal HNL into integer centavos and compare to `order.total_cents`.

6. [HOSTED-PAYMENT-PLAN.md:46](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:46) treats bare `order_id` vs `pixelpay_order_id` as open, but this is not optional for replay safety: a late callback for an old hosted session can otherwise bind only to the order, not the active payment attempt. Fix: use `${order_id}-${attempt_id}` as `_order_id`, verify callback `ref/order` equals the active attempt’s stored hosted order id, and reject superseded attempts.

7. [HOSTED-PAYMENT-PLAN.md:40](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:40) says to reuse `sweepStalePending`, but current sweep [index.js:1159](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/index.js:1159) is auth/capture-specific and calls `runConfirm` or abandons based on `payment_uuid`. Fix: split hosted sweep logic from auth/capture sweep logic.

8. [HOSTED-PAYMENT-PLAN.md:40](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:40) says to reuse `reconcilePayments`, but current reconciliation [index.js:1205](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/index.js:1205) requires a captured attempt, which hosted payments will not have unless you fake capture fields. Fix: add hosted-specific verified fields such as `hosted_callback_verified`, `paid_amount_cents`, `payment_hash_verified`, and reconcile against those.

9. [HOSTED-PAYMENT-PLAN.md:36](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:36) assumes existing void works, but [cancelPaidOrder](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-functions/index.js:1389) only voids when a UUID is already stored; cancelling an active hosted checkout before callback can mark `refunded` while the customer can still pay. Fix: do not mark active hosted attempts refunded without a P- UUID; either expire/cancel the hosted checkout at PixelPay or mark `cancel_pending_payment` and auto-void if a later paid callback arrives.

10. [HOSTED-PAYMENT-PLAN.md:24](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:24) assumes callback JSON and `_complete?paymentHash=…`; the existing extractor is tolerant, but the hosted plan should not bake in one content type or redirect param name without a prod/sandbox capture. Fix: implement callback parsing for JSON and form-encoded bodies, log raw field names safely, and make `_complete` poll by `order_id`/token rather than depending on redirect hash fields.

11. [HOSTED-PAYMENT-PLAN.md:12](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:12) likely under-specifies hosted signing: current `clientSignature` helper can compute HMAC, but the current server client posts JSON transaction APIs with auth headers, while hosted says query/form fields. Fix: create a separate hosted client that sends exactly PixelPay’s required form/query fields and headers, with sandbox/prod probes pinned in tests.

12. [HOSTED-PAYMENT-PLAN.md:14](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:14) lists `_email` as required, but the order form currently does not collect customer email and the old flow used a hardcoded fallback [index.html:2229](/Users/xavierlacayo/Downloads/xpizza-delivery/xpizza-orders/index.html:2229). Fix: either add email collection/validation or explicitly document and test an accepted merchant fallback email.

VERDICT: REVISE
### Claude's response (round 1)
Accepted ALL 12 findings — all valid + money-safety-relevant. Revisions: create-claim state machine + reuse live checkout URL (3,4,10); retry-safe webhook 2xx-only-after-durable (1); missing-callback → manual_reconciliation not failed (2); integer-centavo amount compare (5); _order_id=${order_id}-${attemptId} + binding check, reject superseded (6); separate hosted client/sweep/reconcile fields (7,8,11); cancel of no-uuid active hosted via cancel_pending + auto-void on late paid callback (9); parse JSON+form callback, _complete polls by order_id/token (10); email field + valid fallback (12); added 'pin real callback shape in sandbox' build step.

## Round 2 — Codex

Prior round-1 findings are mostly addressed: #1-#3, #5-#12 are explicitly covered in Rev 2. #4 is only partially fixed, and that partial fix creates the main remaining blocker.

**Findings**

1. [HOSTED-PAYMENT-PLAN.md:20](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:20) only claims `hosted_state=creating`, while [line 22](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:22) persists `hosted_order_id` only after PixelPay returns; if PixelPay creates the checkout and immediately sends a callback before that persist, [line 28](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:28) can reject a real paid callback because `active attempt.hosted_order_id` is missing. Fix: set `hosted_order_id`, `hosted_created_at`, `hosted_expires_at`, and poll token in the same CAS claim before calling PixelPay.

2. [HOSTED-PAYMENT-PLAN.md:23](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:23) says stale `creating` goes to manual review, but with deterministic `_order_id=${order_id}-${attemptId}` the webhook can still verify and recover paid callbacks even if the checkout URL was never persisted. Fix: distinguish “stale creating with valid paid callback” from “stale creating with no callback”; accept the former and materialize/void per normal rules.

3. [HOSTED-PAYMENT-PLAN.md:30](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:30) says “otherwise return non-2xx,” but [line 31](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:31) has permanent verification failures that should not be retried forever once durably recorded. Fix: return 2xx after durable `manual_reconciliation` for permanent amount/hash/binding failures; reserve non-2xx for transient handler/storage failures.

4. [HOSTED-PAYMENT-PLAN.md:26](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:26) omits hosted failure/cancel handling even though sandbox has fail/cancel scenarios [line 59](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:59); unresolved cancelled checkouts would sit until manual reconciliation. Fix: define `_cancel` and failed-status callback behavior as non-money terminal states that mark the attempt `cancelled`/`failed` and allow a fresh hosted attempt.

5. [HOSTED-PAYMENT-PLAN.md:12](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:12) defines `hosted_state` without `manual_reconciliation`, `failed`, `cancelled`, or `refund_pending`, but later sections rely on those outcomes. Fix: make the hosted attempt enum complete and map each webhook/sweep/cancel outcome to exactly one terminal or retryable state.

VERDICT: REVISE
### Claude's response (round 2)
Accepted all 5. Rev 3: persist deterministic hosted_order_id+created_at+expires_at+poll_token IN the CAS claim BEFORE calling PixelPay (R2-1); stale 'creating' recovers via a valid paid callback, only no-callback stale → manual (R2-2); webhook returns 2xx after durable permanent-fail (manual_reconciliation) AND success, non-2xx only on transient errors (R2-3); _cancel + failed-status callbacks are non-money terminals (cancelled/failed) allowing a fresh attempt (R2-4); completed the hosted_state enum + outcome map, added I11 (R2-5).

## Round 3 — Codex

Round-2 items 1, 2, 3, and 5 are resolved in Rev 3: `hosted_order_id` is pre-persisted, stale `creating` can recover from a paid callback, return-code policy distinguishes permanent vs transient failures, and the hosted state enum is now explicit.

**Still Material**

1. [HOSTED-PAYMENT-PLAN.md:42](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:42) treats the customer-facing `_cancel` redirect as a non-money terminal, but redirects are not authoritative and can race with or be manually hit before a delayed paid callback. This can let the customer retry while the first hosted checkout is still payable, creating double-charge risk or a paid callback for a now-superseded attempt. Fix: make `_cancel` UX-only, or mark only `customer_cancel_seen` while keeping the attempt eligible to accept/void a later paid callback until expiry plus retry window.

2. [HOSTED-PAYMENT-PLAN.md:41](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:41) says a failed-status callback marks the attempt `failed`, but the plan does not require authentication/binding for non-paid callbacks. A forged failed callback could close a live attempt and allow a fresh checkout while the original is still payable. Fix: accept failed/cancel server callbacks only if they are authenticated via a webhook secret embedded in `_callback` or have an equivalent verifiable PixelPay binding; otherwise ignore or treat as non-authoritative telemetry.

VERDICT: REVISE
### Claude's response (round 3)
Accepted both. Rev 4 adds an explicit AUTHORITY MODEL: only (a) a verified+authenticated paid callback and (b) expired_at are authoritative; _cancel/failed/_complete are telemetry that never confirm money, terminate an attempt, or free a 2nd checkout (R3-1). _cancel → customer_cancel_seen flag, attempt stays payable until expiry; failed-status callback → last_failed_callback_at flag, attempt stays live (customer can retry same checkout). Added PIXELPAY_WEBHOOK_SECRET on the _callback URL — webhook rejects any callback without it before acting (R3-2). I10 hardened to 'exactly one live payable checkout per order' (reuse live URL; new checkout only after prior paid/voided/expired). Added I12.

## Round 4 — Codex

Rev 4 resolves the two round-3 findings: `_cancel` and failed callbacks are telemetry only, callbacks are secret-gated, and the one-live-checkout rule now blocks retry/double-pay races while the checkout remains payable.

One remaining material ambiguity: [HOSTED-PAYMENT-PLAN.md:42](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:42) says a new attempt/checkout may be created once a prior attempt is `paid`/`voided`/`expired`. `paid` must never permit another checkout for the same order, and `voided` is only retryable in some cases; a void caused by cancellation, mismatch, or post-paid reversal should not reopen the order. Fix: state that `paid` returns `already_paid`, and a fresh checkout is allowed only when the order is still `pending_payment` and the prior attempt is non-money expired/abandoned or an explicitly retryable failed create, never after paid/cancelled/mismatch-voided states.

VERDICT: REVISE
### Claude's response (round 4)
Accepted. Rev 5: tightened the fresh-checkout rule — paid → already_paid (never a new checkout); a new checkout only when order.status=='pending_payment' AND the prior attempt is a non-money terminal (expired/abandoned or failed-create); never after paid/cancelled/voided/refund_pending. Updated flow step 2 + I10.

## Round 5 — Codex

Final pass: the round-4 issue is addressed. The plan now explicitly returns `already_paid` for paid attempts and only allows a new checkout while the order is still `pending_payment` and the prior attempt is a non-money terminal. The authority model, webhook secret, paid callback verification, retry behavior, callback/redirect races, cancel-before-callback path, stale checkout handling, and one-live-checkout rule are now coherent enough to implement.

Minor note: the header still says “Rev 4” on [HOSTED-PAYMENT-PLAN.md:2](/Users/xavierlacayo/Downloads/xpizza-delivery/HOSTED-PAYMENT-PLAN.md:2), but that is documentation hygiene, not a material payment-safety issue.

VERDICT: APPROVED