'use strict';
// OFFER AUDIENCE (PLAN-5f-offer-audience r4.1) — the audience layer's own pin: every owned file minus the audience hunks === BASE:<file>
// byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and every reader that peels
// mktprice peels the audience layer first, directly inside it (some audience hunks edit mktprice lines). Run: node audience-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyAudienceModule } = require('./tools/audience-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'AUDIENCE: non-vacuity — the layer owns files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `AUDIENCE: non-vacuity — ${F} carries the audience hunks`);
  assert.strictEqual(unapplyAudienceModule(F, disk), base, `AUDIENCE: 🔴 ${F} minus the audience hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyAudienceModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `AUDIENCE: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyAudienceModule(F, disk + h.now), /occurs 2 times/, `AUDIENCE: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyAudienceModule('tb-unowned.js', 'x\n'), 'x\n', 'AUDIENCE: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} audience hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyMktPriceModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/mktprice-module-inverse\.js$|(^|\/)mktprice-wiring\.guard\.test\.js$|(^|\/)audience-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/mktprice-module-inverse'\)\.unapplyMktPriceModule\(/g; let m;
    while ((m = re.exec(s))) if (!/^[^,]+, require\('[./]*tools\/audience-module-inverse'\)\.unapplyAudienceModule\(/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 200))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `AUDIENCE: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `AUDIENCE: 🔴 a mktprice peel whose argument is not the audience peel: ${bare.join(', ')}`);
  ok(`every mktprice peel in ${files.length} readers peels the audience layer first (directly inside it)`);
}
console.log(`audience-wiring guard: OK (${n})`);
