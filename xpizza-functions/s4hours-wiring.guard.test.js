'use strict';
// S4 C′ (PLAN-capp-S4-r4 §2 / r5) — the index.js footprint of the schedule_only hook is EXACTLY one delimited segment at the
// end of quoteOrder's existing clientIp line:
//   (i)   unapplyS4HoursIndex(index.js) === 638d42f5:index.js byte-for-byte; missing / duplicated / out-of-order / multi-line
//         / outside-byte each detected; the portal fold carries it and the same inverse strips it;
//   (ii)  POSITION: inside quoteOrder, AFTER resolveRestaurantId + clientIp, BEFORE the quote_ip limiter and BEFORE any pricing
//         (resolvePricingTables) — so a schedule read never spends quote capacity nor touches pricing;
//   (iii) GATE: `body.schedule_only === true &&` precedes the module require — an ordinary quote never even loads the module.
// Run: node s4hours-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, BEGIN, END, unapplyS4HoursIndex } = require('./tools/s4hours-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const real = require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/_asm-next2-layers').stripLayers('index.js', require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))), ['p5a', 'alertsan', 'hostedrace'])   /* DRYRUN: 3a's sd(sb) is already in this chain */)   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ ))))))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */;
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.notStrictEqual(unapplyS4HoursIndex(real), real, 'non-vacuity: the segment is present and removed');
assert.strictEqual(unapplyS4HoursIndex(real), base, `🔴 index.js minus the s4hours segment is not ${BASE}:index.js`);
assert.strictEqual(real.split('\n').length, base.split('\n').length, 'NO LINE ADDED OR MOVED (no R3 call site shifts)');
assert.throws(() => unapplyS4HoursIndex(real.replace(BEGIN, ' /* s4hours:BEGIN */ ')), /not found exactly once/, 'a missing begin');
assert.throws(() => unapplyS4HoursIndex(real.replace(END, ' /* s4hours:END */')), /not found exactly once/, 'a missing end');
assert.throws(() => unapplyS4HoursIndex(real + `${BEGIN}x${END}\n`), /second delimiter/, 'a duplicated segment');
assert.throws(() => unapplyS4HoursIndex(`a${END}\nb${BEGIN}c\n`), /out of order/, 'delimiters out of order');
assert.throws(() => unapplyS4HoursIndex(real.replace(BEGIN, `${BEGIN}\n`)), /more than one line/, 'a multi-line segment');
assert.notStrictEqual(unapplyS4HoursIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the segment survives (the base pin catches it)');
ok(`index.js: unapplyS4HoursIndex → ${BASE}:index.js byte-for-byte; no line added; missing / duplicate / order / multi-line / outside each caught`);

const qo = real.slice(real.indexOf('exports.quoteOrder = onRequest('), real.indexOf('exports.quoteRedemption = onRequest('));
const seg = qo.slice(qo.indexOf(BEGIN), qo.indexOf(END) + END.length);
assert.ok(qo.includes(BEGIN) && real.indexOf(BEGIN) === real.indexOf(BEGIN, real.indexOf('exports.quoteOrder = onRequest(')), 'the segment lives inside quoteOrder');
const at = (s) => { const i = qo.indexOf(s); assert.ok(i >= 0, `anchor ${s}`); return i; };
const iRid = at('resolveRestaurantId(body.restaurant_id'), iIp = at('const clientIp ='), iSeg = at(BEGIN), iLim = at("checkRateLimit(db, 'quote_ip'"), iPrice = at('resolvePricingTables(restaurantId)');
assert.ok(iRid < iIp && iIp < iSeg, 'POSITION: after resolveRestaurantId and on the clientIp line');
assert.ok(iSeg < iLim, 'POSITION: BEFORE the quote_ip limiter (a schedule read never spends quote capacity)');
assert.ok(iSeg < iPrice, 'POSITION: BEFORE any pricing (resolvePricingTables)');
assert.ok(qo.slice(iIp, iSeg).indexOf('\n') === -1, 'the segment is on the clientIp line itself');
ok('POSITION: quoteOrder → resolveRestaurantId → clientIp line [segment] → quote_ip limiter → pricing');

assert.ok(/^ \/\* s4hours:begin \*\/ if \(body\.schedule_only === true && await require\('\.\/schedule\/schedule-only'\)\.handle\(\{ res, body, db, restaurantId, clientIp, checkRateLimit \}\)\) return; \/\* s4hours:end \*\/$/.test(seg), 'the segment is exactly the gated hook');
ok('GATE: `body.schedule_only === true &&` short-circuits before the module require — an ordinary quote never loads it');

const { foldPortalSplit } = require('./tools/portal-split');
const fold = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/grpid-module-inverse').unapplyGrpidModule('index.js', require('./tools/s3choice-module-inverse').unapplyS3choiceModule('index.js', require('./tools/s2bext-module-inverse').unapplyS2bextModule('index.js', foldPortalSplit())))))))))));
assert.ok(fold.includes(seg), 'premise: the segment survives the portal fold');
assert.ok(!unapplyS4HoursIndex(fold).includes(BEGIN), 'the same inverse strips it from a fold');
ok('FOLD: the segment survives foldPortalSplit and unapplyS4HoursIndex strips it there too');
console.log(`\ns4hours-wiring.guard: OK (${n})`);
