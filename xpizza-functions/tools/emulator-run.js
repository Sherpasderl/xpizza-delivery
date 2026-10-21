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
const fs = require('fs');
const os = require('os');
const path = require('path');
const EE = require('../lib/emulator-endpoint');
const ALLOC = require('./emu-alloc');

const ROOT = path.join(__dirname, '..');
const BASE_CONFIG = path.join(ROOT, 'firebase.json');
const SLOTS = EE.SLOTS;

/* 🔴 EVERY LISTENER FIREBASE OPENS NEEDS A BAND, NOT JUST THE OBVIOUS THREE. Starting `functions`
   also starts Eventarc and Cloud Tasks; the hub always starts; and LOGGING starts too. Bands are 400
   wide so offsets 0..390 can never make one service's port equal another's (cell 3 of the guard).
   R1: the table lives in lib/emulator-endpoint.js so the validator and the launcher cannot disagree. */
const planPorts = EE.planPorts;

/* R1: the slot is no longer derived from the checkout path (40 slots, ~60 worktrees: birthday collisions
   shared bands). It is OWNED per run by a sentinel socket (tools/emu-alloc.js). XPIZZA_EMU_PORT_OFFSET is
   still honoured — as a PIN that goes through the same arbitration and refuses rather than queues. */
function pinFromEnv(env = process.env) {
  const raw = env.XPIZZA_EMU_PORT_OFFSET;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > (SLOTS - 1) * 10 || n % 10 !== 0 || !/^\d+$/.test(String(raw))) {
    console.error(`emulator-run: XPIZZA_EMU_PORT_OFFSET must be a multiple of 10 in 0..${(SLOTS - 1) * 10}, got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n / 10;
}

/* Services this runner knows how to pin AND preflight, with the extra listeners each one drags in.
   Adding a service means adding its band above and its listeners here — anything absent is refused
   rather than started on a default. */
const SERVICE_LISTENERS = {
  firestore: ['firestore', 'firestoreWebsocket'],
  database: ['database'],
  functions: ['functions', 'eventarc', 'tasks'],
  // Optional, and never implied: a suite that needs real Auth names it (`--only firestore,database,auth`). One listener.
  auth: ['auth'],
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
  auth: ['FIREBASE_AUTH_EMULATOR_HOST'],
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
function childEnv(services, parentEnv, run = null) {
  const env = { ...parentEnv };
  const keep = new Set([].concat(...services.map((s) => HOST_ENV[s] || [])));
  for (const v of ALL_HOST_ENV) if (!keep.has(v)) delete env[v];
  /* 🔴 R1 (advisor-approved): a data service this run does NOT start gets the NULL endpoint, never an absent var.
     Absent meant "the Admin SDK goes to production" for whatever touched it; lib/admin.js now REFUSES a
     half-configured process, and the NULL endpoint (127.0.0.1:1 — privileged, never bound) is the one value that
     is valid, unreachable by construction, and fails fast through the NULL guard. */
  for (const svc of EE.DATA_SERVICES) {
    if (!services.includes(svc)) env[EE.HOST_VAR[svc]] = EE.NULL_ENDPOINT;
  }
  // Inherited run identity is never trusted: a nested or stale value would name someone else's slot. An inherited
  // FIREBASE_CONFIG is scrubbed too (codex R1-build P2-6): the CLI derives the run's own from --project for the suite.
  for (const v of [ALLOC.RUN_VAR, ALLOC.OFFSET_VAR, EE.SERVICES_VAR, EE.DEAD_VAR, 'FIREBASE_CONFIG', 'XPIZZA_EMU_FS_RULES', 'XPIZZA_EMU_STARTED_FILE']) delete env[v];
  // R3 P1-a (codex r2 P1-1c): a test process never holds a REAL credential — every secret key (tools/secret-env.js: the
  // reviewed list ∪ the functions .env* key NAMES) is removed from the suite's environment; suites set their own fakes
  require('./secret-env').scrub(env);
  if (run) {
    env[ALLOC.RUN_VAR] = ALLOC.formatMarker(run);
    env[ALLOC.OFFSET_VAR] = String(run.slot * 10);
    env[EE.SERVICES_VAR] = services.join(',');
  }

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
     🔴 ALWAYS this run's own directory (codex R1-build P1-4): an INHERITED value used to be kept, so two worktrees
     inheriting one path shared functions.yaml. An inherited value is overridden — and the launcher says so. */
  /* 🔴 A PATH WE OWN, NOT "true". The literal "true" makes the CLI mkdtemp its own
     firebase-discovery-XXXX directory and never remove it — discovery/index.js reads the manifest and
     deletes nothing, so every functions run leaks one. I found four already, all mine, from
     introducing this branch. Pointing it at a directory this process created makes the manifest ours
     to delete, on the same cleanup path as the generated config, signals included. */
  if (services.includes('functions')) {
    env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH = discoveryDirFor(run ? run.pid : process.pid);
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
// R3 (2026-10-12): node FLAGS may sit between `node` and the file (`node --experimental-vm-modules <file>`, needed by the
// contract page harness's vm.SourceTextModule). A flag is `--name` or `--name=value` (no quotes, no spaces); it is kept
// in place, ahead of the injected preloads. Every `node [flags] <file>` invocation is still anchored on its file.
const NODE_INVOCATION = /\bnode\s+((?:--[a-z][a-z0-9-]*(?:=[^\s"']+)?\s+)*)(?=[\w./-]+\.(?:js|mjs)\b)/g;
const injectCounter = (command, counter, ...more) =>
  String(command).replace(NODE_INVOCATION, (_, flags) => `node ${flags}${[counter, ...more].map((p) => `-r ${p} `).join('')}`);

/* Per-run TMPDIR: the CLI writes its hub locator to `${os.tmpdir()}/hub-<project>.json` (hub.js:25) and WARNS AND
   LEAVES it when a live one exists — so two same-project runs sharing a TMPDIR fight over one locator. Each run gets
   its own, named by supervisor pid so the dead-pid sweep can tell a stale one from a live one. */
const TMP_PREFIX = 'xpizza-emu-tmp.';

/* The services a run starts. `functions` IMPLIES both data services (advisor-approved): discovery's env is NOT
   process.env (runtimes/node/index.js:119-127) — it carries host vars only for RUNNING emulators — so a NULL
   endpoint cannot reach it, and lib/admin.js would refuse a half-configured discovery. Starting both makes
   discovery see two real hosts. Order preserved, duplicates dropped. */
function servicesFor(only) {
  // no --only: the three services a bare run always started (auth is opt-in only, never a default)
  const list = only ? String(only).split(',').map((x) => x.trim()).filter(Boolean) : ['firestore', 'database', 'functions'];
  const out = [];
  const add = (x) => { if (!out.includes(x)) out.push(x); };
  for (const x of list) add(x);
  if (out.includes('functions')) { add('firestore'); add('database'); }
  return out;
}

/* Every listener a run opens: hub + logging always (the UI is disabled and --ui refused), plus each service's. */
function bandListeners(services, ports) {
  const out = [['hub', ports.hub], ['logging', ports.logging]];
  for (const s of services) for (const l of (SERVICE_LISTENERS[s] || [])) out.push([l, ports[l]]);
  return out;
}

/* R1 (codex R1-build P1-2): the suite command is parsed into a plain `node …` && chain and run by the MARKED wrapper
   (tools/emu-cmd-wrapper.js), never by a shell — a platform shell carries the run marker invisibly to `ps`. Single and
   double quotes group (no escapes inside); `&&` separates steps; ANY other shell syntax (; | & > < ` $ ( ) \ newline,
   `||`) is REFUSED rather than guessed at. Every routed script is already this shape. */
function parseChain(command) {
  const toks = [];
  let cur = null;
  const s = String(command);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j < 0) throw new Error(`unterminated ${c} quote`);
      cur = (cur || '') + s.slice(i + 1, j); i = j; continue;
    }
    if (/\s/.test(c)) { if (c === '\n' || c === '\r') throw new Error('a newline (two commands)'); if (cur !== null) { toks.push(cur); cur = null; } continue; }
    if (c === '&' && s[i + 1] === '&') { if (cur !== null) { toks.push(cur); cur = null; } toks.push({ op: '&&' }); i++; continue; }
    if (';|&><`$()\\'.includes(c)) throw new Error(`shell syntax ${JSON.stringify(c)} outside quotes`);
    cur = (cur || '') + c;
  }
  if (cur !== null) toks.push(cur);
  const steps = [[]];
  for (const t of toks) {
    if (typeof t === 'object') { if (!steps[steps.length - 1].length) throw new Error('an empty step around &&'); steps.push([]); continue; }
    steps[steps.length - 1].push(t);
  }
  if (!steps[steps.length - 1].length) throw new Error('an empty step around &&');
  for (const st of steps) if (st[0] !== 'node' || st.length < 2) throw new Error(`a step that is not \`node …\`: ${JSON.stringify(st.join(' '))}`);
  return steps;
}

