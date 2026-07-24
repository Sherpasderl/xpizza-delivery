'use strict';
const assert=require('assert');
process.env.OTP_SALT='x'.repeat(40);
const L=require('./otp-lib');
let n=0; const ok=l=>console.log(`  ok ${++n} ${l}`);
assert.equal(L.phoneHash('+504 9999-9999'), L.phoneHash('50499999999')); ok('phoneHash normalizes + is stable');
assert.notEqual(L.phoneHash('50499999999'), L.phoneHash('50488888888')); ok('distinct phones distinct hash');
const c=L.genCode(); assert.ok(/^\d{6}$/.test(c)); ok('6-digit code');
assert.equal(L.hashCode('123456'), L.hashCode('123456')); assert.notEqual(L.hashCode('123456'), L.hashCode('654321')); ok('code hash stable + distinct');
assert.ok(L.constEq('abc','abc') && !L.constEq('abc','abd')); ok('constant-time compare');
// fail-closed salt
delete require.cache[require.resolve('./otp-lib')]; const OLD=process.env.OTP_SALT; process.env.OTP_SALT='';
assert.throws(()=>require('./otp-lib')); process.env.OTP_SALT=OLD; ok('missing/short OTP_SALT throws (fail-closed)');
console.log(`otp-lib: OK (${n})`);
