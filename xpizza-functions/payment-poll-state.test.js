'use strict';

// paymentPollState — the online-return poll state machine, incl. the new closed_refunded (paid-after-close).
// Run: node payment-poll-state.test.js
const assert = require('assert');
const { paymentPollState } = require('./payment-poll-state');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// NEW: paid-after-close auto-refund → closed_refunded (before the generic cancelled mapping)
assert.strictEqual(paymentPollState({ blocked_reason: 'refunded_paid_after_close', payment_status: 'refunded', status: 'cancelled' }), 'closed_refunded'); ok('paid-after-close refund → closed_refunded');
assert.strictEqual(paymentPollState({ blocked_reason: 'refunded_paid_after_close', status: 'cancelled', payment_status: 'refunded' }), 'closed_refunded'); ok('closed_refunded takes precedence over the generic cancelled mapping');
// REVISE: refund-in-flight (paid-after-close) → verifying, NOT the generic refund_pending→cancelled
assert.strictEqual(paymentPollState({ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close' }), 'verifying'); ok('refund_pending_paid_after_close → verifying (reassure, not cancelled)');

// Regression: existing states unchanged
assert.strictEqual(paymentPollState({ payment_status: 'confirmed', status: 'new' }), 'paid'); ok('confirmed/new → paid');
assert.strictEqual(paymentPollState({ status: 'ready' }), 'paid'); ok('live status (ready) → paid');
assert.strictEqual(paymentPollState({ status: 'cancelled' }), 'cancelled'); ok('cancelled → cancelled');
assert.strictEqual(paymentPollState({ payment_status: 'refunded' }), 'cancelled'); ok('generic refunded (no paid-after-close reason) → cancelled');
assert.strictEqual(paymentPollState({ payment_status: 'refund_pending' }), 'cancelled'); ok('refund_pending → cancelled');
assert.strictEqual(paymentPollState({ payment_status: 'failed' }), 'failed'); ok('failed → failed');
assert.strictEqual(paymentPollState({ payment_status: 'manual_reconciliation' }), 'verifying'); ok('manual_reconciliation → verifying');
assert.strictEqual(paymentPollState({ payment_status: 'pending' }), 'pending'); ok('pending → pending');
assert.strictEqual(paymentPollState({}), 'pending'); ok('empty → pending');
assert.strictEqual(paymentPollState({ status: 'scheduled' }), 'scheduled_paid'); ok('scheduled → scheduled_paid');
assert.strictEqual(paymentPollState({ status: 'releasing' }), 'scheduled_paid'); ok('releasing → scheduled_paid');

// F2 — paid scheduled order, slot closed at confirm → manual_review + blocked_reason:'confirm_<reason>' → scheduled_review
assert.strictEqual(paymentPollState({ status: 'pending_payment', payment_status: 'manual_review', blocked_reason: 'confirm_closed_at_slot' }), 'scheduled_review'); ok('F2: confirm_closed_at_slot → scheduled_review');
assert.strictEqual(paymentPollState({ status: 'pending_payment', payment_status: 'manual_review', blocked_reason: 'confirm_missed_window' }), 'scheduled_review'); ok('F2: confirm_missed_window → scheduled_review');
assert.strictEqual(paymentPollState({ status: 'pending_payment', payment_status: 'manual_review' }), 'pending'); ok('F2 boundary: manual_review WITHOUT confirm_ blocked_reason → pending (unchanged)');
assert.strictEqual(paymentPollState({ status: 'scheduled', blocked_reason: 'confirm_closed_at_slot' }), 'scheduled_paid'); ok('F2 order: a live scheduled order still → scheduled_paid (scheduled check precedes)');

console.log(`\n${n} passed`);
