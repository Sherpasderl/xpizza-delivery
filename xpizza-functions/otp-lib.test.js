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
// offer-audience PLAN r2 §6 (silent normaliser): phoneHash never prints a phone — whatsapp.normalizePhone logs the raw input when it is
// invalid; phoneHash runs on every login / guest / audience path, so its normaliser is a silent one with identical semantics
{ const W=require('./whatsapp'); const out=[]; const keep={log:console.log,warn:console.warn,error:console.error,info:console.info};
  for(const k of Object.keys(keep)) console[k]=(...a)=>out.push(a.join(' '));
  let h; try { h=L.phoneHash('99 12-3'); } finally { Object.assign(console,keep); }
  assert.strictEqual(h,null,'NORM-SILENT: an invalid phone has no hash'); assert.deepStrictEqual(out,[],'NORM-SILENT: phoneHash printed '+JSON.stringify(out));
  const seen=[]; const w=console.warn; console.warn=(...a)=>seen.push(a.join(' '));
  try { for(const p of ['+50488884444','504 8888-4444','88884444','8888-4444','12','','  ','+1 (415) 555-0100','1234567890123456','abc 9999 9999'])
    assert.strictEqual(L.normalizePhoneQuiet(p), W.normalizePhone(p), `NORM-SAME: ${JSON.stringify(p)}`); } finally { console.warn=w; }
  assert.ok(seen.length>0,'premise: the loud normaliser does log an invalid phone'); ok('phoneHash is silent on an invalid phone; its normaliser = whatsapp.normalizePhone on 10 inputs'); }
// fail-closed salt
delete require.cache[require.resolve('./otp-lib')]; const OLD=process.env.OTP_SALT; process.env.OTP_SALT='';
assert.throws(()=>require('./otp-lib')); process.env.OTP_SALT=OLD; ok('missing/short OTP_SALT throws (fail-closed)');
console.log(`otp-lib: OK (${n})`);
