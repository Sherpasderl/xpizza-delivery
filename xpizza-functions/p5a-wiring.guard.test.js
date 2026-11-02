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
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// DRYRUN (2e, next-train assembly): compare against the REAL pre-P5a assembly commit, not the lane base 8a31e2a3 (which lacks the
// whole last train). Re-point again at the real assembly (TRAIN-NEXT2 obligation A4).
const ASM_BASE = 'f1077a76';
const baseOf = (f) => execFileSync('git', ['show', `${ASM_BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES].sort(), ['cancel-order-core.js', 'index.js', 'pixelpay-client.js', 'pixelpay-confirm.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js'], 'the slice owns exactly these files');
for (const f of FILES) {
  const src = require('./tools/_asm-next2-layers').stripNewer(f, read(f), 'p5a'); const b = baseOf(f);   // DRYRUN: 3a's sb / sd (newer) first
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  // DRYRUN: index.js compared OUTSIDE the checkout endpoints block (3a's new endpoints live inside it, stripped whole — as 3a's guards do)
  const fold = (X) => (f === 'index.js' ? require('./tools/checkout-inverse').unapplyCheckoutIndex(X) : X);
  assert.strictEqual(fold(unapplyP5aModule(f, src)), fold(b), `🔴 ${f} minus the P5a hunks is not ${ASM_BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyP5aModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyP5aModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyP5aModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives (the base pin catches it)`);
}
ok(`each of ${FILES.length} files: unapplyP5aModule → ${BASE} byte-for-byte; inside / duplicate / outside each caught (${HUNKS.length} hunks)`);

{ const CIx = require('./tools/checkout-inverse').unapplyCheckoutIndex;   // DRYRUN: newer layers first; compared outside the checkout block
  assert.strictEqual(CIx(unapplyP5aIndex(require('./tools/_asm-next2-layers').stripNewer('index.js', read('index.js'), 'p5a'))), CIx(baseOf('index.js')), 'unapplyP5aIndex is the index.js case'); }
{ const CIx = require('./tools/checkout-inverse').unapplyCheckoutIndex;   // DRYRUN: P5a's OWN line effect — newer layers stripped, outside the checkout block
  assert.strictEqual(CIx(require('./tools/_asm-next2-layers').stripNewer('index.js', read('index.js'), 'p5a')).split('\n').length, CIx(baseOf('index.js')).split('\n').length, 'index.js: same-line edits only (no line moved)'); }
const other = 'tb unowned source\n';
assert.strictEqual(unapplyP5aModule('tb-unowned.js', other), other, 'a file the slice does not own passes through untouched');
ok('unapplyP5aIndex = the index.js case; index.js line count unchanged; unowned files pass through');

const sites = execFileSync('git', ['grep', '-l', 'unapplyP5aIndex(', '--', '*.test.js'], { cwd: __dirname, encoding: 'utf8' }).trim().split('\n').filter((f) => f !== 'p5a-wiring.guard.test.js');
const fsSites = execFileSync('git', ['grep', '-l', 'unapplyFormSignalIndex(', '--', '*.test.js'], { cwd: __dirname, encoding: 'utf8' }).trim().split('\n').filter((f) => f !== 'p5a-wiring.guard.test.js');
for (const f of fsSites) assert.ok(sites.includes(f), `🔴 ${f} folds index.js through the formsignal inverse but not through the newer P5a inverse`);
ok(`every index.js fold site (${fsSites.length} files) applies the P5a inverse`);
console.log(`\np5a-wiring.guard: OK (${n})`);
