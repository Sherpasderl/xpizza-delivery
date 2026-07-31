# HANDOFF → AUDITOR: pickup-completion v3 — codex DESIGN re-gate (run on the CORRECT base)

**Written:** 2026-07-31 (executor). The prior re-gate returned **REVISE** and — critically — **ran on the stale `docs/dispatch-redesign-spec` branch** (pre-rewards-v2), which mis-reported the consume path and every line number. This v3 folds all its findings AND relocates to the right base. **Action:** codex **design re-gate** on v3. Return **VERDICT: APPROVED / REVISE**.

## ⚠ RUN ON THIS BASE (do not repeat the last gate's mistake)
- **Branch: `feat/pickup-completion`** (off `origin/main` `c09fe12`, post-rewards-v2). **NOT** `docs/dispatch-redesign-spec`.
- **Spec:** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (commit `9f29872`).
- `git rev-parse --short HEAD` must be at/after `9f29872`; confirm `grep -c settleRedemptionAtConfirm xpizza-functions/index.js` > 0 before trusting any earn/consume claim. Line numbers in the spec are main-accurate; verify by logic, not just number.
- Read-only from repo root: `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null`.

## Design in one line
KDS Completar on `order_type==='pickup'` → `setOrderStatus(id,'completed')`; wire `completed` into 4 terminal/active checks that only knew `delivered`; dashboard aggregate stats; pickup-scoped backfill. Earn+consume fire on `completed` (already wired on main). Delivery/driver path byte-untouched; `delivered` stays delivery-only.

## The 4 consumer fixes to VERIFY (v3 §4 — confirm each is the RIGHT site, RIGHT fix, on main)
1. **[MONEY] dashboard `actionConfig`** cancel/refund gate (`xpizza-dashboard/index.html`, `if (o.status !== 'delivered' && !inReconFlow)` universal-cancel block): fix = add `&& o.status !== 'completed'`. Confirm a `completed` pickup then offers **no** Cancelar/Reembolsar, and the recon-flow branch is unaffected.
2. **dashboard `statusBucket`** (`index.html:1442`): fix = `completed` → a terminal bucket (not `'active'`). Confirm consistency with the aggregate-stats inclusion (§5.2) so it's counted completed once, never active, never double.
3. **KDS status→estado map** (`xpizza-kitchen/index.html`, `else if (o.status==='delivered') estado='Archivado'`): fix = `|| o.status==='completed'`. Confirm a server-`completed` pickup maps to Archivado (not the `else → 'Nuevo'`) so it can't reappear as a new ticket on a device lacking the local `completedSet`.
4. **[FUNCTIONS] inbound status-check** (`xpizza-functions/index.js:3738`, `o.status !== 'delivered' && o.status !== 'cancelled'`): fix = `&& o.status !== 'completed'`. Confirm a customer texting after pickup no longer gets an "active order" reply. **This is the functions touch → confirm it's the ONLY functions logic change** (earn/consume already handles `completed`).

## THE CRUX — completeness sweep (this is what the last gate was for; do it exhaustively)
The whole risk of reusing an intended-but-unwired status is a **missed consumer**. Independently enumerate **every** site that branches on order `status` treating `delivered`/`cancelled`/terminal specially, across `xpizza-functions/`, `xpizza-dashboard/`, `xpizza-kitchen/`, `xpizza-dispatch/`, and shared `xpizza-delivery.js` — and confirm each handles `completed` correctly. Is there a **5th** consumer the spec's list of 4 missed? Candidates to probe explicitly: order_timelines / ready-time predictor status gates; `user_orders` / status-mirror; tracker page status copy; any `TERMINAL_*` set; reorder/history filters; driver settlement/cash; sweep-pending; reward reversal/placement. **A 5th missed consumer = REVISE.**

## Money & invariants
- Money paths: (a) the `completed` write triggers the already-gated `earnRewardsOnCompletion` (earn + `settleRedemptionAtConfirm consume`) — confirm it reaches earn/consume for a driverless pickup and is idempotent (`earn_${orderId}`) under a KDS re-tap + the backfill; (b) the `actionConfig` cancel-gate fix removes a bogus refund path. No NEW money logic.
- **Delivery/driver path byte-untouched:** pickup-only branch; delivery Completar = local `completedSet`; `completeDeliveryTask` unmodified; `delivered` stays delivery-only; no rules edit.
- Backfill: strictly `order_type==='pickup'` + non-terminal, dry-run-reviewed, cannot touch a delivery order; retro-earn accepted + flagged.

## OUTPUT
VERDICT APPROVED/REVISE + numbered findings. Priorities: (1) is the consumer list COMPLETE (any 5th?); (2) the 4 fixes correct on main; (3) money paths (actionConfig + earn/consume idempotency); (4) delivery-path untouched + functions scope minimal. If clean → writing-plans → build → codex-on-diff money-gate → deploy (KDS 2 sites + dashboard + functions), folded into the rewards launch.
