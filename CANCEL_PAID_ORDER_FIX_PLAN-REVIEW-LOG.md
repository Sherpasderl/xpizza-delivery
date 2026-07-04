# Plan Review Log: dispatch cancel of a paid online order must refund

Act 2 (Codex adversarial). PLAN_FILE=CANCEL_PAID_ORDER_FIX_PLAN.md. MAX_ROUNDS=5.

## Round 1 — Codex (thread 019f2eb1) — VERDICT: REVISE

Headline: the "small fix" is actually "give `cancelPaidOrder` the same atomic-claim / phase-machine
discipline we just shipped for `resolveManualReconciliation`," and Codex's simplest-safest alternative
is to **centralize ALL dispatcher cancellation server-side** (one server `cancelOrder`: cash handled
locally, online through the money-aware state machine), leaving client RTDB-cancel for non-money paths
only.

Findings:
1. `cancel_pending` is not a real claim — the attempt tx returns `{...a, cancel_pending:true}` for EVERY
   caller, so two concurrent cancels both commit and both void. Need a unique `cancel_claim_id` CAS from
   a pre-side-effect state; only the committed-claim owner calls PixelPay.
2. `confirmOnlinePayment`'s cancel-vs-confirm check looks for `freshAttempt.cancelling`, NOT
   `cancel_pending` — the capture-in-flight path isn't closed. Set `cancelling:true` in the claim, or
   make confirm honor `cancel_pending`.
3. Void is non-idempotent → a payment_status CAS alone is underspecified: crash after CAS but
   around the PixelPay call → stuck or double-void. Need explicit phases (`cancel_claimed`,
   `refund_side_effect_started`); pre-side-effect stale → recover, post-side-effect unknown → manual_review.
4. `voidOrRefund` (shared by refundReconciler/webhook/cancel) voids BEFORE any durable side-effect
   marker. Move the marker before the external call; make retry phase-aware.
5. Final `db.ref().update(updates)` can clobber newer payment state after a stale initial read
   (webhook/manual-resolution transitions). Make the order-node finalize transactional, verifying
   active_attempt_id + payment state + cancel_claim_id.
6. `already_cancelled` "safe no-op" set {refunded,refund_pending,failed,abandoned}∪not-paid is wrong:
   failed/abandoned can carry late/persisted paid evidence. Define safe-no-op from order+attempt
   evidence, not payment_status alone.
7. Heal condition misses hosted_state==='paid'/capture_verified/paid_during_resolve/attempt
   status:'captured'. Use the SHARED paid-evidence predicate (manual-resolve.js hasPaidEvidence).
8. `active_attempt_id` missing on a cancelled+confirmed order → silently stranded. Return/alert
   manual_review when order says paid but no attempt/uuid resolvable.
9. `refund_pending`/`manual_reconciliation`/`resolving_*` not ordered vs the cancelled guard — a
   cancelled order can still be money-ambiguous/mid-resolution. Check those before any already_cancelled
   success unless a terminal verified refund exists.
10. Client "route all online" overstated — `subscribeToOrders` filters out `pending_payment`, so unpaid
    online orders aren't in `allOrders` (can't be cancelled from that path). Scope to live/materialized,
    or add a pending-payment cancellation surface.
11. Client branch on `allOrders[orderId].payment_method` can misroute legacy/stale records to the cash
    RTDB path. Default UNKNOWN → server path; only explicit `payment_method==='cash'` → client cancel.
12. No UI dedupe/disable during in-flight remote cancel → double-clicks stress the server race.
13. Auth likely OK (authorizeDispatcherAction checks /dispatchers/{uid}) but verify tenant/hub scope if
    dispatchers aren't global.
14. Simpler/safer: server-side `cancelOrder` centralizes everything; client RTDB cancel only for
    non-money/internal paths.

### Claude's response — pending owner scope decision + executor handoff (see below).

### Claude's response (rev-2)
Owner chose FULL server-side centralization + advisor converges the gate. Rewrote the plan: one
authenticated server `cancelOrder` (pure `cancel-order.js` core reusing manual-resolve.js
hasPaidEvidence/PHASE/isResolving; deps-injected wiring) is the single truth. Folded all 14 findings:
real unique `cancel_claim_id` CAS w/ committed-verify (1); claim sets `cancelling:true` to close the
confirmOnlinePayment capture-in-flight path (2); phases cancel_claimed→refund_side_effect_started w/
durable marker BEFORE the void + phase-aware recovery (3,4); transactional finalize re-verifying
attempt+payment+claim, no clobber (5); evidence-based already-cancelled via shared hasPaidEvidence, not
payment_status (6,7); missing-attempt-but-paid → manual_review+alert (8); manual_reconciliation/
resolving_* → 409 to the recon panel before any already_cancelled success (9); cancel-by-order_id
server-side moots the pending_payment-not-in-allOrders issue (10); SERVER defaults unknown
payment_method → online money-aware path, only explicit cash → cash branch (11); client disables the
per-order cancel until settle (12); enforce/attest dispatcher tenant scope (13); centralize server-side,
retire client RTDB cancel after auditing callers (14).

