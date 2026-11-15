'use strict';
// S3a envío — hot-file wiring guard (index.js inverse-fold invariant; see memory index-js-inverse-fold-invariant). The
// slice's index.js hunks are all SAME-LINE (no line inserted, so no R3 region line shifts): the DW require, the two quote
// endpoints' envío, createOrder / chargeOnlineOrder's deliveryFor → withDelivery, the refusal step before each gate, the
// envío context in each gate input, and the hosted pending record's envío fields. It ships tools/s3a-inverse.js and
// composes unapplyS3aIndex INNERMOST (newest-slice-first) into every index.js fold guard. This guard proves:
//   (i)  unapplyS3aIndex(index.js) === c2c3b815:index.js BYTE-FOR-BYTE (each hunk exactly once), with inside /
//        duplicated / missing sensitivity; and
//   (ii) NON-VACUITY — the live index.js differs from the base, every hunk is present, and the order paths call the seam.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS3aIndex } = require('./tools/s3a-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = 'c2c3b815';   // the held S8 tip (r5) this slice branches from
const live = require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/dpao-module-inverse').unapplyDpaoModule('index.js', require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule('index.js', require('./tools/zones-module-inverse').unapplyZonesModule('index.js', require('./tools/envlim-module-inverse').unapplyEnvlimModule('index.js', require('./tools/d4-intake-inverse').unapplyD4Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', require('./tools/s2bext-module-inverse').unapplyS2bextModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))))))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */))))));   // S3b (newer) is reversed first
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(unapplyS3aIndex(live), baseIdx, `🔴 index.js minus the S3a hunks is not ${BASE}:index.js — something beyond the stated seams changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunks insert NO line (R3 region binds pin index.js lines)');
assert.notStrictEqual(live, baseIdx, 'non-vacuity: the slice is present in index.js');
for (const [now] of HUNKS) assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, `each hunk present exactly once: ${now.slice(0, 60)}`);
const calls = (re) => (live.match(re) || []).length;
assert.strictEqual(calls(/DW\.deliveryFor\(db, \{ rid: restaurantId, mode: orderType, pin: DW\.orderPin\(body\)/g), 2, 'both order paths derive the envío');
assert.strictEqual(calls(/DW\.withDelivery\(dq, redemptionPriced/g), 2, 'both order paths record/charge the envío breakdown');
assert.strictEqual(calls(/DW\.refusalGate\(dq, /g), 2, 'both order paths refuse at the gate step (after a live checkout resume)');
assert.strictEqual(calls(/DW\.gateExtra\(dq\)/g), 2, 'both gates carry the envío context');
assert.strictEqual(calls(/DW\.quoteDeliveryFor\(req, db, restaurantId, body/g), 2, 'both quote endpoints price the envío');
assert.strictEqual(calls(/DW\.chargeContext\(db, orderId, await DW\.deliveryFor\(/g), 1, 'the card path prices against the STORED order (live checkout kept / context change refused — codex P1-1/P1-2)');
assert.strictEqual(calls(/if \(dq && dq\.refusal\) return res\.status\(dq\.httpStatus\)/g), 1, 'the card path refuses BEFORE any pending order or hold exists');
assert.strictEqual(calls(/if \(dq\.refuse\) return res\.status\(dq\.httpStatus \|\| 200\)/g), 2, 'both quote endpoints answer a config outage with its 503 (codex P2-6)');
assert.strictEqual(calls(/attachCustomerAttribution\([^;]*total: DW\.totalLempiras\(dq, effectiveTotal\)/g), 2, 'member history carries the order total (codex P2-4)');
ok(`unapplyS3aIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} same-line hunks, no line inserted); the seam is called at every site; non-vacuous`);

const [first] = HUNKS[0];
assert.throws(() => unapplyS3aIndex(live.replace(first, first.replace('DW', 'DX'))), /exactly once/, 'a byte INSIDE a hunk');
assert.throws(() => unapplyS3aIndex(live + HUNKS[3][0]), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS3aIndex(live.replace(HUNKS[HUNKS.length - 1][0], '')), /exactly once/, 'a MISSING hunk');
ok('sensitivity: a byte inside a hunk, a duplicated hunk and a missing hunk are each detected');

// ── the pinned order-path MODULES: their exact inverse (tools/s3a-module-inverse.js, applied first by
// catalog/identity-record-guards and a1-wiring.guard) reproduces c2c3b815 byte-for-byte ──
{
  const { unapplyS3aModule, FILES, HUNKS: MH } = require('./tools/s3a-module-inverse');
  assert.deepStrictEqual([...FILES].sort(), ['compute-server-net.js', 'quote-issue.js', 'rewards-redeem-intake.js', 'token-gate.js']);
  for (const f of FILES) {
    const S2TM = require('./tools/s2tip-module-inverse');   // S2-srv-tip (newest) touched these modules too: its exact inverse is reversed first
    const raw = require('./tools/sdkpay-module-inverse').unapplySdkPayModule(f, require('./tools/keymode-module-inverse').unapplyKeyModeModule(f, require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule(f, require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule(f, require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule(f, require('./tools/s1d-module-inverse').unapplyS1dModule(f, require('./tools/s2-module-inverse').unapplyS2Module(f, require('./tools/dpao-module-inverse').unapplyDpaoModule(f, require('./tools/kdsnames-module-inverse').unapplyKdsNamesModule(f, require('./tools/confirmretire-module-inverse').unapplyConfirmRetireModule(f, require('./tools/zones-module-inverse').unapplyZonesModule(f, require('./tools/envlim-module-inverse').unapplyEnvlimModule(f, require('./tools/s1srv-module-inverse').unapplyS1srvModule(f, require('./tools/grpid-module-inverse').unapplyGrpidModule(f, require('./tools/s3choice-module-inverse').unapplyS3choiceModule(f, require('./tools/s2bext-module-inverse').unapplyS2bextModule(f, require('./tools/d3live-module-inverse').unapplyD3liveModule(f, require('./tools/d4-intake-inverse').unapplyD4Module(f, fs.readFileSync(path.join(__dirname, f), 'utf8')))))))))))))))))));
    const src = S2TM.FILES.includes(f) ? S2TM.unapplyS2tipModule(f, raw) : raw;
    const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8' });
    assert.notStrictEqual(src, base, `non-vacuity: ${f} carries S3a hunks`);
    assert.strictEqual(unapplyS3aModule(f, src), base, `🔴 ${f} minus the S3a hunks is not ${BASE}:${f}`);
    const h = MH.find((x) => x.file === f);
    assert.throws(() => unapplyS3aModule(f, src.replace(h.now, h.now.replace(/\w/, 'Z'))), /exactly once/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyS3aModule(f, src + h.now), /exactly once/, `${f}: a duplicated hunk`);
    assert.notStrictEqual(unapplyS3aModule(f, `\n${src}`), base, `${f}: a byte OUTSIDE every hunk survives the inverse (the pin catches it)`);
  }
  ok(`module inverse: unapplyS3aModule → ${BASE} byte-for-byte for ${FILES.join(', ')} (${MH.length} hunks); inside / duplicate / outside each caught`);
}

console.log(`\ns3a-wiring.guard: OK (${n})`);
