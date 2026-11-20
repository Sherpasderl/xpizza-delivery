'use strict';
// STATS comparison.missing_days (advisor 11-15) — the statscmp layer's own pin: stats/stats-api.js minus the comparison.missing_days
// hunk === BASE:stats/stats-api.js byte-for-byte; the layer is non-vacuous, detects a tampered or
// duplicated hunk, passes other files through; and every reader that peels D4 also peels statscmp in the peel chain enclosing it (newer layers may sit
// between; the d4-wiring INNER rule keeps D4 on the raw read). Run: node statscmp-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyStatsCmpModule } = require('./tools/statscmp-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const F = 'stats/stats-api.js';

assert.deepStrictEqual([...FILES], [F], 'STATSCMP: the owned file');
{
  // read through every NEWER layer's peel first (sales-multi, merged forward on top of this line), as the older guards do
  const disk = require('./tools/mrr-module-inverse').unapplyMrrModule(F, require('./tools/cpark-module-inverse').unapplyCparkModule(F, require('./tools/ratt-module-inverse').unapplyRattModule(F, require('./tools/dirwire-module-inverse').unapplyDirwireModule(F, require('./tools/salesmulti-module-inverse').unapplySalesMultiModule(F, require('./tools/d4-intake-inverse').unapplyD4Module(F, require('./tools/mktprice-module-inverse').unapplyMktPriceModule(F, require('./tools/audience-module-inverse').unapplyAudienceModule(F, require('./tools/ledgers1-module-inverse').unapplyLedgerS1Module(F, fs.readFileSync(path.join(__dirname, F), 'utf8'))))))))));
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, 'STATSCMP: non-vacuity — stats-api.js carries the comparison.missing_days hunk');
  assert.strictEqual(unapplyStatsCmpModule(F, disk), base, `STATSCMP: 🔴 ${F} minus the comparison.missing_days hunk is not ${BASE}:${F}`);
  for (const h of HUNKS) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyStatsCmpModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, 'STATSCMP: a byte inside a hunk');
    assert.throws(() => unapplyStatsCmpModule(F, disk + h.now), /occurs 2 times/, 'STATSCMP: a duplicated hunk');
  }
  assert.strictEqual(unapplyStatsCmpModule('tb-unowned.js', 'x\n'), 'x\n', 'STATSCMP: an unowned file passes through');
}
ok(`${F} minus the ${HUNKS.length} comparison.missing_days hunk(s) === ${BASE}:${F} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)statscmp-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    // the contiguous chain of layer peels enclosing the D4 call (newer layers sit INSIDE older ones, D4 innermost) must include statscmp
    while ((m = re.exec(s))) { let pre = s.slice(Math.max(0, m.index - 2000), m.index); const chain = []; let w;
      while ((w = /require\('[./]*tools\/[a-z0-9-]+'\)\.(unapply\w+Module)\([^,()]+, $/.exec(pre))) { chain.push(w[1]); pre = pre.slice(0, w.index); }
      if (!chain.includes('unapplyStatsCmpModule')) bare.push(`${f}@${m.index}`); }
  }
  assert.ok(files.length > 50, `STATSCMP: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `STATSCMP: 🔴 a D4 peel without the statscmp peel around it: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is enclosed by the statscmp peel`);
}
console.log(`statscmp-wiring.guard: OK (${n})`);
