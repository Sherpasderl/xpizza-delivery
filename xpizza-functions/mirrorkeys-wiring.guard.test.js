'use strict';
// MIRROR KEY ENCODING (hotfix 2026-10-26) — the fix's footprint in the PINNED catalog modules is EXACTLY the generated hunks:
// unapplyMirrorKeysModule(f) === 6fcd7ff2:f byte-for-byte for mirror-rtdb.js and snapshot-fallback.js; a byte changed inside a
// hunk, a duplicated hunk, and a byte outside every hunk are each detected. Run: node mirrorkeys-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyMirrorKeysModule, HUNKS, FILES, BASE } = require('./tools/mirrorkeys-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.deepStrictEqual([...FILES].sort(), ['catalog/mirror-rtdb.js', 'catalog/snapshot-fallback.js']);
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8' });
  assert.notStrictEqual(src, base, `non-vacuity: ${f} carries the fix`);
  assert.strictEqual(unapplyMirrorKeysModule(f, src), base, `🔴 ${f} minus the mirror-keys hunks is not ${BASE}:${f}`);
  for (const h of HUNKS.filter((x) => x.file === f)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyMirrorKeysModule(f, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyMirrorKeysModule(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
  }
  assert.notStrictEqual(unapplyMirrorKeysModule(f, '\n' + src), base, `${f}: a byte OUTSIDE every hunk`);
}
assert.strictEqual(unapplyMirrorKeysModule('catalog/other.js', 'x'), 'x', 'other files pass through');
ok(`mirror-rtdb.js + snapshot-fallback.js = ${BASE} + exactly the ${HUNKS.length} mirror-keys hunks; inside / duplicated / outside each detected`);
console.log(`\nmirrorkeys-wiring: OK (${n})`);
