'use strict';
/* Per-run emulator slot allocation — the pure, injectable core (PLAN-emulator-isolation v5 §b.1–b.3, codex r5 P1-B).
 *
 * A slot is owned for the life of a run by a kernel-held SENTINEL SOCKET on 127.0.0.1:(SENTINEL_BASE+slot).
 * No lock files, no reclaim: the kernel releases the socket on process death. Admission NEVER kills — it
 * QUARANTINES a slot that bears any marked process whose supervisor is dead (or whose same-user scan is
 * incomplete) and moves on; killing happens only in the explicit tools/emu-reap.js CLI. Everything here is
 * dependency-injected (bind/probe/scan/clock) so the guard can drive it over a FIXTURE sentinel range.
 *
 * ═══ THE PROCESS SCAN (P1-B), MEASURED ON THIS MAC (macOS 26, /bin/ps) — NOT ASSUMED ═══
 *   · Population = the caller's REAL UID only (`ps -U <uid>`): other users' processes (root, system accounts)
 *     are outside the supported single-user workflow and are never read.
 *   · `ps -E` appends the launch-time environment to the argv. Apple REDACTS it for platform binaries even for
 *     the same user: measured, `FOO=1 /bin/sh -c …`, `FOO=1 /bin/sleep`, Apple's python3 all print argv only,
 *     while `FOO=1 node …` and the Homebrew JVM print `FOO=1`. On this machine 333 of 419 same-UID rows show no
 *     env. So "no env shown ⇒ unreadable ⇒ quarantine" (the WIP heuristic) would quarantine EVERY slot, and
 *     "KEY=VALUE token present ⇒ env readable" misreads an argv like `x=y`.
 *   · THEREFORE the env is computed per row as (-E args) MINUS (plain args) — two scans, prefix-stripped — so
 *     an `x=y` in argv is never mistaken for env, and an empty remainder is just "no env", NOT "unreadable".
 *   · A LIVE UNREADABLE row is what Apple's ps prints when it cannot read a process's arguments at all: the
 *     parenthesised command-name fallback `(comm)`, or a row whose -E text does not begin with its plain argv.
 *     Such a row ⇒ INCOMPLETE ⇒ quarantine — unless it is a zombie or has vanished, which are skipped.
 *   · RESIDUAL, argued and proved rather than hidden: a run's /bin/sh wrappers (firebase runs the suite through
 *     a shell) carry the marker invisibly. They hold no band listener and no database connection; every process
 *     a run starts that CAN hold one — the firebase CLI, the emulator JVMs, the suite, the functions workers — is
 *     node or java, both non-platform and readable (the guard spawns marked node/java/sh and asserts exactly
 *     this). Any listener on a band, whatever its binary, is caught by the band probe regardless.
 */
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SLOTS = 40;
const SENTINEL_BASE = 6400;          // production sentinels 6400-6439, in the free 6400-8079 gap (below firestore 8080)
const FIXTURE_SENTINEL_BASE = 6440;  // tests only: 6440-6479 — asserted disjoint from the real pool + bands + discovery
const RUN_VAR = 'XPIZZA_EMU_RUN';
const OFFSET_VAR = 'XPIZZA_EMU_OFFSET';

const sentinelPort = (slot, base = SENTINEL_BASE) => base + slot;
const newNonce = () => crypto.randomBytes(8).toString('hex');

// ── Marker: slot:supervisorPid:nonce:startEpochSeconds ──────────────────────────────────────────
// start is the supervisor's `ps -o lstart` (LC_ALL=C, TZ=UTC) as epoch seconds — no spaces, so the marker is ONE
// token inside `ps -E` output. Published in EVERY child's env at spawn, so it survives SIGKILL and is readable from
// any orphan. It disambiguates PID reuse (whole-second precision: a same-second reuse is a documented residual).
function formatMarker({ slot, pid, nonce, start }) { return `${slot}:${pid}:${nonce}:${start}`; }
function parseMarker(s) {
  const m = /^(\d{1,2}):(\d+):([0-9a-f]{16}):(\d+)$/.exec(String(s == null ? '' : s));
  if (!m || Number(m[1]) >= SLOTS) return null;
  return { slot: Number(m[1]), pid: Number(m[2]), nonce: m[3], start: Number(m[4]) };
}

