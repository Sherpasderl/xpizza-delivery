'use strict';
// PLAN-5f-cancel-park r1 option A (5f) — the cpark layer's own pin: index.js + cancel-order-core.js minus the cpark
// hunk === BASE:index.js byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and
// every reader that peels D4 also peels cpark in the peel chain enclosing it (outermost on 31f05c8a4; the d4-wiring INNER rule keeps D4 on the raw read).
// Run: node cpark-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyCparkModule } = require('./tools/cpark-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.deepStrictEqual([...FILES].sort(), ['cancel-order-core.js', 'index.js'], 'CPARK: the owned files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `CPARK: non-vacuity — ${F} carries the cpark hunks`);
  assert.strictEqual(unapplyCparkModule(F, disk), base, `CPARK: 🔴 ${F} minus the cpark hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyCparkModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `CPARK: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyCparkModule(F, disk + h.now), /occurs 2 times/, `CPARK: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyCparkModule('tb-unowned.js', 'x\n'), 'x\n', 'CPARK: an unowned file passes through');
ok(`${FILES.length} files minus the ${HUNKS.length} cpark hunks === ${BASE} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)cpark-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    // the contiguous chain of layer peels enclosing the D4 call must include cpark (the statscmp rule; on 31f05c8a4 cpark sits OUTERMOST,
    // since salesmulti-wiring pins salesmulti adjacent to D4)
    while ((m = re.exec(s))) { let pre = s.slice(Math.max(0, m.index - 2000), m.index); const chain = []; let w;
      while ((w = /require\('[./]*tools\/[a-z0-9-]+'\)\.(unapply\w+Module)\([^,()]+, $/.exec(pre))) { chain.push(w[1]); pre = pre.slice(0, w.index); }
      if (!chain.includes('unapplyCparkModule')) bare.push(`${f}@${m.index}`); }
  }
  assert.ok(files.length > 50, `CPARK: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `CPARK: 🔴 a D4 peel without the cpark peel around it: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is enclosed by the cpark peel`);
}
console.log(`cpark-wiring.guard: OK (${n})`);
