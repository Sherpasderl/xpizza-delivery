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

/* 🔴 "ARMED" IS A CALL, NOT A SUBSTRING — AND NOT A SINGLE SPELLING EITHER. The first version of
   this matched one shape and was wrong in both directions at once: it MISSED `require (…)(…)` with a
   space, MISSED an aliased require invoked on a later line, and MATCHED a call sitting inside a block
   comment. A missed arming reports a suite as needing no emulator, which is the blind spot this whole
   file exists to close; a false match refuses an honest sweep, which is worse than the drift because
   it fails runs that were fine. tools/emulator-ports.guard.test.js cell 11 remains the property
   itself — it SPAWNS each suite against a hostile host var and requires a refusal. This is the cheap
   static half, used only to decide which suites a sweep must establish an emulator for, and anything
   it cannot prove is reported rather than assumed. */
const { stripComments, maskLiterals } = require('./strip-comments.js');
const SENT = '\\u0000(\\d+)\\u0000';

function armingOf(source) {
  /* Comments out, then literals MASKED — a fixture holding the TEXT of an arming call collapses to a
     single sentinel and cannot match, while a genuine call keeps its structure with its module path
     and service names recoverable. Matching raw source confuses code with data in both directions. */
  const { code, literals } = maskLiterals(stripComments(source));
  const isModule = (n) => /_emulator-required/.test(literals[Number(n)] || '');
  const servicesFrom = (argText) => {
    const out = [];
    for (const m of String(argText || '').matchAll(new RegExp(SENT, 'g'))) {
      const v = literals[Number(m[1])];
      if (v) out.push(v);
    }
    return out.length ? out : null;
  };

  const direct = new RegExp(`require\\s*\\(\\s*${SENT}\\s*\\)\\s*\\(([^)]*)\\)`).exec(code);
  if (direct && isModule(direct[1])) return servicesFrom(direct[2]);

  /* const need = require('…');  …later…  need('database')
     The alias must be BOUND to this module and then INVOKED; binding alone is not arming. */
  const bind = new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*require\\s*\\(\\s*${SENT}\\s*\\)`).exec(code);
  if (bind && isModule(bind[2])) {
    const call = new RegExp(`(?:^|[^\\w$.])${bind[1]}\\s*\\(([^)]*)\\)`, 'm').exec(code);
    if (call) return servicesFrom(call[1]);
  }
  return null;
}

/* Resolve one mutant command into what it will actually run.
 *
 * 🔴 AN UNRECOGNISED SHAPE IS REFUSED, NOT ASSUMED HARMLESS. The whole point of this pre-flight is
 * that an armed suite never runs without an emulator established for it. A command shape this cannot
 * read might run one, so it returns `unclassifiable` and the caller refuses. Silently treating it as
 * "probably not emulator" would reintroduce exactly the blind spot being closed. */
function resolvePlan(command, scripts, listDir) {
  const cmd = command || ['npm', 'test'];
  const [bin, ...args] = cmd;

  if (bin === 'npm') {
    const script = args[0] === 'run' ? args[1] : (args[0] === 'test' ? 'test' : null);
    if (!script) return { unclassifiable: `npm invoked as ${JSON.stringify(cmd)} — not \`npm test\` or \`npm run <script>\`` };
    const body = scripts[script];
    if (body === undefined) return { unclassifiable: `package.json has no script "${script}"` };
    return planFromScript(script, body, listDir);
  }
  if (bin === 'node') {
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { unclassifiable: `node invoked with no file: ${JSON.stringify(cmd)}` };
    return { routed: false, services: [], files, via: cmd.join(' ') };
  }
  return { unclassifiable: `command does not start with npm or node: ${JSON.stringify(cmd)}` };
}

