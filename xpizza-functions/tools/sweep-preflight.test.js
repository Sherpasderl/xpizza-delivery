'use strict';
/**
 * Mutation-sweep pre-flight — every branch, driven directly.
 * Run: node tools/sweep-preflight.test.js
 *
 * 🔴 WHY THIS FILE EXISTS. The defect it guards is not hypothetical: a sweep inherits its environment
 * and never establishes an emulator, so an armed suite handed the wrong one refuses at require time,
 * exits nonzero, and is scored KILLED-but-drifted. A peer's run read `pah` 1/6 with five DRIFTED and
 * the cause was a bound port. The point of the pre-flight is that the SAME condition now produces one
 * refusal naming the reason instead of N results that look like findings — so these cells assert the
 * REASON, not merely that something refused.
 *
 * The verdict is pure, so every cell drives it with injected state: no socket, no emulator, no clock.
 */
const assert = require('assert');
const { armingOf, resolvePlan, planFromScript, preflightVerdict } = require('./sweep-preflight.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const HOST_VAR = { firestore: ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS'], database: ['FIREBASE_DATABASE_EMULATOR_HOST'] };
const LISTENERS = { firestore: ['firestore', 'firestoreWebsocket'], database: ['database'] };
const PORTS = { hub: 4520, firestore: 8200, firestoreWebsocket: 8620, database: 9120 };
const armedDb = () => ['database'];
const notArmed = () => null;
const judge = (over = {}) => preflightVerdict({
  plans: [], armedOf: notArmed, env: {}, hostVarOf: HOST_VAR,
  expectedPorts: PORTS, portState: {}, serviceListeners: LISTENERS, ...over,
});

// ── 1. 🔴 REASON ONE: NO EMULATOR CONFIGURED — an armed suite would run with nothing serving it ──
/* The unrouted case. Nothing will start an emulator, and the host var is unset, so the suite would
   refuse at require time. Before this pre-flight that refusal was scored as a drifted mutant. */
{
  const plans = [{ id: 'x-01', plan: { routed: false, services: [], files: ['test/foo.emulator.test.js'], via: 'node test/foo.emulator.test.js' } }];
  const v = judge({ plans, armedOf: armedDb, env: { /* nothing set */ } });
  assert.strictEqual(v.ok, false, '🔴 an armed suite with no emulator configured was allowed to sweep');
  assert.strictEqual(v.code, 'sweep_preflight_no_emulator', '🔴 the operator is not told the emulator was never configured — the one fix that would work');
  assert.match(v.lines.join('\n'), /FIREBASE_DATABASE_EMULATOR_HOST is not set/, 'the refusal names the variable an operator must set');
  assert.match(v.lines.join('\n'), /x-01/, 'and the mutant it would have mis-scored');
  ok('unrouted armed suite + host var unset → sweep_preflight_no_emulator, naming the variable');
}

