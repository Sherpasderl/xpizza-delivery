#!/usr/bin/env node
'use strict';
/* Emulator launcher: per-checkout ports, and a preflight that REFUSES rather than attaches.
 *
 * 🔴 WHY THIS EXISTS. Two checkouts of this repo on one machine both ran `firebase emulators:exec`
 * on the Firebase defaults (firestore 8080, database 9000, hub 4400, UI 4000). When a second run
 * started while the first was up, it either failed to start or ATTACHED to the running emulator and
 * asserted against the OTHER checkout's data — and still reported green. That happened: six suites
 * in a gate re-run were affected, and a green suite that read a foreign tree is not evidence about
 * the tree under test. It is the same failure class this programme keeps hitting, one layer down:
 * a measurement that measured nothing, reported as a pass.
 *
 * Two changes close it:
 *   1. PORTS ARE PER-CHECKOUT, derived from the checkout path, so two working copies do not target
 *      the same emulator in the first place.
 *   2. A PREFLIGHT BINDS EVERY PORT FIRST and refuses loudly if one is taken. A collision now fails
 *      with a named port and a named service instead of silently attaching to whatever is there.
 *
 * Usage — a drop-in for `firebase emulators:exec`, same arguments:
 *     node tools/emulator-run.js --only firestore --project demo-xpizza "node test/foo.test.js"
 *
 * Override the port block explicitly with XPIZZA_EMU_PORT_OFFSET=<0..390, multiple of 10>.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_CONFIG = path.join(ROOT, 'firebase.json');

/* The offset is derived from the checkout's REAL path, so a second clone or worktree lands on a
   different block without anyone configuring anything. 40 slots, step 10 — chosen so that all four
   port ranges stay disjoint (firestore 8080-8470, database 9000-9390, hub 4400-4790, UI 4000-4390):
   one checkout's UI can never sit on another checkout's hub. The bands are UI 4000-4390, hub
   4400-4790, functions 5001-5391, firestore 8080-8470, database 9000-9390, firestore websocket
   9400-9790 — asserted, not assumed, by cell 3 of tools/emulator-ports.guard.test.js, which is how
   the websocket overlap above was found. Two checkouts CAN still hash to the same slot; that is not
   silent — the preflight refuses, and XPIZZA_EMU_PORT_OFFSET overrides. */
const SLOTS = 40;
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
  const h = crypto.createHash('sha256').update(real).digest();
  return (h.readUInt32BE(0) % SLOTS) * 10;
}

function planPorts(offset) {
  return {
    firestore: 8080 + offset,
    database: 9000 + offset,
    hub: 4400 + offset,
    ui: 4000 + offset,
    functions: 5001 + offset,
    /* The Firestore emulator opens a second listener for its UI websocket; left unset it picks its
       own (9150 by default) and can land on a neighbour. Pinned so every port this process opens is
       one we preflighted.
       🔴 9400, NOT 9150: at 9150 this band ran 9150-9540 and overlapped DATABASE's 9000-9390, so
       checkout A's websocket could sit on checkout B's database port — one checkout's test traffic
       arriving at another's emulator, which is the whole class this tool exists to stop. I had
       written a comment below asserting the bands were disjoint; it was wrong, and cell 3 of
       tools/emulator-ports.guard.test.js is what caught it rather than the comment being re-read. */
    firestoreWebsocket: 9400 + offset,
  };
}

module.exports = { planPorts, offsetFor, SLOTS, ROOT };
if (require.main !== module) return;

const OFFSET = offsetFor(ROOT);
const PORTS = planPorts(OFFSET);

const argv = process.argv.slice(2);
const onlyArg = (() => {
  const i = argv.indexOf('--only');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith('--only='));
  return inline ? inline.slice('--only='.length) : null;
})();
const services = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : ['firestore', 'database', 'functions'];

/* The hub always comes up under emulators:exec, so it is preflighted whether or not it was asked
   for. The UI is not started by exec, but its port is pinned and checked anyway: an unchecked port
   is exactly how the websocket listener drifted onto a neighbour's. */
/* RUNS FIRST, BEFORE ANY REFUSAL CAN EXIT. A crash or SIGKILL can leave a generated config behind. Sweep our own strays whose pid is gone:
   that keeps `git status` clean for the gate, and means a recycled pid cannot inherit a stale file.
   It sat below the --only validation at first, so exactly the runs that exit early — the refusals —
   never swept, which is backwards: a refusing run is the one most likely to follow a crashed one. */
for (const f of fs.readdirSync(ROOT)) {
  const m = /^firebase\.emulator\.(\d+)\.json$/.exec(f);
  if (!m) continue;
  const pid = Number(m[1]);
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e && e.code === 'EPERM'; }
  if (!alive) { try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* raced with another sweep */ } }
}

