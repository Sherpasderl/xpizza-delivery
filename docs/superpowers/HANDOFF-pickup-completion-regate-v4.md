# HANDOFF → AUDITOR: pickup-completion v4 — codex DESIGN re-gate (CONFIRM the complete matrix)

**Written:** 2026-07-31 (executor). v3 re-gate REVISE found 3 more consumers (⑤⑥⑦). Executor then did a **systematic enumeration** of every order-status terminal/active branch and folded a **complete-by-construction consumer matrix** into v4. **Action:** codex re-gate v4 — this pass should **CONFIRM** the matrix (or find the 12th/16th consumer). Return **VERDICT: APPROVED / REVISE**. Still money-adjacent (closes the pickup rewards hole) — gate accordingly.

## ⚠ RUN ON THIS BASE (v3's #1 finding — do not repeat)
- **Branch `feat/pickup-completion`** (off `origin/main` `c09fe12`, post-rewards-v2). NOT `docs/dispatch-redesign-spec`.
- **Spec:** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (commit `c47b5da`).
- Sanity-gate before trusting anything: `git rev-parse --short HEAD` ≥ `c47b5da`; `grep -c settleRedemptionAtConfirm xpizza-functions/index.js` > 0. **Spec line numbers are main-accurate this time — but verify by LOGIC.**
- Read-only from repo root: `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null`.

## Design in one line
KDS Completar on `order_type==='pickup'` → `setOrderStatus(id,'completed')`; wire `completed` into every terminal/active consumer (spec §3A, 15 sites); dashboard aggregate; pickup-scoped backfill. `completed` earns+consumes (already wired on main); nothing writes it today (de-facto pickup-unique). Delivery/driver path byte-untouched; `delivered` stays delivery-only.

## THE JOB — this is a COMPLETENESS confirmation, not a fresh discovery
The spec's §3 partitions **every** `status` terminal/active branch into three buckets. Your job:

**1. Independently re-run the enumeration (the crux).** Grep the whole repo (functions + `xpizza-dispatch`/`-dashboard`/`-kitchen`/`-track`/`xpizza-orders`/`la-musa-orders` + the SDK copies) for every branch that treats order `status` as terminal/active/done — `'delivered'`, `'cancelled'`, `!== 'delivered'`, terminal/active/done Sets, `statusBucket`/`orderStatusPill`/estado maps, tracker progress steps, closed/history filters, status mirror, lifecycle stamps. **Compare your set to §3.** If ANY consumer is missing from all three §3 buckets — that's the finding → REVISE. (If none — the matrix is complete; say so explicitly.)

**2. Confirm each §3A FIX is correct** (right site, right edit) and each §3B LEAVE / §3C ALREADY-HANDLES is correctly categorized. Spot-check the load-bearing ones:
- **D1 [MONEY]** `actionConfig` gate — completed → no bogus Cancelar/Reembolsar; recon-flow unaffected.
- **D2/D4/D8** dashboard bucket+active-exclusion+filter — completed counted once as completed, never active, never double.
- **K2** KDS estado — completed→Archivado (else NUEVO reappear on a device without local `completedSet`).
- **DI2** dispatch closed `dCount` — completed in the ✓ count, not miscounted as ✕/cancelled.
- **T1–T3** tracker — completed terminal ("Recogido"), not step-1.
- **A1/A2** account pill — completed → "Recogido", not the "En preparación" default.
- **F1** inbound status-check — completed excluded from active; **confirm F1 is the ONLY functions logic change**.

**3. Re-verify money & delivery (independently).**
- Driverless pickup `completed` reaches `earnRewardsOnCompletion` → `creditEarnForOrder` + `settleRedemptionAtConfirm('consume')` (no driver/task guard); idempotent (`earn_${orderId}` + state-machine consume + `sweepConsumeRecovery` incl `completed`) under KDS re-tap AND backfill re-run; cancel/reversal blocks `completed`.
- §3C ALREADY-HANDLES claims: `mirrorStatusToHistory` status-agnostic (propagates `completed`→`user_orders`), `onOrderCancelled` fires only on `cancelled`, `sendOrderStatusNotifications` silent on `completed`, `logOrderLifecycle` `completed_at` stamp harmless.
- Delivery/driver path byte-untouched (pickup-only branch; `completeDeliveryTask` unmodified; `delivered` delivery-only; no rules edit).

**4. Backfill:** pickup-scoped + non-terminal + dry-run; cannot touch a delivery order; retro-earn idempotent + flagged.

## OUTPUT
VERDICT APPROVED/REVISE + numbered findings. **Priority #1: is §3 the COMPLETE set** (any consumer missing?). Then: §3A fixes correct, money idempotency, delivery untouched, F1-only functions scope. If clean → writing-plans → build → codex-on-diff money-gate → deploy (KDS ×2 + dashboard + track + orders ×2 + functions), folded into the rewards launch.
