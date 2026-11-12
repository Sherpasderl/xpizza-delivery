'use strict';
// S5 ratings writer — hot-file wiring guard (index.js inverse-fold invariant). The slice's ONE index.js hunk is a same-line
// append to the RATE_LIMIT_BUCKETS export: `exports.rateOrder = require('./ratings/rate-order').rateOrder;` (a direct require
// chain — contract/discovery's source inventory classifies it). It ships tools/s5r-inverse.js and composes unapplyS5rIndex
// INNERMOST into every index.js fold guard. This guard proves unapplyS5rIndex(index.js) === 5f2e1ef7:index.js byte-for-byte
// (one hunk, no line inserted), the export, and source discovery's view of it.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS5rIndex } = require('./tools/s5r-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '5f2e1ef7';   // the HELD S3c tip this slice branches from
const live = require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */)));   // S2-srv-tip composes on top of this slice (stripped first, newest-first)
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(HUNKS.length, 1, 'one index.js hunk (the same-line re-export)');
assert.strictEqual(unapplyS5rIndex(live), baseIdx, `🔴 index.js minus the S5r hunk is not ${BASE}:index.js`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunk inserts NO line (R3 region binds pin index.js lines)');
assert.ok(HUNKS[0][0].includes("exports.rateOrder = require('./ratings/rate-order').rateOrder;"), 'the hunk re-exports rateOrder as a direct require chain');
const D = require('./contract/discovery');
const inv = D.sourceInventory();
assert.deepStrictEqual(inv.entries.filter((e) => e.name === 'rateOrder').map((e) => [e.how, e.category]), [['reexport', 'http']], 'source discovery sees rateOrder as an HTTP re-export');
assert.ok(!inv.unclassified.some((u) => u.name === 'rateOrder'), 'rateOrder is not unclassified');
ok(`unapplyS5rIndex(index.js) === ${BASE}:index.js byte-for-byte (1 same-line hunk); rateOrder is a discovered HTTP re-export`);

const [now] = HUNKS[0];
assert.throws(() => unapplyS5rIndex(live.replace(now, now.replace('rate-order', 'rate-ordr'))), /exactly once/, 'a byte INSIDE the hunk');
assert.throws(() => unapplyS5rIndex(live + now), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS5rIndex(live.replace(now, '')), /exactly once/, 'a MISSING hunk');
ok('sensitivity: a byte inside the hunk, a duplicated hunk and a missing hunk are each detected');

console.log(`\ns5r-wiring.guard: OK (${n})`);
