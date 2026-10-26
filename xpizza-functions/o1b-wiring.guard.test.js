'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3 T9) — index.js's O1b footprint is EXACTLY the stated hunks (the four lifecycle names in the
// ops early branch's PORTAL_OPS_TARGETS and their re-exports on the portal-ops export line):
//   (i)  unapplyO1bIndex(index.js) === acf32fc8:index.js byte-for-byte; inside / outside / duplicated / missing each detected;
//   (ii) unapplyO1bFold(foldPortalSplit()) === foldPortalSplit(acf32fc8:index.js) (the fold consumes the early branch);
//   (iii) the ops group exports exactly the 11 names (index.js's same-object re-export: portal/ops-split.test.js cell 5).
// Run: node o1b-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyO1bIndex, unapplyO1bFold, INDEX_HUNKS, BASE } = require('./tools/o1b-inverse');
const { foldPortalSplit } = require('./tools/portal-split');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const base = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.notStrictEqual(real, base, 'non-vacuity: the slice is present');
assert.strictEqual(INDEX_HUNKS.length, 2, 'exactly two hunks');
assert.strictEqual(unapplyO1bIndex(real), base, `🔴 index.js minus the O1b hunks is not ${BASE}:index.js`);
for (const [now] of INDEX_HUNKS) {
  const k = Math.floor(now.length / 2);
  const inside = real.replace(now, now.slice(0, k) + (now[k] === '#' ? '%' : '#') + now.slice(k + 1));
  assert.throws(() => unapplyO1bIndex(inside), /occurs 0×/, 'a byte changed INSIDE a hunk');
  assert.throws(() => unapplyO1bIndex(real + now), /occurs 2×/, 'a duplicated hunk');
  assert.throws(() => unapplyO1bIndex(real.replace(now, '')), /occurs 0×/, 'a missing hunk');
}
assert.notStrictEqual(unapplyO1bIndex(real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(')), base, 'a byte OUTSIDE every hunk survives');
ok(`PROOF: unapplyO1bIndex(index.js) === ${BASE}:index.js byte-for-byte (2 hunks, each once); inside / outside / duplicated / missing each detected`);

assert.strictEqual(unapplyO1bFold(foldPortalSplit()), foldPortalSplit(undefined, base), `🔴 the portal fold minus the O1b export hunk is not the ${BASE} fold`);
assert.throws(() => unapplyO1bFold(foldPortalSplit() + INDEX_HUNKS.find(([now]) => now.includes('PORTAL_OPS_TARGETS'))[0]), /early-branch hunk survived/, 'the top hunk must never survive the fold');
ok('FOLD: unapplyO1bFold(foldPortalSplit()) equals the base fold; the early-branch hunk never survives the fold');

const ops = require('./portal/ops-functions');
const NEW = ['createBranchDraft', 'updateBranchProfile', 'setBranchActive', 'deleteBranchDraft'];
assert.strictEqual(Object.keys(ops).length, 11);
for (const k of NEW) assert.strictEqual(typeof ops[k], 'function', `ops-functions exports ${k}`);
ok('the ops group exports the 11 names (index.js\'s full-load re-export of them as the SAME objects is portal/ops-split.test.js cell 5)');

console.log(`\no1b-wiring: OK (${n})`);
