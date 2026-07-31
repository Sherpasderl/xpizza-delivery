# HANDOFF → AUDITOR: pickup-completion — codex-on-diff MONEY-GATE (built code)

**Written:** 2026-07-31 (executor). Design APPROVED after 6 rounds; build is DONE (subagent-driven, opus controller-reviewed each task). **Action:** codex-on-diff on the actual code — the **real remaining gate** (first time there's code; money-adjacent because the KDS write triggers the already-gated rewards earn/consume). Return **VERDICT: APPROVED / REVISE**.

## Gate this
- **Branch:** `feat/pickup-completion` @ `87d2680` (off `origin/main` `c09fe12`, post-rewards-v2). Pushed.
- **Diff:** `git diff c09fe12 87d2680 -- xpizza-kitchen xpizza-dashboard xpizza-dispatch xpizza-track xpizza-orders la-musa-orders xpizza-functions scripts` — **9 files, +89/-16** (the rest of the branch is spec/plan/handoff docs).
- **Spec (matrix):** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (v7 + v8 build note). **Plan:** `docs/superpowers/plans/2026-07-31-pickup-order-completion.md`.
- Read-only from repo root: `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null`. Sanity: `grep -c settleRedemptionAtConfirm xpizza-functions/index.js > 0`.

## What was built (reconcile the diff against the spec §3A matrix)
- **KDS** `xpizza-kitchen/index.html`: **K1** `startCompletion` is now `async` and, only for `order_type==='pickup'` in a non-terminal status, `await XPD.setOrderStatus(id,'completed')` — gated on the return exactly like `commitStatusWrite` (`wrote !== true` → no local bump, surface error, return). **K2** estado map adds `|| o.status==='completed'` → Archivado.
- **Functions** `xpizza-functions/index.js` (the ONLY fn file): **F1** inbound status-check adds `&& o.status !== 'completed'`; **F2** `queryPaymentStatus` paid-list adds `'completed'`.
- **Dashboard** `xpizza-dashboard/index.html`: **D1** actionConfig cancel-gate adds `&& o.status !== 'completed'`; **D2** statusBucket adds a `completed` terminal bucket; **D3** completed count, **D4** active-exclusion, **D6** completedSeries include `completed`; **D7** closeLabel `completed→'Recogido'`; **D8** filter option. **D5 was REVERTED** (see below).
- **Dispatch** `xpizza-dispatch/index.html`: **DI1** closed-list, **DI2** closed dCount, **DI3** detail pill "Recogido", **DI4** topbar done-count — all add `completed`.
- **Tracker** `xpizza-track/index.html`: **T1/T2/T3** treat `completed` as terminal (reuses the existing `isPickup?'Recogido'` copy).
- **Account** `xpizza-orders/account.js` + `la-musa-orders/account.js`: **A1/A2** add `case 'completed' → 'Recogido'`.
- **Backfill** `scripts/backfill-pickup-completion.{mjs,test.mjs}`: pure `selectBackfillCandidates` (allowlist) + guarded dry-run runner.

## TWO build-time corrections to specifically confirm sound
1. **D5 reverted.** `completedOrders` (`:921`) feeds ONLY `prepDur` (filters `picked_up_at`) and `delvDur` (via `isPlausibleDelivery`, requires `status==='delivered'`) — delivery-duration metrics, not an aggregate count. So it stays `delivered`-only (a completed pickup has no `picked_up_at`/`delivered_at` and would be filtered out anyway; including it was a semantic no-op). The completed COUNT is D3 and the sparkline is D6 (both include completed). **Confirm D5-as-delivered-only is correct and no aggregate under-counts.**
2. **Backfill = ALLOWLIST `{new,preparing,ready}`** (not `pickup && !terminal`). This EXCLUDES `pending_payment` (UNPAID — must never be marked completed → would earn on an unpaid order), `scheduled`/`releasing` (held, not collected), and terminal. **Confirm the allowlist can't earn on an unpaid/held order, and that `--apply` writes only `orders/{id}/status='completed'` for pickup candidates.**

## The MONEY path (hardest — verify independently)
The KDS `completed` write triggers `earnRewardsOnCompletion` (`shouldEarnOnStatus=delivered||completed`) → `creditEarnForOrder` + `settleRedemptionAtConfirm('consume')`. Confirm: (a) it reaches earn/consume for a driverless pickup; (b) **idempotent** — K1's terminal-skip guard + `earn_${orderId}` + state-machine consume + `sweepConsumeRecovery` incl `completed` mean a KDS re-tap or a backfill re-run cannot double-earn; (c) K1 gates the local completion beat on `wrote===true` (a failed/ownership-skipped write does NOT locally-complete); (d) no NEW money logic anywhere — only the status write + the D1 cancel-gate removal of a bogus refund path.

## The hard invariant — delivery/driver path byte-untouched
Confirm across the diff: the change is gated on `order_type==='pickup'`; delivery Completar stays the local `completedSet` bump; `completeDeliveryTask` / driver flow unmodified; `delivered` stays delivery-only (leaderboard/delivery-count/prep-time lines unchanged — verified 0 `completed`); no RTDB rules edit; no SDK edit.

## Completeness (already gated 6× — quick reconcile)
The spec §3 matrix is the exhaustive consumer set (dual-grep: equality + Set/list membership). Confirm the diff wires exactly §3A (14 sites, D5 excluded), touches none of §3B LEAVE, and needs none of §3C ALREADY-HANDLES.

## OUTPUT
VERDICT APPROVED/REVISE + numbered findings. Priorities: (1) money idempotency + the two build-time corrections; (2) delivery-path byte-untouched; (3) diff == matrix (no over/under-wire). If APPROVED → `git fetch` re-confirm `origin/main`, merge → deploy (KDS ×2 Netlify sites explicit `--site`, dashboard, track, orders ×2, **functions** [[prod-functions-deployed-state]]/[[functions-env-management]]), run the backfill dry-run → review → `--apply`, **folded into the rewards launch**.
