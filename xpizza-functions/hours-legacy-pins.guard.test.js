'use strict';
// S4 C′ G1 (PLAN-capp-S4-r5 §1 + r5.1 BC-2) — the legacy hours readers/parsers L1-L12 stay BYTE-IDENTICAL (Ruling A): each
// pinned region's literal start/end anchors occur exactly once and its sha256 matches tools/hours-legacy-pins.json.
// Only HOURS-ONE-SOURCE may REMOVE a record (when it migrates that consumer); a record is never re-hashed in place.
// Run: node hours-legacy-pins.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('./tools/hours-legacy-pins');
const RECS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools', 'hours-legacy-pins.json'), 'utf8'));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const families = new Set(RECS.map((r) => r.family));
for (let i = 1; i <= 12; i++) assert.ok(families.has(`L${i}`), `G1-COVERAGE: family L${i} has at least one pin record`);
assert.strictEqual(new Set(RECS.filter((r) => r.family === 'L10').map((r) => r.file)).size, 2, 'G1-L10-TWO-FILES (brand store + brand projection)');
assert.ok(RECS.filter((r) => r.family === 'L6').length >= 3, 'G1-L6-FULL-FAMILY (default table, getHoursStatus, converter)');
assert.ok(RECS.every((r) => r.inclusive === true && /^[0-9a-f]{64}$/.test(r.sha256)));
ok(`COVERAGE: ${RECS.length} records over L1-L12 (L6 full family; L10 across brand-store + brand-projection)`);

const bad = P.check(RECS);
assert.deepStrictEqual(bad, [], `🔴 legacy hours region changed:\n${bad.join('\n')}`);
ok('every pinned region: anchors unique and sha256 unchanged');

// MUTANTS (in memory; each must be detected): an in-place edit inside L4, a duplicated start anchor, a removed end anchor.
{
  const rec = RECS.find((r) => r.id === 'L4-release');
  const src = fs.readFileSync(path.join(__dirname, rec.file), 'utf8');
  const mut = src.replace(".once('value')).val() || null;", ".once('value')).val() || {};");
  assert.notStrictEqual(mut, src, 'premise: the L4 mutation applies');
  // L4's region is two lines and both are anchors, so an in-place edit surfaces as a missing anchor (or, for a region edit
  // between anchors, a sha256 mismatch) — either way the guard fails.
  let detected = false;
  try { detected = P.sha(P.region(mut, rec.start_anchor, rec.end_anchor)) !== rec.sha256; } catch (e) { detected = /anchor occurs 0×/.test(e.message); }
  assert.ok(detected, 'G1-MUT-L4: the in-place L4 edit is detected');
  {   // a region-interior edit (L8: a line strictly between its anchors) → sha256 mismatch
    const r8 = RECS.find((r) => r.id === 'L8-grace');
    const s8 = fs.readFileSync(path.join(__dirname, r8.file), 'utf8');
    const m8 = s8.replace("catch (_) { return false; }   // config outage", "catch (_) { return true; }   // config outage");
    assert.notStrictEqual(m8, s8, 'premise: the L8 interior mutation applies');
    assert.notStrictEqual(P.sha(P.region(m8, r8.start_anchor, r8.end_anchor)), r8.sha256, 'G1-MUT-L8: "L8 region sha256 mismatch"');
  }
  assert.throws(() => P.region(src + '\n' + rec.start_anchor + '\n', rec.start_anchor, rec.end_anchor), /start anchor occurs 2×/, 'G1-MUT-DUP-ANCHOR');
  assert.throws(() => P.region(src.replace(rec.end_anchor + '\n', ''), rec.start_anchor, rec.end_anchor), /end anchor occurs 0×/, 'G1-MUT-MISSING-ANCHOR');
  ok('MUTANTS: an in-place L4 edit (|| null → || {}), an L8 interior edit (sha256 mismatch), a duplicated anchor and a removed anchor are each detected');
}
console.log(`\nhours-legacy-pins.guard: OK (${n})`);
