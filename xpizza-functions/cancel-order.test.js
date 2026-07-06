'use strict';

// Goldens for the dispatcher-cancel pure core (cancel-order.js). Run: node cancel-order.test.js
// Money-path decision logic — a wrong branch is a lost charge or a double-void, so every gate is pinned.
const assert = require('assert');
const C = require('./cancel-order');
const MR = require('./manual-resolve');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── B.2 gate ──
assert.deepStrictEqual(C.gate({ status: 'delivered', payment_status: 'confirmed' }).reject.outcome, 'not_cancelable'); ok('delivered → 409 not_cancelable');
assert.deepStrictEqual(C.gate({ status: 'completed', payment_status: 'confirmed' }).reject.outcome, 'not_cancelable'); ok('completed → 409 not_cancelable');
assert.strictEqual(C.gate({ status: 'new', payment_status: 'resolving_refund' }).reject.outcome, 'resolving_in_progress'); ok('isResolving → 409 resolving_in_progress');
assert.strictEqual(C.gate({ status: 'new', payment_status: 'manual_review' }).reject.outcome, 'manual_review'); ok('[Fix#1] payment_status manual_review → 409 (human-resolve, blocks retry re-void)');
assert.strictEqual(C.gate({ status: 'pending_payment', payment_status: 'manual_reconciliation' }).reject.outcome, 'in_recon_surface'); ok('manual_reconciliation + pending_payment → 409 in_recon_surface');
{
  const g = C.gate({ status: 'cancelled', payment_status: 'manual_reconciliation' });
  assert.strictEqual(g.reject.outcome, 'manual_review'); assert.strictEqual(g.reject.alert, true);
  ok('manual_reconciliation NOT in surface (cancelled) → 409 manual_review + alert');
}
assert.deepStrictEqual(C.gate({ status: 'new', payment_status: 'confirmed' }), { ok: true }); ok('live confirmed order → ok (proceed)');
assert.deepStrictEqual(C.gate({ status: 'new', payment_method: 'cash' }), { ok: true }); ok('live cash order → ok (uniform path)');
// Scheduled Orders: a HELD (scheduled/releasing) paid order MUST be cancelable → cancelPaidOrder refunds
// the captured money via the shipped reversal machine (no held-money trap; the claim guard blocks the race).
assert.deepStrictEqual(C.gate({ status: 'scheduled', payment_status: 'confirmed' }), { ok: true }); ok('scheduled (held, paid) → ok → cancelPaidOrder refunds it');
assert.deepStrictEqual(C.gate({ status: 'releasing', payment_status: 'confirmed' }), { ok: true }); ok('releasing (mid-release) paid → ok (cancelable)');

// ── B.4 cancelledDecision (status==='cancelled' only) ──
assert.deepStrictEqual(C.cancelledDecision({ payment_status: 'refunded' }, {}), { code: 200, outcome: 'already_cancelled' }); ok('cancelled+refunded → already_cancelled (200)');
assert.deepStrictEqual(C.cancelledDecision({ payment_status: 'failed' }, { hosted_state: 'created' }), { code: 200, outcome: 'already_cancelled' }); ok('cancelled, no captured evidence (failed, unpaid attempt) → already_cancelled');
assert.deepStrictEqual(C.cancelledDecision({ payment_status: 'refund_pending' }, { capture_verified: true, payment_uuid: 'S-1' }), { code: 409, outcome: 'refund_pending' }); ok('cancelled+refund_pending (money) → 409 refund_pending');
assert.deepStrictEqual(C.cancelledDecision({ payment_status: 'confirmed' }, { hosted_state: 'paid', payment_uuid: 'S-1' }), { heal: true }); ok('cancelled + captured money + uuid → heal (void)');
{
  const d = C.cancelledDecision({ payment_status: 'confirmed' }, { hosted_state: 'paid' }); // no uuid
  assert.strictEqual(d.outcome, 'manual_review'); assert.strictEqual(d.alert, true);
  ok('cancelled + captured money but NO resolvable uuid → 409 manual_review + alert');
}

