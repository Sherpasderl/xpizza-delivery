# Scheduled Orders — Design Review Log
grill-with-docs-codex Act 2. MAX_ROUNDS=5. thread 019f386b.

## Round 1 — REVISE (13 findings) → rev-2
All 13 folded: (1) confirmAndMaterialize always writes 'new' → NEW confirmAndHoldScheduled path (no
materialized_at/tasks/tracking); (2) materializeOnConfirm gated to status:pending_payment ONLY (else auto-
releases paid scheduled); (3) NON_LIVE_ORDER_STATUSES copied in 4 bundles (kitchen/dispatch/dashboard/
driver) → update all 4 or dedupe; (4) cash createOrder branches BEFORE buildCreateOrderUpdates (no live
side-effects); (5) release = atomic claim scheduled→releasing w/ release_claim_id (double-release/cancel-
race safe); (6) release transaction-checks status/no-cancel/attempt-match; (7) reconcilePayments knows
paid-scheduled valid till release_at, overdue→scheduled_release_overdue; (8) release-recovery sweep
(overdue by release_at<=now, stale releasing recovery, missed-window alert); (9) RTDB query = status==
scheduled indexed + in-memory release_at filter (or release queue); (10) SERVER-authoritative hours/slot
gen/validation (UTC-6, config, min-lead/max-horizon) at create+confirm+release; (11) delivery release
jitter + no-driver alert v1, per-slot cap v2; (12) factura not_due till release, tested; (13) no
tracking_token/order_tracking until release + notifier skips non-live; (14 capture-now SLA) grace-alert +
hard-deadline dispatcher refund/release.

## Round 2 — Codex (resume)

## Round 2 — REVISE (4 findings) → rev-3
Folded: (1) release sweep SKIPS scheduled_blocked===true (else re-alert every run; cleared only via
dispatcher override); (2) manual release = audited dispatcher-only releaseScheduledOrder running the SAME
single-claim materialization (never a raw status→new write); (3) orderFingerprint must bind scheduled_for/
fulfillment (else same-cart reuse binds wrong slot); (4) paid-return UX — add scheduled_paid paymentStatus
state (confirmed+status:scheduled+no token, carries scheduled_for), both forms show "programado" confirmation
not "ya está en cocina".

## Round 3 — Codex (resume)

## Round 3 — APPROVED (thread 019f386b)
No new blocking flaw. All R2 folds close the holes: blocked-skip (no alert-loop), releaseScheduledOrder
single-claim materialization, slot-bound fingerprint, scheduled_paid UX. Editorial: header rev label fixed.
Design gate CONVERGED (13→4→0). Ready for executor build against SCHEDULED_ORDERS_PLAN.md rev-3.
