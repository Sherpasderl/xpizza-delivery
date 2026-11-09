'use strict';
// S3c envío activation prerequisites — hot-file wiring guard (index.js inverse-fold invariant). The slice's index.js hunks are
// all SAME-LINE: the DELIVERY order-received calls carry the CHARGED total and the «Envío» argument (createOrder, and the
// online order-received trigger); a pickup never carries envío, so both pickup calls are untouched. It ships tools/s3c-inverse.js and composes unapplyS3cIndex INNERMOST into every
// index.js fold guard. This guard proves (i) unapplyS3cIndex(index.js) === 786a328a:index.js BYTE-FOR-BYTE with sensitivity,
// and (ii) NON-VACUITY — every hunk present and every order-received call site carries the envío argument.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyS3cIndex } = require('./tools/s3c-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BASE = '786a328a';   // the HELD S3b tip this slice branches from
const live = require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/pausa-inverse').unapplyPausaIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))) /* DRYRUN R-WIRE (2e): 10 cross-side layers innermost */))));   // S5r (newer) is reversed first
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

assert.strictEqual(unapplyS3cIndex(live), baseIdx, `🔴 index.js minus the S3c hunks is not ${BASE}:index.js — something beyond the stated seams changed`);
assert.strictEqual(live.split('\n').length, baseIdx.split('\n').length, 'the hunks insert NO line (R3 region binds pin index.js lines)');
for (const [now] of HUNKS) assert.ok(live.indexOf(now) > -1 && live.indexOf(now, live.indexOf(now) + 1) === -1, `each hunk present exactly once: ${now.slice(0, 60)}`);
const calls = (re) => (live.match(re) || []).length;
assert.strictEqual(calls(/total: DW\.totalLempiras\(dq, effectiveTotal\), \.\.\.DW\.waEnvio\(priceBreakdown\),/g), 1, 'createOrder: the DELIVERY order-received message carries the charged total + envío');
assert.strictEqual(calls(/total: order\.total, \.\.\.DW\.waEnvio\(order\),/g), 1, 'the online order-received trigger carries envío on the DELIVERY template');
assert.ok(calls(/tplPickupReceived\(\{[^}]*\}/g) === 2 && calls(/tplPickupReceived\(\{[^}]*waEnvio/g) === 0, 'a PICKUP never carries envío (codex S3c r1): both pickup calls are byte-identical to the base');
assert.strictEqual(calls(/whatsapp\.tpl(OrderReceived|PickupReceived)\(/g), 4, 'premise: there are exactly four order-received call sites');
ok(`unapplyS3cIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} same-line hunks); the two DELIVERY order-received calls carry envío; pickup untouched`);

const [first] = HUNKS[0];
assert.throws(() => unapplyS3cIndex(live.replace(first, first.replace('waEnvio', 'waEnviX'))), /exactly once/, 'a byte INSIDE a hunk');
assert.throws(() => unapplyS3cIndex(live + HUNKS[HUNKS.length - 1][0]), /exactly once/, 'a DUPLICATED hunk');
assert.throws(() => unapplyS3cIndex(live.replace(HUNKS[HUNKS.length - 1][0], '')), /exactly once/, 'a MISSING hunk');
ok('sensitivity: a byte inside a hunk, a duplicated hunk and a missing hunk are each detected');

// the MODULE inverse (assembly dry run STOP 3): S3c's whatsapp.js hunks — the «Envío» receipt line — reversed exactly, so the
// guards that pin whatsapp.js (main's DRIVER C: drvc-wiring, brand-server-wiring) reverse s2tip's hunks, THEN these, then C's
{
  const { unapplyS3cModule, HUNKS: MH, FILES } = require('./tools/s3c-module-inverse');
  const { unapplyS2tipModule } = require('./tools/s2tip-module-inverse');
  const show = (rev) => execFileSync('git', ['show', `${rev}:xpizza-functions/whatsapp.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 26 });
  const baseWa = show(BASE);
  assert.deepStrictEqual([...FILES], ['whatsapp.js'], 'S3C-MOD-FILES: whatsapp.js only');
  assert.strictEqual(unapplyS3cModule('whatsapp.js', show('72ba5a0d')), baseWa, '🔴 S3C-MOD-GEN: the S3c tip\'s whatsapp.js minus the S3c hunks is not 786a328a:whatsapp.js');
  const wa = unapplyS2tipModule('whatsapp.js', require('./tools/drvc-inverse').unapplyDrvcModule('whatsapp.js', fs.readFileSync(path.join(__dirname, 'whatsapp.js'), 'utf8')) /* R-WIRE (3a stack): main's DRIVER C whatsapp.js hunks, a cross-side layer, innermost */);   // the fold order: s2tip (newer) FIRST
  assert.strictEqual(unapplyS3cModule('whatsapp.js', wa), baseWa, '🔴 S3C-MOD-BASE: whatsapp.js minus s2tip\'s, then S3c\'s hunks, is not 786a328a:whatsapp.js — something beyond the stated seams changed');
  assert.notStrictEqual(wa, baseWa, 'S3C-MOD-NONVACUOUS: the S3c hunks are present');
  for (const h of MH) assert.ok(wa.indexOf(h.now) > -1 && wa.indexOf(h.now, wa.indexOf(h.now) + 1) === -1, `S3C-MOD-ONCE: ${h.now.slice(0, 50)}`);
  assert.throws(() => unapplyS3cModule('whatsapp.js', wa.replace('🛵 Envío: Gratis', '🛵 Envío: gratis')), /exactly once/, 'S3C-MOD-EDIT: a byte inside a hunk');
  assert.throws(() => unapplyS3cModule('whatsapp.js', wa + MH[MH.length - 1].now), /exactly once/, 'S3C-MOD-DUP: a duplicated hunk');
  assert.throws(() => unapplyS3cModule('whatsapp.js', wa.replace(MH[MH.length - 1].now, '')), /exactly once/, 'S3C-MOD-MISSING: a missing hunk');
  assert.strictEqual(unapplyS3cModule('index.js', 'x'), 'x', 'S3C-MOD-PASSTHROUGH: other files pass through');
  ok(`unapplyS3cModule(whatsapp.js): 72ba5a0d → ${BASE} and (after s2tip) the live file → ${BASE} byte-for-byte (${MH.length} hunks); edited / duplicated / missing hunks refused; other files pass through`);
}

console.log(`\ns3c-wiring.guard: OK (${n})`);