// ── ps parsing ──────────────────────────────────────────────────────────────────────────────────
// `-o pid=,state=,lstart=,args=` under LC_ALL=C TZ=UTC: lstart is always 5 tokens (DOW MON DD HH:MM:SS YYYY).
function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s?(.*)$/.exec(String(line == null ? '' : line));
  if (!m) return null;
  const t = Date.parse(`${m[3]} UTC`);
  return { pid: Number(m[1]), state: m[2], lstart: m[3], start: Number.isFinite(t) ? Math.floor(t / 1000) : null, args: m[4] };
}
const isZombie = (state) => /Z/.test(state || '');
const isFallback = (args) => /^\(.*\)$/.test(String(args || '').trim());   // Apple ps: args unreadable → "(comm)"
const markerIn = (env) => {
  const m = new RegExp(`(?:^| )${RUN_VAR}=(\\S+)`).exec(env || '');
  return m ? parseMarker(m[1]) : null;
};

/* Join the two scans into rows with a SEPARATED env. Pure — the guard feeds it fixtures.
   plainLines: `ps … -o pid=,state=,lstart=,args=`   envLines: the same with -E. */
function joinScans(plainLines, envLines) {
  const plain = new Map((plainLines || []).map(parsePsLine).filter(Boolean).map((r) => [r.pid, r]));
  const withEnv = new Map((envLines || []).map(parsePsLine).filter(Boolean).map((r) => [r.pid, r]));
  const rows = [];
  for (const [pid, e] of withEnv) {
    const p = plain.get(pid);
    const row = { pid, state: e.state, lstart: e.lstart, start: e.start, argv: p ? p.args : null, env: '', readable: true, why: null };
    if (isFallback(e.args) || (p && isFallback(p.args))) { row.readable = false; row.why = 'args unreadable (ps fallback)'; }
    else if (!p) { row.readable = false; row.why = 'absent from the plain scan'; }
    else if (p.start !== e.start) { row.readable = false; row.why = 'pid changed identity between scans'; }
    else if (e.args === p.args) row.env = '';                                   // no env (empty OR platform-redacted)
    else if (e.args.startsWith(p.args + ' ')) row.env = e.args.slice(p.args.length + 1);
    else { row.readable = false; row.why = '-E text does not begin with the argv'; }
    rows.push(row);
  }
  return rows;
}

/* Classify the joined same-UID table for `slot`.
   occupied   = any marked process names this slot (live OR dead supervisor) — another run's or an orphan;
   orphans    = marked processes whose supervisor is dead (absent, or alive with a different start = PID reuse);
   incomplete = a LIVE row we could not read (isAlive(pid) re-checked: a vanished pid is skipped, not doubted). */
function classifyScan(rows, slot, { isAlive = () => true } = {}) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let incomplete = false; const unreadable = [];
  const orphans = []; const live = [];
  let occupied = false;
  for (const r of rows) {
    if (isZombie(r.state)) continue;
    if (!r.readable) {
      if (isAlive(r.pid)) { incomplete = true; unreadable.push({ pid: r.pid, why: r.why }); }
      continue;
    }
    const mk = markerIn(r.env);
    if (!mk || mk.slot !== slot) continue;
    occupied = true;
    const sup = byPid.get(mk.pid);
    const supervisorDead = !sup || isZombie(sup.state) || sup.start !== mk.start;
    (supervisorDead ? orphans : live).push({ pid: r.pid, supervisorPid: mk.pid, nonce: mk.nonce, start: mk.start });
  }
  return { occupied, incomplete, unreadable, orphans, live };
}

