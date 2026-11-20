'use strict';
// manual_review reasons (5f, advisor 11-19) — the mrr layer's own pin: cancel-order-core.js + resolve-manual.js + pixelpay-hosted-webhook.js minus the mrr
// hunk === BASE:index.js byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and
// every reader that peels D4 also peels mrr in the peel chain enclosing it (outermost on 31f05c8a4; the d4-wiring INNER rule keeps D4 on the raw read).
// Run: node mrr-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyMrrModule } = require('./tools/mrr-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.deepStrictEqual([...FILES].sort(), ['cancel-order-core.js', 'pixelpay-hosted-webhook.js', 'resolve-manual.js'], 'MRR: the owned files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `MRR: non-vacuity — ${F} carries the mrr hunks`);
  assert.strictEqual(unapplyMrrModule(F, disk), base, `MRR: 🔴 ${F} minus the mrr hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyMrrModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `MRR: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyMrrModule(F, disk + h.now), /occurs 2 times/, `MRR: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyMrrModule('tb-unowned.js', 'x\n'), 'x\n', 'MRR: an unowned file passes through');
ok(`${FILES.length} files minus the ${HUNKS.length} mrr hunks === ${BASE} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)mrr-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    // the contiguous chain of layer peels enclosing the D4 call must include mrr (the statscmp rule; on 31f05c8a4 mrr sits OUTERMOST,
    // since salesmulti-wiring pins salesmulti adjacent to D4)
    while ((m = re.exec(s))) { let pre = s.slice(Math.max(0, m.index - 4000), m.index); const chain = []; let w;   // a 4000-char window: with mrr outside cpark the chains run past 2000 chars
      while ((w = /require\('[./]*tools\/[a-z0-9-]+'\)\.(unapply\w+Module)\([^,()]+, $/.exec(pre))) { chain.push(w[1]); pre = pre.slice(0, w.index); }
      if (!chain.includes('unapplyMrrModule')) bare.push(`${f}@${m.index}`); }
  }
  assert.ok(files.length > 50, `MRR: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `MRR: 🔴 a D4 peel without the mrr peel around it: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is enclosed by the mrr peel`);
}
console.log(`mrr-wiring.guard: OK (${n})`);