## Round 2 — Codex (thread 019f2eb1, resume)

### Claude's response (rev-3)
Investigated the codebase to ground the fixes. Folded all R2 findings: generalize the EXISTING
cancelPaidOrder in place (keep name/URL → 31→31, no new fn / no prune) instead of adding exports.cancelOrder
(F10); ONE uniform money-aware path for all methods with the void gated on a NEW tight
`hasCapturedMoneyEvidence` (paid_during_resolve/capture_verified/hosted_state=paid/confirmed — NOT bare
UUID, since declined auths carry UUIDs) while broad hasPaidEvidence only routes ambiguity to manual_review
(F3,F4,F11-r1,F5); order-node transaction for money/status + SEPARATE idempotent best-effort tasks/drivers
(RTDB can't span nodes) (F1); reuse existing PHASE.CLAIMED/SIDE_EFFECT_STARTED w/ resolving_action='cancel'
(no invented enum) (F2); allowed-state gate rejects delivered + orders the driver already completed (F8);
refund_pending → 409{outcome} vs already_cancelled(200)=refunded/never-captured contract defined (F6);
cancelled+manual_reconciliation (not in recon surface) → manual_review alert (F7); missing-attempt-but-paid
→ manual_review (F8-r1); dispatchers attested GLOBAL, scope-hook noted (F13); audited callers — dashboard
(:841) + driver (:862) ALSO ship client cancelOrder w/ the same bug → migrate all three surfaces to the
endpoint, retire client cancelOrder after audit, driver-cancel policy flagged to owner (F9); pending_payment
not in dispatch list → server supports by-id, UI surface out-of-scope (F10-r1). Owner: card_delivery dormant
(cash+online only) → uniform path handles it as cash, no special-case.

## Round 3 — Codex (thread 019f2eb1, resume)

### Claude's response (rev-4)
Verified field names/behavior in code, folded all 5 R3 findings: claim sets BOTH cancel_pending:true (so
pixelpay-hosted-webhook.js:77 auto-voids a late paid callback, not just confirmOnlinePayment's cancelling
check) — closes the after-claim-before-finalize materialize window (F1); finalize transaction CLEARS
cancel_claim_id/resolving_action/resolving_phase on success so a done cancel isn't seen as stale (F2);
task/driver cleanup made durable by ENHANCING onOrderCancelled (currently notify-only) to idempotently
cancel tasks + release driver current_task_id — the inline update is fast-path, the trigger guarantees
eventual consistency (F3); hasCapturedMoneyEvidence adds hosted_callback_verified (:91/:105 durable bit)
(F4); dashboard index.html:1704 online&&confirmed guard broadened to route ALL orders through the
universal endpoint, added to client checklist (F5).

## Round 4 — Codex (thread 019f2eb1, resume)

### Claude's response (rev-5)
Folded both R4 blockers: (F1-r4) scoped ALL idempotency/already_cancelled bullets to
status==='cancelled' ONLY — a LIVE order (incl. cash, no evidence) proceeds to claim+finalize, never
returns already_cancelled; (F2-r4) the onOrderCancelled task/driver cleanup MUST run FIRST, never behind
the KDS_SHEET_ID early-return or the Google Sheets try/catch — reorder or use a dedicated
cancellation-cleanup trigger.

## Round 5 — Codex (thread 019f2eb1, resume) — FINAL round (MAX_ROUNDS=5)

Codex R5: the two R4 blockers resolved, all R3 items remain covered, no new blocking design issue.

## Resolution — CONVERGED (APPROVED)
Codex-APPROVED at round 5/5 (thread 019f2eb1). The gate drove the "small button-wire" into a full
money-safe redesign: 14→11→5→2→0 findings across 5 rounds. What the two acts improved:
- Reframed the fix as "give cancel the same atomic-claim/phase discipline as resolveManualReconciliation"
  — real unique cancel_claim_id CAS + phases + phase-aware recovery, not a blind status flip.
- Closed BOTH capture-in-flight callback paths (cancelling for confirm, cancel_pending for the hosted
  webhook) and split evidence (tight hasCapturedMoneyEvidence for the void gate vs broad hasPaidEvidence
  for ambiguity routing) so declined-auth UUIDs never trigger a void.
- Grounded the plumbing in reality: RTDB can't transact across nodes (order-node money tx + durable
  onOrderCancelled task/driver cleanup that runs before the Sheets early-return), generalize-in-place to
  stay 31→31 zero-prune, and migrate all three client bundles (dispatch/dashboard/driver).
Ready for executor build against this plan.
