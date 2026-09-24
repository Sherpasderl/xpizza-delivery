#!/usr/bin/env node
'use strict';
/* Emulator launcher: per-checkout ports, and a preflight that REFUSES rather than attaches.
 *
 * 🔴 WHY THIS EXISTS. Two checkouts of this repo on one machine both ran `firebase emulators:exec`
 * on the Firebase defaults. When a second run started while the first was up, it either failed or
 * ATTACHED to the running emulator and asserted against the OTHER checkout's data — and still
 * reported green. Six suites in one gate re-run were affected. A green suite that read a foreign
 * tree is not evidence about the tree under test.
 *
 * Usage — a drop-in for `firebase emulators:exec`:
 *     node tools/emulator-run.js --only firestore --project demo-xpizza "node test/foo.test.js"
 *
 * Override the port block with XPIZZA_EMU_PORT_OFFSET=<0..390, multiple of 10>.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_CONFIG = path.join(ROOT, 'firebase.json');
const SLOTS = 40;

/* 🔴 EVERY LISTENER FIREBASE OPENS NEEDS A BAND, NOT JUST THE OBVIOUS THREE. Starting `functions`
   also starts Eventarc and Cloud Tasks; the hub always starts; and LOGGING starts too (it shows up
   in every run's shutdown log). Unbanded services take their shared defaults, and the installed CLI
   SEARCHES FOR ANOTHER PORT when one is occupied — retry-instead-of-refuse, the precise behaviour
   this tool exists to remove, reintroduced through a service nobody listed.
   Bands are 400 wide so offsets 0..390 can never make one service's port equal another's. Asserted
   across all slots by cell 3 of tools/emulator-ports.guard.test.js — the previous layout claimed
   disjointness in a comment and was wrong (the websocket band overlapped database's). */
function planPorts(offset) {
  return {
    ui: 4000 + offset,
    hub: 4400 + offset,
    logging: 4800 + offset,
    functions: 5200 + offset,
    eventarc: 5600 + offset,
    tasks: 6000 + offset,
    firestore: 8080 + offset,
    firestoreWebsocket: 8500 + offset,
    database: 9000 + offset,
  };
}

function offsetFor(root) {
  const env = process.env.XPIZZA_EMU_PORT_OFFSET;
  if (env !== undefined && env !== '') {
    const n = Number(env);
    if (!Number.isInteger(n) || n < 0 || n > (SLOTS - 1) * 10 || n % 10 !== 0) {
      console.error(`emulator-run: XPIZZA_EMU_PORT_OFFSET must be a multiple of 10 in 0..${(SLOTS - 1) * 10}, got ${JSON.stringify(env)}`);
      process.exit(2);
    }
    return n;
  }
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* not yet resolvable; the raw path still hashes */ }
  return (crypto.createHash('sha256').update(real).digest().readUInt32BE(0) % SLOTS) * 10;
}

/* Services this runner knows how to pin AND preflight, with the extra listeners each one drags in.
   Adding a service means adding its band above and its listeners here — anything absent is refused
   rather than started on a default. */
const SERVICE_LISTENERS = {
  firestore: ['firestore', 'firestoreWebsocket'],
  database: ['database'],
  functions: ['functions', 'eventarc', 'tasks'],
};
// Host vars the Admin SDK honours. Cleared for every service we are NOT starting, so an inherited
// value from a parent shell can never point a suite at a foreign emulator (see CLEARED_ENV below).
const HOST_ENV = {
  /* Verified by printing the child's environment under the installed CLI, not from memory. Firestore
     exports a second ALIAS the Admin SDK also honours; missing it meant a foreign Firestore could
     still be reached through FIREBASE_FIRESTORE_EMULATOR_ADDRESS after the obvious var was cleared. */
  firestore: ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS'],
  database: ['FIREBASE_DATABASE_EMULATOR_HOST'],
  functions: ['CLOUD_EVENTARC_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST'],
};