// ── Real scans (macOS /bin/ps, the supported platform) ──────────────────────────────────────────
const PS_ENV = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' };
// Every ps call is BOUNDED (codex R1-build P2-8): a hung ps throws here, and callers treat a failed scan as INCOMPLETE.
const PS_TIMEOUT_MS = 10000;
function readPsTables(uid = process.getuid()) {
  const run = (extra) => execFileSync('/bin/ps', ['-U', String(uid), '-ww', ...extra, '-o', 'pid=,state=,lstart=,args='],
    { encoding: 'utf8', env: PS_ENV, maxBuffer: 64 * 1024 * 1024, timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' }).split('\n').filter(Boolean);
  /* -E FIRST, plain SECOND: we iterate the -E rows, so a row missing from the later plain scan has EXITED in
     between (isAlive then skips it) — never "born after", which the opposite order mistook for unreadable
     (measured: the second ps itself showed up as a live unreadable row and quarantined all 40 slots). */
  const withEnv = run(['-E']);
  const plain = run([]);
  return { plain, withEnv };
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } };
function scanSlot(slot, { tables, isAlive = pidAlive } = {}) {
  let t = tables;
  if (!t) {
    try { t = readPsTables(); } catch (e) {
      // a failed / timed-out scan proves nothing about the slot ⇒ INCOMPLETE ⇒ quarantine (unverifiable ⇒ refuse)
      return { occupied: false, incomplete: true, unreadable: [{ pid: 0, why: `ps scan failed: ${(e && (e.code || e.message)) || e}` }], orphans: [], live: [] };
    }
  }
  return classifyScan(joinScans(t.plain, t.withEnv), slot, { isAlive });
}
// ONE pid, fresh — the identity check made immediately before a signal. null = not listed (gone) or unreadable scan.
function readPsRow(pid) {
  const run = (extra) => execFileSync('/bin/ps', ['-p', String(pid), '-ww', ...extra, '-o', 'pid=,state=,lstart=,args='],
    { encoding: 'utf8', env: PS_ENV, timeout: PS_TIMEOUT_MS, killSignal: 'SIGKILL' }).split('\n').filter(Boolean);
  let withEnv; let plain;
  try { withEnv = run(['-E']); plain = run([]); } catch (e) { if (e && e.status === 1 && !e.signal) return null; throw e; }   // ps exits 1: no such pid
  return joinScans(plain, withEnv)[0] || null;
}

/* ═══ THE TERMINATION ROUTINE — shared by emu-reap and the launcher's teardown (codex R1-build P1-3) ═══
 * select(table) → { targets: rows that are ours to end, unattributable: live rows we could not read }
 * same(row)     → is a FRESH row still the same marked process we meant (marker/nonce test; start compared here)
 * Rules:
 *   · the FULL selected set is re-enumerated every iteration, so a descendant spawned during the reap is added;
 *   · each pid is re-read FRESH (readRow) immediately before EACH signal — same start time AND same(row) — else skipped;
 *   · individual pids only, never a process group;
 *   · death is CONFIRMED only for a pid that is gone, a zombie, or now a different process (start changed). An
 *     unreadable or EPERM target is UNCONFIRMED — never counted as dead.
 * Returns { confirmed, signalled, unconfirmed, eperm }. */
async function terminateMarked({ select, same, readTable = () => { const t = readPsTables(); return joinScans(t.plain, t.withEnv); },
  readRow = readPsRow, kill = process.kill.bind(process), isAlive = pidAlive, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(), phases = [['SIGTERM', 8000], ['SIGKILL', 4000]], pollMs = 200, log = () => {} }) {
  const tracked = new Map();                           // pid → start (the identity we are ending)
  const signalled = []; const eperm = new Set();
  let unattributable = [];
  const refresh = () => {
    let table;
    try { table = readTable(); } catch (e) { unattributable = [{ pid: 0, why: `ps scan failed: ${(e && (e.code || e.message)) || e}` }]; return null; }
    const sel = select(table);
    for (const r of sel.targets) if (!tracked.has(r.pid)) tracked.set(r.pid, r.start);
    unattributable = sel.unattributable || [];
    return table;
  };
  const status = (pid, table) => {
    const row = table ? table.find((r) => r.pid === pid) : null;
    if (!row) return isAlive(pid) ? 'unconfirmed' : 'dead';
    if (row.start !== tracked.get(pid)) return 'dead';            // the pid now names a DIFFERENT process
    if (isZombie(row.state)) return 'dead';
    if (!row.readable) return 'unconfirmed';
    return same(row) ? 'alive' : 'unconfirmed';
  };
  const signalPass = (sig, done) => {
    for (const [pid, start] of tracked) {
      if (done.has(pid)) continue;                               // one signal per pid per phase; newcomers get theirs
      let fresh;
      try { fresh = readRow(pid); } catch { fresh = undefined; }
      if (!fresh || !fresh.readable || fresh.start !== start || isZombie(fresh.state) || !same(fresh)) continue;   // gone / reused / unreadable: NOT signalled
      done.add(pid);
      try { kill(pid, sig); signalled.push(`${pid}:${sig}`); } catch (e) { if (e && e.code === 'EPERM') { eperm.add(pid); log(`pid ${pid}: EPERM — left alone, UNCONFIRMED`); } }
    }
  };
  let table = refresh();
  for (const [sig, waitMs] of phases) {
    const done = new Set();
    const until = now() + waitMs;
    for (;;) {
      signalPass(sig, done);
      await sleep(pollMs);
      table = refresh();                                         // re-enumerates the FULL set: descendants are added
      const live = [...tracked.keys()].filter((pid) => status(pid, table) !== 'dead');
      if (!live.length && !unattributable.length) return { confirmed: true, signalled, unconfirmed: [], eperm: [...eperm] };
      if (now() >= until) break;
    }
  }
  table = refresh();
  const unconfirmed = [...tracked.keys()].filter((pid) => status(pid, table) !== 'dead').map((pid) => ({ pid, status: status(pid, table) }));
  for (const u of unattributable) unconfirmed.push({ pid: u.pid, status: `unattributable (${u.why})` });
  return { confirmed: false, signalled, unconfirmed, eperm: [...eperm] };
}
// The supervisor's own start (epoch seconds), read with the same normalisation the scan uses.
function ownStart(pid = process.pid) {
  const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,state=,lstart=,args='], { encoding: 'utf8', env: PS_ENV }).trim();
  const r = parsePsLine(out);
  if (!r || r.start === null) throw new Error(`emu-alloc: could not read lstart for pid ${pid} (${JSON.stringify(out)})`);
  return r.start;
}

// ── Real sentinel bind (the achievable Node/macOS contract) ─────────────────────────────────────
// Stock libuv sets SO_REUSEADDR with no switch; same-address 127.0.0.1 binds stay mutually exclusive without
// SO_REUSEPORT. So: identical IPv4 host, exclusive:true (no cluster-handle sharing), reusePort unset, ownership
// only on 'listening'. Accepted connections are destroyed at once. EADDRINUSE ⇒ unavailable (null); anything
// else is surfaced (reject).
function bindSentinel(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('connection', (c) => { try { c.destroy(); } catch { /* already gone */ } });
    srv.once('error', (e) => (e && e.code === 'EADDRINUSE') ? resolve(null) : reject(e));
    srv.once('listening', () => resolve(srv));
    srv.listen({ port, host, exclusive: true });
  });
}
const closeServer = (srv) => new Promise((res) => { if (!srv) return res(); try { srv.close(() => res()); } catch { res(); } });

