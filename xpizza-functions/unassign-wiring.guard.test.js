'use strict';
// UNASSIGN (PLAN-unassign-prepickup r1.2) — the index.js inverse-fold guard for this slice. Run: node unassign-wiring.guard.test.js
//   (i)  unapplyUnassignIndex(index.js) === e8e77e24:index.js BYTE-FOR-BYTE (needs git history), with sensitivity: a byte changed
//        inside a hunk, a byte changed outside every hunk, and a duplicated hunk are each detected.
//   (ii) non-vacuity: the live index.js differs from e8e77e24 and both hunks are present.
// This slice is the newest, so its inverse is applied INNERMOST (first) in every downstream index.js fold consumer.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyUnassignIndex, INDEX_HUNKS } = require('./tools/unassign-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))))))));   // TRACKER FIXES landed on top of UNASSIGN (train 09fb9705): its inverse is reversed first
const BASE = execFileSync('git', ['show', 'e8e77e24:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

assert.strictEqual(unapplyUnassignIndex(idx), BASE, '🔴 index.js minus the unassign hunks is not e8e77e24:index.js — something beyond the stated seams changed');
assert.strictEqual(INDEX_HUNKS.length, 2, 'exactly two index.js hunks (the auth sibling + wrapper, the unassignOrder adapter)');
{
  const inHunk = idx.replace("byKind: 'recon_secret' }", "byKind: 'recon_secreT' }");
  assert.notStrictEqual(inHunk, idx, 'the inside-hunk mutation actually changed the source');
  let detected; try { detected = unapplyUnassignIndex(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  const outside = idx.replace('exports.cancelPaidOrder = onRequest(', 'exports.cancelPaidOrder = onRequest( ');
  assert.notStrictEqual(outside, idx, 'the outside-hunk mutation actually changed the source');
  assert.notStrictEqual(unapplyUnassignIndex(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  assert.throws(() => unapplyUnassignIndex(idx + INDEX_HUNKS[1][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyUnassignIndex(index.js) === e8e77e24:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes each detected`);

assert.notStrictEqual(idx, BASE, '🔴 the live index.js already equals e8e77e24 — the unassign slice is MISSING; the inverse would be a no-op');
for (const [cand] of INDEX_HUNKS) assert.strictEqual(idx.split(cand).length - 1, 1, `each hunk candidate is present exactly once: ${JSON.stringify(cand.slice(0, 60))}`);
assert.ok(INDEX_HUNKS.some(([c]) => c.includes('exports.unassignOrder = onRequest(')) && INDEX_HUNKS.some(([c]) => c.includes('async function authorizeDispatcherActionWithUid(req)')), 'the hunks are the endpoint and the auth sibling');
ok('PROOF (ii): the live index.js differs from e8e77e24 and both hunks (endpoint + auth sibling) are present — the inverse is not a no-op');

console.log(`unassign-wiring.guard: OK (${n} cases)`);
