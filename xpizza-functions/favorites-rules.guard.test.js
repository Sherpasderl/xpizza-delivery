'use strict';
// S-C favorites (PLAN §S-C) — the user_favorites RULES, pinned STATICALLY (the behaviour runs on the emulator:
// test/favorites-rules.emulator.test.js). Members only, owner only, never a handheld; NO write once the account carries ANY tombstone
// or a sweep claim (deleted_uids, user_private.deleted_at, user_profiles.deleting_at — the user_profiles guards); $rid = the
// platform's restaurant-id shape (platform-manifest RID_RE — one source); each favorite is exactly { createdAt: number ≤ now + 60 s }.
// Run: node favorites-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RID_RE } = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
const top = rules.user_favorites;
assert.ok(top && top.$uid, 'premise: rules.user_favorites.$uid exists');
assert.deepStrictEqual(Object.keys(top), ['$uid'], '🔴 nothing grants access at the user_favorites root (no .read / .write above $uid)');
const u = top.$uid;
const OWNER = "auth != null && auth.token.handheld !== true && auth.token.customer === true && auth.uid === $uid";
assert.strictEqual(u['.read'], OWNER, '🔴 read: the member owner only (customer token, never a handheld)');
const w = u['.write'];
for (const guard of [OWNER, "!root.child('deleted_uids').child($uid).exists()", "!root.child('user_private').child($uid).child('deleted_at').exists()", "!root.child('user_profiles').child($uid).child('deleting_at').exists()"])
  assert.ok(w.includes(guard), `🔴 write must carry: ${guard}`);
ok('read / write: the member OWNER only (auth, customer claim, uid match, never a handheld); NO write under any tombstone or a sweep claim');

const r = u.$rid;
assert.ok(r && r['.validate'].includes(`$rid.matches(${RID_RE.toString()})`), `🔴 $rid must match the platform RID_RE ${RID_RE}`);
assert.ok(r['.validate'].includes("newData.hasChildren(['createdAt'])"), 'a favorite carries createdAt');
assert.strictEqual(r.createdAt['.validate'], 'newData.isNumber() && newData.val() <= now + 60000', '🔴 createdAt: a number, never in the future (+60 s skew)');
assert.strictEqual(r.$other['.validate'], false, '🔴 no other field');
assert.deepStrictEqual(Object.keys(u).sort(), ['$rid', '.read', '.write'], 'nothing else under $uid');
ok(`each favorite: $rid = the platform RID_RE (${RID_RE}), exactly { createdAt: number ≤ now + 60 s }, no other field`);

console.log(`favorites-rules.guard: OK (${n})`);