module.exports = { planPorts, pinFromEnv, SLOTS, ROOT, SERVICE_LISTENERS, ALL_HOST_ENV, HOST_ENV, childEnv, discoveryDirFor, DISCOVERY_PREFIX, TMP_PREFIX, injectCounter, NODE_INVOCATION, servicesFor, bandListeners, parseChain };
if (require.main !== module) return;


/* 🔴 THE SWEEP RUNS BEFORE ANYTHING THAT CAN EXIT — including the pin parse, which exits 2 on a malformed
   override. It sat below the --only check once and left strays behind on that path. Cleanup that only runs on
   the happy path is not cleanup. Dead-pid generated configs in ROOT; dead-pid discovery and TMPDIR dirs. */
const deadPid = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return !(e && e.code === 'EPERM'); } };
for (const f of fs.readdirSync(ROOT)) {
  const m = /^firebase\.emulator\.(\d+)\.json(?:\.tmp)?$/.exec(f);
  if (m && deadPid(Number(m[1]))) { try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* raced with another sweep */ } }
}
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    const prefix = [DISCOVERY_PREFIX, TMP_PREFIX].find((p) => d.startsWith(p));
    if (!prefix) continue;
    const pid = Number(d.slice(prefix.length));
    if (Number.isInteger(pid) && deadPid(pid)) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch { /* raced */ } }
  }
} catch { /* tmpdir unreadable — nothing to sweep */ }

