'use strict';
// P5a (PixelPay unknown outcome) — the wiring guard for tools/p5a-inverse.js.
//   1. PROOF: for every file the slice edits, unapplyP5aModule(file) === BASE:file byte-for-byte; a byte inside a hunk,
//      a duplicated hunk and a byte outside every hunk are each caught.
//   2. A file the slice does not own passes through untouched; unapplyP5aIndex is the index.js case.
//   3. The inverse is registered INNERMOST at the index.js fold sites (checked by every older guard going green).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyP5aModule, unapplyP5aIndex } = require('./tools/p5a-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => require('./tools/sdkpay-module-inverse').unapplySdkPayModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'));
// DRYRUN (2e, next-train assembly): compare against the REAL pre-P5a assembly commit, not the lane base 8a31e2a3 (which lacks the
// whole last train). Re-point again at the real assembly (TRAIN-NEXT2 obligation A4).
const ASM_BASE = 'f1077a76';
// asm2 (5f): alert-prune.js's NEVER_AUTO_PRUNE is ONE composed statement; extra-pay's r5 (f2e1f2fa) sits directly below P5a in
// every chain, so P5a's alert-prune hunk returns the composed file to f2e1f2fa's approved alert-prune.js (hostedrace-wiring then
// proves f2e1f2fa minus the hosted-race hunks is the assembly base).
const BELOW = { 'alert-prune.js': 'f2e1f2fa' };
const baseOf = (f) => execFileSync('git', ['show', `${BELOW[f] || ASM_BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES].sort(), ['alert-prune.js', 'cancel-order-core.js', 'index.js', 'pixelpay-client.js', 'pixelpay-confirm.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  // asm2 (5f): index.js carries the newer S-B / S-D layers (stripped first) and capp + 3a additions INSIDE checkout's endpoints
  // block with no inverse of their own — stripped by their EXACT generated text (tools/asm2-approved-additions.js) from the
  // actual side only; every other byte, checkout code included, must be base.
  const CO = (x) => x;
  const src = f === 'index.js' ? require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/asm2-approved-additions').stripApprovedAdditions(read(f))))) : read(f);
  const b = CO(baseOf(f));
  assert.notStrictEqual(CO(src), b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(CO(unapplyP5aModule(f, src)), b, `🔴 ${f} minus the P5a hunks is not ${BELOW[f] || ASM_BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyP5aModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyP5aModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(CO(unapplyP5aModule(f, '\n' + src)), b, `${f}: a byte OUTSIDE every hunk survives (the base pin catches it)`);
}
ok(`each of ${FILES.length} files: unapplyP5aModule → ${BASE} byte-for-byte; inside / duplicate / outside each caught (${HUNKS.length} hunks)`);
// asm2 (5f): index.js's fold to the assembly base — the ONE definition the loop and the sensitivity cell share
const foldIndexToBase = (raw) => unapplyP5aModule('index.js', require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/asm2-approved-additions').stripApprovedAdditions(raw)))));
const indexBase = () => baseOf('index.js');

// ASM2-CHECKOUT-SENSITIVITY (Codex asm2 r1 P2): a change to EXISTING checkout logic must fail the index.js base pin — the
// fold may remove only the approved additions, never the surrounding checkout bytes.
{
  const raw = require('./tools/sdkpay-module-inverse').unapplySdkPayModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'));
  const CALC = "const cappGuestRefusal = require('./checkout-guest-gate').createOrderRefusal(clientHdr, customer_uid, body);";
  assert.strictEqual(raw.split(CALC).length - 1, 1, 'ASM2-CHECKOUT-SENSITIVITY: PREMISE — the calculation is present exactly once');
  const mutated = raw.replace(CALC, () => 'const cappGuestRefusal = null;');
  assert.strictEqual(foldIndexToBase(raw), indexBase(), 'ASM2-CHECKOUT-SENSITIVITY: PREMISE — the unmutated file folds to base');
  assert.notStrictEqual(foldIndexToBase(mutated), indexBase(), 'ASM2-CHECKOUT-SENSITIVITY: replacing cappGuestRefusal\'s calculation with null fails the p5a-wiring index.js base pin');
  ok('ASM2-CHECKOUT-SENSITIVITY: an edit to existing checkout logic is caught');
}

{ const x = require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(read('index.js')))); assert.strictEqual(unapplyP5aIndex(x), unapplyP5aModule('index.js', x), 'unapplyP5aIndex is the index.js case'); assert.notStrictEqual(unapplyP5aIndex(x), x, 'non-vacuity: it strips the P5a hunks'); }
{ const x = require('./tools/sd-inverse').unapplySdIndex(require('./tools/sb-inverse').unapplySbIndex(require('./tools/tippref-inverse').unapplyTipprefIndex(require('./tools/asm2-approved-additions').stripApprovedAdditions(read('index.js'))))); assert.strictEqual(x.split('\n').length, baseOf('index.js').split('\n').length, 'index.js: same-line edits only (no line moved)'); }   // asm2 (5f): the P5a layer alone (newer layers stripped)
const other = 'tb unowned source\n';
assert.strictEqual(unapplyP5aModule('tb-unowned.js', other), other, 'a file the slice does not own passes through untouched');
ok('unapplyP5aIndex = the index.js case; index.js line count unchanged; unowned files pass through');

const sites = execFileSync('git', ['grep', '-l', 'unapplyP5aIndex(', '--', '*.test.js'], { cwd: __dirname, encoding: 'utf8' }).trim().split('\n').filter((f) => f !== 'p5a-wiring.guard.test.js');
const fsSites = execFileSync('git', ['grep', '-l', 'unapplyFormSignalIndex(', '--', '*.test.js'], { cwd: __dirname, encoding: 'utf8' }).trim().split('\n').filter((f) => f !== 'p5a-wiring.guard.test.js');
for (const f of fsSites) assert.ok(sites.includes(f), `🔴 ${f} folds index.js through the formsignal inverse but not through the newer P5a inverse`);
ok(`every index.js fold site (${fsSites.length} files) applies the P5a inverse`);
console.log(`\np5a-wiring.guard: OK (${n})`);
