'use strict';
// Unit tests for the cancel-notification suppression predicate (cancel-notify.js).
// Run: node cancel-notify.test.js
// Proves: the never-placed (abandoned) case suppresses, EVERY real cancellation still notifies (incl.
// paid-after-close, whose double-message is a separate slice), look-alike markers do NOT suppress (the
// predicate is not over-broad), and an unknown shape fails safe toward notifying.
const assert = require('assert');
const { suppressCancelledNotification } = require('./cancel-notify');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// The exact shapes the real writers produce when they set status:'cancelled':
//   resolve-manual.js:103 (Descartar)         → { payment_status:'abandoned', status:'cancelled' }
//   materialize-guard.js:88 / recovery sweep   → { payment_status:'refunded', status:'cancelled', blocked_reason:'refunded_paid_after_close' }
//   cancel-order-core.js:48 (real cancel)      → { status:'cancelled', cancelled_at, cancelled_by, cancel_reason }
//   resolve-manual.js:146 (manual Reembolsar)  → { payment_status:'refunded'|'refund_pending', status:'cancelled' }

// ── SUPPRESS: the ONE never-notify case (a never-placed cart needs no message, and has no replacement) ──
assert.strictEqual(suppressCancelledNotification({ payment_status: 'abandoned', status: 'cancelled' }), true);
ok('abandoned cart (Descartar) → suppress (customer never placed it)');

// paid-after-close is NOT suppressed here: the marker proves the refund, not a successful notification, so
// suppressing on it could drop the customer's only message. The double-message is fixed on its own slice by
// consolidating the two senders — until then the refunded customer still gets a message (the pre-existing behavior).
assert.strictEqual(suppressCancelledNotification({ payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close' }), false);
ok('paid-after-close auto-refund → NOT suppressed here (notification-outcome not proven; separate slice)');

// ── NOTIFY: every real cancellation still sends (non-vacuity — the predicate must not swallow real cancels) ──
assert.strictEqual(suppressCancelledNotification({ status: 'cancelled', cancelled_by: 'dispatcher@x', cancel_reason: 'customer_request' }), false);
ok('real dispatcher cancel → notify (unchanged)');

assert.strictEqual(suppressCancelledNotification({ payment_status: 'refunded', status: 'cancelled' }), false);
ok('manual Reembolsar (refunded, no paid-after-close reason) → notify (customer placed it)');

assert.strictEqual(suppressCancelledNotification({ payment_status: 'refund_pending', status: 'cancelled' }), false);
ok('refund_pending real order → notify');

// ── NOT over-broad: look-alike markers must NOT suppress ──
assert.strictEqual(suppressCancelledNotification({ payment_status: 'refund_pending', blocked_reason: 'refund_pending_paid_after_close', status: 'cancelled' }), false);
ok('refund_pending_paid_after_close (in-flight, no dedicated cancel msg yet) → notify');

assert.strictEqual(suppressCancelledNotification({ payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' }), false);
ok('refund_failed_paid_after_close (needs manual handling) → notify');

assert.strictEqual(suppressCancelledNotification({ payment_status: 'manual_review', status: 'cancelled' }), false);
ok('manual_review real order → notify');

assert.strictEqual(suppressCancelledNotification({ blocked_reason: 'paid_strand_unrecovered' }), false);
ok('unrelated blocked_reason → notify');

// A near-miss on the abandoned string must not match (exact-value predicate, not substring/prefix).
assert.strictEqual(suppressCancelledNotification({ payment_status: 'abandoned_cart' }), false);
ok('payment_status look-alike (abandoned_cart) → notify (exact match only)');

// ── fail-safe: unknown/missing shape → notify (never silently drop a real cancel) ──
assert.strictEqual(suppressCancelledNotification(null), false);
assert.strictEqual(suppressCancelledNotification(undefined), false);
assert.strictEqual(suppressCancelledNotification('cancelled'), false);
assert.strictEqual(suppressCancelledNotification({}), false);
ok('missing/garbage order → notify (fail-safe)');

console.log(`\ncancel-notify: ${pass} checks passed`);
