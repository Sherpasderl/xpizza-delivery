'use strict';

// Golden tests for the atomic-claim pure core (manual-resolve.js). Run: node manual-resolve.test.js
// This is the load-bearing money logic (claim decision, automation predicate, phase-aware recovery,
// paid-evidence, honest-status contract) — a wrong branch here is a money-loss path, so it's pinned.
const assert = require('assert');
const M = require('./manual-resolve');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── claimDecision: null-first-safe + claims only from manual_reconciliation ──
assert.strictEqual(M.claimDecision(null, 'abandon', 'CID', 100), null); ok('[R2-#1] cur===null → null (force server read, not abort)');
assert.strictEqual(M.claimDecision(undefined, 'abandon', 'CID', 100), undefined); ok('undefined node → abort');
assert.strictEqual(M.claimDecision({ payment_status: 'confirmed' }, 'refund', 'CID', 100), undefined); ok('non-manual status → abort (loser → 409)');
assert.strictEqual(M.claimDecision({ payment_status: 'resolving_abandon' }, 'abandon', 'CID', 100), undefined); ok('already resolving → abort');
{
  const out = M.claimDecision({ order_id: 'O1', payment_status: 'manual_reconciliation', total: 5 }, 'refund', 'CID', 100);
  assert.deepStrictEqual(out, { order_id: 'O1', total: 5, payment_status: 'resolving_refund', resolving_action: 'refund', resolving_claim_id: 'CID', resolving_claimed_at: 100, resolving_phase: 'claimed' });
  ok('manual_reconciliation → whole-node claim (status/action/claim_id/claimed_at/phase, other fields preserved)');
}

// ── claimLanded [R2-#4]: a null no-op commits but claims nothing ──
assert.strictEqual(M.claimLanded({ resolving_claim_id: 'CID', payment_status: 'resolving_abandon' }, 'abandon', 'CID'), true); ok('[R2-#4] our claim_id + resolving status → landed');
assert.strictEqual(M.claimLanded(null, 'abandon', 'CID'), false); ok('[R2-#4] null committed (deleted order) → NOT landed (→ 409/404)');
assert.strictEqual(M.claimLanded({ resolving_claim_id: 'OTHER', payment_status: 'resolving_abandon' }, 'abandon', 'CID'), false); ok('foreign claim_id → not landed');

// ── isStatusChangeClosedToAutomation [R4]: gates status-change, not evidence ──
for (const ps of ['resolving_abandon', 'resolving_refund', 'manual_reconciliation', 'confirmed', 'refunded', 'refund_pending', 'abandoned', 'manual_review'])
  assert.strictEqual(M.isStatusChangeClosedToAutomation(ps), true, ps);
ok('closed to status-change automation: resolving_* + terminals + manual_reconciliation');
for (const ps of ['pending_payment', 'new', 'pending', 'capturing', undefined])
  assert.strictEqual(M.isStatusChangeClosedToAutomation(ps), false, String(ps));
ok('OPEN to automation: pending_payment / new / pending / capturing (automation-owned states)');

// ── hasPaidEvidence: any of paid_during_resolve / uuid / capture_verified ──
assert.strictEqual(M.hasPaidEvidence({ paid_during_resolve: true }, null), true); ok('paid_during_resolve → evidence');
assert.strictEqual(M.hasPaidEvidence(null, { payment_uuid: 'S-…' }), true); ok('persisted UUID → evidence');
assert.strictEqual(M.hasPaidEvidence(null, { capture_verified: true }), true); ok('capture_verified → evidence');
assert.strictEqual(M.hasPaidEvidence({}, {}), false); ok('no evidence → false (abandon allowed)');

// ── hasCapturedMoneyEvidence: TIGHT void gate — captured money only, bare UUID EXCLUDED (F3/F4) ──
assert.strictEqual(M.hasCapturedMoneyEvidence({ payment_status: 'confirmed' }, null), true); ok('confirmed order → captured evidence');
assert.strictEqual(M.hasCapturedMoneyEvidence({ paid_during_resolve: true }, null), true); ok('paid_during_resolve → captured evidence');
assert.strictEqual(M.hasCapturedMoneyEvidence(null, { hosted_state: 'paid' }), true); ok('hosted_state=paid → captured evidence');
assert.strictEqual(M.hasCapturedMoneyEvidence(null, { hosted_callback_verified: true }), true); ok('hosted_callback_verified (durable webhook bit) → captured evidence');
assert.strictEqual(M.hasCapturedMoneyEvidence(null, { capture_verified: true }), true); ok('capture_verified → captured evidence');
assert.strictEqual(M.hasCapturedMoneyEvidence({ payment_status: 'pending' }, { payment_uuid: 'S-1' }), false); ok('🔴 bare UUID only (declined auth carries one) → NOT captured evidence (no auto-void)');
assert.strictEqual(M.hasCapturedMoneyEvidence({}, {}), false); ok('nothing → false');

