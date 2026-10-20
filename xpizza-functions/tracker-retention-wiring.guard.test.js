'use strict';
// TRACKER FIXES T6 — the retention-sweep.js module-inverse guard. Run: node tracker-retention-wiring.guard.test.js
//   (i)  unapplyTrackerRetention(retention-sweep.js) === e8e77e24:retention-sweep.js BYTE-FOR-BYTE; a byte changed inside a hunk,
//        outside every hunk, and a duplicated hunk are each detected.
//   (ii) non-vacuity: the live file differs from the base and every hunk is present exactly once.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyTrackerRetention, HUNKS } = require('./tools/tracker-retention-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const live = fs.readFileSync(path.join(__dirname, 'retention-sweep.js'), 'utf8');
const BASE = execFileSync('git', ['show', 'e8e77e24:xpizza-functions/retention-sweep.js'], { cwd: __dirname, encoding: 'utf8' });

assert.strictEqual(unapplyTrackerRetention(live), BASE, '🔴 retention-sweep.js minus the T6 hunks is not e8e77e24:retention-sweep.js');
{
  const inHunk = live.replace("require('./tracking/tombstones')", "require('./tracking/tombstoneS')");
  assert.notStrictEqual(inHunk, live);
  let detected; try { detected = unapplyTrackerRetention(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = live.replace("const { tasksToDelete, confirmTaskDelete } = require('./tasks-retention');", "const { tasksToDelete, confirmTaskDelete } = require('./tasks-retention'); ");
  assert.notStrictEqual(outside, live);
  assert.notStrictEqual(unapplyTrackerRetention(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyTrackerRetention(live + HUNKS[HUNKS.length - 1][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyTrackerRetention(retention-sweep.js) === e8e77e24 byte-for-byte (${HUNKS.length} hunks); inside / outside / duplicated changes detected`);
assert.notStrictEqual(live, BASE, '🔴 retention-sweep.js equals the base — the T6 call site is MISSING');
for (const [c] of HUNKS) assert.strictEqual(live.split(c).length - 1, 1);
assert.ok(HUNKS.some(([c]) => c.includes("require('./tracking/tombstones').sweepTrackerTombstones(db, Date.now())")), 'the call-site hunk is the tombstone sweep');
ok('PROOF (ii): the live file differs from the base and every hunk (incl. the tombstone call site) is present once');
console.log(`tracker-retention-wiring.guard: OK (${n} cases)`);
