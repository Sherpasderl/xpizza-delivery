#!/usr/bin/env node
'use strict';
/* THE gate runner: run every test script in the repo, score each on its own exit code, and refuse to
 * be quietly incomplete.
 *
 * 🔴 WHY. The gate ran a hand-kept list of twelve emulator scripts out of forty-two. The other thirty
 * were not run by anyone, which is how four suites stayed red for an unknown period — one of them
 * sitting on a real money-path defect, and one masking twenty-one redemption-reserve assertions that
 * had not executed since the 1b-1b cutover. Nothing was wrong with the tree that a wider loop would
 * not have shown; the loop was the defect. So the list is ENUMERATED from package.json, never typed:
 * a suite added tomorrow is in the gate tomorrow, without anyone remembering to add it.
 *
 *   npm run test:gate               EVERYTHING: npm test + all 44 emulator scripts + test:portal
 *   npm run test:emulators:all      the emulator subset only (the slow part), by delegation
 *   npm run test:gate -- --list     just show what would run
 *
 * Exit is non-zero if ANY suite fails, if a KNOWN_RED suite is missing/renamed, or if a KNOWN_RED
 * suite PASSES — an allowlist entry that outlives its defect is how a gate rots back into a lie.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* A suite may only be excused with a REASON and a place to look. Silent absence is the failure mode
   this tool removes; a silent skip would reintroduce it one level up. These are not skipped — they
   RUN, and their failure is reported and excused. If one starts passing, this run fails until the
   entry is deleted, so the allowlist cannot outlive what it excuses. */
const KNOWN_RED = {
  'test:resolve-manual': 'REAL PRODUCTION DEFECT, reported to the advisor and deliberately unfixed: '
    + 'index.js resolveDeps omits voidOrRefund, releaseRewardHold, sendPaidAfterCloseRefund and '
    + 'getGraceMinutes, all used by holdIfClosedAtMaterialize (materialize-guard.js:81 calls '
    + 'voidOrRefund UNGUARDED). A dispatcher materialize of a paid order after close therefore never '
    + 'attempts the refund. Awaiting an owner decision on the intended end state; the suite is also '
    + 'stale against the refund contract and needs rewriting alongside the fix.',
};

/* 🔴 THE VERDICT IS A PURE FUNCTION so it can be tested without a forty-minute run. The three
   outcomes that matter — a plain failure, an excused one, and an EXCUSE THAT OUTLIVED ITS DEFECT —
   are exactly the logic a gate depends on, and "we ran it once and it looked right" is not evidence
   for a rule that decides whether the gate is red. tools/emulator-ports.guard.test.js drives all
   three plus the empty case. */
/* 🔴 A SUITE THAT ASSERTS NOTHING IS NOT A PASS. Success was taken from the exit status alone, so a
   suite that exited early, or whose output convention went unrecognised, reported green with 0 cells
   — the exact thing the cell column exists to make visible, sitting in the column and counting for
   nothing. Zero cells now FAILS unless it is allowlisted with a reason, the same rule as KNOWN_RED.
   The allowlist is empty today: every suite reports cells. */
const ZERO_CELL_OK = {};

function classify(results, knownRed, zeroCellOk = ZERO_CELL_OK) {
  const rows = results.map((r) => {
    const known = Object.prototype.hasOwnProperty.call(knownRed, r.name);
    if (r.ok && known) return { ...r, state: 'stale-excuse' };
    if (r.ok && r.cells === 0 && !Object.prototype.hasOwnProperty.call(zeroCellOk, r.name)) return { ...r, state: 'zero-cell' };
    if (r.ok) return { ...r, state: 'pass' };
    if (known) return { ...r, state: 'excused' };
    return { ...r, state: 'fail' };
  });
  const count = (st) => rows.filter((x) => x.state === st).length;
  const failed = count('fail'), excused = count('excused'), stale = count('stale-excuse'), zero = count('zero-cell');
  // Nothing measured is never a pass — the same rule the mutation sweep enforces.
  const exitCode = (!rows.length || failed || stale || zero) ? 1 : 0;
  return { rows, failed, excused, stale, zero, passed: count('pass'), exitCode };
}

module.exports = { classify, KNOWN_RED, ZERO_CELL_OK };
if (require.main !== module) return;

const EMULATORS_ONLY = process.argv.includes('--emulators');
/* The runner's own entry points are excluded, or it would invoke itself. Everything else that is a
   test script runs — including `test`, the in-process chain, which was previously a separate thing
   a person had to remember to run alongside this one. */
const SELF = new Set(['test:gate', 'test:emulators:all']);
const isEmulator = (v) => /emulator-run\.js/.test(v);