// ── 2. 🔴 REASON TWO: CONFIGURED FOR ANOTHER CHECKOUT — the var points at a foreign band ────────
/* This is the case that must NOT collapse into reason one. It is fixed by finding the other run, not
   by setting a variable — sending an operator down the wrong one of those cost a round. */
{
  const plans = [{ id: 'x-02', plan: { routed: false, services: [], files: ['test/foo.emulator.test.js'], via: 'node test/foo.emulator.test.js' } }];
  const v = judge({ plans, armedOf: armedDb, env: { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9310' } });
  assert.strictEqual(v.ok, false, '🔴 a foreign checkout\'s emulator was accepted');
  assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', '🔴 the two reasons collapsed into one — the operator is sent to set a variable when another run holds the port');
  assert.notStrictEqual(v.code, 'sweep_preflight_no_emulator', '🔴 the two reasons collapsed into one — they have different fixes');
  assert.match(v.lines.join('\n'), /9310/, 'the refusal names the port actually configured');
  assert.match(v.lines.join('\n'), /expected 9120/, 'and the port this checkout expects, so the operator can see it is someone else\'s');
  ok('unrouted armed suite + another checkout\'s port → sweep_preflight_foreign_checkout, naming both ports');
}

// ── 3. 🔴 REASON TWO AGAIN, BY THE PATH THAT ACTUALLY BIT US: a routed suite whose port is bound ──
/* The peer's sweep. The script DOES route the runner, so the environment is irrelevant — the runner
   would have established it. What failed is the bind: the runner probes its band and exits 3. Every
   armed suite after that point drifts. This is the condition, predicted once, before scoring. */
{
  const plans = [{ id: 'pah-01', plan: { routed: true, services: ['database'], files: ['test/resolve-manual.emulator.test.js'], via: 'npm run test:resolve-manual' } }];
  const v = judge({ plans, armedOf: armedDb, env: {}, portState: { 9120: 'in-use', 4520: 'free' } });
  assert.strictEqual(v.ok, false, '🔴 a sweep started while another run held this checkout\'s port — every armed mutant would DRIFT');
  assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', '🔴 a bound port is not reported as another run holding it — every armed mutant would DRIFT and read as a finding');
  assert.match(v.lines.join('\n'), /database\s+127\.0\.0\.1:9120\s+in-use/, 'the refusal names the bound listener and port');
  assert.match(v.detail, /already bound/, 'and says the runner would refuse to start, which is the fact an operator needs');
  ok('routed suite + a bound port in this checkout\'s band → refused up front, naming the listener');
}

// ── 4. 🔴 THE SENSITIVITY PARTNER: a correctly-configured sweep STILL RUNS ──────────────────────
/* Without this, every cell above is satisfied by a pre-flight that refuses unconditionally — which
   would be worse than the drift, because it fails honest runs. The guard's own header records that
   exact mistake being made once already (a guard that invented its own precondition). */
{
  const routed = { id: 'pah-01', plan: { routed: true, services: ['database'], files: ['test/resolve-manual.emulator.test.js'], via: 'npm run test:resolve-manual' } };
  const unrouted = { id: 'pah-06', plan: { routed: false, services: [], files: ['../xpizza-dispatch/dispatch-paid-after-close.test.js'], via: 'node ../xpizza-dispatch/dispatch-paid-after-close.test.js' } };
  const v = preflightVerdict({
    plans: [routed, unrouted],
    armedOf: (f) => (f.endsWith('.emulator.test.js') ? ['database'] : null),
    env: {}, hostVarOf: HOST_VAR, expectedPorts: PORTS,
    portState: { 9120: 'free', 4520: 'free' }, serviceListeners: LISTENERS,
  });
  assert.strictEqual(v.ok, true, '🔴 a correctly-configured sweep was refused — the pre-flight fails honest runs');
  assert.strictEqual(v.code, 'ready', '🔴 an honest sweep is blocked — the pre-flight refuses runs it should pass');
  assert.deepStrictEqual(v.lines, [], 'a passing pre-flight reports nothing to fix');
  ok('routed suite on a free band + a non-emulator suite → the sweep proceeds (the pre-flight is not a blanket refusal)');
}

// ── 5. 🔴 AN UNROUTED, UNARMED SUITE NEEDS NO EMULATOR AND MUST NOT BE REFUSED ─────────────────
/* pah-06's shape. Refusing it would make the pre-flight demand an emulator for plain node tests. */
{
  const plans = [{ id: 'x-05', plan: { routed: false, services: [], files: ['catalog/pointer-state.test.js'], via: 'node catalog/pointer-state.test.js' } }];
  const v = judge({ plans, armedOf: notArmed, env: {} });
  assert.strictEqual(v.ok, true, '🔴 a plain unit test was made to depend on an emulator');
  ok('unrouted + not armed → no emulator demanded');
}

// ── 6. 🔴 A SUITE THE PRE-FLIGHT CANNOT READ IS REPORTED, NEVER SKIPPED ────────────────────────
/* "I could not tell" and "it is fine" are the two readings this whole file exists to keep apart. A
   skip here would silently restore the blind spot: an armed suite sweeping with no emulator. */
{
  const plans = [{ id: 'x-06', plan: { routed: false, services: [], files: ['test/vanished.emulator.test.js'], via: 'node test/vanished.emulator.test.js' } }];
  const v = judge({ plans, armedOf: () => { throw new Error('ENOENT: no such file'); }, env: {} });
  assert.strictEqual(v.ok, false, '🔴 an unreadable suite was skipped — the pre-flight cannot promise it had an emulator');
  assert.strictEqual(v.code, 'sweep_preflight_unclassifiable', '🔴 an unreadable suite is not reported, so the sweep proceeds with an armed suite nobody checked');
  assert.match(v.lines.join('\n'), /cannot read test\/vanished\.emulator\.test\.js/, 'the refusal names the file it could not read');
  ok('a suite that cannot be read → sweep_preflight_unclassifiable, not a silent skip');
}

// ── 7. 🔴 A COMMAND SHAPE THE RESOLVER CANNOT READ IS REFUSED, NOT ASSUMED HARMLESS ────────────
{
  const cases = [
    [['bash', '-c', 'node test/foo.emulator.test.js'], /does not start with npm or node/],
    [['npm', 'ci'], /not `npm test` or `npm run/],
    [['npm', 'run', 'test:does-not-exist'], /no script "test:does-not-exist"/],
    [['node', '--test'], /no file/],
  ];
  for (const [command, want] of cases) {
    const plan = resolvePlan(command, { test: 'node a.test.js' });
    assert.ok(plan.unclassifiable, `🔴 ${JSON.stringify(command)} was treated as runnable — an armed suite could sweep with no emulator and every mutant would DRIFT`);
    assert.match(plan.unclassifiable, want, 'the reason names what could not be read');
    const v = judge({ plans: [{ id: 'x-07', plan }] });
    assert.strictEqual(v.code, 'sweep_preflight_unclassifiable', 'and it stops the sweep');
  }
  ok(`${cases.length} unreadable command shapes each refuse with a reason, rather than sweeping`);
}

// ── 8. 🔴 A ROUTED SCRIPT WITH NO --only IS REFUSED — its services are unknown ─────────────────
/* The runner would start every service on this checkout's band, which is a different precondition
   than the one checked here. Guessing it is how a pre-flight starts being wrong quietly. */
{
  const plan = planFromScript('test:x', 'node tools/emulator-run.js --project demo-xpizza "node test/x.emulator.test.js"');
  assert.ok(plan.unclassifiable, '🔴 a routed script with no --only was assumed to need nothing');
  assert.match(plan.unclassifiable, /names no --only/);
  ok('a routed script with no --only → unclassifiable, not guessed');
}

// ── 9. 🔴 UNCLASSIFIABLE OUTRANKS THE ENVIRONMENT REASONS ──────────────────────────────────────
/* A pre-flight that could not decide must not let the sweep proceed on the strength of the checks it
   DID manage — nor report an environment fix that would not address what it could not read. */
{
  const bad = { id: 'x-09a', plan: { unclassifiable: 'cannot read this' } };
  const alsoBroken = { id: 'x-09b', plan: { routed: true, services: ['database'], files: [], via: 'npm run test:y' } };
  const v = judge({ plans: [bad, alsoBroken], armedOf: armedDb, portState: { 9120: 'in-use', 4520: 'free' } });
  assert.strictEqual(v.code, 'sweep_preflight_unclassifiable', '🔴 an undecidable pre-flight reported an environment verdict instead');
  ok('undecidable + a real port collision → reports undecidable first, not a fix that would not help');
}

// ── 10. 🔴 THE ARMING DETECTOR MATCHES A CALL, NOT A MENTION ───────────────────────────────────
/* tools/emulator-ports.guard.test.js cell 11 records the original version of this mistake: asserting
   a file CONTAINED "_emulator-required" passed for prose and for a commented-out line. A detector
   that over-matches here would refuse honest sweeps; one that under-matches would let an armed suite
   through. Both directions are driven. */
{
  const armed = [
    "require('./_emulator-required')('database');",
    'require("../test/_emulator-required")("firestore", "database");',
    "  require('./_emulator-required')('firestore');",
  ];
  for (const src of armed) assert.ok(armingOf(src), `🔴 a real arming call was not detected: ${src}`);
  assert.deepStrictEqual(armingOf("require('./_emulator-required')('firestore', 'database');"), ['firestore', 'database'],
    'both services are reported, so a suite needing two emulators is checked for two');

  const notArmedSrc = [
    "// require('./_emulator-required')('database');",
    "/* this file used to require('./_emulator-required')('database') */",
    "const p = require('./_emulator-required');   // required but never invoked",
    "assert.match(src, /_emulator-required/);",
  ];
  for (const src of notArmedSrc) assert.strictEqual(armingOf(src), null, `🔴 a mention was read as an arming call: ${src}`);
  ok('the arming detector reads a top-level CALL — commented, quoted, and never-invoked mentions are not armed');
}

// ── 11. 🔴 A NON-LOOPBACK OR UNREADABLE HOST IS FOREIGN, NOT "PROBABLY FINE" ───────────────────
{
  const plans = [{ id: 'x-11', plan: { routed: false, services: [], files: ['test/foo.emulator.test.js'], via: 'node test/foo.emulator.test.js' } }];
  for (const [raw, why] of [['evil.example:9120', 'not loopback'], ['0.0.0.0:9120', 'the wildcard bind address is reachable off-box'], ['127.0.0.1', 'no port'], ['127.0.0.1:garbage', 'unreadable port']]) {
    const v = judge({ plans, armedOf: armedDb, env: { FIREBASE_DATABASE_EMULATOR_HOST: raw } });
    assert.strictEqual(v.ok, false, `🔴 ${raw} was accepted — the sweep would assert against another tree's emulator and report green (${why})`);
    assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', `${raw} → foreign`);
  }
  ok('non-loopback, wildcard, portless and unparseable host vars each refuse as foreign');
}

// ── 12. THE VERDICT IS PURE — no reads, no sockets, no environment of its own ──────────────────
/* It is handed plans, an armed lookup, an env object, ports and an already-probed port state. If it
   reached for process.env or a socket, a cell could pass here and the real sweep still drift. */
{
  const before = JSON.stringify({ env: process.env.FIREBASE_DATABASE_EMULATOR_HOST });
  const plans = [{ id: 'x-12', plan: { routed: true, services: ['database'], files: [], via: 'npm run test:z' } }];
  const a = judge({ plans, armedOf: armedDb, portState: { 9120: 'free', 4520: 'free' } });
  const b = judge({ plans, armedOf: armedDb, portState: { 9120: 'free', 4520: 'free' } });
  assert.deepStrictEqual(a, b, 'the same inputs give the same verdict');
  assert.strictEqual(JSON.stringify({ env: process.env.FIREBASE_DATABASE_EMULATOR_HOST }), before, 'the verdict mutated no ambient state');
  assert.strictEqual(a.ok, true, 'and a free band is ready');
  ok('the verdict is a pure function of its arguments');
}

console.log(`\n${n} cells passed`);
