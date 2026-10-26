'use strict';
// TRACKER FIXES T8 (BUILD r1.5 §4) — the index.js inverse-fold guard for this slice. Run: node tracker-fixes-wiring.guard.test.js
//   (i)  unapplyTrackerFixesIndex(index.js) === 09fb9705:index.js BYTE-FOR-BYTE; a byte changed inside a hunk, outside every hunk,
//        and a duplicated hunk are each detected;
//   (ii) non-vacuity: the live index.js differs from 09fb9705, every hunk is present exactly once, and the hunks carry the flag
//        decision, the recompute trigger exports and the ingest fence.
// Base = the train tip 09fb9705 (train/next-after-e8e77e24: main e8e77e24 + the unassign endpoint et al.) the slice restacked onto.
// This slice is the newest layer, so its inverse is applied INNERMOST in every index.js fold consumer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyTrackerFixesIndex, INDEX_HUNKS } = require('./tools/tracker-fixes-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8'))))))));   // DISPATCH-LITE PUSH (newest), BRAND-AGNOSTIC SERVER, then RELEASE RACE reversed first
const BASE = execFileSync('git', ['show', '09fb9705:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.strictEqual(unapplyTrackerFixesIndex(idx), BASE, '🔴 index.js minus the tracker-fixes hunks is not 09fb9705:index.js');
{
  const inHunk = idx.replace('exports.trackerOnOrderStatus = onValueWritten(', 'exports.trackerOnOrderStatuS = onValueWritten(');
  assert.notStrictEqual(inHunk, idx);
  let detected; try { detected = unapplyTrackerFixesIndex(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.cancelPaidOrder = onRequest(', 'exports.cancelPaidOrder = onRequest( ');
  assert.notStrictEqual(outside, idx);
  assert.notStrictEqual(unapplyTrackerFixesIndex(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyTrackerFixesIndex(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyTrackerFixesIndex(index.js) === 09fb9705:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes detected`);

assert.notStrictEqual(idx, BASE, '🔴 the live index.js equals 09fb9705 — the tracker-fixes slice is MISSING');
for (const [now] of INDEX_HUNKS) assert.strictEqual(idx.split(now).length - 1, 1, `hunk present once: ${JSON.stringify(now.slice(0, 60))}`);
const all = INDEX_HUNKS.map(([now]) => now).join('\n');
for (const must of ['trackerFixesEnabled(db)', 'exports.trackerOnOrderStatus', 'exports.trackerOnDriverShiftId', 'makeIngestUpdater({', "trackerHold('ingest:commit'"]) assert.ok(all.includes(must), `the hunks carry ${must}`);
ok('PROOF (ii): the live index.js differs from 09fb9705; every hunk is present once and they carry the flag decision, the recompute exports, the ingest fence and its holds');
console.log(`tracker-fixes-wiring.guard: OK (${n} cases)`);