const scripts = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const all = Object.entries(pkg.scripts || {})
    .filter(([k, v]) => !SELF.has(k) && (k === 'test' || k.startsWith('test:')) && String(v).trim())
    .filter(([, v]) => (EMULATORS_ONLY ? isEmulator(v) : true))
    .map(([k]) => k);
  // `test` first when present: it is the fastest signal and the one most likely to be red.
  return all.sort((a, b) => (a === 'test' ? -1 : b === 'test' ? 1 : a.localeCompare(b)));
})();

if (process.argv.includes('--list')) {
  for (const s of scripts) console.log(`${s}${KNOWN_RED[s] ? '   [known-red]' : ''}`);
  console.log(`\n${scripts.length} ${EMULATORS_ONLY ? 'emulator' : 'test'} scripts`);
  process.exit(0);
}

if (!scripts.length) {
  // Same rule as the mutation sweep: a run that measured nothing is never a pass.
  console.error('gate-all: no test scripts found in package.json — nothing was measured.');
  process.exit(2);
}

for (const name of Object.keys(KNOWN_RED)) {
  if (!scripts.includes(name) && !EMULATORS_ONLY) {
    console.error(`gate-all: KNOWN_RED names "${name}", which is not a test script any more.`);
    console.error('   A stale excuse hides a suite nobody runs. Remove the entry or fix the name.');
    process.exit(2);
  }
}

const started = Date.now();
const results = [];
for (const name of scripts) {
  const t0 = Date.now();
  const r = spawnSync('npm', ['run', '--silent', name], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  /* 🔴 THREE CELL CONVENTIONS IN THIS REPO, AND EACH ONE I MISSED PRINTED A LIE. Most suites print
     "✓ n label"; the rules suites print "ok n label"; node --test prints "✔ label" with a DIFFERENT
     check mark (U+2714, not U+2713). Counting only ✓ reported four rules suites as "0 cells" that
     assert 99 between them. Counting ✓ and ok still reported test:portal as 0 — and that one was
     caught by the zero-assertion rule on its first real run, which is exactly what that rule is for:
     it turned a number I could not trust into a failure instead of a footnote. */
  const cells = (out.match(/^\s*(?:✓|✔|ok \d)/gm) || []).length;
  const ok = r.status === 0;
  results.push({ name, ok, cells, secs: ((Date.now() - t0) / 1000).toFixed(1), out });
}

const verdict = classify(results, KNOWN_RED);
const { failed, excused, stale, zero } = verdict;
const TAG = { pass: 'pass', excused: 'KNOWN-RED (excused)', fail: '🔴 FAIL', 'stale-excuse': '🔴 KNOWN-RED BUT PASSING', 'zero-cell': '🔴 PASSED, 0 ASSERTIONS' };
console.log('');
for (const r of verdict.rows) {
  console.log(`  ${TAG[r.state].padEnd(26)} ${r.name.padEnd(32)} ${String(r.cells).padStart(3)} cells  ${r.secs.padStart(6)}s`);
}

for (const r of results) {
  if (r.ok || KNOWN_RED[r.name]) continue;
  console.log(`\n── ${r.name} ─────────────────────────────`);
  const lines = r.out.split('\n').filter((l) => /FAIL|AssertionError|Error:|REFUSED|not ok/.test(l));
  console.log(lines.slice(0, 6).map((l) => `   ${l.trim()}`).join('\n') || '   (no recognisable failure line; see the suite output)');
}

if (excused) {
  console.log('\nEXCUSED, each with a reason — these RAN and FAILED, they were not skipped:');
  for (const r of results) if (!r.ok && KNOWN_RED[r.name]) console.log(`\n  ${r.name}\n    ${KNOWN_RED[r.name].replace(/(.{96}) /g, '$1\n    ')}`);
}
if (stale) {
  console.log('\n🔴 A KNOWN-RED SUITE PASSED. Delete its KNOWN_RED entry — an excuse that outlives its');
  console.log('   defect silently re-hides the next regression in that suite.');
}

const total = results.length;
if (zero) {
  console.log('\n🔴 A SUITE EXITED 0 WHILE ASSERTING NOTHING. Either it stopped early, or its output');
  console.log('   convention is not recognised here. Both make its green meaningless — fix it, or add');
  console.log('   it to ZERO_CELL_OK with a reason.');
}
console.log(`\ngate-all${EMULATORS_ONLY ? ' (emulators only)' : ''}: ${verdict.passed}/${total} passing, ${failed} failing, ${excused} excused, ${stale} stale-excuse, ${zero} zero-assertion — ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
process.exit(verdict.exitCode);
