'use strict';

/**
 * Manual-reconciliation resolve — the pure decision/predicate/mapping core of the atomic-claim money
 * state machine (RECON_ATOMIC_CLAIM_PLAN.md rev-5, Codex-APPROVED thread 019f2e15).
 *
 * Extracted so the LOAD-BEARING logic — the claim decision, the automation-closed predicate, phase
 * transitions, paid-evidence detection, and the outcome→HTTP-status contract — is golden-testable
 * WITHOUT the emulator. All DB / transaction / PixelPay wiring stays in index.js; this module is PURE
 * (no db, no I/O, no clock — `now`/`claimId` are injected).
 *
 * Invariants this module encodes (verified at the build-gate):
 *  - the claim tx is null-first-safe (don't abort-on-null) and only claims from manual_reconciliation;
 *  - the predicate gates STATUS-CHANGING automation ONLY — never evidence capture (R4 root-cause split);
 *  - a terminal `refunded`/`confirmed` is 2xx; any non-final outcome (refund_pending / manual_review /
 *    error) is non-2xx — never a fake success.
 */

// ── resolving_<action> status vocabulary ──────────────────────────────────────────────────────────
const RESOLVE_ACTIONS = ['materialize', 'refund', 'abandon']; // 'keep' does NOT claim (no mutation)
const ALL_ACTIONS = ['materialize', 'refund', 'abandon', 'keep'];
const RESOLVING_PREFIX = 'resolving_';
const resolvingStatus = (action) => `${RESOLVING_PREFIX}${action}`;
const isResolving = (ps) => typeof ps === 'string' && ps.startsWith(RESOLVING_PREFIX);

const PHASE = Object.freeze({ CLAIMED: 'claimed', SIDE_EFFECT_STARTED: 'side_effect_started' });

// ── [R4] Predicate: gate STATUS-CHANGING automation ONLY (never evidence capture) ─────────────────
// True ⇒ background automation (sweep re-flag, confirm auto-transition, cancelPaidOrder, reconcile
// breach re-flag) must SKIP/409 — the order is mid-resolve or already resolved/queued. Paid-evidence
// capture (webhooks persisting a paid UUID) is a SEPARATE path that must run in EVERY state.
const AUTOMATION_CLOSED_TERMINAL = new Set([
  'manual_reconciliation', 'confirmed', 'refunded', 'refund_pending', 'abandoned', 'failed', 'manual_review',
]);
function isStatusChangeClosedToAutomation(paymentStatus) {
  return isResolving(paymentStatus) || AUTOMATION_CLOSED_TERMINAL.has(paymentStatus);
}

// ── The claim transaction decision (whole order node; null-first-safe) ─────────────────────────────
// Returns the new node value to COMMIT, or `undefined` to ABORT. RTDB runs this once with cur===null on
// an uncached path — returning null forces the server read instead of a spurious abort (R2-#1).
function claimDecision(cur, action, claimId, now) {
  if (cur === null) return null;                                       // R2-#1: force server round-trip
  if (!cur || cur.payment_status !== 'manual_reconciliation') return undefined; // loser → abort → 409
  return {
    ...cur,
    payment_status: resolvingStatus(action),
    resolving_action: action,
    resolving_claim_id: claimId,
    resolving_claimed_at: now,
    resolving_phase: PHASE.CLAIMED,
  };
}

// ── [R2-#4] Verify the claim actually LANDED ───────────────────────────────────────────────────────
// A missing/deleted order commits a null no-op: tx.committed === true but nothing was claimed. Require
// our claim_id + the resolving_<action> status on the committed snapshot before proceeding.
function claimLanded(committedNodeVal, action, claimId) {
  const v = committedNodeVal;
  return !!v && v.resolving_claim_id === claimId && v.payment_status === resolvingStatus(action);
}

// ── Paid-evidence detection (universal — pre-claim window, during resolve, or post-terminal) ───────
// Any of: the order's paid_during_resolve flag, or the attempt's persisted UUID / verified capture.
// BROAD — used to ROUTE AMBIGUITY (a bare UUID may be a declined auth) to manual_review, NEVER to gate a void.
function hasPaidEvidence(order, attempt) {
  return !!(
    (order && order.paid_during_resolve === true) ||
    (attempt && (attempt.payment_uuid || attempt.capture_verified === true))
  );
}

// ── Captured-money evidence — the ONLY void gate (cancel path, F3/F4-r3) ────────────────────────────
// TIGHT: real settled money only. A bare `payment_uuid` is deliberately EXCLUDED (declined auths carry a
// UUID) — that ambiguity routes to manual_review via hasPaidEvidence, never an auto-void. Includes the
// durable `hosted_callback_verified` the hosted webhook writes (:91/:105).
function hasCapturedMoneyEvidence(order, attempt) {
  return !!(
    (order && (order.paid_during_resolve === true || order.payment_status === 'confirmed')) ||
    (attempt && (attempt.capture_verified === true || attempt.hosted_callback_verified === true || attempt.hosted_state === 'paid'))
  );
}

// ── Honest status contract [E / #9] — outcome → HTTP status ────────────────────────────────────────
// 2xx ONLY for a genuinely-final money outcome. Everything else (refund_pending / manual_review /
// confirm_claim_failed / attempt_superseded / no_charge / error) is 409 — never a fake success.
// `scheduled_held` is a genuine SUCCESS (Scheduled Orders / Codex-on-diff): manually verifying a paid
// scheduled order correctly HOLDS it (verified paid + status:scheduled, out of manual_reconciliation) — it
// releases live only via the claim. Without this it 409s + audits materialize_failed (a lie) and can never
// retry (the order is now confirmed, so the manual_reconciliation claim can't re-acquire it).
const FINAL_SUCCESS_OUTCOMES = new Set(['abandoned', 'refunded', 'materialized', 'confirmed', 'already_confirmed', 'scheduled_held']);
function httpForOutcome(outcome) {
  return FINAL_SUCCESS_OUTCOMES.has(outcome) ? 200 : 409;
}

// ── Recovery decision (phase-aware) [D / R2-#2] ────────────────────────────────────────────────────
// For a stale resolving_* order older than `staleMs` (which must be > the function timeout). Pre-side-
// effect → safe to revert to manual_reconciliation; post-side-effect → NEVER revert (a 2nd resolver
// could re-issue the void/refund) — converge to refund_pending/manual_review + alert.
function recoveryDecision(order, now, staleMs) {
  if (!order || !isResolving(order.payment_status)) return { act: false };
  const age = now - (Number(order.resolving_claimed_at) || 0);
  if (!(age > staleMs)) return { act: false, reason: 'not_stale' };
  if (order.resolving_phase === PHASE.SIDE_EFFECT_STARTED) {
    return { act: true, to: 'manual_review', alert: true };  // money may have moved → never re-resolvable
  }
  return { act: true, to: 'manual_reconciliation', alert: false }; // pre-side-effect → safe revert
}

module.exports = {
  RESOLVE_ACTIONS, ALL_ACTIONS, RESOLVING_PREFIX, resolvingStatus, isResolving, PHASE,
  isStatusChangeClosedToAutomation, claimDecision, claimLanded, hasPaidEvidence, hasCapturedMoneyEvidence,
  FINAL_SUCCESS_OUTCOMES, httpForOutcome, recoveryDecision,
};