/* 🔴 EVERY HOST VAR THE INSTALLED CLI CAN EXPORT, not the ones that came to mind. My first list had
   five holes — the Firestore alias above, both Storage spellings and all three Data Connect
   spellings — and the Admin SDK honours the Storage and Data Connect aliases, so an inherited value
   for a service we are not starting still pointed at a foreign emulator.
   Scraped from firebase-tools 15.16.0's own emulator sources and pinned here rather than read at
   runtime: coupling the runner to CLI internals would break every suite the day the layout changes.
   Cell 15 of tools/emulator-ports.guard.test.js re-scrapes the INSTALLED CLI and fails if it can
   export a host var this list does not cover, so the list cannot drift silently.
   Only *_HOST / *_ADDRESS and the hub belong here. START_LOGGING_EMULATOR and
   FUNCTIONS_EMULATOR_PARALLEL are input toggles, not addresses — clearing those would change
   behaviour rather than prevent an adoption. */
const ALL_HOST_ENV = [
  'CLOUD_EVENTARC_EMULATOR_HOST', 'CLOUD_TASKS_EMULATOR_HOST',
  'DATA_CONNECT_EMULATOR_HOST', 'FIREBASE_DATACONNECT_EMULATOR_HOST', 'FIREBASE_DATA_CONNECT_EMULATOR_HOST',
  'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB',
  'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_LOGGING_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST',
  'PUBSUB_EMULATOR_HOST', 'FUNCTIONS_EMULATOR_HOST',
];

/* Exported so the guard can test it without launching anything: the clearing is the load-bearing
   half of the inherited-host-var fix, and a cell that needed a live emulator to check it would not
   be run often enough to matter. */
function childEnv(services, parentEnv) {
  const env = { ...parentEnv };
  const keep = new Set([].concat(...services.map((s) => HOST_ENV[s] || [])));
  for (const v of ALL_HOST_ENV) if (!keep.has(v)) delete env[v];

  /* 🔴 THE ONE LISTENER WE COULD NOT PIN — REMOVED RATHER THAN DOCUMENTED. Starting `functions` makes
     the CLI discover the source by booting a temporary admin server: basePort = 8000 + randomInt(0,
     1000), then portfinder scans UPWARD from there (lib/deploy/functions/runtimes/node/index.js:190).
     That range covers our own firestore 8080-8470 and websocket 8500-8890 bands, so a discovery
     server can take a port another checkout is about to need — and I watched it happen: a run without
     this opened a listener on *:8015, on ALL interfaces, not even loopback.
     Every consequence of that is loud (a waiting checkout's preflight refuses with exit 3, or its
     emulator fails to bind; no suite can adopt a discovery server, since the addresses come from our
     generated config) — but "loud in every direction" is a worse answer than "not there at all".
     FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH=true takes the CLI's manifest branch on the same
     function: it writes functions.yaml to a temp dir and opens NO PORT. Verified: test:quality-runner
     passes its 17 checks this way, and nothing appears in 8000-8999 during the run.
     Only set when unset — an operator who pointed it at a real path meant it. */
  /* 🔴 A PATH WE OWN, NOT "true". The literal "true" makes the CLI mkdtemp its own
     firebase-discovery-XXXX directory and never remove it — discovery/index.js reads the manifest and
     deletes nothing, so every functions run leaks one. I found four already, all mine, from
     introducing this branch. Pointing it at a directory this process created makes the manifest ours
     to delete, on the same cleanup path as the generated config, signals included. */
  if (services.includes('functions') && !env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH) {
    env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH = discoveryDirFor(process.pid);
  }
  return env;
}

/* Kept out of the repo entirely: a discovery manifest inside the functions source dir would need
   both a .gitignore rule and a functions.ignore rule to stay out of a deploy archive, and the file
   has no reason to live there. Named by pid so a stale one can be told from a live one. */
