'use strict';
// fix/privacy-gaps-5f — the privacy layer's own pin: every owned file (index.js + whatsapp.js log lines, signup-endpoints.js deletion fence,
// payments/sdk/cards.js vault fence check) minus the privacy hunks === BASE:<file> byte-for-byte; the layer is non-vacuous, detects a
// tampered or duplicated hunk, passes other files through; and every reader that peels ledgers1 peels the privacy layer FIRST, directly
// on its raw source (the newest layer: generated against main = asm11). The behaviour itself is pinned by tools/pii-log.guard and
// deletion-tombstone D1–D5. Run: node privacy-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyPrivacyModule } = require('./tools/privacy-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'PRIVACY: non-vacuity — the layer owns files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `PRIVACY: non-vacuity — ${F} carries the privacy hunks`);
  assert.strictEqual(unapplyPrivacyModule(F, disk), base, `PRIVACY: 🔴 ${F} minus the privacy hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyPrivacyModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `PRIVACY: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyPrivacyModule(F, disk + h.now), /occurs 2 times/, `PRIVACY: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyPrivacyModule('tb-unowned.js', 'x\n'), 'x\n', 'PRIVACY: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} privacy hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  // inside every ledgers1 peel's argument, each raw source (a readFileSync, a local read() helper or a foldPortalSplit call) is privacy-peeled first
  const close = (s, j) => { let d = 1; while (d) { const c = s[j]; if (c === '(') d += 1; else if (c === ')') d -= 1; j += 1; } return j; };
  const files = git(['grep', '-l', 'unapplyLedgerS1Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/(ledgers1|privacy)-module-inverse\.js$|(^|\/)privacy-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /unapplyLedgerS1Module\(/g; let m;
    while ((m = re.exec(s))) {
      const end = close(s, m.index + m[0].length);
      const arg = s.slice(m.index + m[0].length, end - 1);
      const src = /(?:fs\.|fsys\.)?readFileSync\(|(?<![\w.])read\(|foldPortalSplit\(/g; let q;   // a local read(f) helper is a raw read too
      while ((q = src.exec(arg))) if (!/unapplyPrivacyModule\([^,]*,\s*(require\('fs'\)\.|require\('[./]*tools\/portal-split'\)\.)?$/.test(arg.slice(0, q.index))) bare.push(`${f}@${m.index}`);
    }
  }
  assert.ok(files.length > 50, `PRIVACY: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `PRIVACY: 🔴 a raw source inside a ledgers1 peel that is not privacy-peeled first: ${bare.join(', ')}`);
  ok(`every raw source inside a ledgers1 peel in ${files.length} readers is privacy-peeled first`);
}
console.log(`privacy-wiring guard: OK (${n})`);
