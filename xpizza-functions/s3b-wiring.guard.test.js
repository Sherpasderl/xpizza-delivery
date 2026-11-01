'use strict';
// S3b PixelPay return routing — hot-file wiring guard (index.js inverse-fold invariant). The slice's index.js hunks are all
// SAME-LINE: the resolver import, the fresh path's identity captured for the return site, resolveReturnBaseForCharge
// (platform/sites.json pay_return, brand-aware, ONE precedence rule) and the poll token on the cancel URL. It ships
// tools/s3b-inverse.js and composes unapplyS3bIndex INNERMOST into every index.js fold guard. This guard proves:
//   (i)  unapplyS3bIndex(index.js) === 3b6e9fc8:index.js BYTE-FOR-BYTE (each hunk exactly once), with sensitivity; and
//   (ii) NON-VACUITY — every hunk present, the charge path resolves through the data-driven resolver, cancel carries t.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS3bIndex } = require('./tools/s3b-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '3b6e9fc8';   // the HELD S3a tip this slice branches from
const live = require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */)))));   // S3c (newer) is reversed first
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(unapplyS3bIndex(live), baseIdx, `🔴 index.js minus the S3b hunks is not ${BASE}:index.js — something beyond the stated seams changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunks insert NO line (R3 region binds pin index.js lines)');
for (const [now] of HUNKS) assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, `each hunk present exactly once: ${now.slice(0, 60)}`);
assert.strictEqual((live.match(/await resolveReturnBaseForCharge\(restaurantId, process\.env, \{ identity: s3bIdentity, entryMode: body\.entry_mode, readBrandId: /g) || []).length, 1, 'the charge path resolves its return site from the manifest data');
assert.ok(!/resolveReturnBase\(restaurantId, process\.env\)/.test(live), 'the old rid-only call is gone');
assert.ok(/const cancelUrl = `\$\{siteBase\}\/\?pay=cancel&order=\$\{encodeURIComponent\(orderId\)\}&t=\$\{encodeURIComponent\(pollToken\)\}`;/.test(live), 'the cancel URL carries the poll token');
ok(`unapplyS3bIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} same-line hunks); the data-driven resolver + cancel poll token are wired`);

const [first] = HUNKS[0];
assert.throws(() => unapplyS3bIndex(live.replace(first, first.replace('resolveReturnBaseForCharge', 'resolveReturnBaseForChargX'))), /exactly once/, 'a byte INSIDE a hunk');
assert.throws(() => unapplyS3bIndex(live + HUNKS[HUNKS.length - 1][0]), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS3bIndex(live.replace(HUNKS[HUNKS.length - 1][0], '')), /exactly once/, 'a MISSING hunk');
ok('sensitivity: a byte inside a hunk, a duplicated hunk and a missing hunk are each detected');

console.log(`\ns3b-wiring.guard: OK (${n})`);
