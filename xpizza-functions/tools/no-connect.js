'use strict';
/* Count a process's OUTBOUND CONNECTION ATTEMPTS, from inside that process.
 *
 * 🔴 WHY THIS EXISTS. The emulator-ports guard proves every `test/*.emulator.test.js` REFUSES a foreign
 * host, and it proved it by reading a refusal banner off stderr plus a clean nonzero exit. A banner is a
 * statement about intent, not about behaviour: a suite that did its work, touched a database and THEN
 * printed `🔴 REFUSED —` before exiting 1 satisfies every part of that check. No suite does that today —
 * both refusal helpers exit immediately — but the guard exists to stop an emulator suite from writing to
 * a NON-LOCAL database, which is the wipe-production class of accident. A guarantee for that has to be
 * "it contacted nothing", and only the process itself can say so.
 *
 * Zero ASSERTIONS is not the same guarantee and cannot replace this: a suite can wipe a database root
 * before its first assertion runs, so `##CELLS 0` would be perfectly consistent with a destroyed tree.
 *
 * 🔴 AN OBSERVER, NOT A SANDBOX. Nothing here blocks, delays or rewrites a connection. If this file
 * prevented the connect, the guard would be measuring a DIFFERENT PROGRAM than the one that runs in
 * anger, which is the mistake the fake-stricter-than-Firestore finding cost us a whole slice to learn:
 * a double that is stricter than reality manufactures evidence for a guarantee the system does not have.
 * So it counts and calls through, and a suite that connects still connects — the guard then FAILS and
 * names it, which is the outcome we want.
 *
 * ═══ WHERE IT HOOKS, AND WHY — ALL OF IT MEASURED ON THIS NODE (v24.15.0) AND THIS REPO'S STACK ═══
 * `net.Socket.prototype.connect` is the floor that the interesting layers ride on. Measured, each
 * against a dead LOCAL port, by counting hook calls:
 *     raw net.connect .......... 1 attempt seen
 *     tls.connect .............. seen
 *     https.get ................ seen
 *     http2.connect ............ seen
 *     firebase-admin Firestore .. 7 attempts seen  ← grpc-js, the actual threat path in this repo
 * So one hook covers net / tls / http / https / http2 / grpc-js. That last line is the one that matters
 * and it is why this is not guesswork: the suites reach a foreign Firestore through grpc, and grpc-js
 * goes through this function.
 *
 * 🔴 GLOBAL `fetch` DOES NOT, AND IS HOOKED SEPARATELY. Node's built-in fetch is bundled undici reached
 * through internal bindings, so it never touches the PUBLIC `net` module: with this hook installed,
 * `await fetch('http://127.0.0.1:9')` produced ZERO hits. Nor is it observable by subscribing to
 * `undici:client:beforeConnect` / `undici:client:sendHeaders` / `undici:request:create` — measured, all
 * three published nothing. The only reliable observation point left is `globalThis.fetch` itself, so
 * that is wrapped too and a call counts as an attempt. It is coarser than the socket hook (it counts the
 * intent to fetch rather than a socket), and deliberately so: for this guard's purpose, a suite that
 * calls fetch at a foreign host has already failed.
 *
 * NOT COUNTED, deliberately and on the record: DNS resolution. `dns.lookup` contacts a resolver, not the
 * target, and a suite that resolves a name and then refuses has still contacted no database. Every path
 * that would actually read or write goes through one of the two hooks above — a hostname connect fires
 * `Socket.prototype.connect` regardless of when its lookup happened. If a future finding shows a suite
 * leaking through DNS alone, that is a NEW hook and a new cell, not a widening of this one.
 *
 * ═══ 🔴 WHY A stderr TRAILER IS NOT ENOUGH, AND WHAT DECIDES INSTEAD ═══
 * INJECTION PROPAGATES TO CHILDREN; OBSERVATION DOES NOT. NODE_OPTIONS reaches a child process, so a
 * child DOES load this file and DOES emit its trailer — into whatever its stdio points at. Under the
 * DEFAULT `spawnSync` stdio those pipes are captured by the PARENT and never re-emitted, so the child's
 * `##CONNECT 1 127.0.0.1:9` is swallowed and only the parent's `##CONNECT 0 -` reaches the guard.
 * Reproduced: a parent that spawns a default-piped child which connects, then prints the banner and
 * exits 1, is scored a CLEAN REFUSAL by any stderr-only reader.
 * The earlier cell for this missed it because it used `stdio: 'inherit'` — the one variant where the
 * child's stderr happens to reach the guard. A fixture that picks the arrangement which lets the
 * instrument work is measuring the instrument, not the property.
 *
 * SO THE VERDICT IS DECIDED FROM PER-PROCESS RECORD FILES, WHICH NO stdio ARRANGEMENT CAN INTERCEPT.
 * When `NO_CONNECT_DIR` is set, every process writes its own `<pid>.rec` there, synchronously:
 *     START <pid> <ppid>     at preload time
 *     CONNECT <target>       appended AT EACH ATTEMPT — not at exit, so a process killed mid-flight
 *                            still leaves the evidence behind it
 *     EXIT <code> <attempts> appended in the exit handler, carrying the IN-MEMORY attempt counter
 * A record with START and no EXIT therefore means "this process was observed and did not finish", which
 * the reader must treat as INCOMPLETE COVERAGE and REJECT. Failing closed is the whole point: the
 * alternative reads an unfinished observation as a clean one.
 *
 * 🔴 AND EXIT CARRIES THE COUNT SO A LOST WRITE CANNOT READ AS CLEAN. An earlier version of this file
 * claimed that a failed record write "leaves the record without its EXIT line" — which is only true when
 * the EXIT write is the one that failed. If a single CONNECT append failed while START and EXIT both
 * succeeded, the record held exactly the lines a clean run holds and was read as clean. That was a
 * fails-closed claim stronger than the code, inside the paragraph asserting it fails closed.
 * So EXIT reports the counter kept in memory, which no disk write can lose, and the reader requires
 * `attempts === 0` AND zero CONNECT lines AND THE TWO TO AGREE. A disagreement means a write was lost,
 * and is a rejection naming that — not a verdict. `rec()` still swallows its own errors, because an
 * observer must never break the process it observes; the counter is what makes that safe.
 *
 * ═══ THE TRAILER (kept, for diagnostics only — never for the verdict) ═══
 * `##CONNECT <n> <first-target-or-->` written with `fs.writeSync(2, …)` from an `exit` handler.
 *   · SYNCHRONOUS, and to fd 2 directly, because both refusal helpers end in `process.exit()`. A
 *     buffered `console.error` or an async write can be discarded on exit; `writeSync` in an `exit`
 *     handler was measured to survive `process.exit(3)`.
 *   · stderr, not stdout, so it cannot be mistaken for suite output and cannot disturb the `##CELLS`
 *     counter, which patches stdout.
 *   · 🔴 ABSENCE OF THE TRAILER IS A FAILURE, NOT A ZERO — the same rule count-marks.js states for
 *     `##CELLS`. A count that can go missing silently is exactly what this is meant to replace, so the
 *     reader must treat "no trailer" as untrustworthy rather than as "made no connections". That also
 *     makes a missed injection loud: if a spawn shape ever stops receiving this preload, the trailer
 *     disappears and the guard says so instead of quietly certifying a suite it never watched.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');

const TRAILER = '##CONNECT';

let attempts = 0;
let spawns = 0;
let first = null;

/* The record file, when a reader asked for one. Absent NO_CONNECT_DIR this file behaves exactly as
   before, so nothing that already loads it needs to change. */
