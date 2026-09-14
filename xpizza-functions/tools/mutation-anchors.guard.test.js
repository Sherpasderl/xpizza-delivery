'use strict';
// ---------------------------------------------------------------------------
// 🔴 EVERY MUTANT MUST ANCHOR LIVE CODE — CHECKED FOR ALL OF THEM, EVERY RUN.
//
// The sweep already reports ANCHOR MISSING, but only for the slice being swept. A mutant in a slice
// nobody is running is never checked at all, so it can sit there testing nothing indefinitely while
// the counts of the slices that DO run look perfect. That is not hypothetical: task8-13 was found
// stale here, and `git log` puts the commit that moved its code at 1B Task 6 — several tasks of green
// sweeps, none of which could have noticed, because the task8 slice was not in the b4–b8 rotation.
//
// Rewriting a function silently disarms every mutant pointed at it, and the harness only says so
// afterwards, on a run that may not happen for weeks. This check moves that discovery to `npm test`.
//
// EXACTLY ONE occurrence, not "at least one": an anchor that matches twice mutates whichever copy
// comes first, which is a different mutant from the one the label describes.
// ---------------------------------------------------------------------------
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const MUTANTS = require('./mutation-sweep.mutants.json');

const cache = new Map();
const read = (f) => {
  if (!cache.has(f)) cache.set(f, readFileSync(join(ROOT, f), 'utf8'));
  return cache.get(f);
};

const stale = [];
for (const m of MUTANTS) {
  const n = read(m.file).split(m.from).length - 1;
  if (n !== 1) stale.push(`${m.id} (${m.slice}) anchors ${n}x in ${m.file} — ${m.label}`);
}
assert.deepStrictEqual(stale, [],
  `🔴 ${stale.length} mutant(s) no longer anchor live code — re-point before trusting any sweep count`);

// NON-VACUITY: the detector must actually be able to see a stale anchor, or this file is a green light
// that means nothing. A count that is only ever compared to zero is the easiest check in the world to
// write backwards.
{
  const probe = 'const x = 1;\nconst y = 2;\nconst x = 1;\n';
  const count = (hay, needle) => hay.split(needle).length - 1;
  assert.strictEqual(count(probe, 'const z'), 0, 'non-vacuity: an absent anchor counts 0');
  assert.strictEqual(count(probe, 'const y'), 1, 'non-vacuity: a unique anchor counts 1');
  assert.strictEqual(count(probe, 'const x'), 2, 'non-vacuity: a duplicated anchor counts 2 and would fail');
}

// And the catalogue itself must not be empty or unreadable — a guard over nothing passes trivially.
assert.ok(MUTANTS.length > 200, `non-vacuity: the mutant catalogue is populated (${MUTANTS.length})`);
console.log(`mutation anchors: OK (${MUTANTS.length} mutants, all anchoring live code exactly once)`);
