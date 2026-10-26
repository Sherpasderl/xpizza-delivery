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
const { BASE, BEGIN, END, unapplyFormSignalIndex } = require('./tools/formsignal-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
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
const fold = foldPortalSplit();
assert.ok(fold.includes(block), 'premise: the block survives the portal fold');
assert.ok(!unapplyFormSignalIndex(fold).includes(BEGIN), 'the same inverse strips it from a fold');
ok('FOLD: the block survives foldPortalSplit and unapplyFormSignalIndex strips it there too');
console.log(`\nformsignal-wiring.guard: OK (${n})`);
