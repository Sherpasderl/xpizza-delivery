#!/usr/bin/env node
'use strict';
/* Run EVERY emulator suite, score each on its own exit code, and refuse to be quietly incomplete.
 *
 * 🔴 WHY. The gate ran a hand-kept list of twelve emulator scripts out of forty-two. The other thirty
 * were not run by anyone, which is how four suites stayed red for an unknown period — one of them
 * sitting on a real money-path defect, and one masking twenty-one redemption-reserve assertions that
 * had not executed since the 1b-1b cutover. Nothing was wrong with the tree that a wider loop would
 * not have shown; the loop was the defect. So the list is ENUMERATED from package.json, never typed:
 * a suite added tomorrow is in the gate tomorrow, without anyone remembering to add it.
 *
 *   npm run test:emulators:all            every emulator script, one line each
 *   npm run test:emulators:all -- --list  just show what would run
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
function classify(results, knownRed) {
  const rows = results.map((r) => {
    const known = Object.prototype.hasOwnProperty.call(knownRed, r.name);
    if (r.ok && known) return { ...r, state: 'stale-excuse' };
    if (r.ok) return { ...r, state: 'pass' };
    if (known) return { ...r, state: 'excused' };
    return { ...r, state: 'fail' };
  });
  const count = (st) => rows.filter((x) => x.state === st).length;
  const failed = count('fail'), excused = count('excused'), stale = count('stale-excuse');
  // Nothing measured is never a pass — the same rule the mutation sweep enforces.
  const exitCode = (!rows.length || failed || stale) ? 1 : 0;
  return { rows, failed, excused, stale, passed: count('pass'), exitCode };
}

module.exports = { classify, KNOWN_RED };
if (require.main !== module) return;

const scripts = (() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return Object.entries(pkg.scripts || {})
    .filter(([, v]) => /emulator-run\.js/.test(v))
    .map(([k]) => k)
    .sort();
})();

if (process.argv.includes('--list')) {
  for (const s of scripts) console.log(`${s}${KNOWN_RED[s] ? '   [known-red]' : ''}`);
  console.log(`\n${scripts.length} emulator scripts`);
  process.exit(0);
}

if (!scripts.length) {
  // Same rule as the mutation sweep: a run that measured nothing is never a pass.
  console.error('emulator-all: no emulator scripts found in package.json — nothing was measured.');
  process.exit(2);
}

for (const name of Object.keys(KNOWN_RED)) {
  if (!scripts.includes(name)) {
    console.error(`emulator-all: KNOWN_RED names "${name}", which is not an emulator script any more.`);
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
  /* 🔴 TWO CELL CONVENTIONS IN THIS REPO, AND COUNTING ONLY ONE PRINTS A LIE. Most suites print
     "✓ n label"; the rules suites print "ok n label". Counting only ✓ reported rewards-rules,
     rewards-config-rules, staff-push-rules and user-profiles-rules as "0 cells" — four suites that
     each assert plenty, shown in the summary as if they asserted nothing. A number nobody can trust
     is worse than no column: the whole point of this table is to make a suite that stopped asserting
     visible at a glance. */
  const cells = (out.match(/^\s*(?:✓|ok \d)/gm) || []).length;
  const ok = r.status === 0;
  results.push({ name, ok, cells, secs: ((Date.now() - t0) / 1000).toFixed(1), out });
}

const verdict = classify(results, KNOWN_RED);
const { failed, excused, stale } = verdict;
const TAG = { pass: 'pass', excused: 'KNOWN-RED (excused)', fail: '🔴 FAIL', 'stale-excuse': '🔴 KNOWN-RED BUT PASSING' };
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
console.log(`\nemulator-all: ${verdict.passed}/${total} passing, ${failed} failing, ${excused} excused, ${stale} stale-excuse — ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
process.exit(verdict.exitCode);
