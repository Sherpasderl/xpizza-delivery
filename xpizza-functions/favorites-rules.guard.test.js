'use strict';
// S-C favorites (PLAN §S-C) — the user_favorites RULES, pinned STATICALLY (the behaviour runs on the emulator:
// test/favorites-rules.emulator.test.js). Members only, owner only, never a handheld; NO write once the account carries ANY tombstone
// or a sweep claim (deleted_uids, user_private.deleted_at, user_profiles.deleting_at — the user_profiles guards), and no READ either
// (Codex S-C r1); the whole node is an object; $rid = the platform's restaurant-id shape (platform-manifest RID_RE — one source) AND a
// real restaurant; each favorite is exactly { createdAt: number ≤ now + 60 s }.
// Run: node favorites-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RID_RE } = require('./platform-manifest');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;
const top = rules.user_favorites;
assert.ok(top && top.$uid, 'premise: rules.user_favorites.$uid exists');
// Codex S-C r1 #4: NO ancestor grant — neither the database root nor user_favorites grants read / write (a grant above $uid would
// cascade over every member's favorites; RTDB rules never revoke downward)
for (const k of ['.read', '.write']) assert.ok(!(k in rules), `🔴 the database ROOT carries no ${k} (an ancestor grant cascades over user_favorites)`);
assert.deepStrictEqual(Object.keys(top), ['$uid'], '🔴 nothing grants access at the user_favorites root (no .read / .write above $uid)');
const u = top.$uid;
const OWNER = "auth != null && auth.token.handheld !== true && auth.token.customer === true && auth.uid === $uid";
const TOMBS = ["!root.child('deleted_uids').child($uid).exists()", "!root.child('user_private').child($uid).child('deleted_at').exists()", "!root.child('user_profiles').child($uid).child('deleting_at').exists()"];
for (const k of ['.read', '.write']) {
  assert.ok(u[k].startsWith(OWNER), `🔴 ${k}: the member owner only (customer token, never a handheld)`);
  for (const guard of TOMBS) assert.ok(u[k].includes(guard), `🔴 ${k} must carry: ${guard}`);
}
ok('the database root and user_favorites grant nothing; read / write: the member OWNER only (auth, customer claim, uid match, never a handheld); NO read or write under any tombstone or a sweep claim');

assert.strictEqual(u['.validate'], 'newData.hasChildren()', '🔴 Codex S-C r1 #1: the whole node is an object (a scalar whole-node write is refused; a delete is never validated)');
ok('$uid .validate: the whole node must be an object — no scalar replacement');

const r = u.$rid;
assert.ok(r && r['.validate'].includes(`$rid.matches(${RID_RE.toString()})`), `🔴 $rid must match the platform RID_RE ${RID_RE}`);
assert.ok(r['.validate'].includes("newData.hasChildren(['createdAt'])"), 'a favorite carries createdAt');
// Codex S-C r1 #2 (advisor-ACCEPTED 2026-11-02; documented in xpizza-reference/SCHEMA.md — the rules file is pure JSON, no comments):
// bounded to REAL restaurants — the rid must have the server-side identity the directory's activity reads
// (catalog/public-menu.js activityWithSource → restaurant-config getIdentity → restaurants/{rid}/identity), so the node is bounded
// by the number of restaurants
assert.ok(r['.validate'].includes("root.child('restaurants').child($rid).child('identity').exists()"), '🔴 $rid must name a real restaurant (restaurants/{rid}/identity exists)');
assert.strictEqual(r.createdAt['.validate'], 'newData.isNumber() && newData.val() <= now + 60000', '🔴 createdAt: a number, never in the future (+60 s skew)');
assert.strictEqual(r.$other['.validate'], false, '🔴 no other field');
assert.deepStrictEqual(Object.keys(u).sort(), ['$rid', '.read', '.validate', '.write'], 'nothing else under $uid');
ok(`each favorite: $rid = the platform RID_RE (${RID_RE}) AND a real restaurant (its identity exists), exactly { createdAt: number ≤ now + 60 s }, no other field`);

console.log(`favorites-rules.guard: OK (${n})`);
