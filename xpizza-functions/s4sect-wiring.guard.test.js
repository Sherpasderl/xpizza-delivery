'use strict';
// S4 SECTIONS (PLAN-structure-S4-r4) — the wiring guard for tools/s4sect-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node s4sect-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyS4sectModule } = require('./tools/s4sect-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['catalog/add-product.js', 'catalog/edit-catalog-handler.js', 'catalog/form-menu-source.js', 'catalog/platform-structure.js', 'catalog/publish-edited-handler.js', 'catalog/publish-request.js', 'catalog/source-store.js'], 'the owned (pinned) files S4 edits same-line');
for (const f of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, f), 'utf8'); const src = disk;   // BASE b6f6b82b (asm8) already carries every older layer's lines
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyS4sectModule(f, src), b, `🔴 ${f} minus the s4sect hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyS4sectModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyS4sectModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyS4sectModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyS4sectModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\ns4sect-wiring.guard: OK (${n})`);