/* A bind probe for one band port: free = listenable on 127.0.0.1 AND on both wildcards.
   🔴 LOOPBACK ALONE IS NOT ENOUGH ON macOS (measured in the R1 two-gate proof): ControlCenter (AirPlay Receiver) holds
   `*:5000`, yet macOS still lets 127.0.0.1:5000 be bound, so a loopback-only probe said FREE — while firebase-tools
   decides availability with `lsof -i :PORT -sTCP:LISTEN` (portUtils.js checkListenable, darwin), which sees the
   wildcard listener and refuses: "Could not start Logging Emulator, port taken." Slot 20's logging port is 5000;
   exactly the three suites that drew slot 20 failed. Probing the wildcards too makes the probe at least as strict as
   the CLI, so such a slot is SKIPPED at admission instead of failing the suite. An address family the host does not
   support (EADDRNOTAVAIL / EAFNOSUPPORT for '::') cannot hold a listener and is not a reason to refuse. */
const probeOne = (port, host) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (e) => {
    const code = e && e.code;
    resolve(code === 'EADDRINUSE' || code === 'EACCES' ? 'in-use' : (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') && host === '::' ? 'free' : `error:${code || e}`);
  });
  srv.once('listening', () => srv.close(() => resolve('free')));
  srv.listen({ port, host, exclusive: true, ...(host === '::' ? { ipv6Only: true } : {}) });
});
const PROBE_HOSTS = ['127.0.0.1', '0.0.0.0', '::'];
async function probePort(port, hosts = PROBE_HOSTS) {
  for (const h of hosts) {
    const st = await probeOne(port, h);
    if (st !== 'free') return h === '127.0.0.1' ? st : `${st} (${h})`;
  }
  return 'free';
}

