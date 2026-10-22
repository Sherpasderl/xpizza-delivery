'use strict';
// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §5, codex plan r1 P2-4) — the H1 merchant server and the handheld app
// are NOT changed by this slice: the TRACKED path set of xpizza-functions/merchant and xpizza-handheld, and every file's bytes,
// equal the approved stack tip. An added, deleted or edited file all fail. Run: node portal/slice2-untouched.guard.test.js
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

// train/next-after-2920b705: slice 2 was approved on ea8d9727; in the train it merges onto 6d0dd582 (origin/main 2920b705 + membership
// + portal-ui + T-b/T-c/T-d, which DO touch merchant/), so the untouched pin is the train parent it merged onto.
const BASE = '6d0dd582';
const REPO = path.join(__dirname, '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
const ls = (ref, dir) => (ref ? git('ls-tree', '-r', '--name-only', ref, '--', dir) : git('ls-files', '--', dir)).split('\n').filter(Boolean).sort();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const dir of ['xpizza-functions/merchant', 'xpizza-handheld']) {
  const was = ls(BASE, dir);
  const now = ls(null, dir);
  assert.ok(was.length > 5, `non-vacuity: ${dir} has files at ${BASE} (${was.length})`);
  assert.deepStrictEqual(now, was, `🔴 ${dir}: the tracked file set changed since ${BASE}`);
  const changed = git('diff', '--name-only', BASE, '--', dir).split('\n').filter(Boolean);
  const dirty = git('diff', '--name-only', '--', dir).split('\n').filter(Boolean);
  assert.deepStrictEqual([...changed, ...dirty], [], `🔴 ${dir}: files differ from ${BASE}: ${[...changed, ...dirty].join(', ')}`);
  ok(`${dir}: the same ${was.length} tracked files as ${BASE}, byte-identical (committed and working tree)`);
}
console.log(`\nslice2-untouched.guard: OK (${n})`);
