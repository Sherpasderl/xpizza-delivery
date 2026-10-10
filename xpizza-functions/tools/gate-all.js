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
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* A suite may only be excused with a REASON and a place to look. Silent absence is the failure mode
   this tool removes; a silent skip would reintroduce it one level up. These are not skipped — they
   RUN, and their failure is reported and excused. If one starts passing, this run fails until the
   entry is deleted, so the allowlist cannot outlive what it excuses. */
const KNOWN_RED = {
  /* Empty, and that is the point: the last entry was DELETED when its defect was fixed rather than
     surviving as an excuse. `test:resolve-manual` was excused while the paid-after-close park lived
     on another branch; the owner merged that fix (c954558), the rebase carried it here, the suite
     went green, and this run failed as a STALE EXCUSE until the entry was removed — the mechanism
     proving itself on a real merge instead of on a test of itself. Anything added here needs a
     reason and a place to look; an entry whose suite passes fails the gate by design. */

  /* 🔴 AND `test:identity-registry` MUST NOT BE ADDED HERE — which is worth saying precisely because
     it is the suite you have most likely just been annoyed by. It fails INTERMITTENTLY at ~10% with
     `3 INVALID_ARGUMENT: Transaction is invalid or closed`: 7 signature failures in 90 runs across
     three commits (2026-09-26), and it PRE-DATES the E-2d fence — it reproduces at `793a67a^`, so it
     is not a regression of the D4-P1a slice.

     THE STALE-EXCUSE RULE INVERTS FOR AN INTERMITTENT FAULT, and that is the whole reason for this
     note. An entry here fails the run when its suite PASSES (`classify`, :54; header, :17). For a
     DETERMINISTIC known-red suite that is exactly right — it is what stopped `test:resolve-manual`
     from outliving its fix. For this one it is exactly backwards: it would fail the gate on the nine
     runs in ten where the suite is GREEN and excuse it on the tenth where it is not. And since the
     allowlist keys on SUITE NAME, the entry would also excuse any genuine regression anywhere in
     identity-registry — i.e. tolerating the fault, with paperwork.

     WHAT IT IS: under the suite's deliberate 6-way contention, a server-STREAMING read is re-issued on
     a timer onto a transaction that has already closed (retry-request → makeServerStreamRequest), and
     INVALID_ARGUMENT is not in the retryable set, so it escapes runTransaction's contention-retry loop
     instead of being retried as the ABORTED it stands in for. WHICH read is not established: both
     `tx.get(query)` and `tx.get(docRef)` go out as server streams, so the frames do not separate
     identity-registry.js:450 from :157/:200.

     WHY IT IS DOCUMENTED RATHER THAN FIXED: production's worst shape is 2 contenders, not 6 — both
     callers walk keys with a plain `for…of` + await (identity-backfill.js:84, :112), so one publish
     never races itself — and catalog-publish.js:1469 buckets this as `identity_preserve_failed`,
     warns, and THE PUBLISH STILL SUCCEEDS. Bounded, loud, already handled.

     RE-OPEN AND INSTRUMENT WHICH READ IT IS on any one of: the signature appears in PRODUCTION logs
     (it would arrive as `identity_preserve_failed`); the rate rises materially above ~10%; or it fires
     in a suite that is NOT a deliberate contention test — that last would mean the precondition is
     wrong for a second time and the fault is not about contention at all.

     🔴 AND RE-RUNNING IN ISOLATION DOES NOT DODGE IT. The long-standing "only ever fails after another
     emulator suite" precondition was FALSE: it rested on 8 clean isolation runs, which at a 10% rate
     happen 43% of the time. Four rounds of work ran on that. A clean re-run is not evidence the tree
     is good; it is one sample at ~90%. */
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
    /* 🔴 NOT MEASURED IS NOT ZERO. A suite that emitted no ##CELLS trailer was never counted — the
       preload did not load, or the process died before its exit hook — and reading that as "asserted
       nothing" would file a BROKEN MEASUREMENT under a rule about silent suites, sending whoever
       reads the row to the wrong problem. It fails either way; it must fail saying which.
       Only for a suite that PASSED: one that already failed is reported as the failure it is —
       a crashed suite legitimately emits no trailer, and burying that under "not measured" would
       hide the failure behind the measurement. */
    if (r.ok && (r.cells === null || r.cells === undefined)) return { ...r, state: 'not-measured' };
    if (r.ok && r.cells === 0 && !Object.prototype.hasOwnProperty.call(zeroCellOk, r.name)) return { ...r, state: 'zero-cell' };
    if (r.ok) return { ...r, state: 'pass' };
    if (known) return { ...r, state: 'excused' };
    return { ...r, state: 'fail' };
  });
  const count = (st) => rows.filter((x) => x.state === st).length;
  const failed = count('fail'), excused = count('excused'), stale = count('stale-excuse'), zero = count('zero-cell'), unmeasured = count('not-measured');
  // Nothing measured is never a pass — the same rule the mutation sweep enforces.
  const exitCode = (!rows.length || failed || stale || zero || unmeasured) ? 1 : 0;
  return { rows, failed, excused, stale, zero, unmeasured, passed: count('pass'), exitCode };
}

