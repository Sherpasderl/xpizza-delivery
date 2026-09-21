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
const refunded = (over = {}) => ({ payment_status: 'refunded', blocked_reason: 'refunded_paid_after_close', refunded_at: NOW - 5 * 60 * 1000, ...over });

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

// missing refunded_at → treated as age 0 → not stale → conservative skip (never re-drive on unknown age).
assert.strictEqual(needsRefundNotifyRecovery(refunded({ refunded_at: undefined }), NOW, STALE), false);
ok('missing refunded_at → conservative skip (age 0)');

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