const DISCOVERY_PREFIX = 'xpizza-emu-discovery.';
const discoveryDirFor = (pid) => path.join(os.tmpdir(), `${DISCOVERY_PREFIX}${pid}`);

/* Preload the cell counter into EVERY node invocation of the inner command.
   🔴 ANCHORED ON `node <file>`, NOT A BARE PREFIX. One routed script is a chain —
   test:rewards:emulator runs six suites joined by `&&` inside the single command string — so a
   `^node ` prefix would preload only the first and the other five would report nothing. Exported so
   that property is DRIVEN rather than asserted by reading: it is the shape the review asked about. */
const injectCounter = (command, counter) =>
  String(command).replace(/\bnode\s+(?=[\w./-]+\.(?:js|mjs)\b)/g, `node -r ${counter} `);

module.exports = { planPorts, offsetFor, SLOTS, ROOT, SERVICE_LISTENERS, ALL_HOST_ENV, HOST_ENV, childEnv, discoveryDirFor, DISCOVERY_PREFIX, injectCounter };
if (require.main !== module) return;

/* 🔴 THE SWEEP RUNS BEFORE ANYTHING THAT CAN EXIT — including offsetFor(), which exits 2 on a
   malformed override. It sat below the --only check once and left strays behind on that path; then
   it sat below offsetFor() and left them behind on THAT path. Cleanup that only runs on the happy
   path is not cleanup. */
for (const f of fs.readdirSync(ROOT)) {
  const m = /^firebase\.emulator\.(\d+)\.json$/.exec(f);
  if (!m) continue;
  let alive = false;
  try { process.kill(Number(m[1]), 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
  if (!alive) { try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* raced with another sweep */ } }
}
// …and our own discovery directories, by the same dead-pid rule.
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (!d.startsWith(DISCOVERY_PREFIX)) continue;
    const pid = Number(d.slice(DISCOVERY_PREFIX.length));
    if (!Number.isInteger(pid)) continue;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
    if (!alive) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch { /* raced */ } }
  }
} catch { /* tmpdir unreadable — nothing to sweep */ }

/* 🔴 ARGUMENTS ARE ALLOWLISTED, NOT SCANNED. Scanning for the FIRST --only while Firebase's parser
   takes the LAST meant `--only firestore --only auth` validated firestore and started an unbanded
   auth emulator; `--config firebase.json` re-pointed the CLI at the committed config and restored the
   DEFAULT ports after we had preflighted different ones; `--ui` overrode enabled:false and started
   the UI; `--inspect-functions` opened an unchecked debug listener. Every one of those bypasses the
   preflight. An allowlist is the only shape where a flag nobody anticipated cannot get through, so
   only --only and --project pass, each at most once, plus exactly one command string. All 42 scripts
   already fit that. Duplicates are refused rather than resolved: the CLI would take the last and this
   runner the first, and a disagreement about which value is real is not something to paper over. */
const argv = process.argv.slice(2);
const opts = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  let name = null, value = null;
  if (a === '--only' || a === '--project') { name = a.slice(2); value = argv[++i]; }
  else if (a.startsWith('--only=') || a.startsWith('--project=')) { const j = a.indexOf('='); name = a.slice(2, j); value = a.slice(j + 1); }
  else if (a.startsWith('-')) {
    console.error(`\nemulator-run: refusing the argument "${a}".`);
    console.error('   Only --only and --project are forwarded. Anything else can change ports or config');
    console.error('   AFTER the preflight has checked different ones (--config, --ui, --inspect-functions),');
    console.error('   which would put this back to attaching silently. Add it here deliberately if it is needed.\n');
    process.exit(2);
  } else { rest.push(a); continue; }
  if (value === undefined || String(value).startsWith('-')) { console.error(`emulator-run: --${name} needs a value`); process.exit(2); }
  if (opts[name] !== undefined) { console.error(`emulator-run: --${name} given twice (${opts[name]} then ${value}); the CLI would use the last and this runner the first — refusing rather than guessing`); process.exit(2); }
  opts[name] = value;
}
if (rest.length !== 1) { console.error(`emulator-run: expected exactly one command string, got ${rest.length}`); process.exit(2); }

