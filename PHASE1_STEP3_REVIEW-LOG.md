# Step 3 Shadow Predictor — Review Log
Design gate (Codex adversarial). MAX_ROUNDS=5. thread 019f2f75.

## Round 1 — REVISE (13 findings)
All 13 judged valid + folded into rev-2: (1) event row lacks item_count → ephemeral from event, stable
composition read from /orders, snapshot features; (2) anchor new_at on the to:'new' event.at (not the
lagging order_timelines/new_at); (3) ready-time-features has no bucketOf → add+golden bucket helpers in
this step; (4) don't STORE is_training_eligible (Step 0 recomputes at eval) → store features_snapshot,
recompute at model-update/eval; (5) prediction_logs keyed by {orderId}/{modelVersion} (v2 shadow can log);
(6) join-safe logs — Trigger B always records the actual, prediction_missing if A hasn't run, join at eval;
(7) ring keyed by orderId (samplesByOrder map) → retry-idempotent, not blind append; (8) hierarchical
fallback exact→daypart×load→restaurant-median→cold_start (fleet-size sparsity); (9) la_musa log-only +
constant, no bucket model in v1; (10) add order_predictions/prediction_logs/ready_time_model admin-only
leaves to BOTH rules files + mirror-diff empty + reconcile Step-0 leaves; (11) keep ready_time_model root
separate + rules test KDS can't read it; (12) 31→33 ADD with explicit export-name before/after diff; (13)
denylist API-spy (/orders,/order_tracking,/tasks,/drivers,/dispatcher_alerts,push,config/ready_time).

## Round 2 — Codex (resume)

## Round 2 — REVISE (4 findings) → rev-3
All 4 folded: (1) Trigger B updates ALL THREE fallback rings (exact/daypart/restaurant) per eligible label —
else coarser levels stay empty + fallback is dead; (2) prediction-time temporal features anchor on the
to:'new' event.at, NOT timeline.new_at (extractCreationFeatures reads timeline.new_at — Step 3 helpers take
an explicit at arg); (3) logs WRITE-ONCE, NO backfill — resolves the contradiction; predicted-vs-actual join
is Step-4 eval; (4) ACTIVE_MODEL_VERSIONS single shared constant imported by both triggers → Trigger B knows
which versions to log even if A hasn't run.

## Round 3 — Codex (resume)

## Round 3 — APPROVED (thread 019f2f75)
No new blocking issues. Two editorial nits (header rev label, stale open-Q about backfill) + one build note
(thread an event-anchored order object carrying new_at=event.at through eligibility/bucket/label helpers) —
all folded. Design gate CONVERGED (13→4→0). Ready for executor build against PHASE1_STEP3_SHADOW_PREDICTOR.md.
