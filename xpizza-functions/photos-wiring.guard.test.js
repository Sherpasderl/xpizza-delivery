'use strict';
// DISH PHOTOS A1 step 6 — index.js wiring guard for the photos isolation group (the portalui-wiring pattern).
//   1. PROOF: tools/photos-inverse.js turns index.js back into bd777b6d:index.js BYTE-FOR-BYTE (each hunk exactly once); a byte inside /
//      outside a hunk, a duplicated and a missing hunk are each detected; non-vacuity.
//   2. SAME-LINE: index.js has exactly the base's line count, and exactly the two hunk lines differ.
//   3. The fold variant: unapplyPhotosFold(foldPortalSplit()) strips the re-exports (foldPortalSplit consumes the top hunk).
//   4. The early branch is the EXACT pinned text: a frozen Set of the three names, exact Set.has(FUNCTION_TARGET), the marker,
//      module.exports = photos/functions, return — after the ops branch on the same line.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, BASE, unapplyPhotosIndex, unapplyPhotosFold } = require('./tools/photos-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/_asm-next2-layers').stripNewer('index.js', require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))));
const GBASE = 'd03f8828';   // DRYRUN R-WIRE (2e): the assembly state just before the photos A1+A2 layer (the train's older layers sit under it); re-point at the real assembly
// DRYRUN R-WIRE (2e): the security row (0fda02b3, NEWER than photos) edits only INSIDE the /* checkout:begin endpoints */ block, which
// checkout-inverse removes whole (proven by checkout-wiring.guard) → both sides are compared with that block stripped
const CO = (x) => require('./tools/checkout-inverse').unapplyCheckoutIndex(x);
const baseIdx = CO(execFileSync('git', ['show', `${GBASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 }));

// ── 1. the inverse ──
assert.strictEqual(CO(unapplyPhotosIndex(real)), baseIdx, `🔴 index.js minus the photos hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.strictEqual(HUNKS.length, 2);
for (const h of HUNKS) {
  assert.ok(real.includes(h.now), 'non-vacuity: each hunk is present');
  const inside = real.replace(h.now, h.now.replace('photos/functions', 'photos/functionz'));
  assert.notStrictEqual(inside, real, 'premise');
  assert.throws(() => unapplyPhotosIndex(inside), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyPhotosIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyPhotosIndex(real.replace(h.now, '')), /occurs 0 times/, 'a missing hunk');
}
{
  const outside = real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(');
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(CO(unapplyPhotosIndex(outside)), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
}
ok(`PROOF: unapplyPhotosIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// ── 2. same-line hunks ──
const rl = CO(real).split('\n'), bl = baseIdx.split('\n');
assert.strictEqual(rl.length, bl.length, '🔴 index.js gained or lost a line — the hunks must be SAME-LINE (R3 binds call sites by line)');
const differing = rl.map((l, i) => (l === bl[i] ? null : i)).filter((i) => i !== null);
assert.deepStrictEqual(differing.map((i) => `${rl[i]}\n`), HUNKS.map((h) => h.now), 'exactly the two hunk lines differ, in order');
ok(`SAME-LINE: index.js has the base's ${bl.length} lines; exactly lines ${differing.map((i) => i + 1).join(' and ')} differ`);

// ── 3. the fold variant ──
const { foldPortalSplit } = require('./tools/portal-split');
const fold = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/grpid-module-inverse').unapplyGrpidModule('index.js', require('./tools/s3choice-module-inverse').unapplyS3choiceModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', foldPortalSplit()))))))))))))))));
assert.ok(!fold.includes('PHOTOS_TARGETS'), 'foldPortalSplit drops the early-branch region (with the photos branch in it)');
assert.ok(fold.includes(HUNKS[1].now), 'premise: the re-export hunk survives the portal fold');
const folded = unapplyPhotosFold(fold);
assert.ok(!folded.includes('photos/functions'), 'unapplyPhotosFold removes the re-exports');
assert.throws(() => unapplyPhotosFold(folded), /occurs 0 times/, 'applying it twice fails (each hunk exactly once)');
ok('FOLD: unapplyPhotosFold(foldPortalSplit()) leaves no photos byte; the early branch is consumed by the portal fold');

// ── 4. the exact pinned early branch ──
const PHOTOS_BRANCH = " const PHOTOS_TARGETS = Object.freeze(new Set(['photoUploadStart', 'photoProcess', 'photoSweep']));"
  + " if (PHOTOS_TARGETS.has(process.env.FUNCTION_TARGET)) { console.log('photos_entry', process.env.FUNCTION_TARGET); module.exports = require('./photos/functions'); return; }";
const setLine = rl.find((l) => l.startsWith('const PORTAL_ISOLATED_TARGETS = '));
assert.ok(setLine.includes("module.exports = require('./portal/ops-functions'); return; }" + PHOTOS_BRANCH), '🔴 the photos early branch is not the exact pinned text, right after the ops branch');
assert.strictEqual(real.split('PHOTOS_TARGETS').length - 1, 2, 'the photos Set is declared once and read once');
for (const name of ['photoUploadStart', 'photoProcess', 'photoSweep']) assert.ok(HUNKS[1].now.includes(`exports.${name} = require('./photos/functions').${name};`), `the full load re-exports ${name}`);
ok('EARLY BRANCH: the exact pinned photos branch (frozen Set of 2, exact Set.has, marker, module.exports = photos/functions, return) after the ops branch; both re-exported on the full load');

console.log(`\nphotos-wiring.guard: OK (${n})`);