/* 🔴 ARGUMENTS ARE ALLOWLISTED, NOT SCANNED. Only --only and --project pass, each at most once, plus exactly one
   command string (`--config`, `--ui`, `--inspect-functions`, a repeated --only … each once bypassed the preflight). */
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
    console.error('emulator-run:    Only --only and --project are forwarded. Anything else can change ports or config');
    console.error('emulator-run:    AFTER the preflight has checked different ones (--config, --ui, --inspect-functions),');
    console.error('emulator-run:    which would put this back to attaching silently. Add it here deliberately if it is needed.\n');
    process.exit(2);
  } else { rest.push(a); continue; }
  if (value === undefined || String(value).startsWith('-')) { console.error(`emulator-run: --${name} needs a value`); process.exit(2); }
  if (opts[name] !== undefined) { console.error(`emulator-run: --${name} given twice (${opts[name]} then ${value}); the CLI would use the last and this runner the first — refusing rather than guessing`); process.exit(2); }
  opts[name] = value;
}
if (rest.length !== 1) { console.error(`emulator-run: expected exactly one command string, got ${rest.length}`); process.exit(2); }

const PIN = pinFromEnv();
const services = servicesFor(opts.only);
for (const s of services) {
  if (!SERVICE_LISTENERS[s]) {
    console.error(`\nemulator-run: --only names "${s}", which this runner has no port band for.`);
    console.error(`emulator-run:    known: ${Object.keys(SERVICE_LISTENERS).join(', ')}`);
    console.error('emulator-run:    REFUSING: an unpinned emulator takes a shared default port, unpreflighted, and the');
    console.error('emulator-run:    installed CLI will SEARCH FOR ANOTHER PORT if it is busy rather than stop.');
    console.error('emulator-run:    Add its band to planPorts() and its listeners to SERVICE_LISTENERS.\n');
    process.exit(2);
  }
}
if (opts.only && services.join(',') !== opts.only.split(',').map((x) => x.trim()).filter(Boolean).join(',')) {
  console.error(`emulator-run: --only ${opts.only} → starting ${services.join(',')} (functions implies both data services: discovery must see two real hosts)`);
}
/* Project: BOTH project env vars are normalised to ONE value (a stale GOOGLE_CLOUD_PROJECT from a parent shell
   used to survive beside the CLI's GCLOUD_PROJECT). A script with no --project gets the demo default — the CLI
   would otherwise resolve .firebaserc's PRODUCTION id. Suites that need the prod id pass it explicitly. */