function planFromScript(name, body, listDir) {
  const routed = /emulator-run\.js/.test(body);
  const files = filesIn(body, listDir);

  /* 🔴 A SCRIPT WHOSE CONTENTS WE CANNOT ENUMERATE IS REFUSED, NOT READ AS "RUNS NOTHING". An opaque
     body resolved to `files: []`, which the verdict then read as "no armed suite here" and returned
     ready — the pre-flight declaring a suite safe precisely because it could not see it. The test is
     not "did we find files" but "could this run a JS suite at all": a body that invokes node on a
     FILE we did not recognise might run anything (test:gate runs the whole gate), while one that
     never invokes node on a file (firebase deploy, npx, node -e) cannot run a suite. */
  if (!files.length && runsNodeOnAFile(body)) {
    return { unclassifiable: `script "${name}" runs node on a file this cannot enumerate, so whether it needs an emulator is unknown: ${body.trim().slice(0, 120)}` };
  }
  if (!routed) return { routed: false, services: [], files, via: `npm run ${name}` };

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

/* Does this body hand node a FILE? `node -e "…"` and `npx …` cannot run a suite from disk. */
function runsNodeOnAFile(body) {
  for (const m of String(body).matchAll(/(?:^|[\s&|;"'])node\s+([^&|;"']*)/g)) {
    const args = m[1].split(/\s+/).filter(Boolean);
    if (args.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print')) continue;
    if (args.some((a) => !a.startsWith('-') && /\.(?:js|mjs|cjs)$/.test(a))) return true;
  }
  return false;
}

/* Test files a script names, INCLUDING glob expansion from disk — test:portal names
   `../xpizza-portal/*.test.mjs`, and a literal read of that finds nothing, which is how a suite
   becomes invisible to the pre-flight while still running. */
function filesIn(body, listDir) {
  const out = [];
  const LITERAL = /(?:^|[\s"'])((?:\.\.\/)?[A-Za-z0-9._\/-]+\.(?:test\.js|test\.mjs|guard\.test\.js))/g;
  for (const m of String(body).matchAll(LITERAL)) out.push(m[1]);

  const GLOB = /(?:^|[\s"'])((?:\.\.\/)?[A-Za-z0-9._\/-]*\*[A-Za-z0-9._\/*-]*\.(?:test\.js|test\.mjs|m?js))/g;
  for (const m of String(body).matchAll(GLOB)) {
    const pattern = m[1];
    const slash = pattern.lastIndexOf('/');
    const dir = slash === -1 ? '.' : pattern.slice(0, slash);
    const base = slash === -1 ? pattern : pattern.slice(slash + 1);
    const rx = new RegExp('^' + base.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    let entries;
    try { entries = listDir ? listDir(dir) : []; } catch (_) { entries = null; }
    /* A glob we cannot expand is NOT silently empty — that is the same "could not see it" that made
       an opaque body read as safe. It is surfaced by leaving the list empty AND letting the caller's
       runsNodeOnAFile test refuse, since a glob always arrives as an argument to node. */
    if (!entries) continue;
    for (const e of entries) if (rx.test(e)) out.push(dir === '.' ? e : `${dir}/${e}`);
  }
  return [...new Set(out)];
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
  const needFree = new Map();           // port -> listener, for routed plans (the runner must be able to BIND)
  const needServed = new Map();         // port -> what, for unrouted plans (something must ANSWER)

  for (const { id, plan } of plans) {
    if (plan.unclassifiable) { unclassifiable.push(`${id}: ${plan.unclassifiable}`); continue; }

    const armedHere = [];
    for (const f of plan.files) {
      let services;
      try { services = armedOf(f); } catch (e) {
        unclassifiable.push(`${id}: cannot read ${f} to tell whether it needs an emulator (${(e && e.message) || e})`);
        continue;
      }
      if (services) armedHere.push({ file: f, services });
    }

    if (plan.routed) {
      /* 🔴 THE RUNNER MUST START WHAT THE SUITE ACTUALLY ARMS ITSELF FOR. This used to check only
         that the runner's own ports were free, never that its --only serves the suite. A
         database-armed suite routed through `--only firestore` therefore returned ready — and its
         require-time refusal became exactly the drift this file exists to prevent. The suite says
         what it needs; the script says what is started; a gap between them is a refusal. */
      const started = new Set(plan.services);
      for (const { file, services } of armedHere) {
        for (const s of services) {
          if (!started.has(s)) {
            noEmulator.push(`${id}: ${file} arms itself for the ${s} emulator, but ${plan.via} starts only ${plan.services.join(', ')} — the suite would refuse at require time`);
          }
        }
      }
      for (const s of plan.services) {
        const listeners = (serviceListeners && serviceListeners[s]) || [s];
        for (const l of [...listeners, 'hub']) {
          const port = expectedPorts[l];
          if (port === undefined) { unclassifiable.push(`${id}: service "${s}" opens listener "${l}", which has no port band`); continue; }
          if (!needFree.has(port)) needFree.set(port, l);
        }
      }
      continue;
    }

    /* Unrouted, and it runs an armed suite: nothing will establish the emulator, so the ambient
       variables are all that stand between this suite and real infrastructure or a foreign emulator. */
    for (const { file, services } of armedHere) {
      /* 🔴 THE HUB IS CHECKED WHETHER OR NOT THE SUITE NAMED IT. rules-unit-testing DISCOVERS its
         endpoints through FIREBASE_EMULATOR_HUB and PREFERS what it discovers over the per-service
         variables — so a perfectly correct database address plus a FOREIGN hub still points the suite
         at another checkout, and _emulator-required refuses it. Omitting this check here meant the
         pre-flight returned ready for a configuration the suite itself rejects. */
      const checks = services.map((s) => [(hostVarOf && hostVarOf[s] || [])[0], expectedPorts[s], s, true]);
      checks.push(['FIREBASE_EMULATOR_HUB', expectedPorts.hub, 'hub', false]);

      for (const [varName, want, what, required] of checks) {
        const raw = varName ? env[varName] : undefined;
        if (!raw) {
          if (required) noEmulator.push(`${id}: ${file} needs the ${what} emulator and ${varName || `(no host var for "${what}")`} is not set — via ${plan.via}`);
          continue;                    // an absent hub is fine; an absent service var is not
        }
        const i = String(raw).lastIndexOf(':');
        const host = (i > 0 ? String(raw).slice(0, i) : String(raw)).replace(/^\[|\]$/g, '');
        const portText = i > 0 ? String(raw).slice(i + 1) : '';
        if (!LOOPBACK.has(host)) { foreign.push(`${id}: ${varName}=${raw} is not loopback — the sweep would assert against another machine's emulator (via ${plan.via})`); continue; }
        if (!/^\d+$/.test(portText)) { foreign.push(`${id}: ${varName}=${raw} has no readable port, so it cannot be checked against this checkout's band (via ${plan.via})`); continue; }
        if (want !== undefined && Number(portText) !== want) {
          foreign.push(`${id}: ${varName}=${raw} is not this checkout's ${what} port (expected ${want}) — another checkout's emulator (via ${plan.via})`);
          continue;
        }
        /* 🔴 A CORRECTLY-NUMBERED ADDRESS IS NOT A RUNNING EMULATOR. A stale variable left by a run
           that has since exited names exactly the right port with nothing behind it; the suite then
           fails on connection errors and every mutant DRIFTS. The number being right was treated as
           the emulator being there. */
        if (!needServed.has(Number(portText))) needServed.set(Number(portText), `${what} (${varName})`);
      }
    }
  }

  if (unclassifiable.length) {
    return { ok: false, code: 'sweep_preflight_unclassifiable', lines: unclassifiable,
      detail: 'the pre-flight could not determine what these mutants run, so it cannot promise an armed suite has an emulator' };
  }

  /* 🔴 A PORT WE DID NOT PROBE IS UNKNOWN, NOT FREE — and a probe that failed for a reason other
     than "already bound" is unknown too. Both used to pass: `portState[port] !== undefined` skipped
     unprobed ports, and an `error:EACCES` was reported as a FOREIGN checkout, which is a verdict
     about someone else's run rather than an admission that we cannot tell. Unknown belongs in the
     verdict that outranks the others, which is exactly why that verdict exists. */
  const unknown = [];
  const bound = [];
  for (const [port, what] of needFree) {
    const st = portState[port];
    if (st === undefined) unknown.push(`port ${port} (${what}) was never probed, so this cannot tell whether the runner could bind it`);
    else if (st === 'free') continue;
    else if (st === 'in-use') bound.push(`${String(what).padEnd(20)} 127.0.0.1:${port}   in-use`);
    else unknown.push(`port ${port} (${what}) probed as "${st}", which is neither free nor bound — this cannot tell whether the runner could start`);
  }
  const dead = [];
  for (const [port, what] of needServed) {
    const st = portState[port];
    if (st === undefined) unknown.push(`port ${port} (${what}) was never probed, so this cannot tell whether an emulator is actually serving it`);
    else if (st === 'in-use') continue;                 // something is answering — what we want here
    else if (st === 'free') dead.push(`${String(what).padEnd(20)} 127.0.0.1:${port}   nothing is listening — the variable is stale`);
    else unknown.push(`port ${port} (${what}) probed as "${st}", which is neither free nor bound`);
  }
  if (unknown.length) {
    return { ok: false, code: 'sweep_preflight_unclassifiable', lines: unknown,
      detail: 'the pre-flight could not establish the state of a port it depends on, so it cannot promise an armed suite has an emulator' };
  }

  if (bound.length || foreign.length || dead.length) {
    return { ok: false, code: 'sweep_preflight_foreign_checkout',
      lines: [...bound, ...dead, ...foreign],
      detail: bound.length
        ? 'a port this checkout needs is already bound, so the runner would refuse to start and every armed suite would DRIFT'
        : dead.length
          ? 'a host variable names the right port but nothing is serving it, so every armed suite would fail to connect and DRIFT'
          : 'the environment points at an emulator that is not this checkout\'s, so armed suites would refuse and DRIFT' };
  }
  if (noEmulator.length) {
    return { ok: false, code: 'sweep_preflight_no_emulator', lines: noEmulator,
      detail: 'an armed suite would run with no emulator established for what it needs, so it would refuse at require time and DRIFT' };
  }
  return { ok: true, code: 'ready', lines: [], detail: 'every armed suite has an emulator this checkout owns' };
}

/* Which ports the caller must probe, and what each must look like. Exported so probing (I/O) stays
   in the caller while the SET is derived by the same logic that will judge it — a caller that probed
   a different set is how "never probed" silently became "free". */
function portsToProbe({ plans, armedOf, env, hostVarOf, expectedPorts, serviceListeners }) {
  const ports = new Set();
  for (const { plan } of plans) {
    if (!plan || plan.unclassifiable) continue;
    if (plan.routed) {
      for (const s of plan.services) {
        for (const l of [...((serviceListeners && serviceListeners[s]) || [s]), 'hub']) {
          if (expectedPorts[l] !== undefined) ports.add(expectedPorts[l]);
        }
      }
      continue;
    }
    for (const f of plan.files) {
      let services; try { services = armedOf(f); } catch (_) { continue; }
      if (!services) continue;
      const vars = services.map((s) => (hostVarOf && hostVarOf[s] || [])[0]).concat('FIREBASE_EMULATOR_HUB');
      for (const v of vars) {
        const raw = v ? env[v] : undefined;
        if (!raw) continue;
        const i = String(raw).lastIndexOf(':');
        const portText = i > 0 ? String(raw).slice(i + 1) : '';
        if (/^\d+$/.test(portText)) ports.add(Number(portText));
      }
    }
  }
  return [...ports];
}

module.exports = { armingOf, resolvePlan, planFromScript, preflightVerdict, portsToProbe };
