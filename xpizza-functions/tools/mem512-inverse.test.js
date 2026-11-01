'use strict';
// ENDPOINT MEMORY 256 → 512MiB (assembly obligation 9) — the mem512 inverse and its composition with menu-warm.
//   1. unapplyMem512Index(index.js) === the pre-mem512 index.js byte-for-byte; no line inserted; the 4 endpoints carry 512MiB
//   2. one mutant PER HUNK: a byte inside hunk i makes the inverse throw, naming that endpoint (never a silent skip)
//   3. a duplicated hunk throws; a byte outside every hunk survives the inverse (the base compare catches it)
//   4. ORDER (REQUIRED, advisor 10-31): getPublicMenu's line is inside menu-warm's pinned hunk — mem512 FIRST then menu-warm
//      works; menu-warm FIRST throws its exactly-once pin error, LOUDLY
// Run: node tools/mem512-inverse.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, unapplyMem512Index } = require('./mem512-inverse');
const { unapplyMenuWarmIndex } = require('./menu-warm-inverse');

const BASE = 'ed4e75b6';   // DRYRUN assembly state just before the mem512 layer (re-point at the real assembly)
const live = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1 ──
assert.strictEqual(HUNKS.length, 4, 'four hunks');
assert.deepStrictEqual(HUNKS.map((h) => h.fn), ['createOrder', 'chargeOnlineOrder', 'getPublicMenu', 'quoteOrder']);
assert.notStrictEqual(live, base, 'non-vacuity: index.js carries the mem512 hunks');
assert.strictEqual(unapplyMem512Index(live), base, `🔴 index.js minus the mem512 hunks is not ${BASE}:index.js`);
assert.strictEqual(live.split('\n').length, base.split('\n').length, 'same-line hunks: no line inserted or removed');
for (const h of HUNKS) {
  assert.strictEqual(h.now.replace("memory: '512MiB'", "memory: '256MiB'"), h.was, `${h.fn}: the hunk changes ONLY 256MiB → 512MiB`);
  const at = live.indexOf(h.now); const fnAt = live.lastIndexOf(`exports.${h.fn} = onRequest(`, at);
  assert.ok(fnAt >= 0 && !live.slice(fnAt + 1, at).includes('\nexports.'), `${h.fn}: the hunk sits in ${h.fn}'s own options`);
}
ok('unapplyMem512Index(index.js) === the pre-mem512 index.js byte-for-byte; 4 same-line hunks, each ONLY 256→512 inside its own endpoint\'s options');

// ── 2: a mutant per hunk ──
for (const h of HUNKS) {
  const mutated = live.replace(h.now, h.now.replace("'512MiB'", "'513MiB'"));
  assert.notStrictEqual(mutated, live, `premise: the ${h.fn} mutant edits something`);
  assert.throws(() => unapplyMem512Index(mutated), new RegExp(`the ${h.fn} memory hunk occurs 0 times`), `🔴 a byte inside the ${h.fn} hunk was not caught`);
}
ok('a byte inside EACH hunk (createOrder / chargeOnlineOrder / getPublicMenu / quoteOrder) throws, naming the endpoint');

// ── 3 ──
assert.throws(() => unapplyMem512Index(live + HUNKS[3].now), /quoteOrder memory hunk occurs 2 times/, 'a duplicated hunk throws');
assert.notStrictEqual(unapplyMem512Index(`\n${live}`), base, 'a byte outside every hunk survives the inverse (the base compare catches it)');
ok('a duplicated hunk throws; a byte outside every hunk is caught by the base compare');

// ── 4: ORDER ──
assert.doesNotThrow(() => unapplyMenuWarmIndex(unapplyMem512Index(live)), 'mem512 FIRST, then menu-warm: both apply');
assert.throws(() => unapplyMem512Index(unapplyMenuWarmIndex(live)), /menu-warm hunk occurs 0 times \(expected exactly 1\)/,
  '🔴 ORDER: menu-warm run BEFORE mem512 must throw its pin error, never skip silently');
ok('ORDER: mem512 then menu-warm composes; menu-warm first throws «the menu-warm hunk occurs 0 times (expected exactly 1)»');

console.log(`\nmem512-inverse: OK (${n})`);
