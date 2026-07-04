'use strict';

/**
 * Dispatcher cancellation — the pure decision core (CANCEL_PAID_ORDER_FIX_PLAN.md rev-5, Codex-APPROVED).
 * ONE uniform money-aware path for every order (cash/online alike): void iff captured money, finalize
 * honestly, heal an already-cancelled-but-still-paid order, never double-void. No I/O — DB/PixelPay wiring
 * lives in the deps-injected adapter in index.js (generalized `cancelPaidOrder`). Reuses manual-resolve.js
 * primitives (PHASE / isResolving / httpForOutcome / hasCapturedMoneyEvidence / hasPaidEvidence).
 *
 * Invariants (verified by goldens + the emulator F-matrix):
 *  - the void gate is captured-money evidence ONLY (a bare UUID is a possible declined auth → manual_review);
 *  - idempotency (`already_cancelled`) applies ONLY to an order already status==='cancelled' — a LIVE order
 *    (even cash, no evidence) proceeds to claim+finalize;
 *  - never a fake `refunded`: a non-`anulada` reversal → refund_pending; a paid order with no resolvable
 *    attempt/uuid → manual_review, never a silent success.
 */
const MR = require('./manual-resolve');

const TERMINAL_SUCCESS = new Set(['delivered', 'completed']);          // driver already completed → not cancelable

// ── B.2 Allowed-state gate (BEFORE any mutation) ─────────────────────────────────────────────────────
// Returns { ok:true } to proceed, or { reject: { code, outcome, error, alert? } }.
function gate(order) {
  if (TERMINAL_SUCCESS.has(order.status)) {
    return { reject: { code: 409, outcome: 'not_cancelable', error: 'El pedido ya fue entregado — no se puede cancelar' } };
  }
  if (MR.isResolving(order.payment_status)) {
    return { reject: { code: 409, outcome: 'resolving_in_progress', error: 'Pedido en reconciliación (en proceso)' } };
  }
  // [Fix#1] manual_review is a HUMAN-resolve state (a prior recovery / no-uuid cancel flagged it). Never let a
  // retry re-enter the cancel money path — that would re-void the same charge. Blocked like isResolving.
  if (order.payment_status === 'manual_review') {
    return { reject: { code: 409, outcome: 'manual_review', error: 'Pedido en revisión manual — verificá el cargo en PixelPay' } };
  }
  if (order.payment_status === 'manual_reconciliation') {
    // Still visible in the recon surface (pending_payment) → resolve it there, not here.
    if (order.status === 'pending_payment') {
      return { reject: { code: 409, outcome: 'in_recon_surface', error: 'Resuélvelo en "Reconciliación de pagos"' } };
    }
    // Cancelled/other, NOT in that surface (F7-r2) → never a silent path.
    return { reject: { code: 409, outcome: 'manual_review', error: 'Pedido en revisión manual', alert: true } };
  }
  return { ok: true };
}

// ── B.4 Already-cancelled contract (ONLY when order.status==='cancelled', F1-r4/F6-r2) ───────────────
// Returns { code, outcome } for a no-op/409, or { heal:true } to proceed through the void path.
function cancelledDecision(order, attempt) {
  if (order.payment_status === 'refunded') return { code: 200, outcome: 'already_cancelled' };
  if (!MR.hasCapturedMoneyEvidence(order, attempt)) return { code: 200, outcome: 'already_cancelled' }; // never captured → clean no-op
  if (order.payment_status === 'refund_pending') return { code: 409, outcome: 'refund_pending' };        // reversal attempted, not confirmed
  // Captured money, no completed reversal → HEAL (void). But money at order level w/ no resolvable uuid → manual_review (F8-r1).
  if (!attempt || !attempt.payment_uuid) return { code: 409, outcome: 'manual_review', alert: true };
  return { heal: true };
}

// ── B.5 Cancel-claim decision (null-first-safe tx callback; reuse PHASE, no new enum, F2-r2) ─────────
// Stamps a UNIQUE cancel_claim_id + resolving_action='cancel' + resolving_phase=CLAIMED. Does NOT touch
// payment_status (stays confirmed/etc). Aborts (→ loser 409) if another cancel already owns it or a recon
// claim holds it.
function claimDecision(cur, claimId, now) {
  if (cur === null) return null;                                       // null-first-safe (a679797): force server round-trip
  if (!cur) return undefined;                                          // abort
  if (cur.resolving_action === 'cancel' && cur.cancel_claim_id && cur.cancel_claim_id !== claimId) return undefined; // another cancel owns it
  if (MR.isResolving(cur.payment_status)) return undefined;            // recon claim owns it
  return {
    ...cur,
    cancel_claim_id: claimId,
    resolving_action: 'cancel',
    resolving_phase: MR.PHASE.CLAIMED,
    resolving_claimed_at: now,
  };
}
// Verify OUR claim actually landed (a null no-op commits but claims nothing).
function claimLanded(committedNodeVal, claimId) {
  const v = committedNodeVal;
  return !!v && v.cancel_claim_id === claimId && v.resolving_action === 'cancel';
}

