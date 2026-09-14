'use strict';
// ---------------------------------------------------------------------------
// 🔴 EVERY MUTANT MUST ANCHOR LIVE CODE — CHECKED FOR ALL OF THEM, EVERY RUN.
//
// The sweep reports ANCHOR MISSING only for the slice being swept, so a mutant in a slice nobody is
// running is never checked and can sit there testing nothing indefinitely while the slices that DO run
// look perfect. Not hypothetical: task8-13 was found stale here, and `git log` puts the commit that
// moved its code at 1B Task 6 — several tasks of green sweeps, none of which could have noticed.
//
// 🔴 AND IT MUST NOT RUN INSIDE A SWEEP. While a mutant is applied its anchor is deliberately absent,
// so this guard fails — and under the default `npm test` command the sweep reads that nonzero exit as
// "the suite caught it". 101 mutants would have been scored KILLED by this file rather than by any
// behavioural test, which is worse than having no guard at all: a fake kill is indistinguishable from
// a real one in the output. The sweep sets MUTATION_SWEEP and verifies every anchor itself against the
// PRISTINE tree before applying anything, so skipping here loses no coverage.
//
// EXACTLY ONE occurrence, not "at least one": an anchor matching twice mutates whichever copy comes
// first, which is a different mutant from the one the label describes.
// ---------------------------------------------------------------------------
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const MUTANTS = require('./mutation-sweep.mutants.json');

// THE REAL CHECK, as a function, so the probes below exercise THIS code rather than a restatement of
// it. An earlier version asserted against a counter defined beside the probes — which proves the probe
// can count, and says nothing about whether the guard can.
function staleAnchors(mutants, readFile) {
  const cache = new Map();
  const out = [];
  for (const m of mutants) {
    if (!cache.has(m.file)) cache.set(m.file, readFile(m.file));
    const n = cache.get(m.file).split(m.from).length - 1;
    if (n !== 1) out.push(`${m.id} (${m.slice}) anchors ${n}x in ${m.file} — ${m.label}`);
  }
  return out;
}

if (process.env.MUTATION_SWEEP) {
  console.log('mutation anchors: SKIPPED — a sweep owns this tree and its anchors are deliberately absent');
  process.exit(0);
}

const stale = staleAnchors(MUTANTS, (f) => readFileSync(join(ROOT, f), 'utf8'));
assert.deepStrictEqual(stale, [],
  `🔴 ${stale.length} mutant(s) no longer anchor live code — re-point before trusting any sweep count`);

/* NON-VACUITY, THROUGH THE REAL FUNCTION. A check that is only ever compared against zero is the
   easiest thing in the world to write backwards, so staleAnchors is run over synthetic catalogues whose
   answers are known — one of each outcome it is supposed to distinguish. */
{
  const file = (text) => () => text;
  const mut = (from) => [{ id: 'probe', slice: 'probe', file: 'f.js', from, label: 'probe' }];

  assert.strictEqual(staleAnchors(mut('const z = 3;'), file('const x = 1;')).length, 1,
    'non-vacuity: the guard reports an anchor that matches 0 times');
  assert.strictEqual(staleAnchors(mut('const y = 2;'), file('const x = 1;\nconst y = 2;\n')).length, 0,
    'non-vacuity: the guard passes an anchor that matches exactly once');
  assert.strictEqual(staleAnchors(mut('const x = 1;'), file('const x = 1;\nconst x = 1;\n')).length, 1,
    'non-vacuity: the guard reports an anchor that matches 2 times — ambiguous, not "good enough"');
  // …and the reported line names the mutant, so a failure is actionable rather than a bare count.
  assert.match(staleAnchors(mut('nope'), file('x'))[0], /probe \(probe\) anchors 0x in f\.js/,
    'non-vacuity: the report names the mutant, its slice and its file');
}

assert.ok(MUTANTS.length > 200, `non-vacuity: the mutant catalogue is populated (${MUTANTS.length})`);
console.log(`mutation anchors: OK (${MUTANTS.length} mutants, all anchoring live code exactly once)`);
