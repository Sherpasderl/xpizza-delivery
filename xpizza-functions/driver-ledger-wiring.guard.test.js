'use strict';
// S8 driver payable ledger — hot-file wiring guard (index.js inverse-fold invariant; see memory
// index-js-inverse-fold-invariant). The slice's ONE index.js hunk is a same-line append to the driverDiagIngest export
// (no line inserted, so no R3 region line shifts) that re-exports closeDriverPayWeeks / getDriverPayWeek / markDriverWeekPaid from
// driver-ledger/functions.js. It ships tools/driver-ledger-inverse.js and composes
// unapplyDriverLedgerIndex INNERMOST (newest-slice-first) into every index.js fold guard. This guard proves:
//   (i)  unapplyDriverLedgerIndex(index.js) === ad7a56af:index.js BYTE-FOR-BYTE (the hunk exactly once), with
//        inside / outside / duplicated / missing sensitivity; and
//   (ii) NON-VACUITY — the live index.js differs from the base, the hunk is present, and the three functions export.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyDriverLedgerIndex } = require('./tools/driver-ledger-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = 'ad7a56af';   // the S0-prod tip this slice branches from (index.js there == the train base's)
const live = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');   // this slice is the NEWEST: nothing composes on top
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(HUNKS.length, 1, 'one index.js hunk (the same-line re-export)');
assert.strictEqual(unapplyDriverLedgerIndex(live), baseIdx, `🔴 index.js minus the driver-ledger hunk is not ${BASE}:index.js — something beyond the stated seam changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunk inserts NO line (R3 region binds pin index.js lines)');
assert.notStrictEqual(live, baseIdx, 'non-vacuity: the slice is present in index.js');
const [now] = HUNKS[0];
assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, 'the hunk is present exactly once');
assert.ok(!/repairDriverLedger/.test(now), 'no incremental-ledger writer remains (r3: weeks are closed whole)');
for (const fn of ['closeDriverPayWeeks', 'getDriverPayWeek', 'markDriverWeekPaid']) assert.ok(new RegExp(`exports\\.${fn} = DL\\.${fn};`).test(now), `the hunk exports ${fn}`);
ok(`unapplyDriverLedgerIndex(index.js) === ${BASE}:index.js byte-for-byte (1 same-line hunk, no line inserted); non-vacuous`);

assert.throws(() => unapplyDriverLedgerIndex(live.replace(now, now.replace('DL.markDriverWeekPaid', 'DL.markDriverWeekPaidX'))), /exactly once/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyDriverLedgerIndex(live + now), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyDriverLedgerIndex(live.replace(now, '')), /exactly once/, 'a MISSING hunk');
{
  const outside = live.replace('exports.driverDiagIngest', 'exports.driverDiagIngestX');
  assert.notStrictEqual(outside, live, 'premise: the outside token exists');
  assert.throws(() => unapplyDriverLedgerIndex(outside), /exactly once/, 'a byte just outside, inside the same line, breaks the exact hunk');
}
ok('sensitivity: a byte inside the hunk, a duplicated hunk, a missing hunk and an edit on the same line are each detected');

console.log(`\ndriver-ledger-wiring.guard: OK (${n})`);
