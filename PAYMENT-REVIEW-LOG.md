# Plan Review Log: Wire PixelPay online card payment into the X Pizza order flow
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5. PLAN_FILE=PAYMENT-PLAN.md.

Grill decisions (9 + defaults):
1. Card data → client-side PixelPay SDK tokenization (token only on server; PCI minimized).
2. Sequencing → pending-first (write pending_payment order, no tasks, hidden; charge; confirm→tasks+new; decline→payment_failed→swept).
3. Source of truth → webhook-authoritative + signature verification + reconciliation sweep backstop.
4. 3DS → in-page SDK/iframe; abandon → no webhook → swept.
5. Double-charge → order_id idempotency anchor + server-side charging lock + poll-on-ambiguity.
6. Refund-on-cancel → auto-void(unsettled)/refund(settled) + refund_pending manual fallback.
7. Scope → online for delivery+pickup; on failure offer cash/card-on-delivery; never an unpaid live order.
8. Tax → ISV 15% tax-INCLUSIVE; charged amount unchanged; store subtotal/tax/total; breakdown on display/receipt.
9. Factura → fires on status→new transition (not raw creation), idempotent, carrying tax+payment payload; refund→nota_credito signal.
Defaults: charge server-recomputed total; immediate sale/capture; new functions chargeOnlineOrder/pixelPayWebhook/sweepStalePending(15-min TTL); dispatch/driver trust only payment_status+reference; WhatsApp on confirm only; delete raw-card path + demo shortcut.

---

## Round 1 — Codex
Thread: 019eaeb4-1564-79e3-a519-919155ba4e87 · read-only

1. `status→new` + task/tracking creation not atomic (RTDB txn is single-location); crash between leaves a paid order with no tasks, and later confirmers skip (status already new). Fix: idempotent+recoverable materialization (deterministic task IDs + materialized_at marker + a reconciling trigger/outbox).
2. Single-transaction guard ≠ exactly-once side effects (WhatsApp/factura/auto-assign). Fix: durable per-effect markers (received_whatsapp_sent_at, factura_requested_at, materialized_at); retry only missing ones.
3. Client polling contradiction: polls the tracking record, but tracking is created only at confirmation — a pending/3DS/failed order has nothing to poll. Fix: create a minimal public payment-status record BEFORE charging, or return a poll token from chargeOnlineOrder.
4. Cash/card fallback collides with createOrder idempotency: existing order_id as payment_failed → createOrder returns idempotent success, no live cash order created. Fix: explicit convertFailedOnlineToCOD txn, or force a new order_id for fallback + bind the failed attempt abandoned.
5. order_id = PZX-YYMMDD-HHMMSS (1-sec granularity) → two customers collide; with payment idempotency one is charged/blocked against another's order. Fix: high-entropy randomness in order_id + server-side payload fingerprint on retries.
6. KDS shows unpaid pending orders — kitchen maps unknown status → 'Nuevo' (index 1094) and doesn't filter pending_payment/charging/payment_failed. Fix: explicitly filter non-live payment states from every /orders reader (KDS, dispatch, driver, dashboard, metrics).
7. Webhook validation underspecified: needs raw-body signature, timestamp tolerance + stale-reject, event-id dedup (replay), fail-closed parsing, constant-time.
8. Webhook amount/identity integrity missing: confirm only if PixelPay's authoritative txn matches expected order_id + payment_uuid + amount(HNL) + currency + merchant + final success state.
9. 15-min sweep can expire valid 3DS: "no webhook" ≠ abandoned if PixelPay still reports pending/requires_action. Fix: sweep queries PixelPay; only fail TERMINAL non-approved states; leave pending while challenge active.
10. Cancelling pending/charging ≠ "no money moved" (charge may be in flight / approved-not-confirmed / auth pending). Fix: cancellation of charging must reconcile with PixelPay + void/refund any auth/capture before finalizing.
11. PixelPay dedupe-by-order_id is assumed/open; if it needs an explicit idempotency key, order_id alone won't stop dup charges on transport ambiguity. Fix: persist a PixelPay idempotency key / payment_attempt_id before first charge; reuse for retry + status lookup.
12. Refund handling can silently lose money: refund_pending has no reconciler/queue/alerting/retry. Fix: scheduled refund reconciler + dispatcher queue + aging alerts + immutable refund attempt records.
13. Existing client cancelOrder has no payment guard — a dispatcher could cancel a paid online order without refund. Fix: route paid-online cancellations through a Cloud Function; deny client-side cancellation writes for paid online orders.
14. Money representation loose: PixelPay likely expects minor units / exact decimals; totals are integer lempiras, tax 2dp. Fix: canonical money type — currency HNL + integer minor units for provider calls + derived decimal display.
15. Observability/reconciliation too thin. Fix: scheduled daily PixelPay-vs-RTDB reconciliation + alerts for every money-risk invariant (paid-not-new, new-not-confirmed, dup payment, aged refund_pending, webhook failures).