const REC_DIR = process.env.NO_CONNECT_DIR || null;
const REC = REC_DIR ? path.join(REC_DIR, `${process.pid}.rec`) : null;

/* Synchronous and append-only. A write failure is SWALLOWED, because an observer must never break the
   process it observes — and every way a write can go missing is caught by the READER rather than by
   anything here:
     · a lost CONNECT line — the EXIT line carries the in-memory attempt count, so the reader sees the
       count disagree with the CONNECT lines on disk and rejects, naming the lost write;
     · a lost EXIT line — the record has START and no EXIT, which the reader rejects as observed-but-
       unfinished;
     · a lost START, or no file at all — no record for the top-level pid, which the reader rejects as
       nothing-observed-this-suite.
   🔴 AN EARLIER VERSION OF THIS BLOCK CLAIMED a failed write "leaves the record without its EXIT line,
   which the reader treats as incomplete" — true only when EXIT was the write that failed, and false for
   exactly the case that mattered: a lost CONNECT while START and EXIT both landed left a record holding
   the lines a clean run holds. That claim was retired by the count cross-check and survived here as prose
   contradicting the comment three lines below it. The count is what makes swallowing safe; this comment
   is not what makes it safe. */
function rec(line) {
  if (!REC) return;
  /* Swallowed deliberately — an observer must never break the process it observes. Safe only because
     EXIT carries the in-memory count, so a lost CONNECT line is DETECTED by the reader rather than
     silently becoming a clean record. */
  try { fs.appendFileSync(REC, `${line}\n`); } catch (_) { /* see the header */ }
}

