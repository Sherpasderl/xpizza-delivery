'use strict';
// S1a — index.js wiring guard (PLAN-S1 §15).
//   PROOF: tools/s1a-inverse.js reverses ALL the S1a index.js edits (the svc-assigner handle + the 7 ownership/shift
//   writer conversions + the 4 driver-callable hard-stops + the two requires) back to c83f2f9:index.js BYTE-FOR-BYTE,
//   each hunk exactly once — the inverse every other index.js fold guard applies FIRST (newest-first). A byte inside a
//   hunk, a duplicated hunk, a missing anchor and a byte outside every hunk are each detected.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, applyS1aIndex, unapplyS1aIndex } = require('./tools/s1a-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const BASE = 'c83f2f9';   // the rebase base (S2, atop G2+H0+serial3); S1a's edits are the only index.js delta on top of it
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const real = require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(read('index.js'))))))))))))))))));   // H1a (newest) is reversed FIRST, then PLAN-S5, then S1b, then PLAN-A A-1

// ── 1. the inverse reproduces the base byte-for-byte ──
assert.strictEqual(unapplyS1aIndex(real), baseIdx, `🔴 index.js minus the S1a edits is not ${BASE}:index.js`);
assert.notStrictEqual(unapplyS1aIndex(real), real, 'non-vacuity: the S1a edits are present and reversed');
ok(`unapplyS1aIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each reversed exactly once)`);

// ── 2. forward/inverse are exact mutual inverses on the base ──
assert.strictEqual(applyS1aIndex(baseIdx), real, `🔴 applyS1aIndex(${BASE}:index.js) does not reproduce the committed index.js`);
assert.strictEqual(unapplyS1aIndex(applyS1aIndex(baseIdx)), baseIdx, 'round-trip is identity on the base');
ok('applyS1aIndex and unapplyS1aIndex are exact mutual inverses');

// ── 3. sensitivity — a byte INSIDE a hunk, a DUPLICATED hunk, a MISSING anchor, a byte OUTSIDE every hunk ──
{
  const h = HUNKS.find((x) => x.now.includes('await pickHandle(db)'));   // a representative modification hunk
  assert.throws(() => unapplyS1aIndex(real.replace(h.now, h.now.replace('await pickHandle(db)', 'await pickHandle(DB)'))), /occurs 0×/, 'a byte INSIDE a hunk is detected (anchor no longer matches)');
  assert.throws(() => unapplyS1aIndex(real + h.now), /occurs 2×/, 'a DUPLICATED hunk is detected');
}
{
  const g = HUNKS.find((x) => x.now.includes('assertDriverCallerActive(uid'));
  assert.throws(() => unapplyS1aIndex(real.replace(g.now, '')), /occurs 0×/, 'a MISSING anchor (hunk removed) is detected');
}
{
  const outside = '// s1a-wiring outside-byte probe\n' + real;   // a byte that belongs to no hunk
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(unapplyS1aIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives the inverse and fails the base pin');
}
ok('a byte inside a hunk, a duplicated hunk, a missing anchor, and a byte outside every hunk are each detected');

// ── 4. the edits are actually wired (not just reversible) ──
assert.ok(/require\('\.\/lib\/svc-handle'\)/.test(real) && /require\('\.\/lib\/driver-callable-guard'\)/.test(real), 'both S1a modules are required');
assert.ok(!/svcAssignerDb\(\)/.test(real), 'index.js no longer calls svcAssignerDb directly — the handle comes from the flag-gated pickHandle');
assert.strictEqual((real.match(/const svcDb = await pickHandle\(db\);/g) || []).length, 4, 'all 4 handlers select the handle via the flag-gated pickHandle');
assert.strictEqual((real.match(/svcWriteOrFallback\(db, svcDb, \(h\) =>/g) || []).length, 7, 'all 7 ownership/shift writes (3 claims + 4 finalize/shift-open) go through svcWriteOrFallback');
assert.strictEqual((real.match(/claimDelivery\(h,/g) || []).length, 3, 'all 3 CAS claims take the selected handle');
assert.strictEqual((real.match(/await assertDriverCallerActive\(uid, request\.auth\?\.token,/g) || []).length, 4, 'all 4 driver callables call the hard-stop guard');
ok('wired: flag-gated pickHandle on 4 handlers; svcWriteOrFallback on all 7 ownership/shift writes; the hard-stop on all 4 driver callables');

console.log(`\ns1a-wiring.guard: OK (${n})`);
