'use strict';
// PLAN 2 — warm getPublicMenu: the wiring guard for tools/menu-warm-inverse.js.
//   1. PROOF: unapplyMenuWarmIndex(index.js) === BASE:index.js byte-for-byte (one same-line hunk); a byte inside the hunk, a
//      duplicated hunk and a byte outside it are each caught.
//   2. The option itself is asserted on the REAL export in cors-preflight.test.js (__endpoint.minInstances === 1).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, unapplyMenuWarmIndex } = require('./tools/menu-warm-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))));   // PLAN 3 landed on top: stripped first; R-WIRE train: the newer train slices reversed too (formsignal innermost → wahealth → drvc → drvf → stackseq → O1b)
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.strictEqual(HUNKS.length, 1, 'one hunk');
assert.notStrictEqual(unapplyMenuWarmIndex(real), real, 'non-vacuity: the hunk is present and swapped back');
assert.strictEqual(unapplyMenuWarmIndex(real), base, `🔴 index.js minus the menu-warm hunk is not ${BASE}:index.js`);
assert.strictEqual(real.split('\n').length, base.split('\n').length, 'SAME-LINE: no line is added or removed (R3 call sites do not shift)');
const h = HUNKS[0];
assert.throws(() => unapplyMenuWarmIndex(real.replace(h.now, h.now.replace('minInstances: 1', 'minInstances: 2'))), /occurs 0 times/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyMenuWarmIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
assert.notStrictEqual(unapplyMenuWarmIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the hunk survives (the base pin catches it)');
ok(`index.js: unapplyMenuWarmIndex → ${BASE}:index.js byte-for-byte (1 same-line hunk); inside / duplicate / outside each caught`);
const { foldPortalSplit } = require('./tools/portal-split');
const fold = require('./tools/o1b-inverse').unapplyO1bFold(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthFold(require('./tools/formsignal-inverse').unapplyFormSignalIndex(foldPortalSplit()))))));   // R-WIRE train: the newer train layers reversed first on the fold (formsignal innermost → wahealth (fold) → drvc → drvf → stackseq → O1b (fold))
assert.ok(fold.includes(h.now), 'premise: the hunk survives the portal fold');
assert.ok(!unapplyMenuWarmIndex(fold).includes('minInstances: 1 }'), 'the same inverse strips it from a fold');
assert.strictEqual(unapplyMenuWarmIndex(fold), foldPortalSplit(undefined, base), `🔴 the portal fold minus every newer layer and the menu-warm hunk is not the ${BASE} fold (a missing inverse fails here)`);
ok(`FOLD: the hunk survives foldPortalSplit; unapplyMenuWarmIndex of the fold (newer layers reversed) === the ${BASE} fold byte-for-byte`);
console.log(`\nmenu-warm-wiring.guard: OK (${n})`);