rec(`START ${process.pid} ${process.ppid}`);

/* `Socket.prototype.connect` does NOT receive the caller's arguments. Node normalises them first, so
   the hook sees a single array-like `[options, callback]` — reading `args[0].host` off that yields
   `undefined:undefined`, which is what a first version of this file reported. Measured, then handled. */
function describeTarget(args) {
  try {
    const a0 = args[0];
    const opts = (a0 && typeof a0 === 'object' && '0' in a0) ? a0[0] : a0;
    if (opts && typeof opts === 'object') {
      const where = opts.host || opts.hostname || opts.path || '?';
      return opts.port === undefined ? String(where) : `${where}:${opts.port}`;
    }
    if (typeof opts === 'number') {
      const host = typeof args[1] === 'string' ? args[1] : 'localhost';
      return `${host}:${opts}`;
    }
    return String(opts);
  } catch (_) {
    return '?';                       // never let describing a target break the suite
  }
}

/* One space-free token, so the trailer stays parseable whatever a target looks like. */
const sanitize = (s) => String(s).replace(/\s+/g, '_').slice(0, 120) || '-';

function recordSpawn(kind, what) {
  spawns += 1;
  /* AT CALL TIME: the record exists before the child does, so a child that escapes observation entirely
     still leaves proof that it was started. */
  rec(`SPAWN ${kind}:${sanitize(what)}`);
}

function record(target) {
  attempts += 1;
  const t = sanitize(target);
  if (first === null) first = t;
  /* AT ATTEMPT TIME, deliberately. Written before the connection is even handed to the socket, so a
     process killed or hung mid-connect still leaves `CONNECT <target>` on disk. An exit-time write
     would lose exactly the cases that matter most. */
  rec(`CONNECT ${t}`);
}

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  try { record(describeTarget(args)); } catch (_) { /* observing must never break the suite */ }
  return realConnect.apply(this, args);
};

/* Measured to bypass the hook above on this node; see the header. */
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    try {
      const u = (input && typeof input === 'object' && input.url) ? input.url : input;
      record(`fetch(${u})`);
    } catch (_) { /* as above */ }
    return realFetch.call(this, input, init);
  };
}