const PROJECT = opts.project || 'demo-xpizza';

/* Rules files the generated config names must EXIST and parse: a missing Firestore rules file makes the emulator
   fall back to PERMISSIVE rules (controller.js ~:477) and every rules suite would pass vacuously. Loaded-ness is
   proved behaviourally by the guard (a denied write), not assumed here. */
{
  const base = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  const need = [];
  if (services.includes('database') && base.database && base.database.rules) need.push(['database', base.database.rules]);
  if (services.includes('firestore') && base.firestore && base.firestore.rules) need.push(['firestore', base.firestore.rules]);
  for (const [svc, rel] of need) {
    const abs = path.join(ROOT, rel);
    let text = null;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { /* reported below */ }
    let bad = text === null ? 'is missing' : (!text.trim() ? 'is empty' : null);
    if (!bad && svc === 'database') { try { JSON.parse(text); } catch (e) { bad = `is not valid JSON (${e.message})`; } }
    if (bad) {
      console.error(`\nemulator-run: 🔴 EMULATOR REFUSED TO START — the ${svc} rules file ${rel} ${bad}.`);
      console.error('emulator-run:    The emulator would fall back to permissive (or no) rules and every rules assertion would be vacuous.');
      console.error(`emulator-run:    ${svc === 'database' ? 'Run `npm run sync:rules` first (it copies ../xpizza-reference/database.rules.json).' : ''}\n`);
      process.exit(2);
    }
  }
}

/* SAME-CHECKOUT CONCURRENCY IS UNSUPPORTED (one session per worktree). Best-effort, explicitly NON-ATOMIC courtesy
   refusal: a live run's generated config in ROOT means another run of THIS checkout is up. Two simultaneous starts
   can both pass this check (stated, not fixed — PLAN §b.9); it exists for the common "B after A" case. */
for (const f of fs.readdirSync(ROOT)) {
  const m = /^firebase\.emulator\.(\d+)\.json$/.exec(f);
  if (m && Number(m[1]) !== process.pid && !deadPid(Number(m[1]))) {
    console.error(`\nemulator-run: 🔴 EMULATOR REFUSED TO START — another emulator run of THIS checkout is live (pid ${m[1]}, ${f}).`);
    console.error('emulator-run:    Same-checkout concurrency is unsupported: use a separate worktree per session.\n');
    process.exit(4);
  }
}

const log = (msg) => console.error(`emulator-run: ${msg}`);

