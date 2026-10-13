'use strict';
// S1a — index.js wiring guard (PLAN-S1 §15).
//   PROOF: tools/s1a-inverse.js reverses ALL the S1a index.js edits (the svc-assigner handle + the 7 ownership/shift
//   writer conversions + the 4 driver-callable hard-stops + the two requires) back to 90fac9e:index.js BYTE-FOR-BYTE,
//   each hunk exactly once — the inverse every other index.js fold guard applies FIRST (newest-first). A byte inside a
//   hunk, a duplicated hunk, a missing anchor and a byte outside every hunk are each detected.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, applyS1aIndex, unapplyS1aIndex } = require('./tools/s1a-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const BASE = '90fac9e';   // the rebase base (int7); S1a's edits are the only index.js delta on top of it
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
const real = read('index.js');

// ── 1. the inverse reproduces the base byte-for-byte ──
assert.strictEqual(unapplyS1aIndex(real), baseIdx, `🔴 index.js minus the S1a edits is not ${BASE}:index.js`);
assert.notStrictEqual(unapplyS1aIndex(real), real, 'non-vacuity: the S1a edits are present and reversed');
ok(`unapplyS1aIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each reversed exactly once)`);

// ── 2. forward/inverse are exact mutual inverses on the base ──
assert.strictEqual(applyS1aIndex(baseIdx), real, `🔴 applyS1aIndex(${BASE}:index.js) does not reproduce the committed index.js`);
assert.strictEqual(unapplyS1aIndex(applyS1aIndex(baseIdx)), baseIdx, 'round-trip is identity on the base');
ok('applyS1aIndex and unapplyS1aIndex are exact mutual inverses');

// ── 3. sensitivity — a byte INSIDE a hunk, a DUPLICATED hunk, a MISSING anchor, a byte OUTSIDE every hunk ──
{
  const h = HUNKS.find((x) => x.now.includes('svcAssignerDb()'));   // a representative modification hunk
  assert.throws(() => unapplyS1aIndex(real.replace(h.now, h.now.replace('svcAssignerDb()', 'svcAssignerDB()'))), /occurs 0×/, 'a byte INSIDE a hunk is detected (anchor no longer matches)');
  assert.throws(() => unapplyS1aIndex(real + h.now), /occurs 2×/, 'a DUPLICATED hunk is detected');
}
{
  const g = HUNKS.find((x) => x.now.includes('assertDriverCallerActive(uid'));
  assert.throws(() => unapplyS1aIndex(real.replace(g.now, '')), /occurs 0×/, 'a MISSING anchor (hunk removed) is detected');
}
{
  const outside = '// s1a-wiring outside-byte probe\n' + real;   // a byte that belongs to no hunk
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(unapplyS1aIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives the inverse and fails the base pin');
}
ok('a byte inside a hunk, a duplicated hunk, a missing anchor, and a byte outside every hunk are each detected');

// ── 4. the edits are actually wired (not just reversible) ──
assert.ok(/require\('\.\/lib\/svc-assigner'\)/.test(real) && /require\('\.\/lib\/driver-callable-guard'\)/.test(real), 'both S1a modules are required');
assert.strictEqual((real.match(/claimDelivery\(svcDb,/g) || []).length, 3, 'all 3 CAS claims ride the svc-assigner handle');
assert.strictEqual((real.match(/await svcDb\.ref\(\)\.update\(/g) || []).length, 4, 'all 4 finalize/shift-open writes ride the svc-assigner handle');
assert.strictEqual((real.match(/await assertDriverCallerActive\(uid, request\.auth\?\.token,/g) || []).length, 4, 'all 4 driver callables call the hard-stop guard');
ok('wired: svc-assigner handle on 3 claims + 4 finalize/shift-open writes; the hard-stop on all 4 driver callables');

console.log(`\ns1a-wiring.guard: OK (${n})`);
