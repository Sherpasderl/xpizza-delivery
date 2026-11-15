'use strict';
// KDS TICKET NAMES (MINT_OPAQUE prerequisite 3) — the wiring guard for tools/kdsnames-module-inverse.js: the inverse returns each owned file to
// its BASE byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node kdsnames-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyKdsNamesModule } = require('./tools/kdsnames-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['rewards-redeem-intake.js'], 'the owned files');
for (const f of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, f), 'utf8'); const src = require('./tools/s2bext-module-inverse').unapplyS2bextModule(f, disk);   // the file on disk, minus S2b's s2bext (merged later on the train: train/portal-structure merge 4)
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyKdsNamesModule(f, src), b, `🔴 ${f} minus the kds-names hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyKdsNamesModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyKdsNamesModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyKdsNamesModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyKdsNamesModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} file → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunk); unowned passes`);
console.log(`\nkdsnames-wiring.guard: OK (${n})`);