/* ── signals: while QUEUED they CANCEL the queue (nothing held); while RUNNING they are forwarded to firebase ── */
const STATE = { phase: 'queued', child: null, signalled: null, abort: new AbortController(), teardown: null };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (STATE.signalled) return;
    STATE.signalled = sig;
    if (STATE.phase === 'queued') { STATE.abort.abort(); return; }
    if (STATE.child && STATE.child.exitCode === null) {
      try { STATE.child.kill(sig); } catch { /* already gone */ }
      // firebase gets a bounded grace period; then it is killed individually and teardown proceeds anyway
      setTimeout(() => { try { STATE.child.kill('SIGKILL'); } catch { /* gone */ } }, 30000).unref();
    } else if (STATE.teardown) STATE.teardown(130);
  });
}

/* The suite command: injected + parsed ONCE, before any slot is taken (a refusal here holds nothing). */
const COUNTER = path.join(ROOT, 'tools', 'count-marks.js');
const NULL_GUARD = path.join(ROOT, 'tools', 'emu-null-guard.js');
// R3 P1-a (codex r1 P1-1): the process-level EGRESS refusal is preloaded FIRST — before the counter, the NULL guard and
// any client — into every node step: a suite reaches loopback only (tools/egress-guard.js; R3_EGRESS_MODE=record inventories)
const EGRESS = path.join(ROOT, 'tools', 'egress-guard.js');
const INNER = injectCounter(rest[0], EGRESS, COUNTER, NULL_GUARD);
if (!/count-marks\.js/.test(INNER)) {
  console.error(`\nemulator-run: could not inject the cell counter into ${JSON.stringify(rest[0])}.`);
  console.error('emulator-run:    The suite would run uncounted and the gate would fail it for a missing trailer.');
  console.error('emulator-run:    Expected a command of the form `node <file>` (possibly chained with &&).\n');
  process.exit(2);
}
let STEPS;
try { STEPS = parseChain(INNER); } catch (e) {
  console.error(`\nemulator-run: 🔴 refusing the suite command — ${e.message}.`);
  console.error('emulator-run:    Only `node …` steps joined by && are run (by a marked node wrapper, never a shell).\n');
  process.exit(2);
}
const WRAPPER = path.join(ROOT, 'tools', 'emu-cmd-wrapper.js');
if (/\s/.test(WRAPPER)) { console.error(`emulator-run: 🔴 the checkout path contains whitespace (${WRAPPER}) — refusing`); process.exit(2); }
const WRAPPED = `node ${WRAPPER} ${require('./emu-cmd-wrapper').encode(STEPS)}`;
/* codex r3 (b): firebase-tools runs this through `/bin/sh -c` (spawn shell:true). On this Mac /bin/sh is bash, and
   `bash -c` with ONE SIMPLE COMMAND execs straight into it (measured: the shell's pid BECOMES the node wrapper) — so no
   platform-redacted shell survives between the CLI and the marked wrapper. That holds only while the command stays a
   single simple command: no operators, quotes, globs or expansions. Asserted, not assumed. */
