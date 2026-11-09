'use strict';
// PLAN 4 — the form rebake trigger + reconciler: the wiring guard for tools/formbake-inverse.js.
//   1. PROOF: unapplyFormbakeIndex(index.js) === BASE:index.js byte-for-byte (one end-of-file block); a missing or a
//      duplicated delimiter, delimiters out of order, a missing separator and a byte outside the block are each caught.
//   2. The block holds exactly the two exports (trigger + reconciler) on the mirror path / a 10-minute schedule, bounded and
//      without platform retry, the hooks read from the env (never a literal url), and nothing else of index.js moved.
//   3. FOLD: the block survives foldPortalSplit and the same inverse strips it there.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, BEGIN, END, unapplyFormbakeIndex } = require('./tools/formbake-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))))))))))))) /* DRYRUN R-WIRE (2e): 16 cross-side layers + photos A1/A2 (newest) innermost */;
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.notStrictEqual(unapplyFormbakeIndex(real), real, 'non-vacuity: the block is present and removed');
assert.strictEqual(unapplyFormbakeIndex(real), base, `🔴 index.js minus the formbake block is not ${BASE}:index.js`);
assert.ok(real.startsWith(base), 'APPEND-ONLY: every BASE byte is in place; the block only follows it (no R3 call site shifts)');
const block = real.slice(real.indexOf(BEGIN), real.indexOf(END) + END.length);
assert.deepStrictEqual(block.match(/^exports\.\w+/gm), ['exports.rebakeFormOnMirror', 'exports.reconcileFormBundles'], 'the block exports exactly the trigger + the reconciler');
assert.ok(/onValueWritten\(\n\s*\{ ref: '\/catalog_snapshot\/\{rid\}', region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', maxInstances: 2, retry: false \}/.test(block), 'the trigger: the mirror path, maxInstances 2, NO platform retry');
assert.ok(/onSchedule\(\n\s*\{ schedule: 'every 10 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB', maxInstances: 1, retryCount: 0 \}/.test(block), 'the reconciler: every 10 minutes, maxInstances 1, no retry, a timeout below the interval');
assert.ok(/env: process\.env/.test(block) && !/https?:\/\/[a-z]/i.test(block), 'the hooks come from the env; no url literal in the block');
assert.throws(() => unapplyFormbakeIndex(real.replace(BEGIN, '/* formbake:BEGIN */')), /not found exactly once/, 'a missing begin');
assert.throws(() => unapplyFormbakeIndex(real.replace(END, '/* formbake:END */')), /not found exactly once/, 'a missing end');
assert.throws(() => unapplyFormbakeIndex(real + `\n${BEGIN}\n${END}\n`), /second delimiter/, 'a duplicated block');
assert.throws(() => unapplyFormbakeIndex(`\n${END}\n${BEGIN}\n`), /out of order/, 'delimiters out of order');
assert.throws(() => unapplyFormbakeIndex(real.replace(`\n${BEGIN}`, `;${BEGIN}`)), /blank-line separator/, 'a missing leading separator');
assert.notStrictEqual(unapplyFormbakeIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the block survives (the base pin catches it)');
ok(`index.js: unapplyFormbakeIndex → ${BASE}:index.js byte-for-byte (one appended block: rebakeFormOnMirror + reconcileFormBundles, bounded, no retry, env hooks); missing / duplicate / order / separator / outside each caught`);
const { foldPortalSplit } = require('./tools/portal-split');
const fold = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', foldPortalSplit())));
assert.ok(fold.includes(block), 'premise: the block survives the portal fold');
assert.ok(!unapplyFormbakeIndex(fold).includes(BEGIN), 'the same inverse strips it from a fold');
ok('FOLD: the block survives foldPortalSplit and unapplyFormbakeIndex strips it there too');
console.log(`\nformbake-wiring.guard: OK (${n})`);