function shuffle(arr, random = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* Acquire a free slot, or QUEUE (randomized + jitter — explicitly NOT FIFO) until one frees or the deadline
 * elapses. A PIN (one slot) goes through the SAME arbitration (sentinel → scan → band probe) but never queues:
 * an unavailable pinned slot is reported back so the caller can refuse loudly.
 *   bind(port) → Promise<server|null>   (null = EADDRINUSE; reject = anything else, surfaced)
 *   scan(slot) → (Promise of) { occupied, incomplete, orphans, unreadable }
 *   probeBand(slot) → Promise<true|false>   ;   sleep(ms) ; now() ; random() ; log(msg)
 * Returns { slot, server, offset } — or, pinned and unavailable, { slot: null, reason }.
 * The caller keeps `server` open for the whole run and closes it on release.
 */
async function acquireSlot(opts) {
  const {
    slots = SLOTS, base = SENTINEL_BASE, pin = null, exclude = new Set(), signal = null,
    bind, probeBand, scan,
    now = () => Date.now(), sleep, random = Math.random, log = () => {},
    deadlineMs = 20 * 60 * 1000, waitMs = 2000, jitterMs = 500, heartbeatMs = 30000,
  } = opts;
  if (pin != null && (!Number.isInteger(pin) || pin < 0 || pin >= slots)) throw new Error(`emu-alloc: pin ${pin} out of range 0..${slots - 1}`);
  const t0 = now();
  let lastBeat = -Infinity;
  /* CANCELLATION (codex R1-build P2-7): an aborted signal stops the queue at the next check — before a bind, and out of
     a sleep — with code ECANCELLED; nothing is held when it throws. DEADLINE (P2-8): checked before EVERY slot, not once
     per full sweep, so a slow scan cannot carry the queue far past it. */
  const cancelled = () => { const e = new Error('emu-alloc: cancelled while queued'); e.code = 'ECANCELLED'; return e; };
  const overdue = () => { const w = now() - t0; if (w > deadlineMs) throw new Error(`emu-alloc: no free slot after ${(w / 1000).toFixed(0)}s (deadline ${deadlineMs / 1000}s) — all ${slots} slots busy`); };
  const pause = (ms) => new Promise((res, rej) => {
    if (signal && signal.aborted) return rej(cancelled());
    let onAbort = null;
    Promise.resolve(sleep(ms)).then(() => { if (signal && onAbort) signal.removeEventListener('abort', onAbort); res(); });
    if (signal) { onAbort = () => rej(cancelled()); signal.addEventListener('abort', onAbort, { once: true }); }
  });
  for (;;) {
    const order = pin != null ? [pin] : shuffle([...Array(slots).keys()].filter((x) => !exclude.has(x)), random);
    let lastReason = null;
    for (const slot of order) {
      if (signal && signal.aborted) throw cancelled();
      if (pin == null) overdue();
      const server = await bind(base + slot);      // reject (non-EADDRINUSE) propagates — surfaced loudly
      if (!server) { lastReason = `slot ${slot} sentinel held by another run`; continue; }
      const sc = await scan(slot);
      if (sc.occupied || sc.incomplete) {
        await closeServer(server);
        lastReason = `slot ${slot} QUARANTINED — ${sc.incomplete
          ? `incomplete process scan: live unreadable pid(s) ${sc.unreadable.map((u) => `${u.pid} (${u.why})`).join(', ')} (unverifiable ⇒ refuse)`
          : (sc.orphans.length ? `orphan pid(s) ${sc.orphans.map((o) => `${o.pid} (dead supervisor ${o.supervisorPid})`).join(', ')} — reclaim with: node tools/emu-reap.js ${slot}` : 'marked processes of a live run')}`;
        if (sc.incomplete || sc.orphans.length) log(lastReason);
        continue;
      }
      if (!(await probeBand(slot))) { await closeServer(server); lastReason = `slot ${slot} sentinel free but a band port is busy (an un-sentinelled listener)`; log(lastReason); continue; }
      return { slot, server, offset: slot * 10 };
    }
    if (pin != null) return { slot: null, reason: lastReason };
    overdue();
    const waited = now() - t0;
    if (waited - lastBeat >= heartbeatMs) { log(`all ${slots} slots busy — QUEUED, waiting (${(waited / 1000).toFixed(0)}s of ${deadlineMs / 1000}s)…`); lastBeat = waited; }
    await pause(waitMs + Math.floor(random() * jitterMs));
  }
}

module.exports = {
  SLOTS, SENTINEL_BASE, FIXTURE_SENTINEL_BASE, RUN_VAR, OFFSET_VAR, PS_ENV,
  sentinelPort, newNonce, formatMarker, parseMarker,
  parsePsLine, isZombie, isFallback, markerIn, joinScans, classifyScan,
  readPsTables, readPsRow, pidAlive, scanSlot, ownStart, terminateMarked, PS_TIMEOUT_MS,
  bindSentinel, closeServer, probePort, PROBE_HOSTS, shuffle, acquireSlot,
};