// ── httpForOutcome [E/#9]: 2xx ONLY for genuinely-final, else 409 ──
for (const o of ['abandoned', 'refunded', 'materialized', 'confirmed', 'already_confirmed'])
  assert.strictEqual(M.httpForOutcome(o), 200, o);
ok('final outcomes → 200');
for (const o of ['refund_pending', 'manual_review', 'confirm_claim_failed', 'attempt_superseded', 'no_charge', 'error'])
  assert.strictEqual(M.httpForOutcome(o), 409, o);
ok('[#9] non-final outcomes (incl. refund_pending) → 409, never fake success');

// ── recoveryDecision [D/R2-#2]: PHASE-AWARE — the double-refund hole ──
const STALE = 10 * 60 * 1000, NOW = 1_000_000_000;
assert.deepStrictEqual(M.recoveryDecision({ payment_status: 'resolving_refund', resolving_phase: 'claimed', resolving_claimed_at: NOW - STALE - 1 }, NOW, STALE), { act: true, to: 'manual_reconciliation', alert: false }); ok('[R2-#2] pre-side-effect stale → revert to manual_reconciliation (safe)');
assert.deepStrictEqual(M.recoveryDecision({ payment_status: 'resolving_refund', resolving_phase: 'side_effect_started', resolving_claimed_at: NOW - STALE - 1 }, NOW, STALE), { act: true, to: 'manual_review', alert: true }); ok('[R2-#2] 🔴 POST-side-effect stale → manual_review + alert, NEVER back to re-resolvable manual_reconciliation');
assert.strictEqual(M.recoveryDecision({ payment_status: 'resolving_refund', resolving_phase: 'claimed', resolving_claimed_at: NOW - 1000 }, NOW, STALE).act, false); ok('in-flight (not stale) → do NOT touch');
assert.strictEqual(M.recoveryDecision({ payment_status: 'abandoned' }, NOW, STALE).act, false); ok('non-resolving order → recovery no-op');

// ── close_fulfilled ("Cerrar como entregado"): keep-payment terminal — action + outcome + claim discipline ──
assert.ok(M.RESOLVE_ACTIONS.includes('close_fulfilled'), 'close_fulfilled is a CLAIMING resolve action'); ok('close_fulfilled ∈ RESOLVE_ACTIONS (it mutates → claims)');
assert.ok(M.ALL_ACTIONS.includes('close_fulfilled')); ok('close_fulfilled ∈ ALL_ACTIONS');
assert.ok(M.FINAL_SUCCESS_OUTCOMES.has('closed_fulfilled_offline') && M.httpForOutcome('closed_fulfilled_offline') === 200, 'closed_fulfilled_offline is a final 2xx success'); ok('closed_fulfilled_offline → final success (200) so the panel clears');
// Claim discipline (idempotency + no-double-resolve + can't run over an in-flight paid-after-close refund):
// claimDecision claims ONLY from manual_reconciliation, for close_fulfilled just like every other action.
{
  const claimed = M.claimDecision({ order_id: 'O7F82', payment_status: 'manual_reconciliation', restaurant_id: 'la_musa', total: 2280, blocked_reason: 'manual_refund_required_paid_after_close' }, 'close_fulfilled', 'CID', 200);
  assert.strictEqual(claimed.payment_status, 'resolving_close_fulfilled'); ok('close_fulfilled claims from manual_reconciliation → resolving_close_fulfilled');
  assert.strictEqual(M.claimLanded({ resolving_claim_id: 'CID', payment_status: 'resolving_close_fulfilled' }, 'close_fulfilled', 'CID'), true); ok('close_fulfilled claim lands on our claim_id');
}
assert.strictEqual(M.claimDecision({ payment_status: 'refunding_paid_after_close' }, 'close_fulfilled', 'CID', 200), undefined); ok('🔴 close_fulfilled CANNOT run over refunding_paid_after_close (not manual_reconciliation → abort → 409)');
assert.strictEqual(M.claimDecision({ payment_status: 'resolving_close_fulfilled' }, 'close_fulfilled', 'CID2', 200), undefined); ok('idempotent: a 2nd close_fulfilled while resolving → abort (no double-resolve)');
assert.strictEqual(M.claimDecision({ payment_status: 'confirmed' }, 'close_fulfilled', 'CID', 200), undefined); ok('idempotent: close_fulfilled over an already-terminal confirmed order → abort');

console.log(`manual-resolve: OK (${n} cases)`);
