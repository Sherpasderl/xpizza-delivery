'use strict';
// DISH PHOTOS A2 step 10 — THE MODULE INVERSE, PROVEN: tools/photos-module-inverse.js turns catalog/catalog-publish.js back into
// 743277de BYTE-FOR-BYTE, so the older guards that pin it (context-guards by sha, identity-integrity / identity-record guards,
// extras-wiring, pmdisplay-wiring) reverse this slice FIRST and keep pinning everything else. Same-line hunks (no line moves). An edit
// inside a hunk, a duplicated hunk, a missing hunk and a byte outside every hunk are each caught; the hook sits BEFORE the flip.
// Run: node photos-module-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyPhotosModule, FILES, HUNKS, BASE } = require('./tools/photos-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES], ['catalog/catalog-publish.js', 'catalog/public-menu.js'], 'PHOTOS-MODULE-FILES');
for (const f2 of FILES) {
  const s2 = read(f2); const b2 = baseOf(f2);
  assert.notStrictEqual(s2, b2, `non-vacuity: ${f2} carries the hunks`);
  assert.strictEqual(unapplyPhotosModule(f2, s2), b2, `🔴 PHOTOS-MODULE-PROOF: ${f2} minus the photos hunks is not ${BASE}:${f2}`);
  assert.strictEqual(s2.split('\n').length, b2.split('\n').length, `PHOTOS-MODULE-SAME-LINE ${f2}`);
}
const f = FILES[0]; const src = read(f); const base = baseOf(f);
assert.notStrictEqual(src, base, 'non-vacuity: the hunks are present');
assert.strictEqual(unapplyPhotosModule(f, src), base, `🔴 PHOTOS-MODULE-PROOF: ${f} minus the photos hunks is not ${BASE}:${f}`);
assert.strictEqual(src.split('\n').length, base.split('\n').length, 'PHOTOS-MODULE-SAME-LINE');
for (const h of HUNKS.filter((x) => x.file === f)) {
  assert.throws(() => unapplyPhotosModule(f, src.replace(h.now, h.now.replace('DISH PHOTOS', 'DISH PHOTOZ'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyPhotosModule(f, src + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyPhotosModule(f, src.replace(h.now, h.was)), /occurs 0 times/, 'a missing hunk');
}
assert.notStrictEqual(unapplyPhotosModule(f, src.replace("'use strict';", "'use strict'; ")), base, 'a byte OUTSIDE every hunk is detected');
assert.strictEqual(unapplyPhotosModule('tb/not-a-module.js', 'x'), 'x', 'other files pass through');
ok(`${f}: unapplyPhotosModule → ${BASE} byte-for-byte (${HUNKS.length} same-line hunks); inside / duplicate / missing / outside each caught`);

// the hook runs AFTER the version verifies and BEFORE the flip; meta/photos is deleted with its version
const L = src.split('\n');
const hookAt = L.findIndex((l) => l.includes('if (input && input.photos) await input.photos.commit(db, rid, versionId);'));
const flipAt = L.findIndex((l, i) => i > hookAt && l.includes('const flipped = await flipPointer('));
assert.ok(hookAt > 0 && flipAt > hookAt && L[hookAt].includes('await verifyVersionStructure(db, rid, versionId);'), 'PHOTOS-MODULE-HOOK-BEFORE-FLIP');
const delAt = L.findIndex((l) => l.includes("ops.push((b) => b.delete(vref.collection('meta').doc('photos')));"));
const dv = L.findIndex((l) => l.startsWith('async function deleteVersion('));
assert.ok(dv > 0 && delAt > dv && delAt < dv + 12, 'PHOTOS-MODULE-META-DELETED-WITH-ITS-VERSION');
ok('the commit hook sits on publishVersion\'s verify line, BEFORE flipPointer; meta/photos is deleted inside deleteVersion');
console.log(`photos-module-wiring.guard: OK (${n})`);