const OFFSET = offsetFor(ROOT);
const PORTS = planPorts(OFFSET);
const services = opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : Object.keys(SERVICE_LISTENERS);

/* The hub and the logging emulator come up on every run whether or not they were asked for, so both
   are preflighted unconditionally. The UI is NOT: ui.enabled is false below and --ui is refused
   above, so it cannot start. (An earlier comment here claimed the UI was checked. It was not, and
   saying so was worse than not checking it.) */
const toCheck = [['hub', PORTS.hub], ['logging', PORTS.logging]];
for (const s of services) {
  if (!SERVICE_LISTENERS[s]) {
    console.error(`\nemulator-run: --only names "${s}", which this runner has no port band for.`);
    console.error(`   known: ${Object.keys(SERVICE_LISTENERS).join(', ')}`);
    console.error('   REFUSING: an unpinned emulator takes a shared default port, unpreflighted, and the');
    console.error('   installed CLI will SEARCH FOR ANOTHER PORT if it is busy rather than stop.');
    console.error('   Add its band to planPorts() and its listeners to SERVICE_LISTENERS.\n');
    process.exit(2);
  }
  for (const l of SERVICE_LISTENERS[s]) toCheck.push([l, PORTS[l]]);
}

console.error(`emulator-run: offset ${OFFSET}${process.env.XPIZZA_EMU_PORT_OFFSET ? ' (XPIZZA_EMU_PORT_OFFSET)' : ' (from checkout path)'} — ${toCheck.map(([nm, pt]) => `${nm} ${pt}`).join(', ')}`);

/* 🔴 THE RACE, STATED RATHER THAN PAPERED OVER. Preflight binds, releases, then launches, so two runs
   starting in the same instant can both see a free port. Not closable from here — holding the socket
   would stop firebase binding it. What bounds it: two different checkouts never share a band unless
   they hash to the same slot; concurrent runs in ONE checkout are already forbidden; and if the race
   is lost, the second firebase fails to bind and exits non-zero rather than attaching, because the
   hub port is per-checkout too and hub discovery is how a foreign emulator gets adopted. */

const probe = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (e) => resolve(e && e.code === 'EADDRINUSE' ? 'in-use' : `error:${(e && e.code) || e}`));
  srv.once('listening', () => srv.close(() => resolve('free')));
  srv.listen(port, '127.0.0.1');
});