const PREFLIGHT = {
  firestore: [['firestore', PORTS.firestore], ['firestore UI websocket', PORTS.firestoreWebsocket]],
  database: [['database', PORTS.database]],
  functions: [['functions', PORTS.functions]],
};
const toCheck = [['hub', PORTS.hub]];
for (const s of services) {
  /* 🔴 FAIL CLOSED ON A SERVICE THIS RUNNER DOES NOT KNOW. An unrecognised --only used to fall
     through silently: no port was preflighted AND the generated config named none, so firebase
     started that emulator on its own shared default (auth 9099, storage 9199, pubsub 8085…) —
     unpinned and unchecked, which is precisely the cross-checkout collision this tool exists to
     remove, reintroduced by adding one emulator. Whoever adds a service adds its band here. */
  if (!PREFLIGHT[s]) {
    console.error(`\nemulator-run: --only names "${s}", which this runner has no port band for.`);
    console.error(`   known: ${Object.keys(PREFLIGHT).join(', ')}`);
    console.error('   REFUSING: an unpinned emulator would take a shared default port, unpreflighted,');
    console.error('   and could attach across checkouts. Add its band to planPorts() and PREFLIGHT.\n');
    process.exit(2);
  }
  toCheck.push(...PREFLIGHT[s]);
}

/* Announced on every run so a shared block is visible in the log rather than inferred from a strange
   failure later. Two checkouts CAN hash to the same slot; when they do, this line is what says so. */
console.error(`emulator-run: offset ${OFFSET}${process.env.XPIZZA_EMU_PORT_OFFSET ? ' (XPIZZA_EMU_PORT_OFFSET)' : ' (from checkout path)'} — ${toCheck.map(([nm, pt]) => `${nm} ${pt}`).join(', ')}`);

/* 🔴 THE RACE, STATED RATHER THAN PAPERED OVER. Preflight binds, releases, then launches firebase, so
   two runs starting in the same instant can both see a free port. That window is not closable from
   here (holding the socket would stop firebase binding it). What bounds it: two DIFFERENT checkouts
   never share a band unless they hash to the same slot, and within one checkout concurrent runs are
   already forbidden (a sweep mutates the tree npm test is reading). If the race is lost anyway, the
   second firebase fails to bind its own port and exits non-zero — it does not attach, because the HUB
   port is per-checkout too, and hub discovery is how a foreign emulator would be adopted. So the
   outcome degrades to a loud failure, never to a silent foreign read. */

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
    console.error('   Find it with:  lsof -nP -iTCP:' + taken[0].port + ' -sTCP:LISTEN');
    console.error('   Or pick another block:  XPIZZA_EMU_PORT_OFFSET=<multiple of 10, 0..390>\n');
    process.exit(3);
  }

  /* The generated config carries the ports; the committed firebase.json is left alone so deploys and
     `firebase` commands outside the tests are unaffected. It is written NEXT TO firebase.json so the
     relative rules paths inside it resolve exactly as they did before, and it is pid-suffixed so two
     runs in one checkout cannot clobber each other's file. */
  const base = JSON.parse(fs.readFileSync(BASE_CONFIG, 'utf8'));
  base.emulators = {
    firestore: { host: '127.0.0.1', port: PORTS.firestore, websocketPort: PORTS.firestoreWebsocket },
    database: { host: '127.0.0.1', port: PORTS.database },
    functions: { host: '127.0.0.1', port: PORTS.functions },
    hub: { host: '127.0.0.1', port: PORTS.hub },
    ui: { enabled: false, host: '127.0.0.1', port: PORTS.ui },
    /* 🔴 NO singleProjectMode HERE. I set it while writing this and then took it out: it changes what
       the emulator ACCEPTS, not where it listens, and several rules suites deliberately use their own
       project ids (demo-xpizza-rules, demo-xpizza-owner-rules). A port-isolation change that also
       narrowed project acceptance would be two changes wearing one commit message, and the second one
       is the kind that surfaces as a confusing permission error in an unrelated suite months later. */
  };
  const generated = path.join(ROOT, `firebase.emulator.${process.pid}.json`);
  fs.writeFileSync(generated, JSON.stringify(base, null, 2) + '\n');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.unlinkSync(generated); } catch { /* already gone */ }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

  const args = ['emulators:exec', '--config', generated, ...argv];
  const child = spawn('firebase', args, { stdio: 'inherit', cwd: ROOT });
  child.on('error', (e) => { cleanup(); console.error(`emulator-run: could not launch firebase — ${e && e.message}`); process.exit(1); });
  child.on('exit', (code, signal) => {
    cleanup();
    // The suite's own exit code is the result. Passing it straight through is the whole contract:
    // a wrapper that swallowed it would turn a red suite into a green run.
    process.exit(signal ? 1 : (code === null ? 1 : code));
  });
})();
