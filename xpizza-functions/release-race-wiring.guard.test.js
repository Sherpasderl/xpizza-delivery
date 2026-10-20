'use strict';
// RELEASE RACE (PLAN-release-race r2.1) — the index.js inverse-fold guard for this slice. Run: node release-race-wiring.guard.test.js
//   (i)  unapplyReleaseRaceIndex(index.js) === 32f6f17e:index.js BYTE-FOR-BYTE; a byte changed inside a hunk, outside every hunk,
//        and a duplicated hunk are each detected — so the ONLY index.js change is the healer's alert (the healer's writes unchanged);
//   (ii) non-vacuity: the live index.js differs from 32f6f17e and the hunks carry the require and the post-heal alert call.
// Base = the train tip 32f6f17e. This slice is the newest layer, so its inverse is applied INNERMOST in every fold consumer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyReleaseRaceIndex, INDEX_HUNKS } = require('./tools/release-race-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const BASE = execFileSync('git', ['show', '32f6f17e:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.strictEqual(unapplyReleaseRaceIndex(idx), BASE, '🔴 index.js minus the release-race hunks is not 32f6f17e:index.js');
{
  const inHunk = idx.replace('await alertAssignmentConflict(db, {', 'await alertAssignmentConflicT(db, {');
  assert.notStrictEqual(inHunk, idx);
  let detected; try { detected = unapplyReleaseRaceIndex(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.cancelPaidOrder = onRequest(', 'exports.cancelPaidOrder = onRequest( ');
  assert.notStrictEqual(outside, idx);
  assert.notStrictEqual(unapplyReleaseRaceIndex(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyReleaseRaceIndex(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyReleaseRaceIndex(index.js) === 32f6f17e:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes detected`);
assert.notStrictEqual(idx, BASE, '🔴 the live index.js equals 32f6f17e — the release-race slice is MISSING');
const all = INDEX_HUNKS.map(([now]) => now).join('\n');
for (const must of ["require('./assignment-conflict')", 'await alertAssignmentConflict(db, { orderId, deliveryDriverId: strandedDel, pickupDriverId: strandedPick, now });']) assert.ok(all.includes(must), `the hunks carry ${must}`);
ok('PROOF (ii): the live index.js differs from 32f6f17e; the hunks carry the require and the post-heal alert call (inside the committed-heal branch)');
console.log(`release-race-wiring.guard: OK (${n} cases)`);
