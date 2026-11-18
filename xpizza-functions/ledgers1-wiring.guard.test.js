'use strict';
// LEDGER S1 (PLAN-5f-ledger-shadow-s1-r3 §1) — the ledgers1 layer's own pin: every owned file minus the ledger S1 hunks === BASE:<file>
// byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and every reader that peels
// mktprice peels the ledgers1 layer first, directly inside it (its hosted-call hunk sits inside older layers' hunks). The sites themselves
// are pinned by ledger-writes.guard. Run: node ledgers1-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyLedgerS1Module } = require('./tools/ledgers1-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'LEDGER-S1: non-vacuity — the layer owns files');
for (const F of FILES) {
  // S-ADDR-2 (3a, merged forward onto 31f05c8a4, after this pin): the member-reads hunks marked after 099c280e4 (the useMyAddress export,
  // a pure insertion disjoint from every D4 hunk) are peeled on the raw read — the dirwire shape
  const raw = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const disk = require('./tools/memberreads-module-inverse').unapplyAfter(F, raw, '099c280e4');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `LEDGER-S1: non-vacuity — ${F} carries the ledger S1 hunks`);
  assert.strictEqual(unapplyLedgerS1Module(F, disk), base, `LEDGER-S1: 🔴 ${F} minus the ledger S1 hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyLedgerS1Module(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `LEDGER-S1: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyLedgerS1Module(F, disk + h.now), /occurs 2 times/, `LEDGER-S1: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyLedgerS1Module('tb-unowned.js', 'x\n'), 'x\n', 'LEDGER-S1: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} ledger S1 hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyMktPriceModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/mktprice-module-inverse\.js$|(^|\/)mktprice-wiring\.guard\.test\.js$|(^|\/)ledgers1-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/mktprice-module-inverse'\)\.unapplyMktPriceModule\(/g; let m;
    // asm11 17: on the train the offer-audience peel sits directly inside every mktprice peel (audience-wiring's rule), and the
    // ledgers1 peel (generated against the pre-17 train tip) directly inside THAT: mktprice(audience(ledgers1(…)))
    while ((m = re.exec(s))) if (!/^[^,]+, require\('[./]*tools\/audience-module-inverse'\)\.unapplyAudienceModule\([^,]+, require\('[./]*tools\/ledgers1-module-inverse'\)\.unapplyLedgerS1Module\(/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 300))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `LEDGER-S1: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `LEDGER-S1: 🔴 a mktprice peel whose argument is not audience(ledgers1(…)): ${bare.join(', ')}`);
  ok(`every mktprice peel in ${files.length} readers peels the ledgers1 layer first (directly inside the audience peel inside it)`);
}
console.log(`ledgers1-wiring guard: OK (${n})`);
