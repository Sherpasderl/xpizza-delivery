'use strict';
// S3 r1 has_pending (PLAN-5f-inicio-s3-pending-rebase-r0) — the wiring guard for tools/pending-module-inverse.js: every owned file minus
// the pending hunks === BASE byte-for-byte (non-vacuous); each hunk occurs exactly once (tamper / duplicate refused); the hunks are the
// current `git diff -U0 BASE` (a drifted hunk or a missed edit is refused); same-line everywhere except the fake's inserted getAll.
// Run: node pending-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyPendingModule } = require('./tools/pending-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (a) => execFileSync('git', a, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
const disk = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
assert.deepStrictEqual([...FILES].sort(), ['catalog/edit-catalog-handler.js', 'catalog/firestore-fake.js', 'catalog/publish-edited-handler.js', 'portal/ops-core.js', 'portal/ops-functions.js'], '🔴 PENDING: the owned files');
for (const f of FILES) {
  const src = disk(f), base = git(['show', `${BASE}:xpizza-functions/${f}`]);
  assert.notStrictEqual(src, base, `non-vacuity: ${f} differs from ${BASE}`);
  assert.strictEqual(unapplyPendingModule(f, src), base, `🔴 PENDING: ${f} minus the pending hunks is not ${BASE}:${f}`);
  if (f !== 'catalog/firestore-fake.js') assert.strictEqual(src.split('\n').length, base.split('\n').length, `🔴 PENDING: ${f} — same-line edits only (an older layer pins it)`);
}
ok(`${FILES.length} files minus ${HUNKS.length} hunks === ${BASE} byte-for-byte; same-line except the fake's getAll`);
for (const f of FILES) {
  const d = git(['diff', '-a', '-U0', BASE, '--', f]);
  const got = d.split(/\n(?=@@ )/).slice(1).map((h) => { const ls = h.split('\n').slice(1).filter((l) => l !== '\\ No newline at end of file'); return { now: ls.filter((l) => l[0] === '+').map((l) => l.slice(1) + '\n').join(''), was: ls.filter((l) => l[0] === '-').map((l) => l.slice(1) + '\n').join('') }; });
  assert.deepStrictEqual(HUNKS.filter((h) => h.file === f).map((h) => ({ now: h.now, was: h.was })), got, `🔴 PENDING: ${f}'s hunks are exactly the current diff vs ${BASE} (regenerate: D4c-grill/pending-r1/gen-pending-inverse.js)`);
}
ok('the hunks are exactly the current `git diff -U0 BASE` of each owned file, in diff order');
const h0 = HUNKS[0];
assert.throws(() => unapplyPendingModule(h0.file, disk(h0.file).replace(h0.now, '')), /occurs 0 times/, 'a removed hunk is refused');
assert.throws(() => unapplyPendingModule(h0.file, disk(h0.file) + h0.now), /occurs 2 times/, 'a duplicated hunk is refused');
assert.strictEqual(unapplyPendingModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
ok('tamper / duplicate refused; an unowned file passes through');
console.log(`\npending-wiring.guard: OK (${n})`);