/* ═══ 🔴 LAUNCHES AND SENDS — HOOKED AT THE LOWEST PUBLIC LAYER, NOT PER FUNCTION ═══════════════
 * Five rounds of findings were one class: each fix hooked one more named function and the next escape was
 * a path that did not go through it — a piped child, an env-stripped child, then
 * `new ChildProcess().spawn(...)` reaching none of the seven wrapped functions, and `dgram.send` reaching
 * neither connect hook. Hooking per function is an endless list. So each capability is hooked at the
 * LOWEST PUBLIC LAYER everything above it rides on, and which layer that is was MEASURED:
 *
 *   ChildProcess.prototype.spawn  <- spawn, exec, execFile, fork, cluster.fork, AND a raw
 *                                    `new ChildProcess().spawn({file, args, envPairs: [], stdio})`.
 *                                    Measured: each fires it exactly once, including `exec`, which calls
 *                                    execFile internally and would DOUBLE-COUNT under per-function hooks.
 *   spawnSync / execSync / execFileSync
 *                                 <- the SYNC family does NOT reach the prototype (measured: zero hits),
 *                                    so it keeps explicit hooks. This is the one place per-function is
 *                                    correct rather than lazy.
 *   worker_threads.Worker         <- a worker shares the process but not the module registry.
 *   dgram.Socket.prototype.send / .connect
 *                                 <- measured: BOTH bypass net.Socket.prototype.connect entirely (0 hits).
 *                                    UDP needs no connection, so `send` alone reaches a host.
 *   net.Socket.prototype.connect  <- net, tls, http, https, http2 and grpc-js all ride on it (measured;
 *                                    firebase-admin Firestore produced 7 hits through grpc).
 *   globalThis.fetch              <- bundled undici behind internal bindings: 0 net hits (measured).
 *   globalThis.WebSocket          <- likewise 0 net hits (measured). Present from node 22.
 *                                    `EventSource` and `WebSocketStream` are NOT defined on this runtime
 *                                    (measured); if a future node adds either, the classification cell
 *                                    below does not cover globals, so add the hook deliberately.
 *
 * ESM bindings are resynced once, after patching, so `import { spawn } from 'node:child_process'` sees the
 * patched functions — without it every hook here would be real and reachable only from CJS, which a cell
 * proves rather than assumes. */
const cp = require('child_process');

/* The async floor. One hook for the whole async family and for a hand-built ChildProcess. */
if (cp.ChildProcess && typeof cp.ChildProcess.prototype.spawn === 'function') {
  const realSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function spawn(...args) {
    try {
      const o = args[0] || {};
      recordSpawn('ChildProcess.spawn', o.file || (Array.isArray(o.args) ? o.args[0] : '?'));
    } catch (_) { /* observing must never break the suite */ }
    return realSpawn.apply(this, args);
  };
}

/* The sync family, measured NOT to reach the prototype above. */
for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
  const real = cp[name];
  if (typeof real !== 'function') continue;
  cp[name] = function patched(...args) {
    try { recordSpawn(name, args[0]); } catch (_) { /* as above */ }
    return real.apply(this, args);
  };
}

try {
  const wt = require('worker_threads');
  const RealWorker = wt.Worker;
  if (typeof RealWorker === 'function') {
    wt.Worker = class Worker extends RealWorker {
      constructor(...args) {
        try { recordSpawn('Worker', args[0]); } catch (_) { /* as above */ }
        super(...args);
      }
    };
  }
} catch (_) { /* worker_threads absent: nothing to forbid */ }

/* UDP. `send` is the one that reaches a host without any connect at all. */
try {
  const dgram = require('dgram');
  const DS = dgram.Socket && dgram.Socket.prototype;
  if (DS && typeof DS.send === 'function') {
    const realSend = DS.send;
    DS.send = function send(...args) {
      try {
        const addr = args.find((a) => typeof a === 'string' && a !== '') || '?';
        const port = args.find((a) => typeof a === 'number');
        record(`udp:${addr}:${port === undefined ? '' : port}`);
      } catch (_) { /* as above */ }
      return realSend.apply(this, args);
    };
  }
  if (DS && typeof DS.connect === 'function') {
    const realDgramConnect = DS.connect;
    DS.connect = function connect(...args) {
      try {
        const addr = args.find((a) => typeof a === 'string' && a !== '') || '?';
        record(`udp-connect:${addr}:${args.find((a) => typeof a === 'number') ?? ''}`);
      } catch (_) { /* as above */ }
      return realDgramConnect.apply(this, args);
    };
  }
} catch (_) { /* dgram absent */ }

/* Measured to bypass the socket hook on this runtime, exactly like fetch. */
if (typeof globalThis.WebSocket === 'function') {
  const RealWS = globalThis.WebSocket;
  globalThis.WebSocket = class WebSocket extends RealWS {
    constructor(...args) {
      try { record(`websocket:${args[0]}`); } catch (_) { /* as above */ }
      super(...args);
    }
  };
}

