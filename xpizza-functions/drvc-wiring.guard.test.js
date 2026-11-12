'use strict';
// DRIVER C — index.js wiring guard (index.js is not require-safe): the trigger listens on the arrival leaf, does NOT retry (at
// most once — never a resend), awaits the core with the real sender pieces, the shared name cascade, tagOf and the tracker secret;
// and the slice's index.js footprint is ONLY its delimited block. Run: node drvc-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyDrvcIndex, BEGIN, END } = require('./tools/drvc-inverse');

const src = require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ ))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */)))));   // R-WIRE train re-point: the newer slices reversed first (formsignal innermost → wahealth)
const a = src.indexOf(BEGIN); const b = src.indexOf(END);
assert.ok(a > 0 && b > a, 'DRVC-WIRE-BLOCK the drvc block exists');
const block = src.slice(a, b);
assert.match(block, /exports\.notifyArrivedOnTap = onValueCreated\(/, 'DRVC-WIRE-EXPORT');
assert.match(block, /ref: '\/tasks\/\{taskId\}\/arrived'/, 'DRVC-WIRE-PATH');
assert.match(block, /retry: false/, 'DRVC-WIRE-NORETRY retry:false (at most once, never a resend)');
assert.doesNotMatch(block, /retry: true/, 'DRVC-WIRE-NORETRY-2');
assert.match(block, /await notifyArrived\(getDatabase\(\), \{ taskId: event\.params\.taskId, arrived: event\.data\.val\(\), now: Date\.now\(\) \}/, 'DRVC-WIRE-CALL');
for (const piece of ['sendMessage: whatsapp.sendMessage', 'isSendConfirmed: whatsapp.isSendConfirmed', 'instanceFor: whatsapp.instanceFor',
  'isEnabledForRestaurant: whatsapp.isEnabledForRestaurant', 'tplArrived: whatsapp.tplArrived', "isRoutingValid: require('./restaurant-config').isRoutingValid",
  'resolveDriverName, tagOf, secret: process.env.MAKE_SECRET']) assert.ok(block.includes(piece), `DRVC-WIRE-DEPS ${piece}`);
assert.doesNotMatch(src.slice(0, a) + src.slice(b), /arrived_notices|notifyArrived/, 'DRVC-WIRE-SOLE nothing outside the block touches the arrival path');
console.log('  ✓ drvc wiring: path, retry:false, awaited core with the real sender / name cascade / tagOf / secret, sole reference');

const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const BASE = 'f0cd2566';   // R-WIRE train re-point: M8b^1, the F-bearing train state just before C merged (git log -S must not be used on the train branch)
const base = git(['show', `${BASE}:xpizza-functions/index.js`]);
assert.strictEqual(unapplyDrvcIndex(src), base, 'DRVC-INV-BASE index.js minus the drvc block is not the base index.js');
assert.notStrictEqual(unapplyDrvcIndex(src), src, 'DRVC-INV-NONVACUOUS');
assert.ok(src.trimEnd().endsWith(END), 'DRVC-INV-LAST the drvc block is the LAST thing in index.js');
const blk = src.slice(a, b + END.length);
assert.throws(() => unapplyDrvcIndex(src.replace(BEGIN, '/* drvc:begn */')), /not found exactly once/, 'DRVC-INV-BEGIN');
assert.throws(() => unapplyDrvcIndex(src.replace(END, '/* drvc:ed */')), /not found exactly once/, 'DRVC-INV-END');
assert.throws(() => unapplyDrvcIndex(src + `\n${blk}\n`), /exactly once/, 'DRVC-INV-DUP');
const outside = src.replace('exports.getSalesStats = portalFunctions.getSalesStats;', 'exports.getSalesStats = portalFunctions.getSalesStats; ');
assert.notStrictEqual(outside, src, 'premise: the outside probe edits something');
assert.notStrictEqual(unapplyDrvcIndex(outside), base, 'DRVC-INV-OUTSIDE a byte OUTSIDE the block fails the base pin');
console.log(`  ✓ drvc inverse: index.js minus the block === base (${BASE}) byte-for-byte; last; missing / duplicate / outside each caught`);

// the module inverse: whatsapp.js minus C's hunks === the pre-C file; every hunk once; a duplicated or edited hunk is refused
const { unapplyDrvcModule, MODULE_HUNKS, FILES } = require('./tools/drvc-inverse');
assert.deepStrictEqual([...FILES], ['whatsapp.js'], 'DRVC-MOD-FILES');
const wa = require('./tools/s3c-module-inverse').unapplyS3cModule('whatsapp.js', require('./tools/s2tip-module-inverse').unapplyS2tipModule('whatsapp.js', fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8')));   // DRYRUN R-WIRE (2e): capp S2-srv-tip's whatsapp.js hunks reversed FIRST, then capp S3c's (the «Envío» line)
const preWa = git(['show', `${BASE}:xpizza-functions/whatsapp.js`]);
assert.strictEqual(unapplyDrvcModule('whatsapp.js', wa), preWa, 'DRVC-MOD-BASE whatsapp.js minus the C hunks is not the pre-C file');
assert.notStrictEqual(wa, preWa, 'DRVC-MOD-NONVACUOUS');
assert.throws(() => unapplyDrvcModule('whatsapp.js', wa + MODULE_HUNKS[0].now), /occurs 2 times/, 'DRVC-MOD-DUP');
assert.throws(() => unapplyDrvcModule('whatsapp.js', wa.replace('Ya está afuera con tu pedido.', 'Ya está afuera.')), /occurs 0 times/, 'DRVC-MOD-EDIT');
assert.strictEqual(unapplyDrvcModule('index.js', 'x'), 'x', 'DRVC-MOD-PASSTHROUGH');
console.log(`  ✓ drvc module inverse: whatsapp.js minus ${MODULE_HUNKS.length} hunks === pre-C byte-for-byte; duplicated / edited hunks refused; other files pass through`);

// the arrival notice's token check is pinned to the ONE production generator (index.js): same alphabet, same default length
{
  const { TOKEN_ALPHABET, TOKEN_LENGTH } = require('./arrived-notify');
  const m = src.match(/^const TOKEN_ALPHABET = '([^']+)';/m);
  assert.ok(m, 'DRVC-TOKEN-PIN premise: index.js declares TOKEN_ALPHABET');
  assert.strictEqual(TOKEN_ALPHABET, m[1], 'DRVC-TOKEN-PIN arrived-notify.js TOKEN_ALPHABET === index.js TOKEN_ALPHABET');
  assert.match(src, new RegExp(`^function generateTrackingToken\\(length = ${TOKEN_LENGTH}\\) \\{`, 'm'), 'DRVC-TOKEN-PIN the generator default length is TOKEN_LENGTH');
  console.log('  ✓ the arrival token check is pinned to index.js generateTrackingToken (alphabet + length 12)');
}
