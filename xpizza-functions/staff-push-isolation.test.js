/**
 * Guard: the STAFF push lane (Phase 2b) is purely additive — the DRIVER push path stays
 * byte-for-byte intact. A static assertion over index.js source (no runtime/firebase).
 * Run: `node --test staff-push-isolation.test.js`.
 *
 * A stronger check (line-range diff of sendDriverPush / notifyDriverOnAssignment vs origin/main)
 * is the advisor gate's job; this pins the load-bearing landmarks in CI.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('driver push path untouched — sendDriverPush + notifyDriverOnAssignment present verbatim', () => {
  assert.ok(src.includes('async function sendDriverPush(db, uid, payload)'), 'sendDriverPush signature intact');
  assert.ok(src.includes('exports.notifyDriverOnAssignment = onValueWritten('), 'notifyDriverOnAssignment export intact');
  assert.ok(src.includes('driver_push_tokens/${uid}'), 'FCM token lane intact');
  assert.ok(src.includes('await refreshPushReachable(db, uid)'), 'refreshPushReachable cleanup intact');
});

test('staff lane added additively — helpers + triggers present', () => {
  assert.ok(src.includes('async function sendStaffPush(db, uid, payload)'), 'sendStaffPush present');
  assert.ok(src.includes('async function fanoutStaffPush(db, payload)'), 'fanoutStaffPush present');
  assert.ok(src.includes('exports.notifyStaffOnNewOrder = onValueWritten('), 'notifyStaffOnNewOrder present');
  assert.ok(src.includes('exports.flushStaffPushQueue = onSchedule('), 'flushStaffPushQueue present');
  assert.ok(src.includes('exports.sweepStuckOrders = onSchedule('), 'sweepStuckOrders present');
});

test('staff lane never touches driver storage nodes', () => {
  // Isolate the staff block (from the lane banner to the driver-assignment export) and assert it
  // reads/writes only staff_push* + config/push — no driver_push_tokens / drivers/<uid> mutations.
  const start = src.indexOf('// STAFF WEB-PUSH LANE (Phase 2b)');
  const end = src.indexOf('exports.notifyDriverOnAssignment = onValueWritten(');
  assert.ok(start > 0 && end > start, 'staff block located');
  const block = src.slice(start, end);
  // Match CODE forms (path-ref / call syntax), not the bare words — the lane banner names the
  // frozen driver nodes as documentation and must not itself trip the guard.
  assert.equal(/driver_push_tokens\/\$\{/.test(block), false, 'staff lane must not ref driver_push_tokens');
  assert.equal(/refreshPushReachable\(/.test(block), false, 'staff lane must not call refreshPushReachable');
  assert.equal(/getMessaging\(/.test(block), false, 'staff lane must not use FCM');
});
