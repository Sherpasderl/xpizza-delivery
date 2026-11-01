'use strict';
// SECURITY BACKLOG r2 — the forms verifyOtp (L1) lifecycle-gate WIRING (index.js `/* lifecycle:begin login-uid */`):
//   1. the inverse is EXACT: index.js minus the hunk === index.js at this branch's restack parent's bytes for verifyOtp (proven by
//      the full chains in every *-wiring guard, where it is composed INNERMOST); here: exactly the named whole lines go, nothing else;
//   2. PLACEMENT: inside exports.verifyOtp, right AFTER the phone_index resolution (the uid it gates) and BEFORE the profile read,
//      the welcome credit and the mint — so no token is ever minted for a uid the gate has not passed;
//   3. it calls SE.loginUid with this login's pHash and a fresh-uid generator of the SAME shape as the resolution's (u_ + 24 hex);
//   4. sensitivity: a missing / duplicated / shared-line marker throws.
// Run: node lifecycle-wiring.guard.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { unapplyLifecycleIndex, HUNKS } = require('./tools/lifecycle-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const H = HUNKS.find((h) => h.name === 'login-uid');

const out = unapplyLifecycleIndex(live);
assert.notStrictEqual(out, live, 'non-vacuity: the hunk is present');
const block = live.slice(live.lastIndexOf('\n', live.indexOf(H.begin)) + 1, live.indexOf(H.end) + H.end.length + 1);
assert.strictEqual(live.split('\n').length - out.split('\n').length, block.split('\n').length - 1, 'exactly the hunk\'s whole lines removed');
assert.strictEqual(out.split(block).join(''), out, 'nothing of the hunk remains');
assert.ok(!/lifecycle:(begin|end) /.test(out) && !/SE\.loginUid\(/.test(out), 'no lifecycle marker or loginUid call outside the hunk');
ok('inverse: index.js minus the login-uid hunk removes exactly its whole lines; no marker or loginUid call remains outside it');

const vStart = live.indexOf('exports.verifyOtp = onRequest(');
const vEnd = live.indexOf('\n);', vStart);
const at = live.indexOf(H.begin);
assert.ok(vStart > 0 && at > vStart && at < vEnd, 'the hunk is INSIDE exports.verifyOtp');
const body = live.slice(vStart, vEnd);
const i = (t) => { const k = body.indexOf(t); assert.ok(k >= 0, `premise: verifyOtp carries ${t}`); return k; };
const hunkAt = body.indexOf(H.begin);
assert.ok(i("if (!uid) { uid = 'u_' + require('crypto').randomBytes(12).toString('hex'); await idxRef.set(uid); }") < hunkAt, 'AFTER the phone_index resolution');
for (const t of ["const prof = (await profRef.get()).val();", 'await getAuth().createCustomToken(uid', 'await creditWelcome(db,']) assert.ok(hunkAt < i(t), `BEFORE ${t.slice(0, 40)}`);
ok('placement: inside verifyOtp, after the phone_index resolution and before the profile read, the mint and the welcome credit');

assert.ok(block.includes("uid = await SE.loginUid(db, { pHash, uid, now: Date.now(), newUid: () => 'u_' + require('crypto').randomBytes(12).toString('hex') });"), 'the gate call, with the resolution\'s uid shape');
ok('the call: uid = await SE.loginUid(db, { pHash, uid, now, newUid: u_ + 24 hex }) — the same uid shape as the resolution');

assert.throws(() => unapplyLifecycleIndex(live.replace(H.begin, '/* lifecycle:BEGIN login-uid */')), /missing/, 'a missing begin');
assert.throws(() => unapplyLifecycleIndex(live + `${H.begin}\n${H.end}\n`), /more than once/, 'a duplicated hunk');
assert.throws(() => unapplyLifecycleIndex(live.replace(`      ${H.begin}`, `      x; ${H.begin}`)), /own lines/, 'a marker sharing a base line');
ok('sensitivity: missing / duplicated / shared-line markers throw');

console.log(`\nlifecycle-wiring.guard: OK (${n})`);
