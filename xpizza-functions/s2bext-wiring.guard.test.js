'use strict';
// S2b EXTRAS (extra renames + retired-name reuse, PLAN-structure-S2b-r3) — the wiring guard for tools/s2bext-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node s2bext-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyS2bextModule } = require('./tools/s2bext-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['catalog/add-product.js', 'catalog/candidate-validate.js', 'catalog/catalog-firestore.js', 'catalog/catalog-menu.js', 'catalog/catalog-publish.js', 'catalog/edit-catalog-handler.js', 'catalog/form-menu-source.js', 'catalog/publish-edited-handler.js', 'catalog/reset-draft.js', 'catalog/resolve-lines.js', 'catalog/source-accounting.js', 'catalog/source-store.js', 'catalog/structure-gate.js', 'factura/pricing.js', 'menu-pricing.js', 'quote-token.js', 'tools/publish-version.js'], 'the owned files');
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');   // the NEWEST layer: the file on disk
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyS2bextModule(f, src), b, `🔴 ${f} minus the s2bext hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyS2bextModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyS2bextModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyS2bextModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyS2bextModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
console.log(`\ns2bext-wiring.guard: OK (${n})`);
