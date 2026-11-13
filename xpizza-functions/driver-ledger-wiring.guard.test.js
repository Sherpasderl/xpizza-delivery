'use strict';
// S8 driver payable ledger — hot-file wiring guard (index.js inverse-fold invariant; see memory
// index-js-inverse-fold-invariant). The slice's ONE index.js hunk is a same-line append to the driverDiagIngest export
// (no line inserted, so no R3 region line shifts) that re-exports closeDriverPayWeeks / getDriverPayWeek / markDriverWeekPaid from
// driver-ledger/functions.js. It ships tools/driver-ledger-inverse.js and composes
// unapplyDriverLedgerIndex INNERMOST (newest-slice-first) into every index.js fold guard. This guard proves:
//   (i)  unapplyDriverLedgerIndex(index.js) === e0af1007:index.js BYTE-FOR-BYTE (the hunk exactly once), with
//        inside / outside / duplicated / missing sensitivity; and
//   (ii) NON-VACUITY — the live index.js differs from the base, the hunk is present, and the three functions export.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyDriverLedgerIndex } = require('./tools/driver-ledger-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = 'e0af1007';   // the S0-prod tip this slice branches from (index.js there == the train base's)
const live = require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', require('./tools/s2bext-module-inverse').unapplyS2bextModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */)))))));   // S3a (newer) is reversed first
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(HUNKS.length, 1, 'one index.js hunk (the same-line re-export)');
assert.strictEqual(unapplyDriverLedgerIndex(live), baseIdx, `🔴 index.js minus the driver-ledger hunk is not ${BASE}:index.js — something beyond the stated seam changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunk inserts NO line (R3 region binds pin index.js lines)');
assert.notStrictEqual(live, baseIdx, 'non-vacuity: the slice is present in index.js');
const [now] = HUNKS[0];
assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, 'the hunk is present exactly once');
assert.ok(!/repairDriverLedger/.test(now), 'no incremental-ledger writer remains (r3: weeks are closed whole)');
for (const fn of ['closeDriverPayWeeks', 'getDriverPayWeek', 'markDriverWeekPaid']) assert.ok(now.includes(`exports.${fn} = require('./driver-ledger/functions').${fn};`), `the hunk exports ${fn} as a DIRECT require-chain re-export`);
// S8 r5: the re-exports are direct require chains — contract/discovery.js sourceInventory resolves an `exports.X = Y.z` only
// through a TOP-LEVEL binding of Y, so a block-scoped `const DL` left them unclassified (test:r3-p0-scheduler D0)
{
  const D = require('./contract/discovery');
  const inv = D.sourceInventory();
  assert.deepStrictEqual(inv.unclassified.filter((u) => /DriverPay|DriverWeek/.test(u.name)), [], '🔴 the ledger re-exports are unclassified by source discovery');
  assert.deepStrictEqual(inv.entries.filter((e) => ['closeDriverPayWeeks', 'getDriverPayWeek', 'markDriverWeekPaid'].includes(e.name)).map((e) => [e.name, e.how]).sort(),
    [['closeDriverPayWeeks', 'reexport'], ['getDriverPayWeek', 'reexport'], ['markDriverWeekPaid', 'reexport']], 'source discovery sees all three as re-exports');
}
ok(`unapplyDriverLedgerIndex(index.js) === ${BASE}:index.js byte-for-byte (1 same-line hunk, no line inserted); non-vacuous`);

assert.throws(() => unapplyDriverLedgerIndex(live.replace(now, now.replace('.markDriverWeekPaid;', '.markDriverWeekPaidX;'))), /exactly once/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyDriverLedgerIndex(live + now), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyDriverLedgerIndex(live.replace(now, '')), /exactly once/, 'a MISSING hunk');
{
  const outside = live.replace('exports.driverDiagIngest', 'exports.driverDiagIngestX');
  assert.notStrictEqual(outside, live, 'premise: the outside token exists');
  assert.throws(() => unapplyDriverLedgerIndex(outside), /exactly once/, 'a byte just outside, inside the same line, breaks the exact hunk');
}
ok('sensitivity: a byte inside the hunk, a duplicated hunk, a missing hunk and an edit on the same line are each detected');

console.log(`\ndriver-ledger-wiring.guard: OK (${n})`);
