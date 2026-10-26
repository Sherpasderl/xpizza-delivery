'use strict';
// dispatch-lite iOS push-refresh slice — hot-file wiring guard (index.js inverse-fold invariant; see memory
// index-js-inverse-fold-invariant). The slice edits xpizza-functions/index.js (the staff-push require + the
// test-push-core require, the sendStaffPush compare-and-delete removeSub, and the whole sendTestStaffPush export),
// so it ships tools/dlite-push-inverse.js and composes unapplyDlitePushIndex INNERMOST (newest-slice-first) into
// every index.js fold guard. This guard proves:
//   (i)  unapplyDlitePushIndex(index.js) === 32f6f17e:index.js BYTE-FOR-BYTE (each hunk exactly once), with
//        inside / outside / duplicated / missing sensitivity; and
//   (ii) NON-VACUITY — the live index.js genuinely differs from the base and all three hunks are present, so
//        dropping the inverse surfaces RED rather than passing silently.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyDlitePushIndex } = require('./tools/dlite-push-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '798f9edf';   // the next train: 32f6f17e + release-race + brand-agnostic server (the hunks are unchanged; index.js below them differs only by those slices)
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const live = require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/o1b-inverse').unapplyO1bIndex(read('index.js'))));   // the membership slice landed on top → reversed first (innermost)
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── (i) the inverse reconstructs the base byte-for-byte ──
assert.strictEqual(HUNKS.length, 3, 'three index.js hunks (require line, removeSub, sendTestStaffPush export)');
assert.strictEqual(unapplyDlitePushIndex(live), baseIdx, `🔴 index.js minus the dlite-push hunks is not ${BASE}:index.js — something beyond the stated seams changed`);

// ── (ii) non-vacuity + each hunk present exactly once ──
assert.notStrictEqual(live, baseIdx, 'non-vacuity: the slice is actually present in index.js');
for (const [now] of HUNKS) {
  const i = live.indexOf(now);
  assert.ok(i > -1 && live.indexOf(now, i + 1) === -1, `each hunk present exactly once: ${now.slice(0, 50)}`);
}
ok(`unapplyDlitePushIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); non-vacuous`);

// ── sensitivity: a byte INSIDE a hunk, a DUPLICATED hunk, a MISSING hunk, and a byte OUTSIDE every hunk ──
const [removeSubNow] = HUNKS[1];   // the distinctive compare-and-delete removeSub hunk
assert.throws(() => unapplyDlitePushIndex(live.replace(removeSubNow, removeSubNow.replace('staffPushCleanupUpdater(sub && sub.endpoint)', 'staffPushCleanupUpdater(sub && sub.endpointX)'))),
  /exactly once/, 'a byte INSIDE a hunk → the exact candidate no longer matches');
assert.throws(() => unapplyDlitePushIndex(live + removeSubNow), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyDlitePushIndex(live.replace(removeSubNow, '')), /exactly once/, 'a MISSING hunk');
{
  // a byte OUTSIDE every hunk (the untouched comment just after the export) survives the fold and fails the base pin
  const outside = live.replace('// notifyStaffOnNewOrder — ping dispatch staff', '// notifyStaffOnNewOrderX — ping dispatch staff');
  assert.notStrictEqual(outside, live, 'premise: the outside token exists');
  assert.notStrictEqual(unapplyDlitePushIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives the fold and fails the base pin');
}
ok('sensitivity: a byte inside a hunk, a duplicated hunk, a missing hunk and a byte outside every hunk are each detected');

console.log(`\ndlite-push-wiring.guard: OK (${n})`);