**VERDICT: REVISE**

### Claude's response (Round 1)
Verified the most code-grounded claims: #4 (createOrder returns idempotent for existing order_id — index.js:384), #5 (genOrderId is 1-sec granularity — xpizza-orders/index.html:1418), #6 (KDS defaults unknown status→'Nuevo' at :1094, no payment_status awareness). All confirmed.

**Accepted: all 15.** None bad-faith; several are real money-loss/atomicity holes. Revisions folded into PAYMENT-PLAN.md:
- Rewrote confirmation as an **atomic multi-path `update()`** (status+tasks+tracking+payment fields together) claimed by a status transaction, with **deterministic task IDs + `materialized_at`**, plus a **reconciling DB trigger** that completes materialization for any confirmed-but-unmaterialized order (#1). Added **per-effect idempotency markers** (`materialized_at`, `received_whatsapp_sent_at`, `factura_requested_at`) so WhatsApp/factura/auto-assign fire exactly once (#2).
- Added a **pre-charge public payment-status record** so the client always has something to poll (#3).
- **order_id** now gets a high-entropy suffix + a **server payload fingerprint**; a persisted **PixelPay idempotency key / payment_attempt_id** is the charge-dedup anchor (#5, #11).
- Added an explicit **`convertFailedOnlineToCOD`** server path for the cash fallback (no createOrder idempotency collision) (#4).
- Added an explicit **"hide non-live payment states from every reader"** workstream (KDS/dispatch/driver/dashboard/metrics), incl. fixing the KDS unknown→Nuevo default (#6).
- Hardened the **webhook**: raw-body signature, timestamp tolerance, event-id replay dedup, constant-time, fail-closed — and **re-fetch + match** order_id/payment_uuid/amount/currency/merchant/final-state from PixelPay before confirming (#7, #8).
- **Sweep** now queries PixelPay and only fails **terminal** non-approved states; leaves valid in-progress 3DS pending (#9).
- **Cancel** of `charging`/paid routed through a function that reconciles + voids/refunds first; client cancellation writes for paid online orders denied (#10, #13).
- Added a **refund reconciler + dispatcher refund_pending queue + aging alerts + immutable refund-attempt records** (#12).
- Defined a **canonical money type** (HNL, integer **centavos** for provider calls, derived decimal display) (#14).
- Added a **daily PixelPay↔RTDB reconciliation + money-invariant alerts** function (#15).
No rejections. Proceeding to Round 2.

---

## Round 2 — Codex (resumed)
Addressed: #3, #5, #6, #9, #12, #14, #15 (and #11 in principle). Remaining partials + new issues:

Partials — 1 (confirm claim writes only payment_status; crash before persisting reference/uuid/charged_at leaves recovery unable to materialize → persist verified confirmation data BEFORE claiming confirmed); 2 (external WhatsApp/factura sends can't be atomic with RTDB markers → durable outbox w/ provider idempotency + pending/sent/failed, at-least-once); 4 (cash/COD fallback doesn't handle LATE PixelPay approval after conversion → converted/abandoned attempts must never materialize, must void/refund); 7 (webhook event must be marked done only AFTER handling succeeds → processing/done/failed state, don't suppress retry of unfinished events); 8 (also match payment_attempt_id = active attempt, not just order_id/uuid/amount); 10 (cancelling `charging` needs an atomic cancel-vs-confirm race guard → a `cancelling` claim; late approval after cancel → void/refund not new); 13 (RTDB: broad `orders/$id .write` to dispatchers can't be "denied" by a narrower child rule → remove broad dispatcher writes to paid-online status, route through Cloud Functions).

New material issues — A: chargeOnlineOrder missing `present & pending_payment` claim case (crash between pending write and charging set leaves a stuck order) → matching-fingerprint pending_payment must be claimable into charging. B: `autoAssignOnOrderCreate` fires only on order CREATE (before==null, index.js:1661); online materialize is an UPDATE → never auto-assigns → fire on the status→new transition w/ tasks present. C: fresh attempts after payment_failed need attempt history `/payment_attempts/{attempt_id}` (active/failed/abandoned/converted/refunded); confirm only the active attempt (else old-attempt webhooks confirm wrong state). D: define the fingerprint exactly — exclude token/card/challenge/transient; include canonical priced cart + customer + delivery coords/address + order_type + total_cents. E: separate enums `order.status` vs `payment_status` (existing code uses status:'new'); never test one as the other.

**VERDICT: REVISE**

### Claude's response (Round 2)
Verified B: `autoAssignOnOrderCreate` is create-only (`before !== null) return` at index.js:1661) → confirmed it would fire on the pending create and miss materialization. **Accepted all** Round 2 points. Revisions:
- Added a **`/payment_attempts/{attempt_id}`** subtree (status active/approved/failed/abandoned/converted/voided/refunded) as the charge source-of-truth; **only the ACTIVE attempt can materialize**; late webhooks/sweeps for non-active attempts → **void/refund**, never `new` (resolves #4, #8, #10, C, 11).
- **Confirmation ordering (1):** webhook/charge persists the **verified payment data** (reference/uuid/amount/attempt) into the attempt record **before** the order's `payment_status` is claimed `confirmed`; the recovery trigger reads from the attempt record.
- **Outbox (2):** `/outbox/{id}` records for WhatsApp/factura with provider idempotency where available + `pending/sent/failed`, at-least-once semantics (factura system already idempotent on order_id).
- **Webhook event state (7):** `/webhook_events/{id}` = `processing/done/failed`; mark `done` only after handling succeeds; unfinished events remain retryable.
- **chargeOnlineOrder claim cases (A):** explicit `present & pending_payment & matching-fingerprint → claim into charging w/ new attempt`.
- **Auto-assign (B):** retrigger on the **status→new transition** (tasks present, order_type delivery), unifying cash (created `new`) + online (materialized `new`).
- **Cancel race (10):** a `cancelling` claim state; confirm and cancel converge via the attempt state machine; post-cancel approvals → void/refund.
- **Rules (13):** remove the broad dispatcher `orders/$id` write that lets the client mutate paid-online status; route paid-online cancel/status mutations through Cloud Functions; default-deny `/payment_attempts`, `/webhook_events`, `/outbox`, `/refund_attempts`.
- **Enums (E):** `order.status` (pending_payment | new | preparing | ready | out_for_delivery | delivered | cancelled) vs `payment_status` (pending | confirmed | failed | refunded | refund_pending) vs `payment_attempt.status` — distinct, never cross-tested. `charging` becomes an attempt/lock state, not an order.status.
- **Fingerprint (D):** defined exactly (priced cart items+qty+extras, customer, delivery lat/lng+address, order_type, total_cents; excludes token/card/3DS/transient).
- **order_id suffix uses a CSPRNG (5); KDS unknown→Nuevo default added to implementation test list (6).**
No rejections. Proceeding to Round 3.

---

## Round 3 — Codex (resumed)
"Most Round 2 issues are now addressed at the plan level… materially stronger." 5 still material (all implementation-precision):
1. Active-attempt claim not atomic enough — two concurrent calls could mint two attempts/charges before the pointer is durable. Fix: mint attempt_id before the order txn; the txn installs active_attempt_id (lock); retries reuse the pointer.
2. CONFIRM guard impossible at the stated path — a txn on `orders/{id}/payment_status` can't check sibling `active_attempt_id`. Fix: transact on the whole `orders/{id}` node.
3. Still cross-tests enums — claim cases said `charging/new/confirmed` as comparable order states. Fix: rewrite predicates in precise order.status/payment_status/active_attempt_id/attempt.status terms.
4. Pre-charge poll record can stay stuck — CONFIRM didn't update it. Fix: every terminal path (confirm/decline/converted/cancelled/refund) updates the poll record.
5. Materialize creates both tasks unconditionally — pickup orders get no driver tasks. Fix: materializeLiveOrder() branches by order_type.

**VERDICT: REVISE**

### Claude's response (Round 3)
**Accepted all 5** (implementation-precision, not new architecture; convergence is clear). Edits:
- attempt_id minted up front; **one transaction on the whole `orders/{id}` node** installs `active_attempt_id` (atomic charge lock) — concurrent calls can't double-mint (1).
- **CONFIRM claim = transaction on the whole order node**, checking `payment_status==pending` && `active_attempt_id==this` && not cancelling/cancelled together before setting confirmed (2).
- Rewrote all claim/confirm predicates in **precise enum terms** (3).
- **Every terminal path updates `order_tracking/{token}.phase`** (confirmed/declined/converted/cancelled/refund_pending) (4).
- **`materializeLiveOrder(order_type)` branches**: delivery → pickup+delivery tasks + auto-assign; **pickup → no tasks, no auto-assign** (5).
No rejections. Proceeding to Round 4.

(Round 4 = APPROVED; see below. The entries below it are a post-approval re-review triggered by an architecture change after reading PixelPay's real docs.)

---

## Architecture re-check — Codex (resumed, after PixelPay docs)
Trigger: PixelPay 3DS is client-side only, so the SALE moved server→browser (server signs + confirms via getStatus). Codex: "does not break I1/I2/I5 if server confirmation stays authoritative, but materially weakens I3/I7/I8 unless a sale is bound to a specific active attempt." 6 issues:
1. Local attempt_id not bound to the PixelPay transaction (browser sends order_id; getStatus matches order_id/amount only) → late/old/converted/second-sale approvals are indistinguishable. Fix: per-attempt PixelPay order id (`order_id + '-' + attempt_id`); confirm only if getStatus reports that exact active identifier.
2. I3 (≤1 charge) no longer server-locked — browser can call SaleTransaction repeatedly for the signed order_id. Fix: require a documented PixelPay duplicate-order guarantee OR treat duplicate approved payment_uuids as expected → void/refund every non-winner + alert.
3. x-client-signature not amount-bound — a tampered browser can charge a different amount under the signed order_id; rejecting confirmation isn't enough (customer charged). Fix: approved-but-mismatched amount/tax/currency/status → auto void/refund, refund_pending on failure.
4. payment_hash = MD5(order_id|key_id|secret) is not proof. Fix: signed getStatus is the SOLE authority; payment_hash = early sanity hint only.
5. Shipping sha512(secret) to the browser is credential-like/reusable. Fix: don't log/store client-side; restrict app URL/origin if supported; confirm with PixelPay it enables nothing beyond a signed browser sale.
6. Plan still has contradictory old "chargeOnlineOrder charges PixelPay server-side" text. Fix: remove/update it.

**VERDICT: REVISE**

### Claude's response (architecture re-check)
**Accepted all 6** — the re-check was worth it; these are real holes the browser-sale model opens. Revisions:
- Added **`pixelpay_order_id = ${order_id}-${attempt_id}`** as the per-attempt PixelPay identifier; the x-client-signature signs it, the browser sale uses it, and CONFIRM only materializes if `getStatus` is for the **active attempt's** pixelpay_order_id (1). A same-attempt retry reuses it (dedup); a fresh attempt mints a new one.
- **getStatus = sole authority**; payment_hash demoted to an optional early sanity check (4).
- **Amount/currency/status mismatch on an approved charge → auto void/refund** (refund_pending on failure), not just "reject" (3). Same for any non-active-attempt approval (I8).
- **Reconciler/sweep:** detect duplicate approved `payment_uuid`s per pixelpay_order_id → void all non-winners + alert (2); flagged the "does PixelPay enforce unique order_id?" question.
- **Security note:** treat `sha512(secret)` as public-but-sensitive SDK material — never logged/stored client-side; restrict origin if supported; confirm scope with PixelPay (5).
- **Removed the contradictory server-charge flow text**; chargeOnlineOrder now unambiguously "signs + returns config, never charges" (6).
No rejections. Re-submitting.

---

## Round 4 — BLOCKED (Codex usage limit)
Codex resumed the thread but the turn failed: *"You've hit your usage limit… try again at Jul 7th, 2026 1:08 PM."* No verdict produced. Act 2 cannot continue until the Codex (ChatGPT-account) quota resets ~2026-07-07, or a different Codex account/plan is used.

**State at block:** 3 completed rounds, all REVISE but **rapidly converging** — R1 (15 findings) → R2 (partials + new) → R3 ("most issues addressed, materially stronger"; 5 implementation-precision items). All R3 fixes applied to PAYMENT-PLAN.md (v-after-R3) but **not yet Codex-verified**. This is NOT a Codex-APPROVED plan and NOT a deadlock — it's an external-quota block on the verification round.

_(Resolved: user upgraded the Codex ChatGPT account to Plus + re-logged in; quota restored. Round 4 ran.)_

---

## Round 4 — Codex (resumed, on Plus)
"The five Round-3 blockers are addressed well enough in v4 … **No remaining material money-safety flaw in the plan itself.**" Three implementation cautions (explicitly **not** plan blockers):
1. Don't literally check `order.status === 'cancelling'` — cancellation claim lives on the **attempt**, not the order.
2. Branching on `attempt.status` while transacting `orders/{id}` needs **read-then-transaction + post-transaction recheck** (RTDB can't atomically read `/payment_attempts` inside an `orders/{id}` transaction).
3. Add a test for the **`active_attempt_id` exists but attempt record missing** recovery path (must not mint a second attempt).

**VERDICT: APPROVED**

### Convergence
Act 2 complete after 4 rounds (REVISE → REVISE → REVISE → APPROVED) within MAX_ROUNDS=5. R1 15 findings → R2 partials+new → R3 5 precision → R4 approved. 0 rejections across all rounds. The 3 R4 cautions folded into PAYMENT-PLAN.md "Implementation notes" + the enum fix applied. Awaiting user sign-off before any code. **No code written.**

---

## Architecture re-check Round 2 — Codex (resumed)
Re-submitted after folding the 6 prior findings into the main flow. Codex: "core direction now right," findings 1–6 addressed in the main flow, but **4 new material gaps — all in the stale `PixelPay integration contract` section** (I'd updated lifecycle/Approach but not the contract block):
1. Contract section still used old binding: `HMAC(app_key|order_id|app_url)`, `MD5(order_id|key_id|secret)`, "dedup rests on order_id" — while the rest moved to `pixelpay_order_id`. Fix: replace every PixelPay-facing `order_id` with `pixelpay_order_id`; clarify void signature keying.
2. Contract still listed `payment_hash == MD5 AND getStatus` as the confirm predicate. Fix: MD5 mismatch may fail fast, MD5 match is NEVER a confirm predicate; signed getStatus is sole authority.
3. Duplicate approved `payment_uuid` voiding was only under DAILY reconcile → hours of exposure; overclaimed "enforces I3." Fix: run dedup/void inline in every confirm/webhook/sweep path; daily = backstop.
4. `getStatus`/`void` keyed by `payment_uuid` vs `sweep query by pixelpay_order_id` may be incompatible — if PixelPay can't look up by `pixelpay_order_id`, a lost client-result + lost webhook = paid order with no `payment_uuid`, undiscoverable until ledger reconciliation. Fix: confirm PixelPay status-lookup-by-order-id, else add durable result capture.

**VERDICT: REVISE**

### Claude's response (architecture re-check R2)
**Accepted all 4** — they were real (I'd missed the contract block on the first revision). Revisions:
- **Contract §3 rewritten:** PixelPay-facing id is now `pixelpay_order_id` everywhere (signature, sale, payment_hash, void); signed `getStatus` = SOLE authority; `payment_hash` = early sanity hint only (mismatch may fail fast, match never confirms) (1, 2).
- **Inline duplicate-charge guard** added to §B as the *primary* control (confirm/webhook/sweep void the losing `payment_uuid` in-path via an attempt transaction); §I daily reconcile demoted to explicit **backstop** for duplicates no live path saw (3).
- **Gap #4 made explicit:** sweep looks up by **durably-captured `payment_uuid` first** (client-POST + webhook = two independent captures), falling back to `pixelpay_order_id` only if PixelPay supports that lookup — flagged as a build-time confirm with the no-payment_uuid failure mode spelled out (4).
- Also reconciled stragglers: **I7** and the §A/§G pseudocode now say `pixelpay_order_id`.
No rejections. Re-submitting.

---

## Architecture re-check Round 2 — Codex (resumed) — APPROVED
"The four re-check findings are addressed in the main plan … **No new material money-safety issue in the plan.**" One restated hard launch gate (already named in the plan, not a new finding): before launch, confirm PixelPay can either report `payment_uuid` reliably via client-POST/webhook **or** support lookup/listing by `pixelpay_order_id` — else the "paid but no order until ledger reconciliation" case is too slow for production.

**VERDICT: APPROVED**

### Convergence (architecture re-check)
The browser-sale refinement passed Act 2 after 2 re-check rounds (REVISE 6 → REVISE 4 → APPROVED), both within the same thread. The R4-APPROVED money-safety core held; the re-check only hardened the browser-sale binding (`pixelpay_order_id` per attempt, getStatus-sole-authority, inline duplicate void, durable payment_uuid capture). Plan is Codex-approved for the current architecture. **No code written during the re-check.** Stage 3a crypto helpers (architecture-independent) shipped earlier stay valid. Next: Stage 3b `chargeOnlineOrder`.

---

## SDK-accuracy revision (before Stage 4) — read @pixelpay/sdk-core v2.5.2 source
Pulled the real SDK (npm) and read it rather than trusting the API doc. Material finding: **the SDK has no x-client-signature / HMAC / SHA3** — its auth is just `x-auth-key` + `x-auth-hash` (+`x-auth-user` for void, `x-auth-secure` for encrypted card). `x-client-signature` is a raw-API/Postman-only path. Since our browser uses the SDK, **the server does NOT sign the sale**; the browser charges with the public key+hash; the server's roles are the pending-first state machine + independent `getStatus` confirmation. Raw secret needed only for `void_signature` + optional `payment_hash`.

Exact specs now known (were TBD): status = `POST api/v2/transaction/status {payment_uuid}`; void = `POST api/v2/transaction/void {payment_uuid, void_reason, void_signature}`; `payment_hash = MD5(order_id|auth_key|secret)` (matches pixelpay.js); confirm fields from `TransactionResult` = `response_approved`, `transaction_approved_amount`, `payment_uuid`, `payment_hash`.

Plan edits: rewrote the integration-contract architecture (server no longer signs; browser uses public key+hash); pseudocode + §A return `{mode,endpoint,key,hash,order,callback}` with NO signature; §B/I7 confirm = `getStatus` authoritative for approval+amount, `payment_hash` supplies the `payment_uuid`↔`pixelpay_order_id` binding the status entity omits (reconciles re-check #4 without making MD5 the approval decision); webhook signature scheme now MOOT (nudge-only + re-verify); Risks updated (resolved vs still-sandbox-pin). Stage 3b's returned `client_signature` flagged vestigial (remove at implementation).

Net: a **simplification** — removes the server-signing component; no money-safety invariant weakened (getStatus was always the authority; void path unchanged). Re-submitting to Codex for re-approval of the simplified architecture before Stage 4 code.

---

## SDK-accuracy revision — Codex round 1 (resumed)
Codex: simplified architecture "close, but one material binding issue." **Binding-replay attack:** if the `payment_hash` used for binding comes from the browser/webhook (client-supplied), an attacker can pay order A (→ real `payment_hash(A)`), pay an unrelated transaction B for the correct amount (→ `payment_uuid(B)`), then submit `payment_uuid(B)+payment_hash(A)` to confirm A — `getStatus(B)` proves amount/approval, the replayed hash "proves" A, nothing proves B belongs to A. Fix: the binding `payment_hash` MUST come from the signed `getStatus(payment_uuid)` response; server ignores client/webhook hash; sandbox-pin that getStatus returns `payment_hash` or an order/reference field (else not confirm-safe). Plus: remove the stale "x-client-signature signs it" sentence; `payment_hash` uses `pixelpay_order_id` everywhere PixelPay-facing.
**VERDICT: REVISE**

### Claude's response
**Accepted — sharp catch, real hole.** The SDK supports the fix: `TransactionResult` (what `status` returns) HAS a `payment_hash` field, so we bind using the **status-returned** hash, not the client's. Revisions: §B confirm rewritten — neither the webhook/client `payment_hash` nor its order id is trusted; approval+amount AND the binding (`getStatus`-returned `payment_hash` == `MD5(active.pixelpay_order_id|auth_key|secret)`) both come from getStatus; documented the exact replay it defeats; added the HARD sandbox-pin (getStatus must return payment_hash or an order/ref field, else not confirm-safe). Contract §3 + identifiers + lifecycle pseudocode + I7 + Risks all updated to "status-returned hash" and `pixelpay_order_id`. Removed the stale signature sentence. No rejections. Re-submitting.

---

## SDK-accuracy revision — Codex round 2 (resumed) — APPROVED
"The confirm path is now structurally sound" — binding uses the `getStatus`-returned `payment_hash` (not client payloads); replay/mix-and-match attack documented + defeated; I7 correct; stale `x-client-signature` removed; Risks use `MD5(pixelpay_order_id|auth_key|secret)`. "No new material issue." Remaining launch gates already called out: sandbox must prove `getStatus` returns `payment_hash` or an order/reference field; void signature/order-id expectation pinned before production.
**VERDICT: APPROVED**

### Convergence (SDK-accuracy revision)
Simplified (server-doesn't-sign) architecture passed Act 2 after 2 rounds (REVISE binding-replay → APPROVED). The change was a net simplification grounded in the real SDK source; the one real hole Codex found (client-supplied binding hash) is closed by binding on the status-returned hash. Plan is Codex-approved for Stage 4. **No code written during this revision.** Stage 4 may proceed, gated by the named sandbox pins (getStatus payment_hash/order-ref; void signature keying).