/* ═══ 🔴 DNS — A RESOLVER IS A HOST, AND THE SUITE CHOOSES IT ═══════════════════════════════════
 * This file previously classified dns as NOT APPLICABLE, reasoning that a resolver is "not the target".
 * That was wrong, and it was my reasoning rather than an oversight. Reproduced:
 *     const r = new (require('dns').Resolver)({ timeout: 100, tries: 1 });
 *     r.setServers(['127.0.0.1:9']); r.resolve4('example.test', cb);
 * left `START | EXIT 1 0 0` — entirely unrecorded. A suite can point a Resolver at ANY address and reach
 * it, so the server IS the contacted host. c-ares does this natively, so it touches neither
 * net.Socket.prototype.connect nor dgram; only the JS entry points can see it.
 *
 * THE FOUR SURFACES, enumerated because they are genuinely four: `dns`, `dns.Resolver.prototype`,
 * `dns.promises`, and `dns.promises.Resolver.prototype` — and `dns.promises.Resolver !== dns.Resolver`
 * (measured), so patching one class does not cover the other.
 * The FUNCTION LIST IS DERIVED, not written down: every own function matching /^(resolve|reverse|lookup)/
 * on each surface. This runtime has `resolveTlsa`, which a hand-written list would have missed — the same
 * lesson as classifying builtins from `builtinModules` instead of from memory. */
try {
  const dns = require('dns');
  const surfaces = [
    ['dns', dns],
    ['dns.Resolver', dns.Resolver && dns.Resolver.prototype],
    ['dns.promises', dns.promises],
    ['dns.promises.Resolver', dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype],
  ];
  const describeDns = (self, name) => {
    try {
      /* lookup/lookupService go through getaddrinfo/getnameinfo — the SYSTEM resolver rather than a server
         the suite named. Still a host, still recorded, but labelled so a failure says which it was. */
      if (name.startsWith('lookup')) return 'dns:system(getaddrinfo)';
      const servers = (self && typeof self.getServers === 'function') ? self.getServers() : dns.getServers();
      return `dns:${Array.isArray(servers) ? servers.join(',') : String(servers)}`;
    } catch (_) { return 'dns:?'; }
  };
  for (const [label, target] of surfaces) {
    if (!target) continue;
    for (const name of Object.keys(target)) {
      if (!/^(resolve|reverse|lookup)/.test(name)) continue;
      const real = target[name];
      if (typeof real !== 'function') continue;
      target[name] = function patchedDns(...args) {
        try { record(`${describeDns(this, name)}|${label}.${name}`); } catch (_) { /* never break the suite */ }
        return real.apply(this, args);
      };
    }
  }
} catch (_) { /* dns absent */ }

/* ═══ 🔴 module.register — LOADER HOOKS RUN ON A DEDICATED THREAD ═══════════════════════════════
 * `module.register(specifier)` starts async loader hooks on a thread that does NOT go through the wrapped
 * Worker constructor, so it is execution this file cannot govern. Reproduced with a data-URL initializer:
 * it reported isMainThread:false and its `net.connect` was attributed to a thread whose counter the main
 * thread never sees.
 * 🔴 IT WAS ALREADY REJECTED BEFORE THIS HOOK, BUT FOR THE WRONG REASON — the loader thread's own copy of
 * this preload appended a CONNECT line while the MAIN thread's EXIT counter said 0, so the reader called
 * it a "record write was lost" MISMATCH. That verdict is right and its diagnosis is wrong: nothing was
 * lost, a second thread wrote it. An operator would have gone looking for a disk problem. Recording the
 * register itself makes the rejection say what actually happened.
 * `registerHooks` (synchronous, in-thread on this runtime) is hooked too: measured present here, and a
 * synchronous loader hook is still a way to run code the classification table has not accounted for. */
try {
  const mod = require('module');
  for (const name of ['register', 'registerHooks']) {
    const real = mod[name];
    if (typeof real !== 'function') continue;
    mod[name] = function patchedRegister(...args) {
      try {
        const spec = args[0];
        recordSpawn(`module.${name}`, typeof spec === 'string' ? spec.slice(0, 60) : (spec && spec.href) || '?');
      } catch (_) { /* never break the suite */ }
      return real.apply(this, args);
    };
  }
} catch (_) { /* module always present; defensive */ }

