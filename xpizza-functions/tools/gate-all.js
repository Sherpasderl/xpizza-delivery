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

/* 🔴 A GUARD AGAINST PORT COLLISION BETWEEN SEQUENTIAL SUITES. Each emulator suite starts and stops
   its own emulator on this checkout's band; the next suite starts immediately afterwards. Ports are
   not released instantly — MEASURED at ~300ms, on every transition — so the next suite can begin
   while the previous emulator still holds one. That is an observed, expensive failure here: a port
   collision between sequential runs once produced a FALSE DRIFTED sweep result that cost a full
   diagnostic round to unpick, because a suite that cannot start its emulator fails at require time
   and every mutant after it dies on the wrong assertion. This waits for the band to clear, or
   refuses by name.

   🔴 AND IT IS NOT A FIX FOR THE identity-registry FLAKE. It was BUILT as one and it does not work:
   across three runs it engaged every time (293/302/333ms) and the flake occurred anyway, with every
   port in the band confirmed free before the next suite started. PORT RELEASE IS NOT THE MECHANISM —
   that elimination is what these engagement figures bought, and it is the reason this comment says
   so instead of implying a fix. Do not read a green run as evidence that this prevented anything.

   🔴 A RELATED CLAIM OF MINE WAS RETRACTED, recorded here because the file would otherwise carry the
   reasoning that produced it: I reported identity-registry running ~17s in the gate "against a usual
   ~5s" in isolation. There is no slowdown — it takes ~17s wherever it runs, measured. I had misread
   a CELLS column as seconds. The precondition that survives is only that four failures each occurred
   immediately after another emulator suite, and never in isolation.

   Kept on its own merits rather than on the flake: a port still bound when the next suite starts is
   worth refusing whether or not it is what ails identity-registry. */
/* This checkout's OWN band, so the wait can never be satisfied or blocked by another checkout's
   emulator — the same per-checkout derivation emulator-run.js uses to start them. */
const { planPorts, offsetFor, ROOT: EMU_ROOT } = require('./emulator-run.js');
const BAND = planPorts(offsetFor(EMU_ROOT));

const SETTLE_TIMEOUT_MS = 30000;
const SETTLE_POLL_MS = 100;
const settleStats = { engagements: 0, maxWaitMs: 0, totalWaitMs: 0 };

const portFree = (port) => {
  const r = spawnSync(process.execPath, ['-e', `const n=require('net');const s=n.createServer();
    s.once('error',e=>{process.stdout.write(e&&e.code==='EADDRINUSE'?'busy':'err');process.exit(0)});
    s.once('listening',()=>s.close(()=>{process.stdout.write('free');process.exit(0)}));
    s.listen(${port},'127.0.0.1');`], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').trim() === 'free';
};

/* 🔴 ON TIMEOUT IT REFUSES; IT NEVER FALLS THROUGH. Falling through would start the suite into
   exactly the condition this removes, while printing nothing — so the flake would return looking
   identical and we would have spent the work to hide our own evidence. */
function settleAfter(previousSuite, nextSuite, deps = {}) {
  const isFree = deps.isFree || portFree;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], { timeout: 5000 }));
  const onRefuse = deps.onRefuse || ((code) => process.exit(code));
  const stats = deps.stats || settleStats;
  const timeout = deps.timeoutMs === undefined ? SETTLE_TIMEOUT_MS : deps.timeoutMs;
  const t0 = now();
  const ports = Object.entries(deps.band || BAND);
  for (;;) {
    const busy = ports.filter(([, port]) => !isFree(port));
    if (!busy.length) break;
    if (now() - t0 > timeout) {
      console.error(`\n🔴 GATE REFUSED — an emulator port never released after ${previousSuite}.`);
      for (const [what, port] of busy) console.error(`   ${String(what).padEnd(20)} 127.0.0.1:${port}   still bound`);
      console.error(`\n   about to run : ${nextSuite}`);
      console.error(`   waited       : ${((now() - t0) / 1000).toFixed(1)}s (limit ${timeout / 1000}s)`);
      console.error('\n   Starting it anyway is the condition this wait exists to remove, so this refuses');
      console.error('   rather than running into it silently.\n');
      return onRefuse(2);
    }
    sleep(SETTLE_POLL_MS);
  }
  const waited = now() - t0;
  /* 🔴 IT RECORDS WHETHER IT ACTUALLY ENGAGED. A mitigation that never engages, for an intermittent
     fault that happens not to recur, is indistinguishable from luck — and would close the
     investigation while changing nothing. If this reports ~0ms and the flake returns, the ports were
     never the mechanism, and that is a finding rather than a disappointment. */
  if (waited >= SETTLE_POLL_MS) {
    stats.engagements += 1;
    stats.totalWaitMs += waited;
    stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
    console.log(`  settle: waited ${waited}ms for ports to release after ${previousSuite}`);
  }
  return waited;
}

