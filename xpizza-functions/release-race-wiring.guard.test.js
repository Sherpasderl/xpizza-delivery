'use strict';
// RELEASE RACE (PLAN-release-race r2.1) — the index.js inverse-fold guard for this slice. Run: node release-race-wiring.guard.test.js
//   (i)  unapplyReleaseRaceIndex(index.js) === 32f6f17e:index.js BYTE-FOR-BYTE; a byte changed inside a hunk, outside every hunk,
//        and a duplicated hunk are each detected — so the ONLY index.js change is the healer's alert (the healer's writes unchanged);
//   (ii) non-vacuity: the live index.js differs from 32f6f17e and the hunks carry the require and the post-heal alert call.
// Base = the train tip 32f6f17e. This slice is the newest layer, so its inverse is applied INNERMOST in every fold consumer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyReleaseRaceIndex, INDEX_HUNKS } = require('./tools/release-race-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/s2bext-module-inverse').unapplyS2bextModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))))))))))))))))))))))))));   // BRAND-AGNOSTIC SERVER (newer layer) reversed first
const BASE = execFileSync('git', ['show', '32f6f17e:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.strictEqual(unapplyReleaseRaceIndex(idx), BASE, '🔴 index.js minus the release-race hunks is not 32f6f17e:index.js');
{
  const inHunk = idx.replace('await alertAssignmentConflict(db, {', 'await alertAssignmentConflicT(db, {');
  assert.notStrictEqual(inHunk, idx);
  let detected; try { detected = unapplyReleaseRaceIndex(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.cancelPaidOrder = onRequest(', 'exports.cancelPaidOrder = onRequest( ');
  assert.notStrictEqual(outside, idx);
  assert.notStrictEqual(unapplyReleaseRaceIndex(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyReleaseRaceIndex(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyReleaseRaceIndex(index.js) === 32f6f17e:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes detected`);
assert.notStrictEqual(idx, BASE, '🔴 the live index.js equals 32f6f17e — the release-race slice is MISSING');
const all = INDEX_HUNKS.map(([now]) => now).join('\n');
for (const must of ["require('./assignment-conflict')", 'await alertAssignmentConflict(db, { orderId, deliveryDriverId: strandedDel, pickupDriverId: strandedPick, now });']) assert.ok(all.includes(must), `the hunks carry ${must}`);
ok('PROOF (ii): the live index.js differs from 32f6f17e; the hunks carry the require and the post-heal alert call (inside the committed-heal branch)');
// (iii) codex build r1 P2: the alert call is anchored to its CONTROL FLOW — the only call site, inside `if (didHeal) {` right after
//      the committed heal (healStrandedOrder → healed:true), after the existing healed++ / warn — and a relocation is caught.
const ANCHOR = /const \{ healed: didHeal \} = await healStrandedOrder\(db, orderId, strandedDel, strandedPick\);\n {6}if \(didHeal\) \{\n {8}healed\+\+;\n {8}console\.warn\(`sweepPending: self-healed strand [^\n]*\n(?: {8}\/\/[^\n]*\n)* {8}await alertAssignmentConflict\(db, \{ orderId, deliveryDriverId: strandedDel, pickupDriverId: strandedPick, now \}\);\n {6}\}\n/;
const inFlow = (src) => ANCHOR.test(src) && src.split('alertAssignmentConflict(db,').length - 1 === 1;
assert.ok(inFlow(idx), '🔴 the alert call is not (only) inside `if (didHeal)` after the committed heal');
const CALL = '        await alertAssignmentConflict(db, { orderId, deliveryDriverId: strandedDel, pickupDriverId: strandedPick, now });\n';
assert.strictEqual(idx.split(CALL).length - 1, 1, 'premise: the call line is present once');
const without = idx.replace(CALL, '');
const movedBefore = without.replace('      if (didHeal) {\n        healed++;', `${CALL.replace(/^ {8}/, '      ')}      if (didHeal) {\n        healed++;`);
assert.notStrictEqual(movedBefore, idx, 'premise: relocation applied');
assert.strictEqual(movedBefore.split('alertAssignmentConflict(db,').length - 1, 1, 'premise: the BEFORE relocation kept the call');
assert.strictEqual(inFlow(movedBefore), false, 'relocated BEFORE `if (didHeal)` (an aborted heal would alert) → red');
const movedAfter = without.replace('      if (didHeal) {\n        healed++;', '      if (didHeal) {\n        healed++;').replace('\n      }\n    }\n\n    // S1a §5', `\n      }\n${CALL.replace(/^ {8}/, '      ')}    }\n\n    // S1a §5`);
assert.strictEqual(movedAfter.split('alertAssignmentConflict(db,').length - 1, 1, 'premise: the AFTER relocation kept the call (moved, not dropped)');
assert.strictEqual(inFlow(movedAfter), false, 'relocated AFTER the `if (didHeal)` block → red');
assert.strictEqual(inFlow(idx + '\nalertAssignmentConflict(db, {});\n'), false, 'a second call site → red');
ok('PROOF (iii): the alert call is anchored inside `if (didHeal)` after the committed heal, as the only call site; relocations before / after the block and a second call site are each red');
console.log(`release-race-wiring.guard: OK (${n} cases)`);
