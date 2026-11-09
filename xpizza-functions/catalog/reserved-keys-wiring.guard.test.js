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
// ── 5 ── D3 at the activation: switch ON only, the ACTIVE version's items read with the other reads, the rename rule judged
//    against the set as read (before the union), before the union and the pointer
{
  const AREAD = "const activeItemsSnap = (textEditCapabilities().enabled && liveActive && liveActive !== versionId) ? await tx.get(versionsColOf(db, rid).doc(liveActive).collection('menu_items')) : null;";
  const CHECK = "const rkConflict = activeItemsSnap ? RK.renameConflicts({ items: candItemsSnap.docs.map((d) => d.data() || {}), activeItems: activeItemsSnap.docs.map((d) => d.data() || {}), reserved: RK.reservedKeySet(reservedDoc) })[0] : null;";
  assert.strictEqual(count(AREAD), 1, '🔴 RKW-D3-AREAD the active items are read once, only with the switch on');
  assert.ok(at(AREAD) < at(BRANCH), '🔴 RKW-D3-AREAD among the reads, before any write');
  assert.strictEqual(count(CHECK), 1, '🔴 RKW-D3-CHECK');
  assert.ok(at(CHECK) < at(LIMIT) && at(CHECK) < at(UNION) && at(CHECK) < at(POINTER), '🔴 RKW-D3-ORDER judged against the set as read, before the union and the pointer');
  assert.strictEqual(src.split("const { textEditCapabilities } = require('./item-text-edit');").length - 1, 1, '🔴 RKW-D3 the switch is read from its one module');
  ok('D3 at the activation: switch-gated read of the active items; the rename rule runs before the union and the pointer');
}
// ── 4 ── the slice's test-only inverse returns every pinned file it edits to its base byte for byte (every older pin peels it)
{
  const I = require('../tools/reservedkeys-module-inverse');
  const BASE_SHA = {
    'catalog/catalog-publish.js': '012eccdf776cc4f06c52dcb9cba315e8dc3daa30f026368e1e5b3192b5ce0669',
    'catalog/edit-catalog-handler.js': 'a747ce0695a06d762a3424c2cf893376a1ce983e056c87be917be93e04c3b37a',
    'catalog/publish-edited-handler.js': 'ef64da069cc1766399fab66580096a087f8db6ac5ab444b8d16a2eb968e30613',
  };
  assert.deepStrictEqual([...I.FILES].sort(), Object.keys(BASE_SHA).sort(), 'RKW-INVERSE the slice edits exactly these pinned files');
  for (const [f, want] of Object.entries(BASE_SHA)) {
    const now = fs.readFileSync(path.join(__dirname, '..', f));
    const back = Buffer.from(I.unapplyReservedKeysModule(f, now.toString('utf8')), 'utf8');
    assert.strictEqual(require('crypto').createHash('sha256').update(back).digest('hex'), want, `🔴 RKW-INVERSE ${f} round trip to 43cfdf11`);
    assert.strictEqual(back.toString('utf8').split('\n').length, now.toString('utf8').split('\n').length, `🔴 RKW-SAME-LINE ${f}: no line added`);
  }
  ok('the inverse returns each pinned file to 43cfdf11 byte for byte; same-line edits only');
}
console.log(`\nreserved-keys-wiring.guard: OK (${n})`);