// ── B.5 claimDecision (null-first-safe) + claimLanded ──
assert.strictEqual(C.claimDecision(null, 'CID', 100), null); ok('claim: cur===null → null (force server round-trip)');
assert.strictEqual(C.claimDecision({ payment_status: 'confirmed', resolving_action: 'cancel', cancel_claim_id: 'OTHER' }, 'CID', 100), undefined); ok('claim: another cancel owns it → abort');
assert.strictEqual(C.claimDecision({ payment_status: 'resolving_refund' }, 'CID', 100), undefined); ok('claim: recon claim holds it → abort');
{
  const out = C.claimDecision({ order_id: 'O', payment_status: 'confirmed', status: 'new' }, 'CID', 100);
  assert.deepStrictEqual(out, { order_id: 'O', payment_status: 'confirmed', status: 'new', cancel_claim_id: 'CID', resolving_action: 'cancel', resolving_phase: MR.PHASE.CLAIMED, resolving_claimed_at: 100 });
  ok('claim: clean → stamps cancel_claim_id + resolving_action=cancel + phase, payment_status untouched');
}
assert.strictEqual(C.claimLanded({ cancel_claim_id: 'CID', resolving_action: 'cancel' }, 'CID'), true); ok('claimLanded: our claim id + cancel action → true');
assert.strictEqual(C.claimLanded(null, 'CID'), false); ok('claimLanded: null commit → false (404)');
assert.strictEqual(C.claimLanded({ cancel_claim_id: 'OTHER', resolving_action: 'cancel' }, 'CID'), false); ok('claimLanded: foreign claim id → false');

// ── B.7 shouldVoid ──
assert.strictEqual(C.shouldVoid({ payment_status: 'confirmed' }, { hosted_state: 'paid' }), true); ok('shouldVoid: captured money, not reversed → true');
assert.strictEqual(C.shouldVoid({ payment_status: 'refunded' }, { hosted_state: 'paid' }), false); ok('shouldVoid: order already refunded → false (no double-void)');
assert.strictEqual(C.shouldVoid({ payment_status: 'confirmed' }, { hosted_state: 'paid', status: 'refunded' }), false); ok('[Fix#1] shouldVoid: ATTEMPT already refunded → false (no re-void after recovery)');
assert.strictEqual(C.shouldVoid({ payment_status: 'confirmed' }, { capture_verified: true, status: 'voided' }), false); ok('[Fix#1] shouldVoid: attempt voided → false');
assert.strictEqual(C.shouldVoid({ payment_status: 'confirmed' }, { capture_verified: true, status: 'refund_pending' }), false); ok('[Fix#1] shouldVoid: attempt refund_pending → false');
assert.strictEqual(C.shouldVoid({ payment_status: 'refund_pending' }, { capture_verified: true }), false); ok('shouldVoid: refund_pending → false');
assert.strictEqual(C.shouldVoid({ payment_status: 'pending' }, { payment_uuid: 'S-1' }), false); ok('shouldVoid: bare UUID (possible declined auth) → false (no void)');
assert.strictEqual(C.shouldVoid({ payment_method: 'cash', status: 'new' }, null), false); ok('shouldVoid: cash order, no evidence → false (plain finalize)');

