'use strict';

// paymentPollState — the online-return poll state machine, incl. the new closed_refunded (paid-after-close).
// Run: node payment-poll-state.test.js
const assert = require('assert');
const { paymentPollState } = require('./payment-poll-state');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// NEW: paid-after-close auto-refund → closed_refunded (before the generic cancelled mapping)
assert.strictEqual(paymentPollState({ blocked_reason: 'refunded_paid_after_close', payment_status: 'refunded', status: 'cancelled' }), 'closed_refunded'); ok('paid-after-close refund → closed_refunded');
assert.strictEqual(paymentPollState({ blocked_reason: 'refunded_paid_after_close', status: 'cancelled', payment_status: 'refunded' }), 'closed_refunded'); ok('closed_refunded takes precedence over the generic cancelled mapping');

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

console.log(`\n${n} passed`);
