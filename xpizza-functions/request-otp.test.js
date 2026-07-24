'use strict';
// Unit tests for requestOtp's rate-limit state machines (the exact pure fns the RTDB transactions run).
const assert = require('assert');
process.env.OTP_SALT = 'y'.repeat(40);
const OTP = require('./otp-lib');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const NOW = 1_700_000_000_000;
const { MIN_GAP, WINDOW, MAX_PER_WINDOW, IP_MAX_PER_HR } = OTP.LIMITS;

// ── per-phone slot reservation (sendReserve) ──
// fresh phone → reserves, generates a 6-digit code, stores ONLY the hash, attempts 0
const fresh = OTP.sendReserve(null, NOW);
assert.ok(fresh.next && /^\d{6}$/.test(fresh.code)); ok('fresh send reserves + 6-digit code');
assert.ok(fresh.next.code_hash && fresh.next.code_hash !== fresh.code && !('code' in fresh.next)); ok('only the code HASH is stored (no plaintext)');
assert.equal(fresh.next.attempts, 0); assert.equal(fresh.next.sends.length, 1); ok('attempts=0, send recorded');
assert.equal(OTP.hashCode(fresh.code), fresh.next.code_hash); ok('stored hash matches the generated code');

// 2nd send within 30s → ABORT (next undefined)
const tooSoon = OTP.sendReserve({ sends: [NOW - 5_000] }, NOW);
assert.equal(tooSoon.next, undefined); assert.equal(tooSoon.code, null); ok('2nd send within 30s rejected');

// exactly at the 30s boundary is still within (> now - MIN_GAP) → allow just after
const afterGap = OTP.sendReserve({ sends: [NOW - (MIN_GAP + 1)] }, NOW);
assert.ok(afterGap.next); ok('send allowed after the 30s min-gap');

// 4th send in the 10-min window → ABORT (3 already, none within 30s)
const many = OTP.sendReserve({ sends: [NOW - 9*60e3, NOW - 5*60e3, NOW - 2*60e3] }, NOW);
assert.equal(many.next, undefined); ok('4th send within 10-min window rejected (3-per-window cap)');

// stale sends outside the window are pruned, so a new send is allowed
const stale = OTP.sendReserve({ sends: [NOW - (WINDOW + 1), NOW - (WINDOW + 2)] }, NOW);
assert.ok(stale.next && stale.next.sends.length === 1); ok('sends older than the window are pruned');

// ── per-IP hourly cap (ipReserve) ──
const ip1 = OTP.ipReserve(null, NOW);
assert.equal(ip1.count, 1); ok('fresh IP → count 1');
const ipAtCap = OTP.ipReserve({ window_start: NOW - 60e3, count: IP_MAX_PER_HR }, NOW);
assert.equal(ipAtCap, undefined); ok('IP at hourly cap → aborted');
const ipRoll = OTP.ipReserve({ window_start: NOW - 3600e3 - 1, count: IP_MAX_PER_HR }, NOW);
assert.ok(ipRoll && ipRoll.count === 1); ok('IP window older than 1h resets');

// ── phone normalization / no-enumeration input guard ──
assert.equal(OTP.phoneHash('garbage'), null); ok('invalid phone → null (handler returns uniform ok)');

console.log(`request-otp: OK (${n})`);
