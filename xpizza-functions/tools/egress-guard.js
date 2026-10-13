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

  // loopback recognition on the NORMALIZED address (codex r2 P2): any IPv6 spelling (::1, 0:0:…:1, ::ffff:7f00:1,
  // ::ffff:127.0.0.1, zero-padded / compressed forms) is parsed to its 16 bytes first; IPv4-mapped forms are judged as IPv4
  const v6bytes = (s) => {
    let t = s.toLowerCase(); const zi = t.indexOf('%'); if (zi >= 0) t = t.slice(0, zi);
    let tail4 = null; const m4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
    if (m4) { tail4 = m4[1].split('.').map(Number); if (tail4.some((x) => x > 255)) return null; t = t.slice(0, -m4[1].length) + '0:0'; }
    const halves = t.split('::'); if (halves.length > 2) return null;
    const hx = (h) => (h === '' ? [] : h.split(':'));
    const a = hx(halves[0]); const b = halves.length === 2 ? hx(halves[1]) : [];
    const groups = halves.length === 2 ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    const bytes = groups.flatMap((g) => { const v = parseInt(g, 16); return [v >> 8, v & 255]; });
    if (tail4) { bytes[12] = tail4[0]; bytes[13] = tail4[1]; bytes[14] = tail4[2]; bytes[15] = tail4[3]; }
    return bytes;
  };
  const isLoopbackAddress = (h) => {
    const s = String(h).replace(/^\[|\]$/g, '');
    if (net.isIPv4(s)) return Number(s.split('.')[0]) === 127;
    if (net.isIPv6(s) || s.includes(':')) {
      const b = v6bytes(s); if (!b) return false;
      if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;                              // ::1
      if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return b[12] === 127;     // ::ffff:a.b.c.d
      return false;
    }
    return false;
  };
  const isLoopbackName = (h) => { const s = String(h).toLowerCase().replace(/\.$/, ''); return s === 'localhost' || s.endsWith('.localhost'); };
  const isLoopbackHost = (h) => (h == null || h === '' ? true : isLoopbackAddress(h) || isLoopbackName(h));
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

  // the RESOLVED destination is checked too (codex r2 P1-1a): a loopback NAME (or a caller's custom lookup) that resolves
  // to a non-loopback address is refused at the lookup the socket actually uses, before any connection attempt
  const checkedLookup = (inner, hostLabel) => function r3CheckedLookup(hostname, options, cb) {
    const done = typeof options === 'function' ? options : cb; const opts = typeof options === 'function' ? {} : (options || {});
    return inner.call(this, hostname, opts, (err, address, family) => {
      if (err) return done(err, address, family);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const bad = list.find((a) => !isLoopbackAddress(a));
      if (bad) { const e = refuse('connect (resolved)', `${hostLabel || hostname}→${bad}`); if (e) return done(e); }
      return done(null, address, family);
    });
  };
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    let norm; try { norm = net._normalizeArgs(args.length === 1 && Array.isArray(args[0]) ? args[0] : args); } catch (_) { norm = null; }
    const opts = norm && norm[0] && typeof norm[0] === 'object' ? norm[0] : null;
    if (opts && !opts.path) {
      const host = opts.host;
      if (!isLoopbackHost(host)) {
        const e = refuse('connect', `${host}:${opts.port}`);
        // fail the socket the way a refused connection fails (an 'error' on the next tick): no byte is ever sent — writes
        // queued before connect are discarded by destroy — and every client sees an ordinary connection error
        if (e) { const sock = this; process.nextTick(() => sock.destroy(e)); return sock; }
      } else if (host && !net.isIP(String(host).replace(/^\[|\]$/g, ''))) {
        // a loopback NAME: validate whatever address the socket's lookup (default or caller-supplied) resolves it to
        const fwd = { ...opts, lookup: checkedLookup(opts.lookup || origLookupRef(), host) };
        return origConnect.call(this, fwd, norm[1]);
      }
    }
    return origConnect.apply(this, args);
  };

  const origLookup = dns.lookup;
  function origLookupRef() { return origLookup; }
  dns.lookup = function guardedLookup(hostname, options, cb) {
    if (!isLoopbackHost(hostname)) {
      const done = typeof options === 'function' ? options : cb;
      const e = refuse('dns.lookup', hostname);
      if (e) { if (typeof done === 'function') { process.nextTick(() => done(e)); return {}; } throw e; }
    }
    if (typeof options === 'function' || typeof cb === 'function') return checkedLookup(origLookup, hostname).call(this, hostname, options, cb);
    return origLookup.apply(this, arguments);
  };
  if (dns.promises && dns.promises.lookup) {
    const origP = dns.promises.lookup;
    dns.promises.lookup = function guardedLookupP(hostname, ...rest) {
      if (!isLoopbackHost(hostname)) { const e = refuse('dns.promises.lookup', hostname); if (e) return Promise.reject(e); }
      return origP.call(this, hostname, ...rest);
    };
  }
  // ── DESCENDANTS (codex r2 P1-1b): the guard travels with every child process, whatever env the caller builds ──
  // (1) this process's own NODE_OPTIONS carries it, so a plain spawn(process.execPath, …) inherits it;
  // (2) child_process.{spawn,spawnSync,execFile,execFileSync,fork,exec,execSync} are wrapped: the child's env (the
  //     caller's replacement env included, NODE_OPTIONS deleted or not) always gets `--require <this guard>` added;
  // (3) worker_threads.Worker: an explicit execArgv (e.g. []) gets `--require <this guard>` appended, an explicit env too.
  const GUARD = __filename;
  const REQ = /\s/.test(GUARD) ? `--require "${GUARD}"` : `--require ${GUARD}`;
  const withGuard = (env) => { const e = { ...(env && typeof env === 'object' ? env : process.env) }; if (!String(e.NODE_OPTIONS || '').includes(GUARD)) e.NODE_OPTIONS = `${e.NODE_OPTIONS ? `${e.NODE_OPTIONS} ` : ''}${REQ}`; return e; };
  process.env.NODE_OPTIONS = withGuard(process.env).NODE_OPTIONS;
  const cp = require('child_process');
  const isOpts = (a) => a !== null && typeof a === 'object' && !Array.isArray(a);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
    const orig = cp[name]; if (typeof orig !== 'function' || orig.__r3guarded) continue;
    const execLike = name === 'exec' || name === 'execSync';
    const wrapped = function r3GuardedChild(...a) {
      let i = a.findIndex((x, k) => k >= 1 && isOpts(x));
      if (i >= 0) a[i] = { ...a[i], env: withGuard(a[i].env) };
      else { const at = execLike ? 1 : (Array.isArray(a[1]) ? 2 : 1); a.splice(Math.min(at, a.length), 0, { env: withGuard(process.env) }); i = at; }
      if (name === 'fork' && Array.isArray(a[i].execArgv) && !a[i].execArgv.includes(GUARD)) a[i] = { ...a[i], execArgv: [...a[i].execArgv, '--require', GUARD] };
      return orig.apply(this, a);
    };
    Object.defineProperty(wrapped, '__r3guarded', { value: true });
    cp[name] = wrapped;
  }
  { const wt = require('worker_threads'); const W = wt.Worker;
    if (!W.__r3guarded) {
      class R3GuardedWorker extends W {
        constructor(filename, options = {}) {
          const o = { ...options };
          if (Array.isArray(o.execArgv) && !o.execArgv.includes(GUARD)) o.execArgv = [...o.execArgv, '--require', GUARD];
          if (o.env && typeof o.env === 'object' && o.env !== wt.SHARE_ENV) o.env = withGuard(o.env);
          super(filename, o);
        }
      }
      Object.defineProperty(R3GuardedWorker, '__r3guarded', { value: true });
      wt.Worker = R3GuardedWorker;
    } }
  try { require('module').syncBuiltinESMExports(); } catch (_) { /* best effort */ }
  module.exports = { refused, isLoopbackHost, isLoopbackAddress, MODE, GUARD };
} else {
  module.exports = { refused: global.__R3_EGRESS_REFUSED, isLoopbackHost: null };
}