try { require('module').syncBuiltinESMExports(); } catch (_) { /* older node: CJS hooks still apply */ }

process.on('exit', (code) => {
  /* The COUNTS, from memory, not from the file: a CONNECT or SPAWN append that failed silently would
     otherwise leave a record indistinguishable from a clean one. The reader cross-checks both. */
  rec(`EXIT ${code} ${attempts} ${spawns}`);
  try {
    fs.writeSync(2, `${TRAILER} ${attempts} ${first || '-'}\n`);
  } catch (_) { /* nothing useful to do while exiting */ }
});

/* ═══ 🔴 THE THREAT MODEL, STATED — WHAT THIS CATCHES AND WHAT IT EXPLICITLY DOES NOT ══════════════
 * Catches NON-ADVERSARIAL suites that do work, launch a process or worker, or contact a host before
 * refusing, through any public Node networking or process API (classified exhaustively against
 * builtinModules). It does NOT defend against a suite that deliberately tampers with its own observer
 * (hook removal, record-file writes, native addons, process.binding, process.dlopen); that is out of
 * scope for this test-harness guard. Deliberate tampering with the platform is owned by a separate
 * platform-security initiative (access control, credential separation, server-side trust), not by this
 * guard.
 *
 * Why that boundary is the honest one: every hook here lives in the same process as the code it watches,
 * so a suite that wants to remove them can. The accident this exists to stop — a suite pointed at a
 * non-local database doing its work before refusing — is not adversarial, and a guarantee against
 * carelessness is worth having even where a guarantee against malice is impossible. What would be
 * dishonest is leaving the difference unstated.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE CLASSIFICATION TABLE. Every entry of `require('module').builtinModules` must appear below, as either
 * HOOKED (naming the hook) or a reason it cannot launch a process or reach a host. A cell in
 * tools/emulator-ports.guard.test.js takes the RUNTIME'S OWN list and fails if any entry is missing, so a
 * new node version cannot add an unobserved path silently — the completeness is by construction rather
 * than by my having thought of everything. */
const H = (hook, doc, measured) => ({ hooked: true, by: hook, doc, measured: measured || null });
const NA = (why, doc, measured) => ({ hooked: false, why, doc, measured: measured || null });

const NET = 'net.Socket.prototype.connect';
const CPS = 'ChildProcess.prototype.spawn (+ spawnSync/execSync/execFileSync)';
const NOTHING = '<nothing recorded>';

/* `doc` cites the Node API documentation SECTION that establishes the verdict; `measured` records a probe
   run under this preload, with its result, for every entry where the documentation alone left any doubt.
   🔴 THE PROBE HARNESS WAS CONTROLLED BEFORE ITS NULLS WERE BELIEVED: net.connect, spawnSync, dns.resolve4
   and a connect inside vm each RECORDED under the same harness, so `<nothing recorded>` below means the
   API did nothing observable rather than that the probe was broken. An audit whose every answer is "clean"
   is indistinguishable from an audit that measured nothing. */
