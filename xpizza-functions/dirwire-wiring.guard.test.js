'use strict';
// PLAN-directory-endpoint-r0 — the dirwire layer's own pin: index.js minus the directory wiring (the ONE getRestaurantDirectory export
// line) === BASE:index.js byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through;
// and every reader that peels D4 also peels dirwire, just outside it (the d4-wiring INNER rule keeps D4 on the raw read).
// Run: node dirwire-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyDirwireModule } = require('./tools/dirwire-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.deepStrictEqual([...FILES], ['index.js'], 'DIRWIRE: the owned file');
assert.strictEqual(HUNKS.length, 1, 'DIRWIRE: one hunk (one added export line)');
assert.ok(HUNKS[0].now.startsWith('exports.getRestaurantDirectory = onRequest(') && HUNKS[0].was === '', 'DIRWIRE: the hunk IS the export line, added');
{
  // asm11: the offer-audience layer (5f, disjoint index.js hunks, merged beside this one) is peeled on the raw read
  // asm11 15: the 3a capp push wiring (memberreads hunks marked after aaeb8f277, merged last) is peeled first
  const raw = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const disk = require('./tools/audience-module-inverse').unapplyAudienceModule('index.js', require('./tools/memberreads-module-inverse').unapplyAfter('index.js', raw, 'aaeb8f277'));
  const base = git(['show', `${BASE}:xpizza-functions/index.js`]);
  assert.notStrictEqual(disk, base, 'DIRWIRE: non-vacuity — index.js carries the wiring');
  assert.strictEqual(unapplyDirwireModule('index.js', disk), base, `DIRWIRE: 🔴 index.js minus the directory wiring is not ${BASE}:index.js`);
  const h = HUNKS[0].now; const k = Math.floor(h.length / 2);
  assert.throws(() => unapplyDirwireModule('index.js', disk.replace(h, h.slice(0, k) + '#' + h.slice(k + 1))), /occurs 0 times/, 'DIRWIRE: a byte inside the hunk');
  assert.throws(() => unapplyDirwireModule('index.js', disk + h), /occurs 2 times/, 'DIRWIRE: a duplicated hunk');
  assert.strictEqual(unapplyDirwireModule('tb-unowned.js', 'x\n'), 'x\n', 'DIRWIRE: an unowned file passes through');
}
ok(`index.js minus the dirwire hunk === ${BASE}:index.js byte-for-byte; tamper / duplicate detected; other files pass through`);

// every D4 peel in a reader is wrapped by the salesmulti peel (salesmulti-wiring's rule) and THAT by the dirwire peel — the rebased placement on main
// eb3d1cb9c (ruling: dirwire's one export-line hunk is disjoint from every other layer's, so it sits just outside salesmulti)
{
  const files = git(['grep', '-l', 'unapplyD4Module(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/d4-intake-inverse\.js$|(^|\/)d4-wiring\.guard\.test\.js$|(^|\/)dirwire-wiring\.guard\.test\.js$|(^|\/)salesmulti-wiring\.guard\.test\.js$/.test(f));   // paths relative to this directory
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/d4-intake-inverse'\)\.unapplyD4Module\(/g; let m;
    while ((m = re.exec(s))) if (!/unapplyDirwireModule\([^,]+, require\('[./]*tools\/salesmulti-module-inverse'\)\.unapplySalesMultiModule\([^,]+, $/.test(s.slice(Math.max(0, m.index - 300), m.index))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `DIRWIRE: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `DIRWIRE: 🔴 a D4 peel whose salesmulti peel is not wrapped by the dirwire peel: ${bare.join(', ')}`);
  ok(`every D4 peel in ${files.length} readers is wrapped by the dirwire peel`);
}
console.log(`dirwire-wiring.guard: OK (${n})`);
