'use strict';
// S2 (PLAN-portal-inicio-server-r0) — the salesmulti layer's own pin: stats/stats-api.js minus the S2 hunks (the per-branch view
// extracted, the multi-branch form added) === BASE:stats/stats-api.js byte-for-byte; the layer is non-vacuous, detects a tampered or
// duplicated hunk, passes other files through; and every reader that peels D4 also peels salesmulti, just outside it (the d4-wiring
// INNER rule keeps D4 on the raw read). Run: node salesmulti-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplySalesMultiModule } = require('./tools/salesmulti-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const F = 'stats/stats-api.js';

assert.deepStrictEqual([...FILES], [F], 'SALESMULTI: the owned file');
{
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, 'SALESMULTI: non-vacuity — stats-api.js carries the S2 hunks');
  assert.strictEqual(unapplySalesMultiModule(F, disk), base, `SALESMULTI: 🔴 ${F} minus the S2 hunks is not ${BASE}:${F}`);
  for (const h of HUNKS) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplySalesMultiModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, 'SALESMULTI: a byte inside a hunk');
    assert.throws(() => unapplySalesMultiModule(F, disk + h.now), /occurs 2 times/, 'SALESMULTI: a duplicated hunk');
  }
  assert.strictEqual(unapplySalesMultiModule('tb-unowned.js', 'x\n'), 'x\n', 'SALESMULTI: an unowned file passes through');
}
ok(`${F} minus the ${HUNKS.length} S2 hunks === ${BASE}:${F} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)salesmulti-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    while ((m = re.exec(s))) if (!/unapplySalesMultiModule\([^,]+, $/.test(s.slice(Math.max(0, m.index - 120), m.index))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `SALESMULTI: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `SALESMULTI: 🔴 a D4 peel without the salesmulti peel around it: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is wrapped by the salesmulti peel`);
}
console.log(`salesmulti-wiring.guard: OK (${n})`);
