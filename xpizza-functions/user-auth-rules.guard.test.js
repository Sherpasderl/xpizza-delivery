'use strict';
// H1 guard: customer custom tokens (customer:true) must NOT satisfy any operational staff read.
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname,'..','xpizza-reference','database.rules.json'),'utf8')).rules;
let n=0; const ok=(l)=>console.log(`  ok ${++n} ${l}`);
// Every top-level operational read that gates on auth: customer tokens must be excluded, either by an
// explicit `auth.token.customer !== true` clause or by a positive staff-role check (dispatchers membership).
const STAFF_NODES = ['dispatchers','drivers','tasks','orders','config','order_timelines','incoming_messages','kitchen'];
for (const k of STAFF_NODES){
  const r = (rules[k] && rules[k]['.read']) || '';
  assert.ok(/auth\.token\.customer\s*!==\s*true/.test(r) || /dispatchers'\)\.child\(auth\.uid\)/.test(r),
    `${k}.read must exclude customer tokens (got: ${r})`);
  assert.ok(!/^\s*auth != null\s*$/.test(r), `${k}.read must not be bare auth!=null`);
  ok(`${k} read excludes customer tokens`);
}
// restaurants/$restaurant_id/identity is the nested 8th bare-auth read — assert it too.
const ident = ((((rules.restaurants||{}).$restaurant_id||{}).identity)||{})['.read'] || '';
assert.ok(/auth\.token\.customer\s*!==\s*true/.test(ident), `restaurants/$restaurant_id/identity.read must exclude customer tokens (got: ${ident})`);
ok('restaurants identity read excludes customer tokens');
// No bare `auth != null` operational read may remain anywhere in the ruleset.
const raw = fs.readFileSync(path.join(__dirname,'..','xpizza-reference','database.rules.json'),'utf8');
assert.ok(!/"\.read":\s*"auth != null"/.test(raw), 'no bare auth!=null read may remain');
ok('zero bare auth!=null reads remain');

// ── Task 2: user_profiles owner-only + otp/phone_index/user_orders deny-all ──
const up = rules.user_profiles.$uid;
assert.equal(up['.read'],  "auth != null && auth.uid === $uid"); ok('user_profiles read owner-only');
assert.ok(/newData\.exists\(\)/.test(up['.write']) && /auth\.uid === \$uid/.test(up['.write'])); ok('user_profiles write owner-only + no wholesale delete');
assert.ok(/newData\.val\(\) === data\.val\(\)/.test(up.phone['.validate'])); ok('phone immutable');
assert.ok(/newData\.val\(\) === data\.val\(\)/.test(up.created_at['.validate'])); ok('created_at immutable');
assert.equal(up.addresses['.validate'], false); ok('addresses denied (P2)');
assert.equal(up.$other['.validate'], false); ok('no stray profile keys');
for (const k of ['user_orders','otp','otp_ip','phone_index']){
  const node = k==='user_orders' ? rules.user_orders.$uid : rules[k];
  assert.equal(node['.read'], false); assert.equal(node['.write'], false); ok(`${k} deny-all`);
}
console.log(`user-auth-rules.guard: OK (${n})`);
