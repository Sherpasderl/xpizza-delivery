'use strict';
// «PAUSA» (PLAN-driver-pausa-server r1.1) — index.js footprint guard (index.js is not require-safe): the slice is exactly its five
// hunks (the inverse returns acf32fc8's index.js byte-for-byte), and each hunk says what the plan says:
//   • pickEligibleDriver skips on_break right beside the off_shift skip (ranking for auto-assign, sweep and timeout reassign);
//   • reassertAssignable refuses on_break right before the write (auto-assign + sweep recheck);
//   • startDriverShift (svc handle — the clear-only grant) and endDriverShift clear break_since.
// Run: node pausa-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyPausaIndex, INDEX_HUNKS } = require('./tools/pausa-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(require('./tools/driver-ledger-inverse').unapplyDriverLedgerIndex(require('./tools/s3a-inverse').unapplyS3aIndex(require('./tools/s3b-inverse').unapplyS3bIndex(require('./tools/s3c-inverse').unapplyS3cIndex(require('./tools/s5r-inverse').unapplyS5rIndex(require('./tools/s2tip-inverse').unapplyS2tipIndex(require('./tools/s2app-inverse').unapplyS2appIndex(require('./tools/area-inverse').unapplyAreaIndex(require('./tools/formbake-inverse').unapplyFormbakeIndex(require('./tools/s4hours-inverse').unapplyS4HoursIndex(require('./tools/mem512-inverse').unapplyMem512Index(require('./tools/checkout-inverse').unapplyCheckoutIndex(require('./tools/lifecycle-inverse').unapplyLifecycleIndex(require('./tools/intl-inverse').unapplyIntlIndex(require('./tools/photos-inverse').unapplyPhotosIndex(require('./tools/hostedrace-module-inverse').unapplyHostedRaceModule('index.js', require('./tools/p5a-inverse').unapplyP5aIndex(require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', require('./tools/keymode-module-inverse').unapplyKeyModeModule('index.js', require('./tools/frozenkeys-module-inverse').unapplyFrozenKeysModule('index.js', require('./tools/resolvelines-module-inverse').unapplyResolveLinesModule('index.js', require('./tools/reservedkeys-module-inverse').unapplyReservedKeysModule('index.js', require('./tools/s1d-module-inverse').unapplyS1dModule('index.js', require('./tools/s2-module-inverse').unapplyS2Module('index.js', require('./tools/s1srv-module-inverse').unapplyS1srvModule('index.js', require('./tools/d3live-module-inverse').unapplyD3liveModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))))))))   /* DRYRUN R-WIRE (2e): photos A1/A2 (newest) innermost */ )))))))))))))))))))))))) /* DRYRUN R-WIRE (2e): 17 cross-side layers innermost */;
const BASE = execFileSync('git', ['show', 'acf32fc8:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

const fnText = (head) => { const a = src.indexOf(head); assert.ok(a >= 0, `${head} present`); return src.slice(a, src.indexOf('\n}\n', a)); };
{
  const pick = fnText('async function pickEligibleDriver(');
  assert.match(pick, /if \(d\.status === 'off_shift'\) continue;\n {4}if \(d\.status === 'on_break'\) continue;/, 'PAUSA-PICK the ranking skips on_break right beside off_shift');
  const re = fnText('async function reassertAssignable(');
  assert.match(re, /if \(d\.status === 'off_shift'\) return \{ ok: false, reason: 'off_shift' \};\n {2}if \(d\.status === 'on_break'\) return \{ ok: false, reason: 'on_break' \};/, 'PAUSA-REASSERT the recheck refuses on_break before the write');
  ok('pickEligibleDriver skips on_break; reassertAssignable refuses it (reason on_break)');
}
{
  const start = src.slice(src.indexOf('exports.startDriverShift'), src.indexOf('exports.endDriverShift'));
  assert.match(start, /\[`drivers\/\$\{uid\}\/break_since`\]: null,/, 'PAUSA-START startDriverShift clears break_since (a new shift never starts paused)');
  assert.match(start, /svcWriteOrFallback\(db, svcDb, \(h\) => h\.ref\(\)\.update\(shiftOpen\)/, 'premise: the shift-open batch goes through the svc handle (the clear-only grant)');
  const end = src.slice(src.indexOf('exports.endDriverShift'), src.indexOf('exports.endDriverShift') + 2500);
  assert.match(end, /\[`drivers\/\$\{uid\}\/status`\]: 'off_shift',\n {4}\[`drivers\/\$\{uid\}\/shift_ended_at`\]: ServerValue\.TIMESTAMP,\n {4}\[`drivers\/\$\{uid\}\/break_since`\]: null,/, 'PAUSA-END endDriverShift clears break_since with off_shift');
  ok('startDriverShift and endDriverShift clear break_since');
}
let unapplied; try { unapplied = unapplyPausaIndex(src); } catch (e) { assert.fail(`PAUSA-INV-BASE 🔴 a pausa hunk is missing or edited: ${e.message}`); }
assert.strictEqual(unapplied, BASE, 'PAUSA-INV-BASE 🔴 index.js minus the pausa hunks is not acf32fc8:index.js');
assert.notStrictEqual(src, BASE, 'PAUSA-INV-NONVACUOUS');
assert.strictEqual(INDEX_HUNKS.length, 5, 'PAUSA-INV-COUNT exactly the five planned hunks');
{
  const [now] = INDEX_HUNKS[1];
  const at = src.indexOf(now) + Math.floor(now.length / 2);
  const inside = src.slice(0, at) + (src[at] === 'x' ? 'y' : 'x') + src.slice(at + 1);
  let detected; try { detected = unapplyPausaIndex(inside) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'PAUSA-INV-INSIDE a byte changed inside a hunk is caught');
  assert.throws(() => unapplyPausaIndex(src + now), /occurs 2×/, 'PAUSA-INV-DUP');
  const outside = src.replace('exports.getSalesStats = portalFunctions.getSalesStats;', 'exports.getSalesStats = portalFunctions.getSalesStats; ');
  assert.notStrictEqual(outside, src, 'premise: the outside probe edits something');
  assert.notStrictEqual(unapplyPausaIndex(outside), BASE, 'PAUSA-INV-OUTSIDE a byte outside every hunk fails the base pin');
}
ok('unapplyPausaIndex(index.js) === acf32fc8:index.js byte-for-byte (5 hunks); inside / duplicate / outside each caught');

console.log(`\npausa-wiring.guard: OK (${n})`);