/* 🔴 THE COUNT IS REPORTED BY THE SUITE, NOT INFERRED FROM ITS OUTPUT. This used to pattern-match
   the combined stdout of a subprocess tree, which is not only the suite's: the firebase CLI writes
   "✔  Script exited successfully", "✔  firestore: Firestore Emulator was started", "✔  Rules
   updated." and "✔  Export complete" at line start, with the same U+2714 node --test uses. Stripping
   those one at a time was a denylist that grew every round — and it grew in BOTH directions, because
   one suite's own summary line ("✓ driver-diag: 10 tests passed") stood for ten and counted as one.

   tools/count-marks.js is preloaded into each suite's own process and emits `##CELLS n`. The chrome
   is written by a DIFFERENT process, so it is excluded by isolation rather than by pattern. Several
   processes in a chain each emit a trailer (npm and the runner contribute 0), so they SUM.

   🔴 NO TRAILER IS A FAILURE, NOT A ZERO. A suite that emitted no trailer was not measured — the
   preload did not load, or the process died before exit — and a number that can go missing silently
   is what the zero-assertion rule exists to replace. `null` is returned so classify() can tell "not
   measured" from "asserted nothing"; both fail, for different reasons and with different messages. */
const TRAILER = /^##CELLS (\d+)$/gm;
const countCells = (out) => {
  const hits = [...String(out || '').matchAll(TRAILER)];
  if (!hits.length) return null;                       // not measured
  return hits.reduce((n, m) => n + Number(m[1]), 0);
};

/* R1 (PLAN-emulator-isolation §b.5): THE SETTLE WAIT IS GONE — its job moved INTO the launcher. tools/emulator-run.js
   now owns its slot by a sentinel socket for the whole run and, on exit, terminates its own marked processes to a
   confirmed-death barrier and verifies its band released BEFORE closing the sentinel. A following suite cannot be
   admitted to a slot whose sentinel is still held, and one whose band is still bound is skipped by the band probe —
   so there is no shared band left to wait on. (The wait also never explained the identity-registry flake: it engaged
   every time and the flake recurred with every port free.)

   STREAMING. A launcher queued behind 40 busy slots prints admission heartbeats to stderr; captured with spawnSync
   they would surface only after the suite ends, which reads as a hang. Scripts that reach the launcher — directly
   (emulator-run.js in the body) or INDIRECTLY (a test file that self-launches it, e.g. test:kds-manifest-writer) —
   have their `emulator-run:` lines teed live (from stderr AND stdout — see runScript), while the full output is still
   captured for ##CELLS. */