// ── isAlreadyReversed + reversedPaymentStatus (Fix A — no cancelled-but-reads-confirmed) ──
assert.strictEqual(C.isAlreadyReversed({ payment_status: 'confirmed' }, { status: 'refunded' }), true); ok('isAlreadyReversed: attempt refunded → true');
assert.strictEqual(C.isAlreadyReversed({ payment_status: 'refund_pending' }, {}), true); ok('isAlreadyReversed: order refund_pending → true');
assert.strictEqual(C.isAlreadyReversed({ payment_status: 'confirmed' }, { status: 'captured' }), false); ok('isAlreadyReversed: captured attempt → false');
assert.strictEqual(C.reversedPaymentStatus({ payment_status: 'confirmed' }, { status: 'refunded' }), 'refunded'); ok('[Fix A] reversedPaymentStatus: attempt refunded → refunded (never left confirmed)');
assert.strictEqual(C.reversedPaymentStatus({ payment_status: 'confirmed' }, { status: 'voided' }), 'refunded'); ok('[Fix A] reversedPaymentStatus: attempt voided → refunded');
assert.strictEqual(C.reversedPaymentStatus({ payment_status: 'confirmed' }, { status: 'refund_pending' }), 'refund_pending'); ok('[Fix A] reversedPaymentStatus: refund_pending → refund_pending');

// ── isReconcilerRetryable (closes the reversal machine — every non-terminal state has a scheduled re-drive) ──
{
  const RS = 2 * 60 * 1000, NW = 1e9;
  assert.strictEqual(C.isReconcilerRetryable({ status: 'refund_pending' }, NW, RS), true); ok('reconciler selects refund_pending');
  assert.strictEqual(C.isReconcilerRetryable({ status: 'reversing', reversing_at: NW - RS - 1 }, NW, RS), true); ok('[Fix B-r3] reconciler selects STALE reversing (crashed void)');
  assert.strictEqual(C.isReconcilerRetryable({ status: 'reversing', reversing_at: NW - 1000 }, NW, RS), false); ok('[Fix B-r3] reconciler SKIPS fresh reversing (in-flight void — no double-void)');
  assert.strictEqual(C.isReconcilerRetryable({ status: 'captured' }, NW, RS), false); ok('reconciler skips captured');
  assert.strictEqual(C.isReconcilerRetryable({ status: 'refunded' }, NW, RS), false); ok('reconciler skips terminal refunded');
  assert.strictEqual(C.isReconcilerRetryable(null, NW, RS), false); ok('reconciler skips null attempt');
}

// ── B.11 finalizeOutcome ──
assert.deepStrictEqual(C.finalizeOutcome({ hadEvidence: false, voided: false }), { code: 200, outcome: 'cancelled', payment_status: null }); ok('finalize: no money → cancelled (200), payment_status untouched');
assert.deepStrictEqual(C.finalizeOutcome({ hadEvidence: true, voided: true }), { code: 200, outcome: 'cancelled', payment_status: 'refunded' }); ok('finalize: voided → cancelled+refunded (200)');
assert.deepStrictEqual(C.finalizeOutcome({ hadEvidence: true, voided: false }), { code: 409, outcome: 'refund_pending', payment_status: 'refund_pending' }); ok('finalize: void failed → refund_pending (409), never fake refunded');

// ── B.10 cancelRecoveryDecision ──
const STALE = 10 * 60 * 1000, NOW = 1e9;
assert.strictEqual(C.cancelRecoveryDecision({ payment_status: 'confirmed' }, NOW, STALE).act, false); ok('recovery: not a cancel claim → no act');
assert.deepStrictEqual(C.cancelRecoveryDecision({ resolving_action: 'cancel', resolving_phase: 'claimed', resolving_claimed_at: NOW - STALE - 1 }, NOW, STALE), { act: true, clearClaim: true, alert: false }); ok('recovery: pre-side-effect stale → clear claim (safe)');
assert.deepStrictEqual(C.cancelRecoveryDecision({ resolving_action: 'cancel', resolving_phase: 'side_effect_started', resolving_claimed_at: NOW - STALE - 1 }, NOW, STALE), { act: true, to: 'manual_review', alert: true }); ok('recovery: post-side-effect stale → manual_review + alert (never blind re-void)');
assert.strictEqual(C.cancelRecoveryDecision({ resolving_action: 'cancel', resolving_phase: 'claimed', resolving_claimed_at: NOW - 1000 }, NOW, STALE).act, false); ok('recovery: in-flight (not stale) → no act');

console.log(`cancel-order: OK (${n} cases)`);
