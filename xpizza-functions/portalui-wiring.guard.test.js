'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6) — index.js wiring guard.
//   1. PROOF: tools/portalui-inverse.js turns index.js back into the slice base BYTE-FOR-BYTE (each hunk exactly once); a byte
//      inside / outside a hunk, a duplicated and a missing hunk are each detected; non-vacuity (the slice is present).
//   2. SAME-LINE: index.js has exactly as many lines as the base (no R3 call-site line shifts), and exactly the two hunk lines
//      differ.
//   3. The fold variant: unapplyPortalUiFold(foldPortalSplit()) strips the re-export (foldPortalSplit consumes the top hunk).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { HUNKS, BASE, unapplyPortalUiIndex, unapplyPortalUiFold } = require('./tools/portalui-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const real = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const baseIdx = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. the inverse ──
assert.strictEqual(unapplyPortalUiIndex(real), baseIdx, `🔴 index.js minus the portal-ui hunks is not ${BASE}:index.js`);
assert.notStrictEqual(real, baseIdx, 'non-vacuity: the slice is present');
assert.strictEqual(HUNKS.length, 2);
for (const h of HUNKS) {
  assert.strictEqual(h.file, 'index.js');
  assert.ok(real.includes(h.now), 'non-vacuity: each hunk is present');
  const inside = real.replace(h.now, h.now.replace('portal/ops-functions', 'portal/ops-functionz'));
  assert.notStrictEqual(inside, real, 'premise');
  assert.throws(() => unapplyPortalUiIndex(inside), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyPortalUiIndex(real + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.throws(() => unapplyPortalUiIndex(real.replace(h.now, '')), /occurs 0 times/, 'a missing hunk');
}
{
  const outside = real.replace('exports.quoteOrder = onRequest(', 'exports.quoteOrder  = onRequest(');
  assert.notStrictEqual(outside, real, 'premise');
  assert.notStrictEqual(unapplyPortalUiIndex(outside), baseIdx, 'a byte OUTSIDE every hunk survives and fails the base pin');
}
ok(`PROOF: unapplyPortalUiIndex(index.js) === ${BASE}:index.js byte-for-byte (${HUNKS.length} hunks, each once); inside / outside / duplicated / missing each detected`);

// ── 2. same-line hunks ──
const rl = real.split('\n'), bl = baseIdx.split('\n');
assert.strictEqual(rl.length, bl.length, '🔴 index.js gained or lost a line — the hunks must be SAME-LINE (R3 binds call sites by line)');
const differing = rl.map((l, i) => (l === bl[i] ? null : i)).filter((i) => i !== null);
assert.deepStrictEqual(differing.map((i) => `${rl[i]}\n`), HUNKS.map((h) => h.now), 'exactly the two hunk lines differ, in order');
assert.ok(HUNKS[0].now.includes("PORTAL_OPS_TARGETS.has(process.env.FUNCTION_TARGET)") && HUNKS[0].now.includes("module.exports = require('./portal/ops-functions'); return;"),
  'hunk 1 is the ops early branch');
for (const n of ['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability']) {
  assert.ok(HUNKS[1].now.includes(`exports.${n} = require('./portal/ops-functions').${n};`), `hunk 2 re-exports ${n} (the static form source discovery reads)`);
}
ok(`SAME-LINE: index.js has the base's ${bl.length} lines; exactly lines ${differing.map((i) => i + 1).join(' and ')} differ (the two hunks)`);

// ── 3. the fold variant ──
const { foldPortalSplit } = require('./tools/portal-split');
const fold = foldPortalSplit();
assert.ok(!fold.includes('PORTAL_OPS_TARGETS'), 'foldPortalSplit drops the early-branch region (with the ops branch in it)');
assert.ok(fold.includes(HUNKS[1].now), 'premise: the re-export hunk survives the portal fold');
const folded = unapplyPortalUiFold(fold);
assert.ok(!folded.includes('portal/ops-functions'), 'unapplyPortalUiFold removes the re-export');
assert.throws(() => unapplyPortalUiFold(folded), /occurs 0 times/, 'applying it twice fails (each hunk exactly once)');
ok('FOLD: unapplyPortalUiFold(foldPortalSplit()) leaves no portal-ui byte; the ops branch is consumed by the portal fold');

console.log(`\nportalui-wiring.guard: OK (${n})`);