const launcherFiles = (body) => [...String(body).matchAll(/(?:^|\s|")((?:\.\.?\/)?[\w./-]+\.(?:js|mjs))\b/g)].map((m) => m[1]);
function reachesLauncher(body, root = ROOT) {
  if (/emulator-run\.js/.test(body)) return true;
  return launcherFiles(body).some((f) => {
    try { return /emulator-run\.js/.test(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return false; }
  });
}

module.exports = { classify, KNOWN_RED, ZERO_CELL_OK, countCells, reachesLauncher };
if (require.main !== module) return;

const EMULATORS_ONLY = process.argv.includes('--emulators');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;
/* The runner's own entry points are excluded, or it would invoke itself. Everything else that is a
   test script runs — including `test`, the in-process chain, which was previously a separate thing
   a person had to remember to run alongside this one. */
const SELF = new Set(['test:gate', 'test:emulators:all']);
const isEmulator = (v) => /emulator-run\.js/.test(v);

/* The script BODIES, so a launcher-reaching suite is told apart by what it runs rather than by its name. */
const pkgScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts || {};

const scripts = (() => {
  const pkg = { scripts: pkgScripts };
  const all = Object.entries(pkg.scripts || {})
    .filter(([k, v]) => !SELF.has(k) && (k === 'test' || k.startsWith('test:')) && String(v).trim())
    .filter(([, v]) => (EMULATORS_ONLY ? isEmulator(v) : true))
    /* 🔴 --only EXISTS SO THE MAIN PATH IS REACHABLE FROM A TEST. Everything below `require.main !==
       module` is invisible to a suite that REQUIRES this file, and a `join is not defined` in the
       spawn loop therefore survived a green npm test, six green sweeps and a green guard — the gate
       itself was the only thing that ran it, and it is the thing being changed. One real script
       through the whole path is the smallest check that would have caught it. */
    .filter(([k]) => !ONLY || ONLY.split(',').includes(k))
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

/* Run one script; stream the launcher's own stderr lines live when it can queue. Async spawn, so a live line is
   printed when it is written rather than when the suite ends. */
function runScript(name, env) {
  const stream = reachesLauncher(pkgScripts[name] || '');
  return new Promise((resolve) => {
    const c = spawn('npm', ['run', '--silent', name], { cwd: ROOT, env });
    let out = '';
    /* BOTH streams are scanned: a launcher reached INDIRECTLY through `node --test` has its stderr forwarded by the test
       runner VERBATIM onto STDOUT (measured, live, line-for-line) — teeing stderr alone would never show its heartbeats. */
    const tee = () => {
      let buf = '';
      return (d) => {
        out += d;
        if (!stream) return;
        buf += d;
        const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) if (/^emulator-run:/.test(l)) process.stderr.write(`  │ ${name}: ${l}\n`);
      };
    };
    c.stdout.on('data', tee());
    c.stderr.on('data', tee());
    c.on('error', (e) => resolve({ status: 1, out: `${out}\nspawn error: ${e && e.message}` }));
    c.on('close', (code) => resolve({ status: code, out }));
  });
}

(async () => {
const started = Date.now();
const results = [];
for (const name of scripts) {
  const t0 = Date.now();
  /* The counter loads in every node process this spawns. npm and the runner write no marks, so they
     contribute 0 and the totals SUM correctly without anyone having to know which process they are
     in; emulator-run strips it before reaching firebase and injects it into the suite instead, so the
     CLI never counts its own chrome. */
  const COUNTER = path.join(ROOT, 'tools', 'count-marks.js');
  const childEnvWithCounter = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${COUNTER}`.trim() };
  const r = await runScript(name, childEnvWithCounter);
  const out = r.out;
  /* 🔴 THREE CELL CONVENTIONS IN THIS REPO, AND EACH ONE I MISSED PRINTED A LIE. Most suites print
     "✓ n label"; the rules suites print "ok n label"; node --test prints "✔ label" with a DIFFERENT
     check mark (U+2714, not U+2713). Counting only ✓ reported four rules suites as "0 cells" that
     assert 99 between them. Counting ✓ and ok still reported test:portal as 0 — and that one was
     caught by the zero-assertion rule on its first real run, which is exactly what that rule is for:
     it turned a number I could not trust into a failure instead of a footnote. */
  const cells = countCells(out);
  const ok = r.status === 0;
  results.push({ name, ok, cells, secs: ((Date.now() - t0) / 1000).toFixed(1), out });
}

const verdict = classify(results, KNOWN_RED);
const { failed, excused, stale, zero } = verdict;
const TAG = { pass: 'pass', excused: 'KNOWN-RED (excused)', fail: '🔴 FAIL', 'stale-excuse': '🔴 KNOWN-RED BUT PASSING', 'zero-cell': '🔴 PASSED, 0 ASSERTIONS', 'not-measured': '🔴 NOT MEASURED (no count)' };
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
console.log(`\ngate-all${EMULATORS_ONLY ? ' (emulators only)' : ''}: ${verdict.passed}/${total} passing, ${failed} failing, ${excused} excused, ${stale} stale-excuse, ${zero} zero-assertion, ${verdict.unmeasured} not-measured — ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
process.exit(verdict.exitCode);
})();
