'use strict';
// Unit tests for the paid-after-close refund-notification decision core (paid-after-close-notify.js).
// Run: node paid-after-close-notify.test.js
// Proves the AT-LEAST-ONCE contract: the sender dedupes on the confirmed-sent marker, and the sweep re-drives a
// finalized-but-unnotified refund (closing the crash/failed-send zero-message gap) — while never re-driving an
// order that was already sent, isn't paid-after-close, isn't terminal, or is still fresh.
const assert = require('assert');
const { alreadyRefundNotified, needsRefundNotifyRecovery } = require('./paid-after-close-notify');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

const NOW = 1_800_000_000_000;
const STALE = 2 * 60 * 1000;
// A recoverable order: terminal paid-after-close refund, has a phone (sendable), refunded long enough ago to be stale.
const refunded = (over = {}) => ({ payment_status: 'refunded', blocked_reason: 'refunded_paid_after_close', customer_phone: '99990000', refunded_at: NOW - 5 * 60 * 1000, ...over });

// ── alreadyRefundNotified: the sender's dedupe gate ──
assert.strictEqual(alreadyRefundNotified({ paid_after_close_refund_sent_at: NOW }), true);
ok('alreadyRefundNotified → true once sent_at is set (dedupe)');
assert.strictEqual(alreadyRefundNotified({}), false);
assert.strictEqual(alreadyRefundNotified(null), false);
ok('alreadyRefundNotified → false when unsent / missing (not vacuous)');

// ── needsRefundNotifyRecovery: the sweep's re-drive selector ──
// The crux: a finalized refund that never confirmed its message → recover (this is the zero-message fix).
assert.strictEqual(needsRefundNotifyRecovery(refunded(), NOW, STALE), true);
ok('finalized refund, no sent_at, stale → RECOVER (closes crash/failed-send zero-message)');

// already sent → never re-drive (no double from the sweep).
assert.strictEqual(needsRefundNotifyRecovery(refunded({ paid_after_close_refund_sent_at: NOW }), NOW, STALE), false);
ok('already sent → no re-drive (dedupe)');

// still fresh → don't race an in-flight finalize's own send.
assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: NOW - 30 * 1000 }), NOW, STALE), false);
ok('refunded < staleMs ago → not yet recovered (no race with in-flight finalize)');

// ── refunded_at PARSE: only a real finite POSITIVE ms timestamp is a known age; everything else → conservative skip.
// The bug this kills: Number(null|''|false)===0 (finite) would be mis-read as epoch-0 → huge age → wrongly ELIGIBLE.
// Assertion that fires red if the strict-parse guard is removed: each of these returns false (would flip to true under Number()).
for (const bad of [null, '', false, undefined, 0, -1, -STALE, NaN]) {
  assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: bad }), NOW, STALE), false);
}
// a numeric STRING must NOT count either (strict typeof number) — a stale-looking string can't smuggle eligibility.
assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: String(NOW - 5 * 60 * 1000) }), NOW, STALE), false);
ok('refunded_at null/""/false/undefined/0/negative/NaN/numeric-string → conservative skip (strict positive-number age, no Number() coercion trap)');

// ── exact staleMs BOUNDARY: age must be STRICTLY greater than staleMs to recover (kills an off-by-one at the gate).
assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: NOW - 120000 }), NOW, STALE), false); // age === staleMs → NOT yet
assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: NOW - 120001 }), NOW, STALE), true);  // age === staleMs+1 → recover
ok('staleMs boundary: age==120000 skips, age==120001 recovers (strict age > staleMs)');

// ── no customer_phone → un-sendable → never selected (the sweep must not churn a phone-less order forever).
// Fires red if the phone guard is dropped: a phone-less stale refund would flip to true.
assert.strictEqual(needsRefundNotifyRecovery(refunded({ customer_phone: undefined }), NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery(refunded({ customer_phone: '' }), NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery(refunded({ customer_phone: null }), NOW, STALE), false);
ok('no customer_phone (undefined/""/null) → not selected (un-sendable never churns the sweep)');

// NOT paid-after-close: an ordinary refund/cancel must never get this message.
assert.strictEqual(needsRefundNotifyRecovery(refunded({ blocked_reason: undefined }), NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery(refunded({ blocked_reason: 'refunded_other' }), NOW, STALE), false);
ok('refunded but NOT paid-after-close → no recovery (scoped to the marker)');

// NOT terminal yet (still refunding/refund_pending) → handled by the existing recoverRefundingDecision path, not here.
assert.strictEqual(needsRefundNotifyRecovery(refunded({ payment_status: 'refunding_paid_after_close' }), NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery(refunded({ payment_status: 'refund_pending' }), NOW, STALE), false);
ok('not-yet-refunded PAC states → not this branch (no double-handling)');

// look-alike / garbage → false (fail-safe: never invent a refund message).
assert.strictEqual(needsRefundNotifyRecovery(null, NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery({}, NOW, STALE), false);
assert.strictEqual(needsRefundNotifyRecovery({ payment_status: 'confirmed' }, NOW, STALE), false);
ok('null / garbage / non-refunded → false (fail-safe)');

console.log(`\npaid-after-close-notify: ${pass} checks passed`);
