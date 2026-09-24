'use strict';
/* Mutation-sweep pre-flight — REFUSE ONCE, UP FRONT, rather than drift N times.
 *
 * 🔴 WHY THIS FILE EXISTS. tools/mutation-sweep.js launches every suite with an INHERITED
 * environment (`{...process.env}`) and never establishes an emulator itself. Before
 * test/_emulator-required.js existed, a sweep launched outside the runner used whatever emulator it
 * found — a FOREIGN checkout's included — and scored GREEN against another tree. The guard replaced
 * that silent-wrong with a loud one: it refuses at REQUIRE time, before any assertion.
 *
 * But the sweep reads a nonzero exit as "the suite noticed" and scores the mutant KILLED on no
 * recorded `kills_with` — i.e. DRIFTED. So an ENVIRONMENT fault arrives disguised as a MUTATION
 * FINDING, once per mutant, and it drifts every mutant an armed suite kills while leaving
 * non-emulator mutants clean. That happened: a peer's sweep read `pah` 1/6 with pah-01..05 DRIFTED
 * (all five killed by the one armed suite) and pah-06 killed normally (a plain node test). The
 * cause was one line — the runner refusing because a port this checkout needs was already bound —
 * and it cost a full gate round to find, because five drifted mutants look exactly like a finding.
 *
 * 🔴 ONE REFUSAL, NAMING THE REASON, BEFORE ANYTHING IS SCORED. A partial sweep must never be
 * readable as evidence, so a refusal exits nonzero with NOTHING scored — the same rule the empty
 * selection and stray-.bak guards already enforce above it.
 *
 * The verdict is PURE: it takes the resolved plans, the armed set, the environment, this checkout's
 * expected ports and an already-probed port state. Probing is I/O and lives in the caller, so every
 * branch here is drivable without a socket or an emulator.
 */

/* 🔴 "ARMED" IS A CALL, NOT A SUBSTRING. tools/emulator-ports.guard.test.js cell 11 learned this the
   hard way: asserting a file CONTAINED "_emulator-required" passed for a file that merely mentioned
   it in prose, and for one with the line commented out. That guard now SPAWNS each suite against a
   hostile host var and requires a refusal — the property itself. This detector is the cheap static
   half used to decide which suites a sweep must establish an emulator for, so it matches a top-level
   invocation and nothing else. It is deliberately stricter than a grep: a file it cannot prove is
   armed is reported as such, and the caller refuses rather than skipping it. */
const ARMING_CALL = /^\s*require\(\s*['"][^'"]*_emulator-required['"]\s*\)\s*\(([^)]*)\)/m;

function armingOf(source) {
  const m = ARMING_CALL.exec(String(source || ''));
  if (!m) return null;
  const services = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return services.length ? services : null;
}

/* Resolve one mutant command into what it will actually run.
 *
 * 🔴 AN UNRECOGNISED SHAPE IS REFUSED, NOT ASSUMED HARMLESS. The whole point of this pre-flight is
 * that an armed suite never runs without an emulator established for it. A command shape this cannot
 * read might run one, so it returns `unclassifiable` and the caller refuses. Silently treating it as
 * "probably not emulator" would reintroduce exactly the blind spot being closed. */
function resolvePlan(command, scripts) {
  const cmd = command || ['npm', 'test'];
  const [bin, ...args] = cmd;

  if (bin === 'npm') {
    const script = args[0] === 'run' ? args[1] : (args[0] === 'test' ? 'test' : null);
    if (!script) return { unclassifiable: `npm invoked as ${JSON.stringify(cmd)} — not \`npm test\` or \`npm run <script>\`` };
    const body = scripts[script];
    if (body === undefined) return { unclassifiable: `package.json has no script "${script}"` };
    return planFromScript(script, body);
  }
  if (bin === 'node') {
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { unclassifiable: `node invoked with no file: ${JSON.stringify(cmd)}` };
    return { routed: false, services: [], files, via: cmd.join(' ') };
  }
  return { unclassifiable: `command does not start with npm or node: ${JSON.stringify(cmd)}` };
}

