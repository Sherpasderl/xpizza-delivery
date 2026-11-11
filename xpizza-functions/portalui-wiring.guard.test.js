'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6) — index.js wiring guard.
//   1. PROOF: tools/portalui-inverse.js turns index.js back into the slice base BYTE-FOR-BYTE (each hunk exactly once); a byte
//      inside / outside a hunk, a duplicated and a missing hunk are each detected; non-vacuity (the slice is present).
//   2. SAME-LINE: index.js has exactly as many lines as the base (no R3 call-site line shifts), and exactly the two hunk lines
//      differ.
//   3. The fold variant: unapplyPortalUiFold(require('./tools/mem512-inverse').unapplyMem512Index(foldPortalSplit())) strips the re-export (foldPortalSplit consumes the top hunk).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, BASE, unapplyPortalUiIndex, unapplyPortalUiFold } = require('./tools/portalui-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))))))))))))))))))))))))))));   // train: formsignal (newest) innermost, then wahealth, drvc, drvf, stackseq, O1b, PLAN 2

// 3a T-c (merged onto this slice in feat/portal-team) appended ONE export to the membership line after BASE — a same-line hunk,
// folded out here so this pin keeps judging portal-ui's own two hunks against BASE (the membership inverse covers T-c's line)
const TC_NOW = 'exports.memberPasswordSet = MEMBERSHIP_TEAM.memberPasswordSet; exports.memberInvitePreview = MEMBERSHIP_TEAM.memberInvitePreview;   /* membership:end team */';
const TC_WAS = 'exports.memberPasswordSet = MEMBERSHIP_TEAM.memberPasswordSet;   /* membership:end team */';
const unapplyTc = (src) => { assert.strictEqual(src.split(TC_NOW).length - 1, 1, 'the T-c same-line hunk occurs exactly once'); return src.replace(TC_NOW, () => TC_WAS); };
// train/next-after-2920b705: portal-ui's parent layer here is origin/main 2920b705 + the membership hunk (membership-wiring.guard
// proves unapplyMembershipIndex of exactly that layer === 2920b705:index.js) — rebuilt by applying that one proven hunk forward.
const withMembership = require('./tools/membership-inverse').HUNKS.reduce((src, h) => {
  assert.strictEqual(src.split(h.was).length - 1, 1, 'the membership hunk anchors once on 2920b705');
  return src.replace(h.was, () => h.now);
}, execFileSync('git', ['show', '2920b705:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 }));
const baseIdx = unapplyTc(withMembership);   // the membership hunk as of T-a: T-c's later same-line export folded out (as for `real`)

// ── 1. the inverse ──
assert.strictEqual(unapplyTc(unapplyPortalUiIndex(real)), baseIdx, `🔴 index.js minus the portal-ui hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.strictEqual(HUNKS.length, 2);
for (const h of HUNKS) {
  assert.strictEqual(h.file, 'index.js');
  assert.ok(real.includes(h.now), 'non-vacuity: each hunk is present');
  const inside = real.replace(h.now, h.now.replace('portal/ops-functions', 'portal/ops-functionz'));
  assert.notStrictEqual(inside, real, 'premise');
  assert.throws(() => unapplyPortalUiIndex(inside), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyPortalUiIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyPortalUiIndex(real.replace(h.now, '')), /occurs 0 times/, 'a missing hunk');
}
{
  const outside = real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(');
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(unapplyPortalUiIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
}
ok(`PROOF: unapplyPortalUiIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// ── 2. same-line hunks ──
const rl = unapplyTc(real).split('\n'), bl = baseIdx.split('\n');   // T-c's same-line hunk folded (see section 1)
assert.strictEqual(rl.length, bl.length, '🔴 index.js gained or lost a line — the hunks must be SAME-LINE (R3 binds call sites by line)');
const differing = rl.map((l, i) => (l === bl[i] ? null : i)).filter((i) => i !== null);
assert.deepStrictEqual(differing.map((i) => `${rl[i]}\n`), HUNKS.map((h) => h.now), 'exactly the two hunk lines differ, in order');
assert.ok(HUNKS[0].now.includes("PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)") && HUNKS[0].now.includes("module.exports = require('./portal/ops-functions'); return;"),
  'hunk 1 is the ops early branch');
for (const n of ['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice']) {
  assert.ok(HUNKS[1].now.includes(`exports.${n} = require('./portal/ops-functions').${n};`), `hunk 2 re-exports ${n} (the static form source discovery reads)`);
}
ok(`SAME-LINE: index.js has the base's ${bl.length} lines; exactly lines ${differing.map((i) => i + 1).join(' and ')} differ (the two hunks)`);

// ── 3. the fold variant ──
const { foldPortalSplit } = require('./tools/portal-split');
const fold = require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bFold(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthFold(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/p5a-inverse').unapplyP5aIndex(foldPortalSplit(undefined, require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8'))))))))))))))))))))))))))))))))))))));   // train: formsignal (newest) innermost → wahealth (fold) → drvc → drvf → stackseq → the O1b fold → PLAN 2   // DRYRUN R-WIRE (2e): Area,S2app,S2tip,S5r,S3c,S3b,S3a,DriverLedger innermost
assert.ok(!fold.includes('PORTAL_OPS_TARGETS'), 'foldPortalSplit drops the early-branch region (with the ops branch in it)');
assert.ok(fold.includes(HUNKS[1].now), 'premise: the re-export hunk survives the portal fold');
const folded = unapplyPortalUiFold(fold);
assert.ok(!folded.includes('portal/ops-functions'), 'unapplyPortalUiFold removes the re-export');
assert.throws(() => unapplyPortalUiFold(folded), /occurs 0 times/, 'applying it twice fails (each hunk exactly once)');
assert.strictEqual(unapplyTc(folded), foldPortalSplit(undefined, baseIdx), '🔴 the portal fold minus every newer layer and the portal-ui hunk is not the base layer\'s fold (a missing inverse fails here)');
ok('FOLD: unapplyPortalUiFold(foldPortalSplit()) leaves no portal-ui byte; the ops branch is consumed by the portal fold');

console.log(`\nportalui-wiring.guard: OK (${n})`);
