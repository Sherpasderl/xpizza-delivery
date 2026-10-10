'use strict';
/* Per-run emulator slot allocation — the pure, injectable core (see PLAN-emulator-isolation v5).
 *
 * A slot is owned for the life of a run by a kernel-held SENTINEL SOCKET on 127.0.0.1:(SENTINEL_BASE+slot).
 * No lock files, no TMPDIR, no reclaim: the kernel releases the socket on process death. Admission NEVER
 * kills — it QUARANTINES a slot that bears any marked orphan (or whose same-user process scan is incomplete)
 * and moves on; killing happens only in the explicit emu-reap CLI. Everything here is dependency-injected
 * (bind/probe/scan/clock) so tools/emulator-ports.guard.test.js can drive it over a FIXTURE sentinel range
 * without binding the real pool.
 */
const net = require('net');
const crypto = require('crypto');

const SLOTS = 40;
const SENTINEL_BASE = 6400;          // production sentinels 6400-6439, in the free 6400-8079 gap (below firestore 8080)
const FIXTURE_SENTINEL_BASE = 6440;  // tests only: 6440-6479 — asserted disjoint from the real pool + bands + discovery
const RUN_VAR = 'XPIZZA_EMU_RUN';
const OFFSET_VAR = 'XPIZZA_EMU_OFFSET';

const sentinelPort = (slot, base = SENTINEL_BASE) => base + slot;
const newNonce = () => crypto.randomBytes(8).toString('hex');

// ── Marker: slot:supervisorPid:nonce:startTime ──────────────────────────────────────────────────
// startTime is the supervisor's `ps -o lstart` under LC_ALL=C/TZ=UTC, captured at spawn and published in
// EVERY child's env, so it survives SIGKILL and is readable from any orphan via ps. It disambiguates PID reuse.
function formatMarker({ slot, pid, nonce, start }) { return `${slot}:${pid}:${nonce}:${start}`; }
function parseMarker(s) {
  const m = /^(\d+):(\d+):([0-9a-f]+):(.+)$/.exec(String(s == null ? '' : s));
  if (!m) return null;
  return { slot: Number(m[1]), pid: Number(m[2]), nonce: m[3], start: m[4] };
}

// ── ps parsing (P1-B) ───────────────────────────────────────────────────────────────────────────
// Lines come from: LC_ALL=C TZ=UTC ps -U <uid> -ww -E -o pid=,state=,lstart=,args=
// Scoped to the real-UID population (-U <uid>), so other users' unreadable procs never make US incomplete.
// lstart under LC_ALL=C is always 5 whitespace tokens: DOW MON DD HH:MM:SS YYYY.
function parsePsLine(line) {
  const t = String(line == null ? '' : line).trim().split(/\s+/);
  if (t.length < 7) return null;
  const pid = Number(t[0]);
  if (!Number.isInteger(pid)) return null;
  return { pid, state: t[1], lstart: t.slice(2, 7).join(' '), args: t.slice(7).join(' ') };
}
// A normally-launched process shows KEY=VALUE env tokens under -E. Their ABSENCE on a live same-user row
// means ps could not read the environment → the scan is INCOMPLETE for that row (unverifiable ⇒ quarantine).
const envReadable = (args) => /(^| )[A-Za-z_][A-Za-z0-9_]*=/.test(args || '');
const isZombie = (state) => /Z/.test(state || '');          // zombie/defunct → not a live threat → skip
const markerIn = (args) => {
  const m = new RegExp(`(?:^| )${RUN_VAR}=(\\S+)`).exec(args || '');
  return m ? parseMarker(m[1]) : null;
};

