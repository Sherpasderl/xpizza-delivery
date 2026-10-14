'use strict';
// PLAN-H0 — the PURE classifier (superseded-capture.js). Run: node superseded-capture.test.js
// The record SHAPES below are the ones the real writers produce (field names / values cited from the census); the
// emulator suite (test/superseded-capture.emulator.test.js) drives the real writers end to end.
const assert = require('assert');
const H0 = require('./superseded-capture');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const O = 'PZX-1';
// attempt shapes as written by: webhook paid (:110), acquire claim (creating/created), voidOrRefund terminal, manual materializer (:35)
const paidHosted = (over = {}) => ({ order_id: O, hosted_state: 'paid', hosted_callback_verified: true, payment_hash_verified: true, payment_uuid: 'U1', paid_amount_cents: 29900, paid_at: 1, ...over });
const created = (over = {}) => ({ order_id: O, hosted_state: 'created', hosted_checkout_url: 'https://x', ...over });
const order = (over = {}) => ({ order_id: O, status: 'pending_payment', payment_status: 'pending', active_attempt_id: 'A2', ...over });

// ── accounted: exactly ONE attempt ──
{
  // auto-confirm writes payment_reference = the PixelPay txn ref (names no attempt) → the active attempt is accounted
  const o = order({ payment_status: 'confirmed', status: 'new', active_attempt_id: 'A1', payment_reference: 'TXN-123' });
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted(), null), null, 'auto-confirmed active attempt → nothing');
  // manual materializer: payment_reference = attemptId (A1) after a rotation to A2 → A1 accounted, a later paid A2 alerts
  const m = order({ payment_status: 'confirmed', status: 'new', active_attempt_id: 'A2', payment_reference: 'A1' });
  const a1 = { order_id: O, status: 'captured', capture_verified: true, manual_verified: true };
  assert.strictEqual(H0.classify(O, m, 'A1', a1, a1), null, 'manual-materialized A1 (payment_reference) → nothing');
  assert.strictEqual(H0.classify(O, m, 'A2', paidHosted(), a1), 'paid_superseded', 'A1 manual + A2 later paid → A2 alerts (codex r4 P1-1)');
  // a payment_reference naming an attempt of ANOTHER order does not count → the active attempt is accounted
  assert.strictEqual(H0.accountedAttemptId(O, m, { order_id: 'OTHER' }), 'A2');
  ok('accounted = payment_reference when it NAMES this order\'s attempt, else the active attempt; every other paid attempt alerts');
}
// ── the superseded capture ──
{
  const o = order({ active_attempt_id: 'A2' });
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted(), null), 'paid_superseded', 'paid A1 after rotation to A2');
  assert.strictEqual(H0.classify(O, o, 'A2', paidHosted(), null), null, 'the active paid attempt → nothing');
  assert.strictEqual(H0.classify(O, o, 'A1', created(), null), null, 'an unpaid rotated attempt → nothing');
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted({ order_id: 'OTHER' }), null), null, 'an attempt of another order → nothing');
  assert.strictEqual(H0.classify(O, null, 'A1', paidHosted(), null), null, 'no order → nothing (orphans are logged by the caller)');
  ok('a verified paid NON-accounted attempt → paid_superseded; active / unpaid / foreign / orphan → nothing');
}
// ── reversals ──
{
  const o = order({ active_attempt_id: 'A2' });
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted({ status: 'refunded' }), null), null, 'proven reversed (refunded)');
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted({ status: 'voided' }), null), null, 'proven reversed (voided)');
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted({ status: 'refund_pending' }), null), null, 'reconciler-owned (refund_pending)');
  assert.strictEqual(H0.classify(O, o, 'A1', paidHosted({ status: 'reversing', reversing_phase: 'claimed' }), null), null, 'reconciler-owned (reversing)');
  // codex r3 P1-3 mixed state: real voidPaid + stale-reversal recovery
  const mixed = paidHosted({ status: 'manual_review', hosted_state: 'refund_pending', reversing_phase: 'side_effect_started' });
  assert.strictEqual(H0.classify(O, o, 'A1', mixed, null), 'reversal_uncertain', 'codex mixed state → reversal_uncertain');
  assert.strictEqual(H0.classify(O, o, 'A2', mixed, null), 'reversal_uncertain', '… even when the attempt is the accounted one');
  // independent of the paid flags (codex r4 P1-2): a direct-cancel stale reversal without paid flags
  assert.strictEqual(H0.classify(O, o, 'A2', { order_id: O, status: 'manual_review', refund_message: 'stale_reversing_post_side_effect' }, null), 'reversal_uncertain', 'manual_review with no paid flags');
  assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, hosted_callback_verified: true, status: 'manual_review', no_uuid_paid_callback: { at: 1 } }, null), 'reversal_uncertain', 'the no-uuid marker');
  // codex build r1 P2-3: a PROVEN reversal (or one a job owns) beats a surviving marker
  for (const st of ['refunded', 'voided', 'refund_pending', 'reversing']) {
    assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, hosted_callback_verified: true, hosted_state: 'voided', status: st, no_uuid_paid_callback: { at: 1 } }, null), null, `the marker under status ${st}`);
    assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, hosted_callback_verified: true, status: st, reversing_phase: 'side_effect_started' }, null), null, `side_effect_started under status ${st}`);
  }
  assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, reversing_phase: 'side_effect_started', status: 'captured' }, null), 'reversal_uncertain', 'side_effect_started outside reversing');
  assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, hosted_state: 'voided', status: 'captured' }, null), 'reversal_uncertain', 'hosted voided with a non-terminal status');
  assert.strictEqual(H0.classify(O, o, 'A1', { order_id: O, hosted_state: 'voided', status: 'refunded' }, null), null, 'hosted voided + status refunded → proven');
  ok('proven reversed / reconciler-owned → nothing; every durable uncertain state → reversal_uncertain, accounted or not, paid flags or not');
}
// ── evidence version ──
{
  const v1 = H0.evidenceVersion('paid_superseded', paidHosted());
  assert.strictEqual(v1, H0.evidenceVersion('paid_superseded', paidHosted({ paid_at: 999 })), 'paid_at does not change the version');
  assert.notStrictEqual(v1, H0.evidenceVersion('paid_superseded', paidHosted({ payment_uuid: 'U2' })), 'a different uuid changes it');
  assert.notStrictEqual(v1, H0.evidenceVersion('paid_superseded', paidHosted({ paid_amount_cents: 1 })), 'a different amount changes it');
  assert.notStrictEqual(v1, H0.evidenceVersion('reversal_uncertain', paidHosted()), 'a different kind changes it');
  ok('the evidence version keys on kind / uuid / amount / status / hosted_state only');
}
// ── evidence keys (abandon) ──
{
  assert.strictEqual(H0.hasEvidenceKeys({}), false);
  assert.strictEqual(H0.hasEvidenceKeys({ paid_evidence: {} }), false);
  assert.strictEqual(H0.hasEvidenceKeys({ paid_evidence: { A1: { kind: 'paid_superseded' } } }), true);
  ok('hasEvidenceKeys: only a non-empty paid_evidence counts');
}
// ── ruling C: an evidence child is resolved ONLY by a dismissal naming its stored (kind, version) ──
{
  const ev = (o = {}) => ({ kind: 'paid_superseded', version: 'v1', ...o });
  assert.strictEqual(H0.evidenceResolved(ev()), false, 'not dismissed');
  assert.strictEqual(H0.evidenceResolved(ev({ dismissed_kind: 'paid_superseded', dismissed_version: 'v1' })), true);
  assert.strictEqual(H0.evidenceResolved(ev({ dismissed_kind: 'paid_superseded', dismissed_version: 'v0' })), false, 'an older version');
  assert.strictEqual(H0.evidenceResolved(ev({ dismissed_kind: 'reversal_uncertain', dismissed_version: 'v1' })), false, 'another kind');
  assert.strictEqual(H0.evidenceResolved({ dismissed_kind: 'paid_superseded', dismissed_version: 'v1' }), false, 'a dismissal-only child (no kind) is never resolved');
  assert.strictEqual(H0.hasUnresolvedEvidenceKeys({ paid_evidence: { A: ev({ dismissed_kind: 'paid_superseded', dismissed_version: 'v1' }), B: ev() } }), true, 'one open child blocks');
  assert.strictEqual(H0.hasUnresolvedEvidenceKeys({ paid_evidence: { A: ev({ dismissed_kind: 'paid_superseded', dismissed_version: 'v1' }) } }), false);
  assert.strictEqual(H0.hasUnresolvedEvidenceKeys({}), false);
  ok('evidenceResolved / hasUnresolvedEvidenceKeys: resolved only by a dismissal of exactly the stored (kind, version)');
}
console.log(`\nsuperseded-capture: OK (${n})`);
