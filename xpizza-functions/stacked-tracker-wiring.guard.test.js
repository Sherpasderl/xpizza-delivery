'use strict';
// STACKED-TRACKER — the index.js inverse-fold guard for this slice. Run: node stacked-tracker-wiring.guard.test.js
//   (i)  unapplyStackedTracker(index.js) === ebc8564:index.js BYTE-FOR-BYTE (needs git history — any worktree of
//        this repo has it), with sensitivity: a byte changed inside a hunk, a byte changed outside every hunk,
//        and a duplicated hunk are each detected.
//   (ii) the inverse is NOT a no-op: the live index.js genuinely differs from ebc8564 (the slice is present), so
//        dropping this inverse from a composed chain would surface as a RED fold — never a silent pass.
// The downstream integration fold (this inverse applied FIRST — the slice landed on top of PB-2 @ ebc8564 — then
// add-product B's inverse, then A's, then D4-c4/D4-c5 → e1aeb3f / bb37684) is proven by order-control-wiring,
// addproduct-wiring, addproduct-b-wiring, portal/portal-split and catalog/identity-record-guards.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyStackedTracker, INDEX_HUNKS } = require('./tools/stacked-tracker-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// D4-c2b landed on top of this slice (main 2cb5a1c): its one delimited block (tools/d4c2b-inverse.js) is reversed FIRST.
// D12b landed on top of D4-c2b: its ONE delimited, byte-pinned index.js block (tools/d12b-inverse.js unapplyD12bIndex) is reversed
// after the WhatsApp-cancel block (tools/wacancel-inverse.js unapplyWaCancelIndex), which is reversed after the per-product extras blocks
// (tools/extras-inverse.js unapplyExtrasIndex — the newest, reversed FIRST).
const idx = require('./tools/d4c2b-inverse').unapplyD4c2b(require('./tools/d12b-inverse').unapplyD12bIndex(require('./tools/wacancel-inverse').unapplyWaCancelIndex(require('./tools/extras-inverse').unapplyExtrasIndex(require('./tools/serial3-inverse').unapplySerial3Index(require('./tools/h0-inverse').unapplyH0Index(require('./tools/s1a-inverse').unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(read('index.js'))))))))))));
const BASE = execFileSync('git', ['show', 'ebc8564:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// ── (i) proof: the fold reconstructs the baseline ──
assert.strictEqual(unapplyStackedTracker(idx), BASE,
  '🔴 index.js minus the stacked-tracker hunks is not ebc8564:index.js — something beyond the stated seams changed');
assert.strictEqual(INDEX_HUNKS.length, 2, 'exactly two index.js hunks (the require + the OFD stacked-waiting block)');
{
  // a byte changed INSIDE a hunk is detected (break the require-line hunk)
  const inHunk = idx.replace('shouldMarkStackedWaiting, stackedWaitingTxn', 'shouldMarkStackedWaiting, stackedWaitingTxN');
  assert.notStrictEqual(inHunk, idx, 'the inside-hunk mutation actually changed the source');
  let detected; try { detected = unapplyStackedTracker(inHunk) !== BASE; } catch (_) { detected = true; }
  assert.ok(detected, 'a byte changed INSIDE a hunk is detected');
  // a byte changed OUTSIDE every hunk is detected (whitespace on the trigger declaration)
  const outside = idx.replace('exports.sendOrderStatusNotifications = onValueWritten(', 'exports.sendOrderStatusNotifications = onValueWritten( ');
  assert.notStrictEqual(outside, idx, 'the outside-hunk mutation actually changed the source');
  assert.notStrictEqual(unapplyStackedTracker(outside), BASE, 'a byte changed OUTSIDE every hunk is detected');
  // a duplicated hunk is refused
  assert.throws(() => unapplyStackedTracker(idx + INDEX_HUNKS[0][0]), /occurs 2×/, 'a duplicated hunk is refused');
}
ok(`PROOF (i): unapplyStackedTracker(index.js) === ebc8564:index.js byte-for-byte (${INDEX_HUNKS.length} hunks); inside / outside / duplicated changes each detected`);

// ── (ii) non-vacuity: the inverse does real work ──
assert.notStrictEqual(idx, BASE,
  '🔴 the live index.js already equals ebc8564 — the stacked-tracker slice is MISSING; the inverse would be a no-op');
// and the two hunks are genuinely present in the live source (each exactly once)
for (const [cand] of INDEX_HUNKS) {
  assert.strictEqual(idx.split(cand).length - 1, 1, `each hunk candidate is present exactly once: ${JSON.stringify(cand.slice(0, 60))}`);
}
ok('PROOF (ii): the live index.js differs from ebc8564 and both hunks are present — the inverse is not a no-op');

console.log(`stacked-tracker-wiring.guard: OK (${n} cases)`);
