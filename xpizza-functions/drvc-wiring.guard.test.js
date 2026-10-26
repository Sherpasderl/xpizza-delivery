'use strict';
// DRIVER C — index.js wiring guard (index.js is not require-safe): the trigger listens on the arrival leaf, does NOT retry (at
// most once — never a resend), awaits the core with the real sender pieces, the shared name cascade, tagOf and the tracker secret;
// and the slice's index.js footprint is ONLY its delimited block. Run: node drvc-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyDrvcIndex, BEGIN, END } = require('./tools/drvc-inverse');

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
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
const introducing = git(['log', '--format=%H', '-S', BEGIN, '--', 'index.js']).trim().split('\n').filter(Boolean).pop();
const base = introducing ? git(['show', `${introducing}^:xpizza-functions/index.js`]) : git(['show', 'HEAD:xpizza-functions/index.js']);
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
console.log(`  ✓ drvc inverse: index.js minus the block === base (${introducing ? `${introducing.slice(0, 8)}^` : 'HEAD'}) byte-for-byte; last; missing / duplicate / outside each caught`);

// the module inverse: whatsapp.js minus C's hunks === the pre-C file; every hunk once; a duplicated or edited hunk is refused
const { unapplyDrvcModule, MODULE_HUNKS, FILES } = require('./tools/drvc-inverse');
assert.deepStrictEqual([...FILES], ['whatsapp.js'], 'DRVC-MOD-FILES');
const wa = fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8');
const preWa = git(['show', `${introducing || 'HEAD'}${introducing ? '^' : ''}:xpizza-functions/whatsapp.js`]);
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