function planFromScript(name, body) {
  const routed = /emulator-run\.js/.test(body);
  const files = [...String(body).matchAll(/(?:^|[\s"'])((?:\.\.\/)?[A-Za-z0-9._\/-]+\.(?:test\.js|test\.mjs|guard\.test\.js))/g)].map((m) => m[1]);
  if (!routed) return { routed: false, services: [], files, via: `npm run ${name}` };

  /* The runner allowlists --only and takes it at most once; a routed script with no --only would
     start every service on this checkout's band, which is a different precondition than the one
     checked here — so it is refused rather than guessed at. */
  /* 🔴 THE SERVICE LIST IS COMPUTED FAIL-CLOSED, NOT GUARDED-THEN-INDEXED. Written as
     `if (!only) return …; only[1].split(…)` the refusal and the use were coupled by ORDER: remove the
     guard and the next line throws a TypeError. A crash is not a decision — it exits nonzero, which
     this harness reads as "the suite noticed", so the property would be scored as guarded by a stack
     trace. Deriving the list first means a missing --only yields an empty list and the refusal below
     is an ordinary branch that cannot be short-circuited into a crash. */
  const only = /--only[= ]([A-Za-z0-9,]+)/.exec(body);
  const services = only ? only[1].split(',').filter(Boolean) : [];
  if (!services.length) return { unclassifiable: `script "${name}" routes the runner but names no --only, so the services it starts are unknown` };
  return { routed: true, services, files, via: `npm run ${name}` };
}

/* The pure verdict.
 *
 *   plans        : [{ id, plan }]                    resolved commands, one per selected mutant
 *   armedOf      : (file) => string[] | null         services a suite arms itself for, null if not armed
 *                                                    (throws for a file it cannot read — see below)
 *   env          : { VAR: value }                    the environment the sweep would hand each suite
 *   hostVarOf    : { service: [VAR, ...] }           which vars the Admin SDK honours per service
 *   expectedPorts: { service: port }                 planPorts(offsetFor(ROOT)) for THIS checkout
 *   portState    : { port: 'free' | 'in-use' | ... } already probed by the caller
 */
function preflightVerdict({ plans, armedOf, env, hostVarOf, expectedPorts, portState, serviceListeners }) {
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
  const unclassifiable = [];
  const noEmulator = [];
  const foreign = [];
  const needPorts = new Map();          // port -> service name, union over every routed plan

  for (const { id, plan } of plans) {
    if (plan.unclassifiable) { unclassifiable.push(`${id}: ${plan.unclassifiable}`); continue; }

    /* Which armed suites does this command run? A file we cannot read is NOT skipped — it is
       reported, because "I could not tell" and "it is fine" are the two readings this whole file
       exists to keep apart. */
    let armedHere = [];
    for (const f of plan.files) {
      let services;
      try { services = armedOf(f); } catch (e) {
        unclassifiable.push(`${id}: cannot read ${f} to tell whether it needs an emulator (${(e && e.message) || e})`);
        continue;
      }
      if (services) armedHere.push({ file: f, services });
    }

    if (plan.routed) {
      /* The runner will establish the environment itself, so the ambient vars do not matter. What
         CAN still fail is the bind: the runner probes its band and exits 3 when a port is held by
         another run. That is the exact failure that produced the drifted sweep, so it is predicted
         here instead of being discovered once per mutant. */
      for (const s of plan.services) {
        const listeners = (serviceListeners && serviceListeners[s]) || [s];
        for (const l of [...listeners, 'hub']) {
          const port = expectedPorts[l];
          if (port === undefined) { unclassifiable.push(`${id}: service "${s}" opens listener "${l}", which has no port band`); continue; }
          if (!needPorts.has(port)) needPorts.set(port, l);
        }
      }
      continue;
    }

    /* Unrouted, and it runs an armed suite: nothing will establish the emulator, so the ambient
       variables are the only thing standing between this suite and either real infrastructure or
       somebody else's emulator. */
    for (const { file, services } of armedHere) {
      for (const s of services) {
        const vars = (hostVarOf && hostVarOf[s]) || [];
        const primary = vars[0];
        const raw = primary ? env[primary] : undefined;
        if (!raw) {
          noEmulator.push(`${id}: ${file} needs the ${s} emulator and ${primary || `(no host var for "${s}")`} is not set — via ${plan.via}`);
          continue;
        }
        const i = String(raw).lastIndexOf(':');
        const host = (i > 0 ? String(raw).slice(0, i) : String(raw)).replace(/^\[|\]$/g, '');
        const portText = i > 0 ? String(raw).slice(i + 1) : '';
        if (!LOOPBACK.has(host)) { foreign.push(`${id}: ${primary}=${raw} is not loopback — that is another machine's emulator (via ${plan.via})`); continue; }
        if (!/^\d+$/.test(portText)) { foreign.push(`${id}: ${primary}=${raw} has no readable port, so it cannot be checked against this checkout's band (via ${plan.via})`); continue; }
        const want = expectedPorts[s];
        if (want !== undefined && Number(portText) !== want) {
          foreign.push(`${id}: ${primary}=${raw} is not this checkout's ${s} port (expected ${want}) — another checkout's emulator (via ${plan.via})`);
        }
      }
    }
  }

  /* 🔴 UNCLASSIFIABLE IS REPORTED FIRST AND ON ITS OWN. It is not a third flavour of environment
     fault — it means the pre-flight could not decide, and a pre-flight that cannot decide must not
     let the sweep proceed on the strength of the checks it DID manage. */
  if (unclassifiable.length) {
    return { ok: false, code: 'sweep_preflight_unclassifiable', lines: unclassifiable,
      detail: 'the pre-flight could not determine what these mutants run, so it cannot promise an armed suite has an emulator' };
  }

  const bound = [...needPorts.entries()]
    .filter(([port]) => portState[port] !== undefined && portState[port] !== 'free')
    .map(([port, name]) => `${name.padEnd(20)} 127.0.0.1:${port}   ${portState[port]}`);

  /* 🔴 BOTH REASONS ARE REPORTED, AND THEY ARE NAMED DIFFERENTLY. "No emulator configured" is fixed
     by running through the runner; "configured for another checkout" is fixed by finding the other
     run and waiting, or by taking a different band. Collapsing them into one message sent the last
     investigation down the wrong path for a round. */
  if (bound.length || foreign.length) {
    return { ok: false, code: 'sweep_preflight_foreign_checkout',
      lines: [...bound, ...foreign],
      detail: bound.length
        ? 'a port this checkout needs is already bound, so the runner would refuse to start and every armed suite would DRIFT'
        : 'the environment points at an emulator that is not this checkout\'s, so armed suites would refuse and DRIFT' };
  }
  if (noEmulator.length) {
    return { ok: false, code: 'sweep_preflight_no_emulator', lines: noEmulator,
      detail: 'an armed suite would run with no emulator established, so it would refuse at require time and DRIFT' };
  }
  return { ok: true, code: 'ready', lines: [], detail: 'every armed suite has an emulator this checkout owns' };
}

module.exports = { armingOf, resolvePlan, planFromScript, preflightVerdict };
