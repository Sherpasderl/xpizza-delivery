# HANDOFF → AUDITOR: pickup-completion v6 — codex DESIGN re-gate (CONVERGENCE CONFIRM)

**Written:** 2026-07-31 (executor). v5-regate (the dual-grep pass) found the last one (⑧ ready-time-quality Set-membership) + a factual SDK correction. v6 folds them. The curve has converged: 6 passes, each finding fewer/more-marginal consumers (customer-facing → shadow-metric → non-prod harness), money/delivery sound 5×. **Action:** codex re-gate v6 — run the dual-grep once more and **CONFIRM the set is complete**, or name the (unlikely) next one. **VERDICT: APPROVED / REVISE.**

## ⚠ RUN ON THIS BASE
- **Branch `feat/pickup-completion`** (off `origin/main` `c09fe12`). **Spec:** `.../specs/2026-07-31-pickup-order-completion-design.md` (commit `1a7b4f7`).
- Sanity-gate: `HEAD ≥ 1a7b4f7`; `grep -c settleRedemptionAtConfirm xpizza-functions/index.js > 0`. Verify by logic.
- `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null` from repo root.

## THE JOB — final completeness confirmation
**1. Run BOTH grep classes and reconcile against spec §3 (the whole point):**
   - (a) equality: `=== 'delivered'` / `!== 'delivered'` / `=== 'cancelled'` / status ternaries & switches.
   - (b) Set/array/`includes()` membership: `new Set([… 'delivered'/'out_for_delivery' …])`, `[…].includes(o.status)`, `*_STATUSES`, `TERMINAL`/`ACTIVE`/paid-lists, `NON_LIVE_ORDER_STATUSES`.
   Over `xpizza-functions/*` + all clients + the SDK copies. **Every hit must be bucketed in §3A/§3B/§3C. Any unbucketed order-status consumer → REVISE. If none → state explicitly: complete.**

**2. Confirm the v6 resolutions:**
   - **⑧ `ready-time-quality.js:19` TERMINAL — LEAVE:** is the rationale sound? It's a pure-shadow predictor-quality monitor (writes only prediction/ready_time nodes, no /orders or user/dispatch effect); `ready_at` is measured at the `ready` transition (pickups hit it); `completed` absent is no regression (pickups never reached out_for_delivery/delivered before) and doesn't affect prediction accuracy. Agree LEAVE, or argue FIX?
   - **SDK `NON_LIVE_ORDER_STATUSES` — LEAVE + correction:** confirm the copies diverge (reference `{pending_payment}` vs apps `+{scheduled,releasing}`), that `completed` is in NONE (→ live everywhere like `delivered`), and that the LEAVE is safe **because** the §3A display fixes treat a live `completed` order as terminal-present (LEAVE-depends-on-FIX). No SDK edit.
   - **`test-harness.html:522` — OUT OF SCOPE** (non-prod). Agree?

**3. Spot-confirm** F1+F2 are the ONLY functions logic changes; the load-bearing FIX sites (D1 money, K2, DI2, T1–T3, A1/A2) are correct.

**4. Money & delivery (quick, sound 5×):** `completed` reaches earn+consume for a driverless pickup, idempotent under re-tap + backfill; cancel/reversal blocks it; delivery/driver byte-untouched; §3C already-handles claims hold.

## OUTPUT
VERDICT APPROVED/REVISE + findings. **#1: is §3 the COMPLETE set (dual-grep) — name any unbucketed consumer, else confirm.** If APPROVED → **writing-plans** → build (15 client sites + F1/F2 + backfill) → codex-on-diff money-gate → deploy (KDS ×2, dashboard, track, orders ×2, functions), folded into the rewards launch.
