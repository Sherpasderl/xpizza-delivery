'use strict';
// «Quitar del menú» × rollback (Codex #176 P2-1, 5f) — the rbrefs layer's own pin: catalog/catalog-publish.js (the rollback re-add's edits) minus the rbrefs
// hunk === BASE:index.js byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and
// every reader that peels s3choice (the newest layer on catalog-publish.js before this one) also peels rbrefs in the peel chain enclosing it (outermost:
// rbrefs' hunks overlap no other layer's; the d4-wiring INNER rule keeps D4 on the raw read).
// Run: node rbrefs-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyRbrefsModule } = require('./tools/rbrefs-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.deepStrictEqual([...FILES].sort(), ['catalog/catalog-publish.js'], 'RBREFS: the owned file');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `RBREFS: non-vacuity — ${F} carries the rbrefs hunks`);
  assert.strictEqual(unapplyRbrefsModule(F, disk), base, `RBREFS: 🔴 ${F} minus the rbrefs hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyRbrefsModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `RBREFS: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyRbrefsModule(F, disk + h.now), /occurs 2 times/, `RBREFS: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyRbrefsModule('tb-unowned.js', 'x\n'), 'x\n', 'RBREFS: an unowned file passes through');
ok(`${FILES.length} files minus the ${HUNKS.length} rbrefs hunks === ${BASE} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyS3choiceModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/s3choice-module-inverse\.js$|(^|\/)s3choice-wiring\.guard\.test\.js$|(^|\/)rbrefs-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/s3choice-module-inverse'\)\.unapplyS3choiceModule\(/g; let m;
    // the contiguous chain of layer peels enclosing the s3choice call must include rbrefs (the statscmp rule; rbrefs sits OUTERMOST)
    while ((m = re.exec(s))) { let pre = s.slice(Math.max(0, m.index - 2000), m.index); const chain = []; let w;
      while ((w = /require\('[./]*tools\/[a-z0-9-]+'\)\.(unapply\w+Module)\([^,()]+, $/.exec(pre))) { chain.push(w[1]); pre = pre.slice(0, w.index); }
      if (!chain.includes('unapplyRbrefsModule')) bare.push(`${f}@${m.index}`); }
  }
  assert.ok(files.length > 40, `RBREFS: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `RBREFS: 🔴 an s3choice peel without the rbrefs peel around it: ${bare.join(', ')}`);
  ok(`every s3choice peel in ${files.length} readers is enclosed by the rbrefs peel`);
}
console.log(`rbrefs-wiring.guard: OK (${n})`);