(async () => {
  const taken = [];
  for (const [name, port] of toCheck) {
    const state = await probe(port);
    if (state !== 'free') taken.push({ name, port, state });
  }
  if (taken.length) {
    console.error('\n🔴 EMULATOR REFUSED TO START — a port this checkout needs is already bound.\n');
    for (const t of taken) console.error(`   ${t.name.padEnd(22)} 127.0.0.1:${t.port}   ${t.state}`);
    console.error(`\n   checkout : ${ROOT}`);
    console.error(`   offset   : ${OFFSET}${process.env.XPIZZA_EMU_PORT_OFFSET ? ' (from XPIZZA_EMU_PORT_OFFSET)' : ' (derived from the checkout path)'}`);
    console.error('\n   REFUSING rather than attaching. An emulator already on this port belongs to another run —');
    console.error('   attaching to it would assert against a different tree and still report green.');
    console.error(`   Find it with:  lsof -nP -iTCP:${taken[0].port} -sTCP:LISTEN`);
    console.error('   Or pick another block:  XPIZZA_EMU_PORT_OFFSET=<multiple of 10, 0..390>\n');
    process.exit(3);
  }

  const base = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  base.emulators = {
    firestore: { host: '127.0.0.1', port: PORTS.firestore, websocketPort: PORTS.firestoreWebsocket },
    database: { host: '127.0.0.1', port: PORTS.database },
    functions: { host: '127.0.0.1', port: PORTS.functions },
    eventarc: { host: '127.0.0.1', port: PORTS.eventarc },
    tasks: { host: '127.0.0.1', port: PORTS.tasks },
    logging: { host: '127.0.0.1', port: PORTS.logging },
    hub: { host: '127.0.0.1', port: PORTS.hub },
    ui: { enabled: false, host: '127.0.0.1', port: PORTS.ui },
    /* 🔴 NO singleProjectMode. It changes what the emulator ACCEPTS, not where it listens, and several
       rules suites deliberately use their own project ids. Two changes in one commit message. */
  };
  const generated = path.join(ROOT, `firebase.emulator.${process.pid}.json`);
  fs.writeFileSync(generated, JSON.stringify(base, null, 2) + '\n');

  const discoveryDir = services.includes('functions') ? discoveryDirFor(process.pid) : null;
  if (discoveryDir) fs.mkdirSync(discoveryDir, { recursive: true });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.unlinkSync(generated); } catch { /* already gone */ }
    if (discoveryDir) { try { fs.rmSync(discoveryDir, { recursive: true, force: true }); } catch { /* already gone */ } }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

  /* 🔴 CLEAR THE HOST VARS WE ARE NOT SERVING. Firebase only sets the host variable for a service it
     actually starts, and this process inherits the whole environment — so a suite launched with
     `--only database` in a shell that still carries a FIRESTORE_EMULATOR_HOST from somewhere else
     reads THAT emulator, silently, and reports green. That is the shape of test:rewards-intake and
     test:intake-availability. An inherited value is never trustworthy here: if we are not starting
     the service, the variable must be absent, so a suite that needs it fails loudly instead. */
  const env = childEnv(services, process.env);

  /* 🔴 THE CELL COUNTER IS INJECTED INTO THE SUITE, NOT INHERITED BY THE CLI. tools/count-marks.js
     must load in the process that writes the ASSERTIONS and nowhere else: firebase is itself node, so
     an inherited NODE_OPTIONS would make the CLI count its own "✔ firestore: …" chrome — the exact
     inflation the counter exists to remove, reintroduced one level up. Injecting here instead means
     nothing is inherited and no guard has to know which process it is in.

     Anchored on `node <file>`, not a bare prefix, because ONE script is a chain —
     test:rewards:emulator runs six suites joined by `&&` inside the single command string — and a
     prefix would preload only the first. Every routed script is `node <file>` repeated, so this is
     regular rather than a general shell rewrite. If a shape ever escapes it, the suite runs WITHOUT
     the preload, emits no ##CELLS trailer, and gate-all fails it: a missed injection is loud. */
  const COUNTER = path.join(ROOT, 'tools', 'count-marks.js');
  const inner = injectCounter(rest[0], COUNTER);
  if (!/count-marks\.js/.test(inner)) {
    console.error(`\nemulator-run: could not inject the cell counter into ${JSON.stringify(rest[0])}.`);
    console.error('   The suite would run uncounted and the gate would fail it for a missing trailer.');
    console.error('   Expected a command of the form `node <file>` (possibly chained with &&).\n');
    process.exit(2);
  }
  /* …and it must not reach firebase through the environment either. */
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim() || undefined;

  const child = spawn('firebase', ['emulators:exec', '--config', generated, ...(opts.project ? ['--project', opts.project] : []), '--only', services.join(','), inner], { stdio: 'inherit', cwd: ROOT, env });
  child.on('error', (e) => { cleanup(); console.error(`emulator-run: could not launch firebase — ${e && e.message}`); process.exit(1); });
  child.on('exit', (code, signal) => {
    cleanup();
    // The suite's own exit code is the result. A wrapper that swallowed it would turn a red suite green.
    process.exit(signal ? 1 : (code === null ? 1 : code));
  });
})();
