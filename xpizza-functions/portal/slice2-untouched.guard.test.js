'use strict';
// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §5, codex plan r1 P2-4) — the H1 merchant server and the handheld app
// are NOT changed by this slice. Proven over the slice's OWN commit range, never the live tree: a later slice that legitimately
// edits merchant/ or xpizza-handheld/ is not slice 2's change (a live-tree pin went falsely red on O1a — advisor ruling 2026-10-21).
//   RANGE: 6d0dd582 (the train parent slice 2 merged onto: origin/main 2920b705 + membership + portal-ui + T-b/T-c/T-d)
//      → f3fd0695 ("Merge commit '69718530' (portal-ui slice 2 Equipos, + 1cfaa6f2 auth emulator) into train/next-after-2920b705",
//        slice 2's final commit on the train; first parent 6d0dd582).
// Fails closed: both SHAs must resolve, BASE must be an ancestor of TIP, and git must answer. Run: node portal/slice2-untouched.guard.test.js
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = '6d0dd582';
const TIP = 'f3fd0695';
const REPO = path.join(__dirname, '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const sha of [BASE, TIP]) {
  let t = '';
  try { t = git('cat-file', '-t', sha).trim(); } catch (e) { assert.fail(`🔴 ${sha} does not resolve (or git is unavailable): ${e.message}`); }
  assert.strictEqual(t, 'commit', `🔴 ${sha} is not a commit`);
}
let ancestor = false;
try { git('merge-base', '--is-ancestor', BASE, TIP); ancestor = true; } catch (_) { ancestor = false; }
assert.ok(ancestor, `🔴 ${BASE} is not an ancestor of ${TIP} — not slice 2's range`);
ok(`${BASE} and ${TIP} are commits; ${BASE} is an ancestor of ${TIP}`);

for (const dir of ['xpizza-functions/merchant', 'xpizza-handheld']) {
  assert.ok(git('ls-tree', '-r', '--name-only', BASE, '--', dir).split('\n').filter(Boolean).length > 5, `non-vacuity: ${dir} has files at ${BASE}`);
  const changed = git('diff', '--name-only', BASE, TIP, '--', dir).split('\n').filter(Boolean);
  assert.deepStrictEqual(changed, [], `🔴 ${dir}: slice 2 (${BASE}..${TIP}) changed ${changed.join(', ')}`);
  ok(`${dir}: slice 2's range ${BASE}..${TIP} changes no file (added, deleted or edited)`);
}
console.log(`\nslice2-untouched.guard: OK (${n})`);
