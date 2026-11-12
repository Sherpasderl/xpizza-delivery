'use strict';
// S1 SERVER (the extras check scoped to app entries) — the wiring guard for tools/s1srv-module-inverse.js: the inverse returns each owned file to its BASE
// byte-for-byte; a byte inside a hunk, a duplicated hunk and a byte outside every hunk are each caught; an unowned file passes
// through; the edits are same-line only. Run: node s1srv-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyS1srvModule } = require('./tools/s1srv-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['delivery/delivery-wire.js', 'index.js'], 'the owned files');
for (const f of FILES) {
  const src = require('./tools/grpid-module-inverse').unapplyGrpidModule(f, fs.readFileSync(path.join(__dirname, f), 'utf8'));   // the NEWEST layer: the file on disk
  const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
  assert.notStrictEqual(src, b, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyS1srvModule(f, src), b, `🔴 ${f} minus the s1srv hunks is not ${BASE}:${f}`);
  assert.strictEqual(src.split('\n').length, b.split('\n').length, `🔴 ${f}: same-line edits only (no line added or moved)`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = h.now.search(/[A-Za-z]/);
    assert.throws(() => unapplyS1srvModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte inside a hunk`);
    assert.throws(() => unapplyS1srvModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyS1srvModule(f, '\n' + src), b, `${f}: a byte OUTSIDE every hunk survives`);
}
assert.strictEqual(unapplyS1srvModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok(`${FILES.length} files → ${BASE} byte-for-byte, same-line only; inside / duplicate / outside caught (${HUNKS.length} hunks); unowned passes`);
// the portal fold of index.js carries every index.js hunk exactly once (the guards that read the fold peel this layer)
const fold = require('./tools/grpid-module-inverse').unapplyGrpidModule('index.js', require('./tools/portal-split').foldPortalSplit());
for (const h of HUNKS.filter((x) => x.file === 'index.js')) assert.strictEqual(fold.split(h.now).length - 1, 1, 'an index.js hunk survives the portal fold exactly once');
ok('the portal fold carries each index.js hunk exactly once');
console.log(`\ns1srv-wiring.guard: OK (${n})`);
