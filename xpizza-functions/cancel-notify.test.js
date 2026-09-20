'use strict';
// Unit tests for the cancel-notification suppression predicate (cancel-notify.js).
// Run: node cancel-notify.test.js
// Proves: the never-placed (abandoned) case AND the paid-after-close auto-refund case suppress the generic
// message (the latter gets a dedicated refund message from the finalize path instead), EVERY real cancellation
// still notifies, look-alike markers do NOT suppress (the predicate is not over-broad), and an unknown shape
// fails safe toward notifying.
const assert = require('assert');
const { suppressCancelledNotification } = require('./cancel-notify');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

// The exact shapes the real writers produce when they set status:'cancelled':
//   resolve-manual.js:103 (Descartar)         → { payment_status:'abandoned', status:'cancelled' }
//   materialize-guard.js:88 / recovery sweep   → { payment_status:'refunded', status:'cancelled', blocked_reason:'refunded_paid_after_close' }
//   cancel-order-core.js:48 (real cancel)      → { status:'cancelled', cancelled_at, cancelled_by, cancel_reason }
//   resolve-manual.js:146 (manual Reembolsar)  → { payment_status:'refunded'|'refund_pending', status:'cancelled' }

// ── SUPPRESS: the two cases where the generic message must NOT fire ──
assert.strictEqual(suppressCancelledNotification({ payment_status: 'abandoned', status: 'cancelled' }), true);
ok('abandoned cart (Descartar) → suppress (customer never placed it)');

// paid-after-close auto-refund: the finalize path sends the DEDICATED refund message (reliably, at-most-once,
// with a durable unresolved-marker on failure), so the generic here would be a confusing double → suppress it.
assert.strictEqual(suppressCancelledNotification({ payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close' }), true);
ok('paid-after-close auto-refund → suppress generic (dedicated refund message sent by the finalize path)');

// precedence sanity: an abandoned order that somehow also carried the refund marker still suppresses.
assert.strictEqual(suppressCancelledNotification({ payment_status: 'abandoned', blocked_reason: 'refunded_paid_after_close' }), true);
ok('either marker → suppress');

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
