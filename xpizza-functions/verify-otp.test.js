'use strict';
// Unit tests for verifyOtp's atomic verify+consume state machine (the exact pure fn the RTDB
// transaction runs). A mint may happen ONLY when outcome==='ok'; consume happens BEFORE minting.
const assert = require('assert');
process.env.OTP_SALT = 'z'.repeat(40);
const OTP = require('./otp-lib');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const NOW = 1_700_000_000_000;
const CODE = '123456';
const good = () => ({ code_hash: OTP.hashCode(CODE), expires_at: NOW + 60e3, attempts: 0, sends: [NOW] });

// correct code → ok + marks consumed (BEFORE mint)
{
  const r = OTP.verifyConsume(good(), NOW, CODE);
  assert.equal(r.outcome, 'ok'); assert.equal(r.next.consumed, true); ok('correct code → ok + consumed');
}
// wrong code → fail + attempts++ (no consume, no mint)
{
  const r = OTP.verifyConsume(good(), NOW, '000000');
  assert.equal(r.outcome, 'fail'); assert.equal(r.next.attempts, 1); assert.ok(!r.next.consumed); ok('wrong code → fail + attempts++');
}
// expired → fail (even with the correct code)
{
  const v = { ...good(), expires_at: NOW - 1 };
  const r = OTP.verifyConsume(v, NOW, CODE);
  assert.equal(r.outcome, 'fail'); ok('expired code → fail (no mint)');
}
// already consumed → fail (a 2nd/parallel verify cannot double-mint)
{
  const v = { ...good(), consumed: true };
  const r = OTP.verifyConsume(v, NOW, CODE);
  assert.equal(r.outcome, 'fail'); ok('already-consumed → fail (no double-mint)');
}
// attempts at cap → fail (must re-request), even with the correct code
{
  const v = { ...good(), attempts: 5 };
  const r = OTP.verifyConsume(v, NOW, CODE);
  assert.equal(r.outcome, 'fail'); ok('attempts>=5 → fail (capped)');
}
// absent OTP node (null) → fail
{
  const r = OTP.verifyConsume(null, NOW, CODE);
  assert.equal(r.outcome, 'fail'); ok('absent OTP → fail');
}
// simulate the double-verify race: first consumes, feeding its next-state into a second verify → fail
{
  const first = OTP.verifyConsume(good(), NOW, CODE);
  assert.equal(first.outcome, 'ok');
  const second = OTP.verifyConsume(first.next, NOW, CODE);   // parallel attempt sees consumed state
  assert.equal(second.outcome, 'fail'); ok('serialized double-verify: exactly one ok, second fails');
}
// attempts climb monotonically toward the cap, then lock out
{
  let v = good();
  for (let i = 1; i <= 5; i++) v = OTP.verifyConsume(v, NOW, '999999').next;
  assert.equal(v.attempts, 5);
  const locked = OTP.verifyConsume(v, NOW, CODE);
  assert.equal(locked.outcome, 'fail'); ok('5 wrong attempts → locked out even for the right code');
}

console.log(`verify-otp: OK (${n})`);
