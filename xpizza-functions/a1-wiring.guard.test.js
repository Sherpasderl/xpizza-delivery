'use strict';
// PLAN-A A-1 (A8a step 1: text-version provenance readers, the write mode hard-wired legacy) — wiring guard.
// Run: node a1-wiring.guard.test.js
//   1. PROOF: tools/a1-inverse.js turns index.js and each pinned module it edits (createorder-classify.js,
//      rewards-redeem-intake.js) back into the base BYTE-FOR-BYTE. A byte inside a hunk, a duplicated hunk and a byte outside
//      every hunk are each detected.
//   2. WRITE MODE: A-1 has NO flag reader — TV.WRITE_MODE is 'legacy', and no code path derives a write mode from a flag.
//   3. NO WRITER CAN PRODUCE A MALFORMED MARKER (advisor Q2): the only writes of the order marker / reservation marker go
//      through TV.markerFields (presence of exactly 'a8', or nothing); no other source writes either field.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyA1Index, unapplyA1Module, HUNKS, FILES, BASE } = require('./tools/a1-inverse');
const { unapplyS1bIndex } = require('./tools/s1b-inverse');   // S1b restacks ON TOP of A-1 (S1b innermost) — strip it first
const TV = require('./catalog/text-version');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1. the inverse ──
{
  const idx = require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(require('./tools/wahealth-inverse').unapplyWaHealthIndex(require('./tools/formsignal-inverse').unapplyFormSignalIndex(read('index.js')))))))))))))))))));   // H1a (newest), then PLAN-S5, are reversed FIRST
  // S1b restacks on top of A-1 (S1b innermost): strip the S1b blocks first to reach the A-1 index.js layer,
  // then verify a1-inverse turns THAT into the base byte-for-byte (both inverses proven byte-exact in s1b-wiring).
  const a1layer = unapplyS1bIndex(idx);
  assert.notStrictEqual(unapplyA1Index(a1layer), a1layer, 'non-vacuity: the A-1 layer carries a1 hunks');
  assert.strictEqual(unapplyA1Index(a1layer), baseOf('index.js'), `🔴 index.js minus the S1b blocks and a1 hunks is not ${BASE}:index.js`);
  const hi = HUNKS.find((h) => h.file === 'index.js' && /TV\./.test(h.now));
  assert.throws(() => unapplyA1Index(a1layer.replace(hi.now, hi.now.replace('TV.', 'TVx.'))), /occurs 0 times/, 'index.js: a byte INSIDE a hunk');
  assert.throws(() => unapplyA1Index(a1layer + hi.now), /occurs 2 times/, 'index.js: a duplicated hunk');
  assert.notStrictEqual(unapplyA1Index('\n' + a1layer), baseOf('index.js'), 'index.js: a byte OUTSIDE every hunk');
  assert.deepStrictEqual([...FILES].sort(), ['createorder-classify.js', 'rewards-redeem-intake.js']);
  for (const f of FILES) {
    const src = read(f);
    assert.notStrictEqual(unapplyA1Module(f, src), src, `non-vacuity: ${f} carries a1 hunks`);
    assert.strictEqual(unapplyA1Module(f, src), baseOf(f), `🔴 ${f} minus the a1 hunks is not ${BASE}:${f}`);
    const h = HUNKS.find((x) => x.file === f && /a8|TV/.test(x.now));
    assert.ok(h, `${f}: a hunk mentions the a8 candidate`);
    assert.throws(() => unapplyA1Module(f, src.replace(h.now, h.now.replace(/a8|TV/, (m) => `${m}x`))), /occurs 0 times/, `${f}: a byte INSIDE a hunk`);
    assert.throws(() => unapplyA1Module(f, src + h.now), /occurs 2 times/, `${f}: a duplicated hunk`);
    assert.notStrictEqual(unapplyA1Module(f, '\n' + src), baseOf(f), `${f}: a byte OUTSIDE every hunk`);
  }
  ok(`inverse: unapplyA1Index / unapplyA1Module → ${BASE} byte-for-byte (${HUNKS.length} hunks over index.js + ${FILES.join(', ')}); inside / duplicate / outside each caught`);
}

// ── 2. the write mode is hard-wired legacy (no flag reader in A-1) ──
{
  assert.strictEqual(TV.WRITE_MODE, 'legacy');
  const idx = read('index.js');
  assert.ok(!/a8_untruncated/.test(idx) && !/a8_untruncated/.test(read('catalog/text-version.js')), 'no A-4 flag is read in A-1');
  const modes = (idx.match(/writeMode: [^,}\n]+/g) || []).map((m) => m.trim());
  assert.ok(modes.length >= 2 && modes.every((m) => m === 'writeMode: TV.WRITE_MODE'), `every write mode passed is TV.WRITE_MODE (${modes})`);
  ok("the write mode is TV.WRITE_MODE = 'legacy' everywhere it is passed; no flag (a8_untruncated) is read in A-1");
}

// ── 3. no writer can produce a malformed marker ──
{
  const files = ['index.js', 'create-order-build.js', 'pixelpay-hosted-charge.js', 'pixelpay-charge.js', 'rewards-reserve.js', 'rewards-redeem-intake.js',
    'materialize.js', 'claim-order.js', 'pixelpay-confirm.js', 'resolve-manual.js', 'cancel-order-core.js', 'scheduled-release-core.js', 'catalog/canonical-binding.js'];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // code only, not comments
    // the literal field names are never assigned directly — only TV.markerFields / TV constants carry them
    assert.ok(!/payment_fingerprint_text_version\s*[:=]/.test(src), `🔴 ${f} assigns payment_fingerprint_text_version directly`);
    assert.ok(!/(^|[^.\w])text_version\s*:/.test(src), `🔴 ${f} assigns text_version directly`);
  }
  assert.deepStrictEqual(TV.markerFields(TV.TEXT_A8), { payment_fingerprint_text_version: 'a8' });
  assert.deepStrictEqual(TV.markerFields(TV.TEXT_LEGACY), {});
  assert.deepStrictEqual(TV.markerFields(undefined), {});
  assert.deepStrictEqual(TV.markerFields('anything-else'), {}, 'any other version writes NOTHING (never a malformed value)');
  assert.deepStrictEqual(TV.markerFields(TV.TEXT_A8, TV.RESERVATION_FIELD), { text_version: 'a8' });
  ok("no writer assigns either marker directly; TV.markerFields writes exactly 'a8' or nothing — no existing writer can produce a malformed marker");
}

console.log(`\na1-wiring.guard: OK (${n})`);
