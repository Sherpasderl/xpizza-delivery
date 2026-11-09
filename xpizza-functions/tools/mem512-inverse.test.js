'use strict';
// ENDPOINT MEMORY 256 → 512MiB (assembly obligation 9) — the mem512 inverse and its composition with menu-warm.
//   1. unapplyMem512Index(index.js) === the pre-mem512 index.js byte-for-byte (+ formSignal at its pre-8a31e2a3 128MiB); no line
//      inserted; the 4 endpoints carry 512MiB; hunk 5 = main-shipped 8a31e2a3 formSignal 128 → 256MiB (advisor STOP-4 ruling)
//   2. one mutant PER HUNK: a byte inside hunk i makes the inverse throw, naming that endpoint (never a silent skip)
//   3. a duplicated hunk throws; a byte outside every hunk survives the inverse (the base compare catches it)
//   4. ORDER (REQUIRED, advisor 10-31): getPublicMenu's line is inside menu-warm's pinned hunk — mem512 FIRST then menu-warm
//      works; menu-warm FIRST throws its exactly-once pin error, LOUDLY
// Run: node tools/mem512-inverse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyMem512Index } = require('./mem512-inverse');
const { unapplyMenuWarmIndex } = require('./menu-warm-inverse');

const BASE = 'ed4e75b6';   // DRYRUN assembly state just before the mem512 layer (re-point at the real assembly)
const live = require('./checkout-inverse').unapplyCheckoutIndex(require('./lifecycle-inverse').unapplyLifecycleIndex(require('./intl-inverse').unapplyIntlIndex(require('./photos-inverse').unapplyPhotosIndex(require('./_asm-next2-layers').stripLayers('index.js', require('./sd-inverse').unapplySdIndex(require('./sb-inverse').unapplySbIndex(require('../tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./keymode-module-inverse').unapplyKeyModeModule('index.js', require('./frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')))))))), ['p5a', 'alertsan', 'hostedrace']))))   /* DRYRUN R-WIRE (2e): intl (newest) innermost */);   // R-WIRE: the guest-checkout hunks are NEWER than mem512 (innermost)
const base0 = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const FS_NOW = "  { region: 'us-central1', cors: FORM_SIGNAL_ORIGINS, timeoutSeconds: 10, memory: '256MiB', maxInstances: 5, concurrency: 40 },\n";
assert.strictEqual(base0.split(FS_NOW).length - 1, 1, 'premise: the pre-mem512 base carries the shipped formSignal 256MiB line once');
const base = base0.replace(FS_NOW, () => FS_NOW.replace("'256MiB'", "'128MiB'"));   // what every fold must see: pre-8a31e2a3 formSignal
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1 ──
assert.strictEqual(HUNKS.length, 5, 'five hunks');
assert.deepStrictEqual(HUNKS.map((h) => h.fn), ['createOrder', 'chargeOnlineOrder', 'getPublicMenu', 'quoteOrder', 'formSignal']);
const MEM = HUNKS.slice(0, 4); const FS = HUNKS[4];
assert.match(FS.shipped, /main-shipped 8a31e2a3/, 'hunk 5 is documented as main-shipped 8a31e2a3');
assert.strictEqual(FS.now, FS_NOW, 'hunk 5 is exactly the shipped formSignal 256MiB line');
assert.strictEqual(FS.was, FS_NOW.replace("'256MiB'", "'128MiB'"), 'hunk 5 restores ONLY 256 → 128');
assert.notStrictEqual(live, base, 'non-vacuity: index.js carries the mem512 hunks');
assert.strictEqual(unapplyMem512Index(live), base, `🔴 index.js minus the mem512 hunks is not ${BASE}:index.js`);
assert.strictEqual(live.split('\n').length, base.split('\n').length, 'same-line hunks: no line inserted or removed');
for (const h of MEM) {
  assert.strictEqual(h.now.replace("memory: '512MiB'", "memory: '256MiB'"), h.was, `${h.fn}: the hunk changes ONLY 256MiB → 512MiB`);
  const at = live.indexOf(h.now); const fnAt = live.lastIndexOf(`exports.${h.fn} = onRequest(`, at);
  assert.ok(fnAt >= 0 && !live.slice(fnAt + 1, at).includes('\nexports.'), `${h.fn}: the hunk sits in ${h.fn}'s own options`);
}
assert.ok(live.lastIndexOf('exports.formSignal = ', live.indexOf(FS.now)) >= 0, 'hunk 5 sits in formSignal\'s options');
ok('unapplyMem512Index(index.js) === the pre-mem512 index.js (formSignal at 128MiB) byte-for-byte; 4 same-line 256→512 hunks + the main-shipped formSignal hunk');

// ── 2: a mutant per hunk ──
for (const h of HUNKS) {
  const mutated = live.replace(h.now, h.now.replace(/'(512|256)MiB'/, "'513MiB'"));
  assert.notStrictEqual(mutated, live, `premise: the ${h.fn} mutant edits something`);
  assert.throws(() => unapplyMem512Index(mutated), new RegExp(`the ${h.fn} memory hunk occurs 0 times`), `🔴 a byte inside the ${h.fn} hunk was not caught`);
}
ok('a byte inside EACH hunk (createOrder / chargeOnlineOrder / getPublicMenu / quoteOrder / formSignal) throws, naming the endpoint');

// ── 3 ──
assert.throws(() => unapplyMem512Index(live + HUNKS[3].now), /quoteOrder memory hunk occurs 2 times/, 'a duplicated hunk throws');
assert.notStrictEqual(unapplyMem512Index(`\n${live}`), base, 'a byte outside every hunk survives the inverse (the base compare catches it)');
ok('a duplicated hunk throws; a byte outside every hunk is caught by the base compare');

// ── 4: ORDER ──
assert.doesNotThrow(() => unapplyMenuWarmIndex(unapplyMem512Index(live)), 'mem512 FIRST, then menu-warm: both apply');
assert.throws(() => unapplyMem512Index(unapplyMenuWarmIndex(live)), /menu-warm hunk occurs 0 times \(expected exactly 1\)/,
  '🔴 ORDER: menu-warm run BEFORE mem512 must throw its pin error, never skip silently');
ok('ORDER: mem512 then menu-warm composes; menu-warm first throws «the menu-warm hunk occurs 0 times (expected exactly 1)»');

console.log(`\nmem512-inverse: OK (${n})`);
