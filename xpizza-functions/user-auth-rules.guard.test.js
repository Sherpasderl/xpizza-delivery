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
for (const k of ['user_orders','otp','otp_ip','phone_index','deleted_uids']){
  const node = k==='user_orders' ? rules.user_orders.$uid : rules[k];
  assert.equal(node['.read'], false); assert.equal(node['.write'], false); ok(`${k} deny-all`);
}

// ── R1 durable-deletion fixes: tombstone-guarded recreation + client-immutable last_login ──
assert.ok(/!root\.child\('deleted_uids'\)\.child\(\$uid\)\.exists\(\)/.test(up['.write']),
  `user_profiles write must block a tombstoned uid (got: ${up['.write']})`); ok('user_profiles write blocks recreation of a tombstoned (deleted) uid');
assert.ok(/newData\.val\(\) === data\.val\(\)/.test(up.last_login['.validate']),
  `last_login must be client-immutable (got: ${up.last_login['.validate']})`); ok('last_login client-immutable (cannot future-date to dodge the H9 sweep)');

// ── R2 fix: a client cannot strip a server-truth field via child-delete. .validate does NOT run on a null
// write, so the immutability guards can't stop a delete; the parent .write requires all 4 fields present
// (hasChildren), evaluated on the MERGED post-write node, which cascades to child writes. ──
for (const f of ['phone', 'phone_hash', 'created_at', 'last_login']) {
  assert.ok(new RegExp(`hasChildren\\([^)]*'${f}'`).test(up['.write']),
    `user_profiles write must require '${f}' present via hasChildren — got: ${up['.write']}`);
  ok(`user_profiles write requires ${f} present (blocks client child-delete of server-truth field)`);
}
console.log(`user-auth-rules.guard: OK (${n})`);
