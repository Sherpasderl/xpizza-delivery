'use strict';
// «Quitar del menú» DELETION CLAIM (advisor 11-13) — the wiring guard for tools/rdclaim-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node rdclaim-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyRdclaimModule } = require('./tools/rdclaim-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['catalog/catalog-edit.js'], 'the owned file (removalDiffOptions reads the claim through catalog/deletion-claim.js)');
for (const f of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, f), 'utf8'); const src = disk;   // BASE 3be4da83 already carries every older layer's lines
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyRdclaimModule(f, src), b, `🔴 ${f} minus the rdclaim hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyRdclaimModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyRdclaimModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyRdclaimModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyRdclaimModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\nrdclaim-wiring.guard: OK (${n})`);
