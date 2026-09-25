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
const { armingOf, resolvePlan, planFromScript, preflightVerdict, portsToProbe } = require('./sweep-preflight.js');

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

  /* 🔴 THE MODULE IS CHECKED, NOT JUST THE SHAPE. An immediately-invoked require of ANY module has
     the same shape as an arming call; reading its arguments as service names would arm half the
     repo on suites that never mention an emulator. */
  for (const other of ["require('./helpers')('database');", "require('express')();", "const f = require('./fmt');\nf('database');"]) {
    assert.strictEqual(armingOf(other), null, `🔴 a require of a DIFFERENT module was read as an emulator arming call: ${other.split('\n')[0]}`);
  }

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
    assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', `🔴 ${raw} was not reported as foreign — the sweep would assert against another tree's emulator and report green`);
  }
  ok('non-loopback, wildcard, portless and unparseable host vars each refuse as foreign');
}

// ── 13. 🔴 THE RUNNER MUST START WHAT THE SUITE ARMS ITSELF FOR ───────────────────────────────
/* A database-armed suite routed through `--only firestore` used to return ready. The suite then
   refuses at require time and every mutant it kills DRIFTS — the exact failure this file prevents,
   reintroduced through a script naming the wrong service. */
{
  const plans = [{ id: 'x-13', plan: { routed: true, services: ['firestore'], files: ['test/db.emulator.test.js'], via: 'npm run test:x' } }];
  const v = judge({ plans, armedOf: () => ['database'], portState: { 8200: 'free', 8620: 'free', 4520: 'free' } });
  assert.strictEqual(v.ok, false, '🔴 the runner starts a service the suite does not need and NOT the one it does');
  assert.strictEqual(v.code, 'sweep_preflight_no_emulator');
  assert.match(v.lines.join('\n'), /arms itself for the database emulator, but npm run test:x starts only firestore/,
    'the refusal names what the suite needs and what the script starts');
  ok('an armed suite whose script starts a DIFFERENT service → refused, naming both');
}

// ── 14. 🔴 A FOREIGN DISCOVERY HUB IS CAUGHT EVEN WHEN THE SERVICE VAR IS CORRECT ──────────────
/* rules-unit-testing discovers endpoints through FIREBASE_EMULATOR_HUB and PREFERS them over the
   per-service variables, so a correct database address plus a foreign hub still lands on another
   checkout — and _emulator-required refuses it while this returned ready. */
{
  const plans = [{ id: 'x-14', plan: { routed: false, services: [], files: ['test/db.emulator.test.js'], via: 'node test/db.emulator.test.js' } }];
  const v = judge({ plans, armedOf: armedDb,
    env: { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9120', FIREBASE_EMULATOR_HUB: '127.0.0.1:4710' },
    portState: { '127.0.0.1:9120': 'serving', '127.0.0.1:4710': 'serving' } });
  assert.strictEqual(v.ok, false, '🔴 a foreign hub points the suite at another checkout even with a correct host var');
  assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', '🔴 a foreign hub points the suite at another checkout even with a correct host var');
  assert.match(v.lines.join('\n'), /FIREBASE_EMULATOR_HUB=127\.0\.0\.1:4710 is not this checkout's hub port \(expected 4520\)/);
  ok('a correct service var + a FOREIGN hub → refused (the hub is checked whether or not the suite named it)');
}

// ── 15. 🔴 A CORRECTLY-NUMBERED ADDRESS IS NOT A RUNNING EMULATOR ──────────────────────────────
/* A stale variable from a run that has since exited names exactly the right port with nothing
   behind it. The number being right was treated as the emulator being there; the suite then fails on
   connection errors and every mutant DRIFTS. */
{
  const plans = [{ id: 'x-15', plan: { routed: false, services: [], files: ['test/db.emulator.test.js'], via: 'node test/db.emulator.test.js' } }];
  /* 🔴 'refused' — a CONNECTION was refused. The old fixture said 'free', meaning a bind succeeded,
     which is a different question: any unrelated process holding the port satisfied a bind probe while
     nothing served the suite. */
  const v = judge({ plans, armedOf: armedDb, env: { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9120' }, portState: { '127.0.0.1:9120': 'refused' } });
  assert.strictEqual(v.ok, false, '🔴 the variable names the right port but nothing is listening');
  assert.strictEqual(v.code, 'sweep_preflight_foreign_checkout', '🔴 the variable names the right port but nothing is listening — every armed mutant would DRIFT');
  assert.match(v.lines.join('\n'), /nothing accepted a connection — the variable is stale/);

  const alive = judge({ plans, armedOf: armedDb, env: { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9120' }, portState: { '127.0.0.1:9120': 'serving' } });
  assert.strictEqual(alive.ok, true, 'and a port something is actually serving is accepted — the check is not a blanket refusal');
  ok('a stale host var naming an unserved port → refused; a served one → ready');
}

// ── 16. 🔴 A PORT NOBODY PROBED IS UNKNOWN, NOT FREE ───────────────────────────────────────────
/* `portState[port] !== undefined` skipped unprobed ports, and a probe error was reported as a
   FOREIGN checkout — a verdict about someone else's run rather than an admission we cannot tell.
   Unknown belongs in the verdict that outranks the others. */
{
  const plans = [{ id: 'x-16', plan: { routed: true, services: ['database'], files: [], via: 'npm run test:x' } }];
  const none = judge({ plans, armedOf: armedDb, portState: {} });
  assert.strictEqual(none.code, 'sweep_preflight_unclassifiable', '🔴 a port nobody probed was treated as free');
  assert.match(none.lines.join('\n'), /was never probed/);

  const odd = judge({ plans, armedOf: armedDb, portState: { 9120: 'error:EACCES', 4520: 'free' } });
  assert.strictEqual(odd.code, 'sweep_preflight_unclassifiable', '🔴 a probe that failed for an unknown reason was reported as a foreign checkout');
  assert.match(odd.lines.join('\n'), /neither free nor bound/);
  ok('an unprobed port and a non-bind probe error are both UNCLASSIFIABLE, not free and not foreign');
}

// ── 17. 🔴 A SCRIPT WHOSE CONTENTS CANNOT BE ENUMERATED IS REFUSED, NOT READ AS "RUNS NOTHING" ──
/* An opaque body resolved to files:[] and returned ready — the pre-flight declaring a suite safe
   precisely because it could not see it. The test is not "did we find files" but "could this run a
   JS suite at all". */
{
  const opaque = resolvePlan(['npm', 'run', 'test:x'], { 'test:x': 'node tools/gate-all.js' });
  assert.ok(opaque.unclassifiable, '🔴 an opaque script body was declared safe precisely because it could not be read');
  assert.match(opaque.unclassifiable, /runs node on a file this cannot enumerate/);

  // …but a body that cannot run a suite at all is not refused.
  for (const body of ['firebase deploy --only functions', 'npx web-push generate-vapid-keys', 'node -e "require(\'fs\')"']) {
    const p2 = resolvePlan(['npm', 'run', 'test:x'], { 'test:x': body });
    assert.ok(!p2.unclassifiable, `🔴 "${body}" was refused although it cannot run a JS suite`);
  }
  ok('an unenumerable node script → unclassifiable; a body that cannot run a suite → not refused');
}

// ── 18. 🔴 A GLOB IS EXPANDED FROM DISK — a literal read finds nothing and hides a whole suite ──
{
  const listDir = (d) => (d === '../xpizza-portal' ? ['a.test.mjs', 'b.test.mjs', 'notes.md'] : []);
  const plan = resolvePlan(['npm', 'run', 'test:portal'], { 'test:portal': 'node --test "../xpizza-portal/*.test.mjs"' }, listDir);
  assert.ok(!plan.unclassifiable, 'a glob that expands is not refused');
  assert.deepStrictEqual(plan.files, ['../xpizza-portal/a.test.mjs', '../xpizza-portal/b.test.mjs'],
    '🔴 a globbed suite is invisible to the pre-flight while still running');
  ok('a glob is expanded from disk, so globbed suites are checked like any other');
}

// ── 19. 🔴 TWO PROBE KINDS, BECAUSE THERE ARE TWO QUESTIONS ──────────────────────────────────
/* A port the runner is about to BIND must be free; an endpoint a suite is about to DIAL must accept
   a connection. The first version asked only the bind question and read EADDRINUSE as "an emulator
   is serving this" — which ANY unrelated listener satisfies, and which says nothing about the
   address family the suite will actually use ([::1] can be dead while 127.0.0.1 is held).
   The set probed must also be the set judged: a caller probing a different set is how "never probed"
   silently became "free". */
{
  const plans = [
    { id: 'r', plan: { routed: true, services: ['database'], files: [], via: 'npm run test:r' } },
    { id: 'u', plan: { routed: false, services: [], files: ['test/db.emulator.test.js'], via: 'node x' } },
  ];
  const args = { plans, armedOf: armedDb, env: { FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9120' }, hostVarOf: HOST_VAR, expectedPorts: PORTS, serviceListeners: LISTENERS };
  const probe = portsToProbe(args);

  assert.ok(Array.isArray(probe.bind) && Array.isArray(probe.connect), 'the probe set names both kinds');
  assert.ok(probe.bind.includes(9120), 'the routed band port is BIND-probed — the runner is about to bind it');
  assert.ok(probe.bind.includes(4520), 'and so is the hub');
  assert.deepStrictEqual(probe.connect, ['127.0.0.1:9120'],
    '🔴 the unrouted endpoint is not CONNECT-probed — a bound-but-dead port would read as serving');
  assert.ok(probe.connect.every((e) => e.includes(':')), 'connect targets carry the HOST, not just a port number');

  /* …and the verdict consults exactly what was probed. */
  const state = {};
  for (const p of probe.bind) state[p] = 'free';
  for (const e of probe.connect) state[e] = 'serving';
  const v = preflightVerdict({ ...args, portState: state });
  assert.strictEqual(v.code, 'ready',
    `🔴 the verdict needed something the probe set did not include — the set judged is not the set measured (${v.lines.join('; ')})`);
  ok('bind and connect are probed separately, connect targets carry the host, and the verdict consults exactly the probed set');
}

// ── 20. 🔴 THE SPELLINGS, ROUND THREE — and why it is a parser now ───────────────────────────
/* Round one missed a spaced `require (…)` and an aliased require, and matched a call inside a block
   comment. Round two fixed those by masking literals and comments — and still inspected only the
   FIRST candidate, so an unrelated `require('./setup')()` earlier in the file hid a real arming call
   underneath it. Every fix was another spelling somebody thought of. acorn has no spellings. */
{
  const armed = {
    'ordinary': "require('./_emulator-required')('database');",
    'spaced require': "require ('./_emulator-required')('database');",
    'space before args': "require('./_emulator-required') ('database');",
    'aliased then invoked': "const need = require('./_emulator-required');\nneed('database');",
    'an unrelated require()() FIRST': "require('./setup')();\nrequire('./_emulator-required')('firestore');",
    'alias bound after an unrelated one': "const a = require('./x');\na();\nconst need = require('./_emulator-required');\nneed('database');",
    'arming call nested in a block': "if (process.env.CI) { require('./_emulator-required')('database'); }",
  };
  for (const [name, src] of Object.entries(armed)) {
    assert.ok(armingOf(src), `🔴 a real arming call was not detected (${name}) — the suite would sweep with no emulator and every mutant would DRIFT`);
  }
  const notArmed = {
    'block comment': "/*\n  require('./_emulator-required')('database');\n*/",
    'line comment': "// require('./_emulator-required')('database');",
    'inside a string': "const s = \"require('./_emulator-required')('database')\";",
    'inside a template literal': 'const s = `require("./_emulator-required")("database")`;',
    'bound, never called': "const p = require('./_emulator-required');",
    'prose mention': 'assert.match(src, /_emulator-required/);',
    'a require of a DIFFERENT module, invoked': "require('./helpers')('database');",
  };
  for (const [name, src] of Object.entries(notArmed)) {
    assert.strictEqual(armingOf(src), null, `🔴 a non-call was read as an arming call (${name}) — an honest sweep would be refused`);
  }
  assert.deepStrictEqual(armingOf("require('./_emulator-required')('firestore', 'database');"), ['firestore', 'database'],
    'both services are reported, so a suite needing two emulators is checked for two');

  /* 🔴 AN UNPARSABLE SUITE IS NOT "UNARMED". Returning null would report it as needing no emulator —
     the exact blind spot this exists to close — so it THROWS and the caller refuses as unclassifiable. */
  assert.throws(() => armingOf('function f( { @@@ not javascript'), /arming_detector_unparsable/,
    '🔴 a suite that could not be parsed was reported as needing no emulator');

  ok(`${Object.keys(armed).length} arming spellings detected and ${Object.keys(notArmed).length} non-calls rejected; an unparsable suite refuses rather than reading as unarmed`);
}

// ── 20b. 🔴 A STRING CONTAINING CODE IS DATA — including this file's own fixtures ─────────────
/* Found by running the tool on the tree rather than by reading it: once the detector stripped
   comments but not literals, it matched the arming-call TEXT held in the fixtures above and refused
   THIS FILE as an armed emulator suite. The sweep refused instead of mis-scoring — the pre-flight
   working — but a guard that fails honest runs is the worse of the two directions. */
{
  const fs = require('fs');
  const self = fs.readFileSync(__filename, 'utf8');
  assert.strictEqual(armingOf(self), null,
    '🔴 the detector read its own test fixtures as a live arming call — it cannot tell code from data');

  const inAString = 'const fixture = "require(\'./_emulator-required\')(\'database\');";';
  assert.strictEqual(armingOf(inAString), null, '🔴 an arming call quoted inside a string was read as code');

  // …and the real suites are still all detected, so the fix did not buy silence with blindness.
  const real = fs.readdirSync(require('path').join(__dirname, '..', 'test')).filter((f) => f.endsWith('.emulator.test.js'));
  const armedCount = real.filter((f) => armingOf(fs.readFileSync(require('path').join(__dirname, '..', 'test', f), 'utf8'))).length;
  assert.strictEqual(armedCount, real.length, `🔴 ${real.length - armedCount} real emulator suites stopped being detected`);
  ok(`code and data are distinguished: this file's ${real.length ? '' : ''}fixtures are inert, and all ${real.length} real suites are still detected`);
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