// ── B.7 Void gate — captured money ONLY, and not already reversed (order OR attempt) ──────────────────
// [Fix#1 defense-in-depth] An already-reversed ATTEMPT (refunded/voided/refund_pending) also blocks the void —
// so a recovery-flagged order whose attempt was already voided can never be re-voided on a retry.
function shouldVoid(order, attempt) {
  return MR.hasCapturedMoneyEvidence(order, attempt)
    && !['refunded', 'refund_pending'].includes(order.payment_status)
    && !(attempt && ['refunded', 'voided', 'refund_pending'].includes(attempt.status));
}

// Money already reversed (order- OR attempt-level) → no void, and NOT ambiguous → a clean finalize.
function isAlreadyReversed(order, attempt) {
  return ['refunded', 'refund_pending'].includes(order.payment_status)
    || !!(attempt && ['refunded', 'voided', 'refund_pending'].includes(attempt.status));
}

// [Fix A] The truthful payment_status to SYNC onto an already-reversed order at finalize — so a cancel of an
// order whose attempt is already refunded never leaves the order reading `confirmed` (cancelled-but-paid, the
// exact bug this whole change kills). refund_pending anywhere → refund_pending; otherwise → refunded.
function reversedPaymentStatus(order, attempt) {
  if (order.payment_status === 'refund_pending' || (attempt && attempt.status === 'refund_pending')) return 'refund_pending';
  return 'refunded';                                                  // refunded / voided → refunded
}

// ── B.11 Honest finalize outcome ─────────────────────────────────────────────────────────────────────
// hadEvidence=false → plain finalize (no money). voided → refunded. else → refund_pending (409).
function finalizeOutcome({ hadEvidence, voided }) {
  if (!hadEvidence) return { code: 200, outcome: 'cancelled', payment_status: null };  // cash / no captured money
  if (voided) return { code: 200, outcome: 'cancelled', payment_status: 'refunded' };
  return { code: 409, outcome: 'refund_pending', payment_status: 'refund_pending' };
}

// The refundReconciler's SELECTOR — which attempts get a scheduled re-drive through voidOrRefund so no reversal
// state strands: refund_pending (a failed void) OR a STALE reversing (a crash after the reversal CAS). FRESH
// reversing (an in-flight void) is skipped — re-driving it would double-void. Completes the reversal machine:
// captured → reversing → {refunded | refund_pending}, every non-terminal state has an automatic recovery.
function isReconcilerRetryable(attempt, now, staleMs) {
  if (!attempt) return false;
  if (attempt.status === 'refund_pending') return true;
  if (attempt.status === 'reversing') return (now - (Number(attempt.reversing_at) || 0)) >= staleMs;
  return false;
}

// ── B.10 Phase-aware recovery decision for a stale resolving_action='cancel' claim ───────────────────
// payment_status is NOT resolving_* for a cancel claim (it stays confirmed), so this keys on
// resolving_action==='cancel' + staleness. Pre-side-effect → clear the claim (safe revert); post → manual_review+alert.
function cancelRecoveryDecision(order, now, staleMs) {
  if (!order || order.resolving_action !== 'cancel') return { act: false };
  const age = now - (Number(order.resolving_claimed_at) || 0);
  if (!(age > staleMs)) return { act: false, reason: 'not_stale' };
  if (order.resolving_phase === MR.PHASE.SIDE_EFFECT_STARTED) {
    return { act: true, to: 'manual_review', alert: true };            // money may have moved → never blind re-void
  }
  return { act: true, clearClaim: true, alert: false };                // pre-side-effect → clear claim, order stays as-is
}

module.exports = { TERMINAL_SUCCESS, gate, cancelledDecision, claimDecision, claimLanded, shouldVoid, isAlreadyReversed, reversedPaymentStatus, isReconcilerRetryable, finalizeOutcome, cancelRecoveryDecision };
