'use strict';
// MARKETING PRICE PATH (PLAN-5f-marketing-price r0) — the mktprice layer's own pin: every owned file (the net, both recorded-total sites,
// the gate, the quote, the envío funder) minus the marketing hunks === BASE:<file> byte-for-byte; the layer is non-vacuous, detects a tampered or
// duplicated hunk, passes other files through; and every reader that peels D4 also peels mktprice, just outside it (the d4-wiring
// INNER rule keeps D4 on the raw read). Run: node mktprice-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyMktPriceModule } = require('./tools/mktprice-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.deepStrictEqual([...FILES].sort(), ['compute-server-net.js', 'delivery/delivery-pricing.js', 'delivery/delivery-wire.js', 'index.js', 'pixelpay-confirm.js', 'quote-issue.js', 'token-gate.js'], 'MKTPRICE: the owned files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `MKTPRICE: non-vacuity — ${F} carries the marketing hunks`);
  assert.strictEqual(unapplyMktPriceModule(F, disk), base, `MKTPRICE: 🔴 ${F} minus the marketing hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyMktPriceModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `MKTPRICE: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyMktPriceModule(F, disk + h.now), /occurs 2 times/, `MKTPRICE: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyMktPriceModule('tb-unowned.js', 'x\n'), 'x\n', 'MKTPRICE: an unowned file passes through');
ok(`${FILES.length} files minus the ${HUNKS.length} marketing hunks === ${BASE} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)mktprice-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    while ((m = re.exec(s))) if (!/unapplyMktPriceModule\([^,]+, $/.test(s.slice(Math.max(0, m.index - 120), m.index))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `MKTPRICE: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `MKTPRICE: 🔴 a D4 peel without the mktprice peel around it: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is wrapped by the mktprice peel`);
}
console.log(`mktprice-wiring.guard: OK (${n})`);