module.exports = { classify, KNOWN_RED, ZERO_CELL_OK, countCells, settleAfter, SETTLE_POLL_MS };
if (require.main !== module) return;

const EMULATORS_ONLY = process.argv.includes('--emulators');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length) || null;
/* The runner's own entry points are excluded, or it would invoke itself. Everything else that is a
   test script runs — including `test`, the in-process chain, which was previously a separate thing
   a person had to remember to run alongside this one. */
const SELF = new Set(['test:gate', 'test:emulators:all']);
const isEmulator = (v) => /emulator-run\.js/.test(v);

/* The script BODIES, so the settle wait can tell an emulator suite from a plain one by what it
   runs rather than by its name. */
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

const started = Date.now();
const results = [];
let previousEmulatorSuite = null;
for (const name of scripts) {
  if (previousEmulatorSuite) settleAfter(previousEmulatorSuite, name);
  const t0 = Date.now();
  /* The counter loads in every node process this spawns. npm and the runner write no marks, so they
     contribute 0 and the totals SUM correctly without anyone having to know which process they are
     in; emulator-run strips it before reaching firebase and injects it into the suite instead, so the
     CLI never counts its own chrome. */
  const COUNTER = path.join(ROOT, 'tools', 'count-marks.js');
  const childEnvWithCounter = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${COUNTER}`.trim() };
  const r = spawnSync('npm', ['run', '--silent', name], { cwd: ROOT, encoding: 'utf8', env: childEnvWithCounter });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  /* 🔴 THREE CELL CONVENTIONS IN THIS REPO, AND EACH ONE I MISSED PRINTED A LIE. Most suites print
     "✓ n label"; the rules suites print "ok n label"; node --test prints "✔ label" with a DIFFERENT
     check mark (U+2714, not U+2713). Counting only ✓ reported four rules suites as "0 cells" that
     assert 99 between them. Counting ✓ and ok still reported test:portal as 0 — and that one was
     caught by the zero-assertion rule on its first real run, which is exactly what that rule is for:
     it turned a number I could not trust into a failure instead of a footnote. */
  const cells = countCells(out);
  const ok = r.status === 0;
  results.push({ name, ok, cells, secs: ((Date.now() - t0) / 1000).toFixed(1), out });
  /* Only an EMULATOR suite leaves ports to release, so only it arms the wait for the next one. */
  previousEmulatorSuite = isEmulator(pkgScripts[name] || '') ? name : null;
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
/* 🔴 THE SETTLE WAIT REPORTS WHETHER IT ACTUALLY ENGAGED. A mitigation for an intermittent fault
   that never engages, on a run where the fault happens not to recur, is indistinguishable from luck
   — and would close the investigation while changing nothing. If this line reads "never engaged" on
   a run where the slow-suite signature is still present, the ports are NOT what the suite waits on,
   which is a finding obtained for the cost of one run. */
/* 🔴 REPORTED WHETHER OR NOT IT ENGAGED, and this is what turned "the poll did not stop the flake"
   into an ELIMINATION rather than a shrug. Without these figures a green run would read as the guard
   working, and a red one as the guard being useless; with them we know the ports really were free and
   the failure happened anyway. A silent mitigation for an intermittent fault is indistinguishable
   from luck in both directions. */
console.log(settleStats.engagements
  ? `settle: engaged ${settleStats.engagements}x, max ${settleStats.maxWaitMs}ms, total ${settleStats.totalWaitMs}ms`
  : 'settle: never engaged (ports were already free at every transition)');
console.log(`\ngate-all${EMULATORS_ONLY ? ' (emulators only)' : ''}: ${verdict.passed}/${total} passing, ${failed} failing, ${excused} excused, ${stale} stale-excuse, ${zero} zero-assertion, ${verdict.unmeasured} not-measured — ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
process.exit(verdict.exitCode);
