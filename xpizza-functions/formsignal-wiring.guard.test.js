'use strict';
// PLAN 3 — formSignal: the wiring guard for tools/formsignal-inverse.js.
//   1. PROOF: unapplyFormSignalIndex(index.js) === BASE:index.js byte-for-byte (one end-of-file block); a missing or a
//      duplicated delimiter, delimiters out of order, and a byte outside the block are each caught.
//   2. The block holds exactly the two exports + the origin constant, and nothing else of index.js moved.
//   3. FOLD: the block survives foldPortalSplit and the same inverse strips it there.
//   The export's options are asserted on the REAL export in cors-preflight.test.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BEGIN, END, unapplyFormSignalIndex } = require('./tools/formsignal-inverse');
const BASE = 'e836997a';   // R-WIRE train re-point: M13^1, the train state just before formSignal merged (the slice's own base was bd777b6d)

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ ))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */)));   // S4 C′ (newest) reversed first
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.notStrictEqual(unapplyFormSignalIndex(real), real, 'non-vacuity: the block is present and removed');
assert.strictEqual(unapplyFormSignalIndex(real), base, `🔴 index.js minus the formsignal block is not ${BASE}:index.js`);
assert.ok(real.startsWith(base), 'APPEND-ONLY: every BASE byte is in place; the block only follows it (no R3 call site shifts)');
const block = real.slice(real.indexOf(BEGIN), real.indexOf(END) + END.length);
assert.deepStrictEqual(block.match(/^exports\.\w+/gm), ['exports.formSignal', 'exports.sweepFormSignals'], 'the block exports exactly formSignal + sweepFormSignals');
assert.ok(/^const FORM_SIGNAL_ORIGINS = require\('\.\/platform-manifest'\)\.PLATFORM\.ACCOUNT_ORIGINS;$/m.test(block), 'the origins are DERIVED from the manifest (no literal list)');
assert.throws(() => unapplyFormSignalIndex(real.replace(BEGIN, '/* formsignal:BEGIN */')), /not found exactly once/, 'a missing begin');
assert.throws(() => unapplyFormSignalIndex(real.replace(END, '/* formsignal:END */')), /not found exactly once/, 'a missing end');
assert.throws(() => unapplyFormSignalIndex(real + `\n${BEGIN}\n${END}\n`), /second delimiter/, 'a duplicated block');
assert.throws(() => unapplyFormSignalIndex(`\n${END}\n${BEGIN}\n`), /out of order/, 'delimiters out of order');
assert.throws(() => unapplyFormSignalIndex(real.replace(`\n${BEGIN}`, `;${BEGIN}`)), /blank-line separator/, 'a missing leading separator');
assert.notStrictEqual(unapplyFormSignalIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the block survives (the base pin catches it)');
ok(`index.js: unapplyFormSignalIndex → ${BASE}:index.js byte-for-byte (one appended block: formSignal + sweepFormSignals); missing / duplicate / order / separator / outside each caught`);
const { foldPortalSplit } = require('./tools/portal-split');
const fold = foldPortalSplit(undefined, require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8'))))))));   // S4 C′ (newest) reversed first
assert.ok(fold.includes(block), 'premise: the block survives the portal fold');
assert.ok(!unapplyFormSignalIndex(fold).includes(BEGIN), 'the same inverse strips it from a fold');
ok('FOLD: the block survives foldPortalSplit and unapplyFormSignalIndex strips it there too');
console.log(`\nformsignal-wiring.guard: OK (${n})`);
