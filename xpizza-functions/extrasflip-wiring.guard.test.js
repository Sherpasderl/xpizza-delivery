'use strict';
// EXTRAS SWITCH-ON (NOTE-extras-switch-on-readiness, owner + advisor 11-16) — the extrasflip layer's own pin: catalog/platform-structure.js
// minus the flip hunk === BASE (eb3d1cb9c, the shipped OFF) byte-for-byte; non-vacuous, tamper / duplicate detected, other files pass
// through; and every reader that peels s3choice peels the extrasflip layer first, directly inside it (the hunk sits on an s3choice line).
// Also: the flip is EXTRAS_CATALOG ONLY — choiceEdit stays OFF. Run: node extrasflip-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyExtrasflipModule } = require('./tools/extrasflip-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'EXTRASFLIP: non-vacuity — the layer owns files');
for (const F of FILES) {
  const raw = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const disk = require('./tools/s4sect-module-inverse').unapplyS4sectModule(F, raw);   // S4 s4sect (advisor 11-19): peeled first — S4 rewrites the flip line and edits choice-compare
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `EXTRASFLIP: non-vacuity — ${F} carries the flip hunk(s)`);
  assert.strictEqual(unapplyExtrasflipModule(F, disk), base, `🔴 EXTRASFLIP-BASE: ${F} minus the flip hunk(s) is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyExtrasflipModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `EXTRASFLIP: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyExtrasflipModule(F, disk + h.now), /occurs 2 times/, `EXTRASFLIP: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyExtrasflipModule('tb-unowned.js', 'x\n'), 'x\n', 'EXTRASFLIP: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} flip hunk(s) === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyS3choiceModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/s3choice-module-inverse\.js$|(^|\/)s3choice-wiring\.guard\.test\.js$|(^|\/)extrasflip-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/s3choice-module-inverse'\)\.unapplyS3choiceModule\(/g; let m;
    while ((m = re.exec(s))) if (!/^[^,]+, require\('[./]*tools\/extrasflip-module-inverse'\)\.unapplyExtrasflipModule\(/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 200))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 40, `EXTRASFLIP: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `🔴 EXTRASFLIP-PEEL: an s3choice peel whose argument is not the extrasflip peel: ${bare.join(', ')}`);
  ok(`every s3choice peel in ${files.length} readers peels the extrasflip layer first (directly inside it)`);
}
assert.deepStrictEqual(require('./catalog/platform-structure').structureCapabilities(), { extrasCatalog: true, choiceEdit: false, sections: false }, '🔴 EXTRASFLIP-SWITCH: the flip turns ON extrasCatalog ONLY (choiceEdit and sections stay OFF)');
ok('the switch: extrasCatalog ON; choiceEdit OFF; sections OFF');
console.log(`extrasflip-wiring guard: OK (${n})`);