if (!/^node \/[^\s'"`$;&|<>*?()]+ [A-Za-z0-9_-]+$/.test(WRAPPED)) { console.error(`emulator-run: 🔴 the wrapped command is not a single simple command (${WRAPPED.slice(0, 120)}) — a shell could survive it`); process.exit(2); }
const MAX_ATTEMPTS = 3;

(async () => {
  const deadlineS = Number(process.env.XPIZZA_EMU_QUEUE_DEADLINE_S || 1200);
  const deadlineMs = (Number.isFinite(deadlineS) && deadlineS > 0 ? deadlineS : 1200) * 1000;
  const excluded = new Set();
  for (let attempt = 1; ; attempt++) {
    const r = await runOnce(excluded, deadlineMs);
    if (r.reslot && attempt < MAX_ATTEMPTS && PIN === null && !STATE.signalled) {
      excluded.add(r.slot);
      log(`🔴 STARTUP PORT CONTENTION on slot ${r.slot} (${r.why}) — the suite never started; this run's processes are confirmed down and the slot released. RE-SLOTTING (attempt ${attempt + 1}/${MAX_ATTEMPTS}, avoiding ${[...excluded].join(',')})`);
      continue;
    }
    if (r.reslot) log(`🔴 STARTUP PORT CONTENTION on slot ${r.slot} (${r.why}) — ${PIN !== null ? 'the run is PINNED, so it refuses rather than moving' : `giving up after ${attempt} attempts`}.`);
    process.exit(r.code);
  }
})();

/* One attempt: acquire a slot, run the suite under it, tear down. Resolves { code, reslot, slot, why } AFTER the teardown
   barrier (own processes confirmed down, band probed, files removed, sentinel closed LAST). */
async function runOnce(excluded, deadlineMs) {
  /* ── 1. OWN A SLOT (sentinel socket) — quarantine, never kill; queue past saturation ─────────────── */
  STATE.phase = 'queued';
  let lastBusy = [];
  const probeBand = async (slot) => {
    const ports = planPorts(slot * 10);
    lastBusy = [];
    for (const [nm, pt] of bandListeners(services, ports)) {
      const st = await ALLOC.probePort(pt);
      if (st !== 'free') lastBusy.push({ name: nm, port: pt, state: st });
    }
    return lastBusy.length === 0;
  };
  // A pinned run states its whole band BEFORE arbitration, so the plan is visible even when the pin is refused.
  if (PIN !== null) log(`pinned slot ${PIN} (XPIZZA_EMU_PORT_OFFSET=${PIN * 10}) — ${bandListeners(services, planPorts(PIN * 10)).map(([nm, pt]) => `${nm} ${pt}`).join(', ')}`);
  let got;
  try {
    got = await ALLOC.acquireSlot({
      pin: PIN,
      exclude: excluded,
      bind: ALLOC.bindSentinel,
      scan: (slot) => ALLOC.scanSlot(slot),
      probeBand,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log,
      deadlineMs,
      signal: STATE.abort.signal,
    });
  } catch (e) {
    if (e && e.code === 'ECANCELLED') {
      console.error(`\nemulator-run: 🔴 cancelled while QUEUED (${STATE.signalled}) — no slot was held, nothing started.\n`);
      return { code: 130 };
    }
    console.error(`\nemulator-run: 🔴 EMULATOR REFUSED TO START — ${e && e.message}\n`);
    return { code: 3 };
  }
  if (got.slot === null) {
    console.error('\nemulator-run: 🔴 EMULATOR REFUSED TO START — the PINNED slot is unavailable (XPIZZA_EMU_PORT_OFFSET).\n');
    console.error(`emulator-run:    ${got.reason || 'unavailable'}`);
    for (const t of lastBusy) console.error(`emulator-run:    ${t.name.padEnd(22)} 127.0.0.1:${t.port}   ${t.state}`);
    console.error('\nemulator-run:    REFUSING rather than attaching. A listener already on this band belongs to another run —');
    console.error('emulator-run:    attaching to it would assert against a different tree and still report green.');
    if (lastBusy[0]) console.error(`emulator-run:    Find it with:  lsof -nP -iTCP:${lastBusy[0].port} -sTCP:LISTEN`);
    console.error('emulator-run:    Or drop the pin: without XPIZZA_EMU_PORT_OFFSET the runner picks a free slot itself.\n');
    return { code: 3 };
  }
  const { slot, server: sentinel } = got;
  const OFFSET = slot * 10;
  const PORTS = planPorts(OFFSET);
  const run = { slot, pid: process.pid, nonce: ALLOC.newNonce(), start: ALLOC.ownStart() };
  log(`slot ${slot} (offset ${OFFSET}${PIN !== null ? ', pinned' : ''}) — ${bandListeners(services, PORTS).map(([nm, pt]) => `${nm} ${pt}`).join(', ')} — sentinel 127.0.0.1:${ALLOC.sentinelPort(slot)}`);

  /* ── 2. Per-run state: generated config (atomic), discovery dir, TMPDIR ─────────────────────────── */
  const base = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  base.emulators = {
    firestore: { host: '127.0.0.1', port: PORTS.firestore, websocketPort: PORTS.firestoreWebsocket },
    database: { host: '127.0.0.1', port: PORTS.database },
    functions: { host: '127.0.0.1', port: PORTS.functions },
    eventarc: { host: '127.0.0.1', port: PORTS.eventarc },
    tasks: { host: '127.0.0.1', port: PORTS.tasks },
    logging: { host: '127.0.0.1', port: PORTS.logging },
    hub: { host: '127.0.0.1', port: PORTS.hub },
    auth: { host: '127.0.0.1', port: PORTS.auth },
    ui: { enabled: false, host: '127.0.0.1', port: PORTS.ui },
    /* 🔴 NO singleProjectMode: it changes what the emulator ACCEPTS, and several rules suites use their own ids. */
  };
  /* The config stays in ROOT, so projectDir = ROOT and functions `source: "."` stays RELATIVE (an absolute source
     breaks controller.js:344's path.join). Published atomically (.tmp + rename): no reader sees a partial file. */
  const generated = path.join(ROOT, `firebase.emulator.${process.pid}.json`);
  fs.writeFileSync(`${generated}.tmp`, JSON.stringify(base, null, 2) + '\n');
  fs.renameSync(`${generated}.tmp`, generated);
  const discoveryDir = services.includes('functions') ? discoveryDirFor(process.pid) : null;
  if (discoveryDir) fs.mkdirSync(discoveryDir, { recursive: true });
  const tmpDir = path.join(os.tmpdir(), `${TMP_PREFIX}${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const startedFile = path.join(tmpDir, 'suite-started');
  try { fs.unlinkSync(startedFile); } catch { /* fresh */ }

  const cleanFiles = () => {
    try { fs.unlinkSync(generated); } catch { /* already gone */ }
    if (discoveryDir) { try { fs.rmSync(discoveryDir, { recursive: true, force: true }); } catch { /* already gone */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  process.once('exit', cleanFiles);   // last resort only — the orderly path below does it after confirmed death

  /* ── 3. The child env: cleared foreign hosts, NULL for unstarted data services, the run marker, TMPDIR,
     one project id on both vars. The marker is in env AT SPAWN, so `ps -E` sees it in every child. ── */
  const env = childEnv(services, process.env, run);
  if (services.includes('functions') && process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH && process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH !== env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH) {
    log(`overriding an inherited FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH (${process.env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH}) with this run's own ${env.FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH}`);
  }
  env.TMPDIR = tmpDir;
  env.GCLOUD_PROJECT = PROJECT;
  env.GOOGLE_CLOUD_PROJECT = PROJECT;
  env.XPIZZA_EMU_STARTED_FILE = startedFile;
  { const fb = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8')); if (services.includes('firestore') && fb.firestore && fb.firestore.rules) env.XPIZZA_EMU_FS_RULES = path.join(ROOT, fb.firestore.rules); }
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.replace(/--require[= ]\S*count-marks\.js/g, '').trim() || undefined;
  if (env.NODE_OPTIONS === undefined) delete env.NODE_OPTIONS;

  /* ── 4. Run, then tear down: after firebase exits, terminate OUR marked processes INDIVIDUALLY to a confirmed-death
     barrier; verify the band released; remove per-run files; close the sentinel LAST. ── */
  /* Our own marked processes, by NONCE (not by slot: a reaped-then-reused slot could name another run) — through the
     SHARED termination routine (tools/emu-alloc.js terminateMarked): the full set re-enumerated every iteration (a
     descendant spawned during teardown is added), each pid re-read FRESH (start + marker) immediately before each signal,
     individual pids only. An unreadable live row cannot be attributed and is reported UNCONFIRMED, never assumed dead. */
  async function reapOwn() {
    const ours = (row) => { const mk = ALLOC.markerIn(row.env); return !!mk && mk.nonce === run.nonce && mk.pid === run.pid; };
    const res = await ALLOC.terminateMarked({
      select: (table) => ({
        targets: table.filter((r) => r.pid !== process.pid && r.readable && !ALLOC.isZombie(r.state) && ours(r)),
        unattributable: table.filter((r) => !r.readable && r.pid !== process.pid && ALLOC.pidAlive(r.pid)).map((r) => ({ pid: r.pid, why: r.why })),
      }),
      same: ours,
      log,
    });
    return res.confirmed ? [] : res.unconfirmed.map((u) => `${u.pid} (${u.status})`);
  }
  let tornDown = null;
  const teardown = (code) => {
    if (tornDown) return tornDown;
    tornDown = (async () => {
      const leftovers = await reapOwn();
      if (leftovers.length) log(`🔴 teardown UNCONFIRMED — ${leftovers.join(', ')} — the slot stays quarantined for the next admission while any marked process lives (reclaim: node tools/emu-reap.js ${slot})`);
      const deadline = Date.now() + 10000;
      let busy = [];
      for (;;) {
        busy = [];
        for (const [nm, pt] of bandListeners(services, PORTS)) if ((await ALLOC.probePort(pt)) !== 'free') busy.push(`${nm} ${pt}`);
        if (!busy.length || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (busy.length) log(`🔴 band not released 10s after teardown: ${busy.join(', ')} — the next admission will skip this slot (band probe)`);
      cleanFiles();
      process.removeListener('exit', cleanFiles);
      log(`teardown complete — slot ${slot}: own processes ${leftovers.length ? 'UNCONFIRMED' : 'confirmed down'}, band ${busy.length ? 'NOT released' : 'released'}; releasing the sentinel`);
      await ALLOC.closeServer(sentinel);
      return { code, busy, confirmed: !leftovers.length };
    })();
    return tornDown;
  };

  return new Promise((resolve) => {
    STATE.phase = 'running';
    STATE.teardown = (code) => teardown(code).then((t) => process.exit(t.code));
    /* 🔴 stdio is INHERITED, never piped through this process (measured in the R1 window): with the CLI's output piped
       here, a SIGKILLed supervisor broke the CLI's pipes, the CLI died WITHOUT shutting its emulators down, and a
       detached JVM was orphaned (the slot stayed quarantined — safe, but leaked). Inherited, the CLI and the marked
       chain outlive a dead supervisor and shut down cleanly. So startup contention is decided from evidence that needs
       no output: the CLI failed BEFORE the suite started (no started-file), and — after THIS run's processes are
       confirmed down — a band port is STILL held: a foreign listener took our band. That is the re-slot condition. */
    const child = spawn('firebase', ['emulators:exec', '--config', generated, '--project', PROJECT, '--only', services.join(','), WRAPPED], { stdio: 'inherit', cwd: ROOT, env });
    STATE.child = child;
    child.on('error', (e) => { console.error(`emulator-run: could not launch firebase — ${e && e.message}`); teardown(1).then((t) => resolve({ code: t.code, slot })); });
    child.on('exit', (code, signal) => {
      // The suite's own exit code is the result. A wrapper that swallowed it would turn a red suite green.
      const exitCode = STATE.signalled ? 130 : (signal ? 1 : (code === null ? 1 : code));
      const started = fs.existsSync(startedFile);
      teardown(exitCode).then((t) => resolve({ code: t.code, slot, reslot: exitCode !== 0 && !started && !STATE.signalled && t.confirmed && t.busy.length > 0, why: `band port(s) held by a foreign listener: ${t.busy.join(', ')}` }));
    });
  });
}
