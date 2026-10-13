'use strict';
/* PROCESS-LEVEL EGRESS REFUSAL for test processes (R3 P1-a, codex r1 P1-1). Preloaded (`node -r tools/egress-guard.js`)
 * BEFORE any client module loads — by tools/emulator-run.js into every `node` step of every emulator suite (beside
 * count-marks.js / emu-null-guard.js), and by every R3 contract entry in the npm test chain.
 *
 * 🔴 WHY. Wrapping one fetch client is not a boundary: XHR, native http / https, other clients (undici, node-fetch,
 * gRPC) and a redirect from a permitted loopback request all reached out. Every TCP / TLS connection in Node goes through
 * net.Socket.prototype.connect (tls.connect, http.Agent, undici and node-fetch all end there), and every name resolution
 * through dns.lookup / dns.promises.lookup — so THOSE are the boundary. A connection to anything but loopback (127/8,
 * ::1, ::ffff:127/104, "localhost") or a local IPC path is REFUSED: the connect throws synchronously with
 * ERR_R3_EGRESS_REFUSED (the socket is destroyed with it on the next tick — an ordinary connection error), nothing is sent, and the attempt is recorded in global.__R3_EGRESS_REFUSED (and printed once
 * to stderr). A redirect to an external host is a NEW connection, so it is refused the same way.
 *
 * MODE (R3_EGRESS_MODE): 'refuse' (the default) | 'record' — record-only, used ONCE to inventory existing attempts
 * across every suite before enforcing (advisor ruling 2026-10-13). Every attempt (refused or recorded) is also appended
 * as one JSON line to R3_EGRESS_LOG when that is set (suite = the entry script, host, port, stack top).
 * ALLOWLIST: tools/egress-allowlist.json — reviewed per-suite entries { suite, host, reason, owner }; EMPTY by design.
 */
const net = require('net');
const dns = require('dns');

if (!global.__R3_EGRESS_GUARD) {
  const refused = [];
  Object.defineProperty(global, '__R3_EGRESS_REFUSED', { value: refused, enumerable: false });
  Object.defineProperty(global, '__R3_EGRESS_GUARD', { value: true, enumerable: false });

  const isLoopbackHost = (h) => {
    if (h == null || h === '') return true;                       // net's default host is localhost
    const s = String(h).replace(/^\[|\]$/g, '').toLowerCase();
    if (s === 'localhost' || s.endsWith('.localhost')) return true;
    if (/^127(\.\d{1,3}){3}$/.test(s)) return true;
    if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
    if (/^::ffff:127(\.\d{1,3}){3}$/.test(s)) return true;
    return false;
  };
  const MODE = process.env.R3_EGRESS_MODE === 'record' ? 'record' : 'refuse';
  const fs = require('fs'); const pathMod = require('path');
  const SUITE = pathMod.relative(pathMod.join(__dirname, '..', '..'), process.argv[1] || '?').split(pathMod.sep).join('/');
  let allow = [];
  try { allow = JSON.parse(fs.readFileSync(pathMod.join(__dirname, 'egress-allowlist.json'), 'utf8')).entries || []; } catch (_) { allow = []; }
  const allowed = (target) => allow.some((a) => a.suite === SUITE && String(target).split(':')[0] === a.host);
  // returns an Error to throw (refuse mode) or null (record mode / reviewed allowlist entry)
  const refuse = (kind, target) => {
    const lim = Error.stackTraceLimit; Error.stackTraceLimit = 40; const raw = new Error().stack; Error.stackTraceLimit = lim;
    const stack = raw.split('\n').slice(1).map((l) => l.trim()).filter((l) => !/egress-guard\.js|\(node:|at node:/.test(l));
    const isAllowed = allowed(target);
    const rec = { kind, target: String(target), suite: SUITE, mode: isAllowed ? 'allowlisted' : MODE, at: stack.slice(0, 3).join(' | ') };
    refused.push(rec);
    if (process.env.R3_EGRESS_LOG) { try { fs.appendFileSync(process.env.R3_EGRESS_LOG, JSON.stringify(rec) + '\n'); } catch (_) { /* best effort */ } }
    if (isAllowed || MODE === 'record') return null;
    try { process.stderr.write(`r3-egress: 🔴 REFUSED ${kind} → ${rec.target} (tests reach loopback only)\n`); } catch (_) { /* best effort */ }
    const e = new Error(`r3-egress: ${kind} to ${rec.target} REFUSED (tests reach loopback only)`);
    e.code = 'ERR_R3_EGRESS_REFUSED';
    return e;
  };

  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let opts = args[0];
    if (Array.isArray(opts) && opts.length && typeof opts[0] === 'object') opts = opts[0];   // the internal [options, cb] form
    let host; let path = null;
    if (opts !== null && typeof opts === 'object') { path = opts.path || null; host = opts.host; }
    else if (typeof opts === 'string' && !/^\d+$/.test(opts)) path = opts;                    // connect(path)
    else host = typeof args[1] === 'string' ? args[1] : undefined;                            // connect(port, host?)
    if (!path && !isLoopbackHost(host)) {
      const e = refuse('connect', `${host}:${opts && typeof opts === 'object' ? opts.port : opts}`);
      // fail the socket the way a refused connection fails (an 'error' on the next tick): no byte is ever sent — writes
      // queued before connect are discarded by destroy — and every client sees an ordinary connection error
      if (e) { const sock = this; process.nextTick(() => sock.destroy(e)); return sock; }
    }
    return origConnect.apply(this, args);
  };

  const origLookup = dns.lookup;
  dns.lookup = function guardedLookup(hostname, options, cb) {
    if (!isLoopbackHost(hostname)) {
      const done = typeof options === 'function' ? options : cb;
      const e = refuse('dns.lookup', hostname);
      if (e) { if (typeof done === 'function') { process.nextTick(() => done(e)); return {}; } throw e; }
    }
    return origLookup.apply(this, arguments);
  };
  if (dns.promises && dns.promises.lookup) {
    const origP = dns.promises.lookup;
    dns.promises.lookup = function guardedLookupP(hostname, ...rest) {
      if (!isLoopbackHost(hostname)) { const e = refuse('dns.promises.lookup', hostname); if (e) return Promise.reject(e); }
      return origP.call(this, hostname, ...rest);
    };
  }
  module.exports = { refused, isLoopbackHost, MODE };
} else {
  module.exports = { refused: global.__R3_EGRESS_REFUSED, isLoopbackHost: null };
}