// Pure: classify the same-UID process table for `slot`. Returns whether the slot is occupied (any marked
// process, live OR dead supervisor), the dead-supervisor orphans (for logging/reap), and whether the scan
// was incomplete (a live same-user row whose env we could not read).
function classifyScan(psLines, slot) {
  const rows = (psLines || []).map(parsePsLine).filter(Boolean);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  let incomplete = false;
  const orphans = [];
  let occupied = false;
  for (const r of rows) {
    if (isZombie(r.state)) continue;
    if (!envReadable(r.args)) { incomplete = true; continue; }
    const mk = markerIn(r.args);
    if (!mk || mk.slot !== slot) continue;
    occupied = true;                                        // any marked proc for the slot ⇒ occupied
    const sup = byPid.get(mk.pid);
    const supervisorDead = !sup || sup.lstart !== mk.start; // absent, or pid-reused (start mismatch)
    if (supervisorDead) orphans.push({ pid: r.pid, supervisorPid: mk.pid, nonce: mk.nonce, start: mk.start });
  }
  return { occupied, incomplete, orphans };
}

// ── Real sentinel bind (the achievable Node/macOS contract) ─────────────────────────────────────
// Stock libuv always sets SO_REUSEADDR and gives no switch; same-address 127.0.0.1 binds are still mutually
// exclusive without SO_REUSEPORT. So: identical IPv4 host, exclusive:true (no cluster-handle sharing),
// reusePort unset(false), ownership acknowledged only on 'listening'. Accepted connections are destroyed at
// once (a listener never TIME_WAITs; an accepted conn could stall close()). EADDRINUSE ⇒ unavailable (null).
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

function shuffle(arr, random = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* Acquire a free slot, or QUEUE (best-effort, randomized + jitter — explicitly NOT FIFO) until one frees or
 * the deadline elapses. Deps injected for testing:
 *   bind(port) → Promise<server|null>   (null = EADDRINUSE/unavailable; reject = non-EADDRINUSE, surfaced)
 *   probeBand(slot) → Promise<boolean>  (true = band free)
 *   scan(slot) → { occupied, incomplete, orphans }
 *   sleep(ms) → Promise ; now() → ms ; random() → [0,1) ; log(msg)
 * Returns { slot, server, offset }. The caller keeps `server` open for the whole run and closes it on release.
 */
async function acquireSlot(opts) {
  const {
    slots = SLOTS, base = SENTINEL_BASE, pin = null,
    bind, probeBand, scan,
    now = () => Date.now(), sleep, random = Math.random, log = () => {},
    deadlineMs = 20 * 60 * 1000, waitMs = 2000, jitterMs = 500,
  } = opts;
  if (pin != null && (pin < 0 || pin >= slots)) throw new Error(`emu-alloc: pin ${pin} out of range 0..${slots - 1}`);
  const t0 = now();
  for (;;) {
    const order = pin != null ? [pin] : shuffle([...Array(slots).keys()], random);
    for (const slot of order) {
      const server = await bind(base + slot);      // reject (non-EADDRINUSE) propagates — surfaced loudly
      if (!server) continue;                        // EADDRINUSE ⇒ unavailable
      const sc = scan(slot);
      if (sc.occupied || sc.incomplete) {
        await closeServer(server);
        log(`slot ${slot} QUARANTINED — ${sc.incomplete ? 'incomplete process scan (unverifiable ⇒ refuse)' : 'orphan pid(s) ' + sc.orphans.map((o) => o.pid).join(',')}`);
        continue;
      }
      if (!(await probeBand(slot))) { await closeServer(server); log(`slot ${slot} sentinel free but band busy — skip`); continue; }
      return { slot, server, offset: slot * 10 };
    }
    if (now() - t0 > deadlineMs) throw new Error(`emu-alloc: no free slot after ${((now() - t0) / 1000).toFixed(0)}s (deadline ${deadlineMs / 1000}s) — all ${slots} slots busy`);
    log(`all ${slots} slots busy — queued, waiting (${((now() - t0) / 1000).toFixed(0)}s)…`);
    await sleep(waitMs + Math.floor(random() * jitterMs));
  }
}

module.exports = {
  SLOTS, SENTINEL_BASE, FIXTURE_SENTINEL_BASE, RUN_VAR, OFFSET_VAR,
  sentinelPort, newNonce, formatMarker, parseMarker,
  parsePsLine, envReadable, isZombie, markerIn, classifyScan,
  bindSentinel, closeServer, shuffle, acquireSlot,
};
