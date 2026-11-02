'use strict';
// S2-srv-app (Customer App S2, PLAN-capp-S2-r4 §2.1) — the slice's index.js seam. This slice is the NEWEST: its inverse is
// composed INNERMOST (stripped first) into every index.js fold guard (tools/s2app-inverse.js). This guard proves the inverse
// reproduces cb7e9bfd byte-for-byte, that the hunk inserts NO line (R3 region binds pin index.js lines), that the hunk is the
// Origin hand-off to the return resolver and nothing else, and that the inverse is sensitive.
// Run: node s2app-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS2appIndex, BASE } = require('./tools/s2app-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */);   // colonia (area-inverse) composes on top: stripped first, INNERMOST
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. index.js: the exact inverse, one same-line hunk ──
assert.notStrictEqual(live, baseIdx, 'non-vacuity: index.js carries the S2-srv-app hunk');
assert.strictEqual(unapplyS2appIndex(live), baseIdx, `🔴 index.js minus the S2-srv-app hunk is not ${BASE}:index.js — something beyond the stated seam changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunk inserts NO line (R3 region binds pin index.js lines)');
assert.strictEqual(HUNKS.length, 1, 'exactly one seam');
const [[now, was]] = HUNKS;
assert.strictEqual(now.replace("requestOrigin: req.get('origin'), ", ''), was, 'the hunk ONLY hands the request Origin to resolveReturnBaseForCharge');
assert.ok(/resolveReturnBaseForCharge\(/.test(now), 'the seam is the charge return-base resolution');
ok(`unapplyS2appIndex(index.js) === ${BASE}:index.js byte-for-byte (1 same-line hunk, no line inserted); it only adds requestOrigin`);

// ── 2. sensitivity ──
assert.throws(() => unapplyS2appIndex(live.replace(now, now.replace('requestOrigin', 'requestOrigix'))), /exactly once/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyS2appIndex(live + now), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS2appIndex(live.replace(now, '')), /exactly once/, 'a MISSING hunk');
assert.notStrictEqual(unapplyS2appIndex(`\n${live}`), baseIdx, 'a byte OUTSIDE the hunk survives the inverse (the base compare catches it)');
ok('sensitivity: a byte inside the hunk, a duplicated hunk and a missing hunk throw; a byte outside is caught');

// ── 3. the Origin reaches ONLY the charge resolver (the direct path ignores it; pixelpay-return-url.test.js differential) ──
assert.strictEqual((live.match(/req\.get\('origin'\)/g) || []).length, 1, 'the request Origin is read exactly once in index.js, for the return base');
ok('index.js reads the request Origin exactly once, for the return base');

console.log(`\ns2app-wiring.guard: OK (${n})`);
