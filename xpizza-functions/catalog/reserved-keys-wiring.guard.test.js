'use strict';
// S1c (D4c-grill/item-s1/S1c-DESIGN.md D2) — the reserved-key set's WIRING in the activation transaction (static).
//   1. The set is read inside the transaction, among the reads, before the certified branch and before any write.
//   2. The activated version's item and extra docs are read ONCE, before the certified branch, and the certified branch reuses
//      that read (no second read of the same collections).
//   3. The union is written in the same transaction, after the branch (so certified and uncertified, publish and rollback all
//      pass it) and before the pointer moves, behind the limit check.
// Behaviour is pinned by test/reserved-keys-flip.emulator.test.js. Run: node catalog/reserved-keys-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, 'catalog-publish.js'), 'utf8');

const start = src.indexOf('async function flipPointer(');
const end = src.indexOf('\nasync function ', start + 10);
assert.ok(start >= 0 && end > start, 'anchor: flipPointer');
const body = src.slice(start, end);
const at = (needle, label) => { const i = body.indexOf(needle); assert.ok(i >= 0, `anchor: ${label || needle}`); return i; };
const count = (needle) => body.split(needle).length - 1;

const READ = 'const reservedSnap = await tx.get(RK.reservedRefOf(db, rid));';
const VREAD = "const [candItemsSnap, candExtrasSnap] = await Promise.all([tx.get(versionsColOf(db, rid).doc(versionId).collection('menu_items')), tx.get(versionsColOf(db, rid).doc(versionId).collection('extras'))]);";
const BRANCH = 'if (certifiedCandidate) {';
const UNION = 'tx.set(RK.reservedRefOf(db, rid), reservedNext.doc);';
const LIMIT = 'RK.assertWithinLimit(reservedNext.doc);';
const POINTER = 'tx.set(pointerRef, {';

// ── 1 ──
{
  assert.strictEqual(src.split("const RK = require('./reserved-keys');").length - 1, 1, '🔴 RKW-REQUIRE the module is required once');
  assert.strictEqual(count(READ), 1, '🔴 RKW-READ-ONCE the set is read exactly once in the transaction');
  const firstWrite = Math.min(...['tx.set(', 'tx.update(', 'tx.create(', 'tx.delete(', 'applyIdentityPlan('].map((w) => { const i = body.indexOf(w); return i < 0 ? Infinity : i; }));
  assert.ok(at(READ) < firstWrite, '🔴 RKW-READ-FIRST the set is read before any write');
  assert.ok(at(READ) < at(BRANCH), '🔴 RKW-READ-OUTSIDE the read is outside (before) the certified branch');
  ok('the set is read once, before any write and outside the certified branch');
}
// ── 2 ──
{
  assert.strictEqual(count(VREAD), 1, '🔴 RKW-VREAD the activated version\'s docs are read once');
  assert.ok(at(VREAD) < at(BRANCH), '🔴 RKW-VREAD before the certified branch');
  const branch = body.slice(at(BRANCH));
  assert.ok(!/tx\.get\(vref\.collection\('menu_items'\)\)/.test(branch) && !/tx\.get\(vref\.collection\('extras'\)\)/.test(branch), '🔴 RKW-NO-DOUBLE-READ the certified branch reuses the read');
  ok('the activated version\'s item and extra docs are read once, before the branch, and reused by it');
}
// ── 3 ──
{
  assert.strictEqual(count(UNION), 1, '🔴 RKW-UNION-ONCE');
  assert.strictEqual(count(LIMIT), 1, '🔴 RKW-LIMIT');
  const closeBranch = body.indexOf('const activation = candidateSnap.exists');
  assert.ok(closeBranch > at(BRANCH), 'anchor: after the branch');
  assert.ok(at(UNION) > closeBranch, '🔴 RKW-UNION-AFTER-BRANCH every activation passes the union (it is not inside the certified branch)');
  assert.ok(at(LIMIT) < at(UNION) && at(UNION) < at(POINTER), '🔴 RKW-UNION-BEFORE-POINTER limit check → union write → pointer');
  ok('the union is written after the branch (every activation) and before the pointer moves, behind the limit check');
}
// ── 4 ── the slice's test-only inverse returns the activation module to its base byte for byte (every older pin peels it)
{
  const I = require('../tools/reservedkeys-module-inverse');
  assert.deepStrictEqual([...I.FILES], ['catalog/catalog-publish.js'], 'RKW-INVERSE the slice edits exactly one pinned file');
  const back = I.unapplyReservedKeysModule('catalog/catalog-publish.js', src);
  assert.strictEqual(require('crypto').createHash('sha256').update(back).digest('hex'), '012eccdf776cc4f06c52dcb9cba315e8dc3daa30f026368e1e5b3192b5ce0669', '🔴 RKW-INVERSE round trip to 43cfdf11');
  assert.strictEqual(back.split('\n').length, src.split('\n').length, '🔴 RKW-SAME-LINE the slice adds no line to the pinned file');
  ok('the inverse returns catalog-publish.js to 43cfdf11 byte for byte; same-line edits only');
}
console.log(`\nreserved-keys-wiring.guard: OK (${n})`);