const BUILTIN_CLASSIFICATION = {
  // ─── HOOKED ───────────────────────────────────────────────────────────────────────────────────
  child_process: H(CPS, 'child_process: Child process', 'spawnSync -> SPAWN spawnSync:/bin/echo; raw ChildProcess().spawn -> SPAWN ChildProcess.spawn:/bin/echo'),
  cluster: H('ChildProcess.prototype.spawn', 'cluster: Cluster — cluster.fork() uses child_process.fork()', 'cluster.fork() -> SPAWN ChildProcess.spawn:node'),
  worker_threads: H('worker_threads.Worker constructor', 'worker_threads: Worker threads', 'new Worker -> SPAWN Worker:...'),
  dgram: H('dgram.Socket.prototype.send and .connect', 'dgram: UDP/datagram sockets — socket.send() needs no connection', 'send -> CONNECT udp:127.0.0.1:9 (and 0 hits on ' + NET + ')'),
  dns: H('every /^(resolve|reverse|lookup)/ function on dns, dns.Resolver.prototype, dns.promises and dns.promises.Resolver.prototype', 'dns: DNS — "dns.setServers()" and the Resolver class let a caller choose the server', 'new Resolver + setServers([127.0.0.1:9]) + resolve4 -> CONNECT dns:127.0.0.1:9|dns.Resolver.resolve4; module-level resolve4 -> CONNECT dns:<system servers>'),
  module: H('module.register and module.registerHooks', 'module: Modules — "module.register()" runs async hooks on a DEDICATED THREAD', 'register(data: URL) -> SPAWN module.register:data:...; the loader thread also produced a second START under the same pid'),
  /* Added because the completeness cell FAILED without it — a second time the runtime's own list knew
     something the author did not. `require('dns/promises')` IS `require('dns').promises` (measured), so the
     surface already hooked above covers it; the entry has to exist all the same. */
  'dns/promises': H('the dns.promises surface hooked above — require(\'dns/promises\') is the same object (measured)', 'dns: Promises API', 'dns/promises Resolver + setServers + resolve4 -> CONNECT dns:127.0.0.1:9|dns.promises.Resolver.resolve4'),
  net: H(NET, 'net: Net', 'connect -> CONNECT 127.0.0.1:9'),
  tls: H(NET + ' — tls.connect rides on it', 'tls: TLS/SSL — "tls.connect()" creates a net.Socket', 'tls.connect -> 1 hit on ' + NET),
  http: H(NET, 'http: HTTP — requests use net sockets', 'https.get -> hit on ' + NET),
  https: H(NET, 'https: HTTPS', 'https.get -> hit on ' + NET),
  http2: H(NET, 'http2: HTTP/2', 'http2.connect -> hit on ' + NET),
  'node:test': H(CPS, 'test runner: "run()" spawns a child process per test file', 'run({files:[real]}) -> SPAWN ChildProcess.spawn:node. An earlier probe with files:[] recorded nothing and proved nothing'),
  _http_agent: H(NET, 'internal http agent; sockets come from net', 'new http.Agent() -> ' + NOTHING + ' (an Agent pools sockets, it does not create them)'),
  _http_client: H(NET, 'internal http client', null),
  _http_common: H(NET, 'internal http parser glue', null),
  _http_incoming: H(NET, 'internal http message', null),
  _http_outgoing: H(NET, 'internal http message', null),
  _http_server: H(NET, 'internal http server (inbound)', null),
  _tls_common: H(NET, 'internal tls helpers', null),
  _tls_wrap: H(NET, 'internal tls socket wrapper', null),
  _stream_wrap: H(NET + ' — it wraps a handle created through a hooked path', 'internal stream wrapper', null),

  // ─── NOT APPLICABLE ───────────────────────────────────────────────────────────────────────────
  assert: NA('assertions only', 'assert: Assert', null),
  'assert/strict': NA('assertions only', 'assert: Strict assertion mode', null),
  async_hooks: NA('tracks async resource lifetimes in-process', 'async_hooks: Async hooks', 'createHook().enable() -> ' + NOTHING),
  buffer: NA('memory', 'buffer: Buffer', null),
  console: NA('writes to stdio that already exists', 'console: Console', null),
  constants: NA('deprecated constant table', 'deprecated: DEP0008', null),
  crypto: NA('computation over local data; no transport of its own', 'crypto: Crypto', null),
  diagnostics_channel: NA('in-process publish/subscribe', 'diagnostics_channel: Diagnostics Channel', 'channel.publish -> ' + NOTHING),
  domain: NA('deprecated error grouping', 'domain: Domain (deprecated)', null),
  events: NA('in-process emitter', 'events: Events', null),
  fs: NA('local filesystem', 'fs: File system', null),
  'fs/promises': NA('local filesystem', 'fs: Promises API', null),
  inspector: NA('opens an INBOUND debugger listener; Session speaks to the in-process V8 inspector over a channel, not a socket', 'inspector: "inspector.open()" starts a listener; "new inspector.Session()" connects to the V8 inspector of the current process', 'open(0,127.0.0.1,false) -> ' + NOTHING + '; new Session().connect() -> ' + NOTHING + '; Session.connectToMainThread() -> ' + NOTHING),
  'inspector/promises': NA('as inspector', 'inspector: Promises API', null),
  os: NA('reads local system information', 'os: OS — "os.networkInterfaces()" reports local addresses', 'networkInterfaces() -> ' + NOTHING),
  path: NA('string manipulation', 'path: Path', null),
  'path/posix': NA('string manipulation', 'path: path.posix', null),
  'path/win32': NA('string manipulation', 'path: path.win32', null),
  perf_hooks: NA('timing and observation of local activity', 'perf_hooks: Performance measurement APIs', 'new PerformanceObserver().observe() -> ' + NOTHING),
  process: NA('the process object opens nothing; process.binding and process.dlopen are explicitly OUT OF SCOPE (see THREAT MODEL)', 'process: Process — "process.dlopen()" loads a shared object', 'process.report.getReport() -> ' + NOTHING),
  punycode: NA('string encoding', 'punycode (deprecated): DEP0040', null),
  querystring: NA('string encoding', 'querystring: Query string', null),
  readline: NA('reads a stream that already exists', 'readline: Readline', 'createInterface over a PassThrough -> ' + NOTHING),
  'readline/promises': NA('as readline', 'readline: Promises API', null),
  repl: NA('evaluates code IN-PROCESS over supplied streams; whatever it runs reaches these same hooks', 'repl: REPL — "repl.start()" reads from an input stream', 'start({input,output}) -> ' + NOTHING),
  stream: NA('plumbing over existing handles', 'stream: Stream', null),
  'stream/consumers': NA('plumbing', 'stream: Consumers', null),
  'stream/promises': NA('plumbing', 'stream: Promises API', null),
  'stream/web': NA('plumbing', 'stream: Web Streams API', null),
  _stream_duplex: NA('stream plumbing', 'stream: Duplex', null),
  _stream_passthrough: NA('stream plumbing', 'stream: PassThrough', null),
  _stream_readable: NA('stream plumbing', 'stream: Readable', null),
  _stream_transform: NA('stream plumbing', 'stream: Transform', null),
  _stream_writable: NA('stream plumbing', 'stream: Writable', null),
  string_decoder: NA('decoding', 'string_decoder: String decoder', null),
  sys: NA('deprecated alias of util', 'deprecated: DEP0025', null),
  timers: NA('scheduling', 'timers: Timers', null),
  'timers/promises': NA('scheduling', 'timers: Promises API', null),
  trace_events: NA('writes trace data to a local file', 'trace_events: Trace events', 'createTracing().enable() -> ' + NOTHING),
  tty: NA('terminal handles', 'tty: TTY', 'isatty(1) -> ' + NOTHING),
  url: NA('parsing', 'url: URL', null),
  util: NA('utilities', 'util: Util', null),
  'util/types': NA('type checks', 'util: util.types', null),
  v8: NA('introspects and serialises this VM; heap snapshots go to a local stream', 'v8: V8', 'serialize() and getHeapStatistics() -> ' + NOTHING),
  vm: NA('runs code IN-PROCESS; whatever it runs reaches these same hooks, which is measured rather than assumed', 'vm: VM', 'runInNewContext doing net.connect -> CONNECT 127.0.0.1:9 (recorded, as it must be); runInNewContext("1+1") -> ' + NOTHING),
  wasi: NA('WASI preview1 as exposed here grants filesystem preopens and no socket capability', 'wasi: WASI — "new WASI()" takes args, env and preopens', 'new WASI({version:preview1}) -> ' + NOTHING),
  zlib: NA('compression', 'zlib: Zlib', null),
  'node:sea': NA('reads assets embedded in a single executable', 'Single executable applications', null),
  'node:sqlite': NA('local file (or in-memory) database', 'node:sqlite: SQLite', 'new DatabaseSync(":memory:") + exec -> ' + NOTHING),
  'node:test/reporters': NA('formats the runner\'s output', 'test runner: Reporters', null),
};

module.exports = { BUILTIN_CLASSIFICATION };
