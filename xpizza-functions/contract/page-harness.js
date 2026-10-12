'use strict';
/* R3 §5a — PAGE BOOT: the REAL staff page HTML in jsdom, its REAL scripts executed in document order inside the page's
 * own window context, the Firebase CDN modules replaced by the §5a adapter (contract/rtdb-adapter.js), nothing else.
 *
 *  · classic scripts (local src or inline) run with vm.runInContext in the window's context;
 *  · module scripts (inline or local) run as vm.SourceTextModule in that context (node --experimental-vm-modules);
 *    imports resolve: relative → the page dir file (query strings dropped); https://www.gstatic.com/firebasejs/*\/<name>.js
 *    → a SyntheticModule over the adapter's exports; any OTHER remote URL → REFUSED (reported, never silently stubbed);
 *  · remote CLASSIC scripts (maps SDKs, fonts) are not executed; each is reported in `skipped` so a page that needed one
 *    shows as a GAP rather than passing;
 *  · VIRTUAL TIMERS, REAL WALL CLOCK (codex r6 structural call; r7 clock-domain ruling): the page's setTimeout /
 *    setInterval / requestAnimationFrame / requestIdleCallback and its QUEUED TASKS (window.postMessage) run on the
 *    harness's own task queue against a VIRTUAL timer clock — nothing fires on real time. Date / performance.now stay REAL,
 *    so browser time stays coherent with server timestamps (countdowns / age-outs behave as in production); a cell that
 *    needs elapsed wall time uses the server-side scheduler control explicitly.
 *    settle(horizonMs) drains microtasks; waits (real time) while REAL I/O is in flight; else runs the next task / timer
 *    due within the horizon, awaiting its returned work (and every event listener's returned promise). There is NO
 *    exemption: a display clock simply runs; anything that writes is a normal, awaited effect.
 *    SEMANTICS (stated): true = nothing due within the horizon AND nothing TRACKED in flight. It is NOT global quiescence:
 *    an UNRETURNED continuation awaiting a timer beyond the horizon is not tracked (true); a RETURNED promise awaiting it is
 *    (false at the real-time cap). Queued-task sources the harness cannot virtualize (MessageChannel, BroadcastChannel,
 *    Worker, SharedWorker) are REMOVED: non-configurable throwing accessors on the window and every nested frame's window;
 *    any get / set / define attempt — at any time, mid-settle included — is a recorded page error and settle() is false.
 *
 * bootPage() never edits a page file: every rewrite is on the import graph (specifier → module), not on source text.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const REPO = path.join(__dirname, '..', '..');
const FIREBASE_CDN = /^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z-]+)\.js$/;

if (typeof vm.SourceTextModule !== 'function') {
  throw new Error('page-harness: vm.SourceTextModule is unavailable — run with node --experimental-vm-modules');
}

async function bootPage(dir, { host, url = 'https://r3.test/', beforeScripts = null, fetchImpl = null, settleMs = 8000, horizonMs = 10000, html: htmlOverride = null } = {}) {
  const pageDir = path.join(REPO, dir);
  const html = htmlOverride !== null ? htmlOverride : fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');   // htmlOverride: the harness's own acceptance pages
  const errors = []; const consoleErrors = []; const skipped = []; const refused = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`jsdom: ${e && e.message}`));
  vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ').slice(0, 300)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  const ctx = dom.getInternalVMContext();

  // ── VIRTUAL TIME ──
  const realNow = () => Date.now();                          // the harness's (and the page's) REAL wall clock
  let vnow = 0; const now = () => vnow;                       // the VIRTUAL timer clock — advanced only by settle()
  const pending = new Set(); let seqT = 0;
  // work in flight: a key stays in `pending` until the callback AND the promise it returned (an async render) finish
  const finish = (key, r, what) => {
    if (r && typeof r.then === 'function') r.then(() => pending.delete(key), (e) => { errors.push(`${what} (async): ${e && e.stack || e}`); pending.delete(key); });
    else pending.delete(key);
  };
  const runTracked = (fn, x, what) => {
    const ek = `exec${++seqT}`; pending.add(ek);
    let r; try { r = fn(...x); } catch (e) { errors.push(`${what}: ${e && e.stack || e}`); pending.delete(ek); return undefined; }
    finish(ek, r, what); return r;
  };
  const io = new Set();   // REAL I/O in flight (fetch, XHR) — distinct from page continuations, which may await virtual timers
  const trackP = (p, what) => { const k = `${what}${++seqT}`; io.add(k); Promise.resolve(p).then(() => io.delete(k), () => io.delete(k)); return p; };
  const siteOf = () => (String(new Error().stack).split('\n').slice(3, 4)[0] || '').trim().replace(/^at /, '').slice(0, 120);
  const norm = (f) => (typeof f === 'function' ? String(f) : String(f || '')).replace(/\s+/g, ' ').trim();
  const timers = new Map(); let nextId = 1;
  const addTimer = (kind, fn, ms, args, every) => {
    const id = nextId++; const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { id, kind, due: now() + delay, delay, every, fn, args, site: siteOf(), cb: norm(fn).slice(0, 90) });
    return id;
  };
  win.setTimeout = (fn, ms, ...a) => addTimer('timeout', fn, ms, a, false);
  win.setInterval = (fn, ms, ...a) => addTimer('interval', fn, ms, a, true);
  win.clearTimeout = (id) => { timers.delete(id); };
  win.clearInterval = (id) => { timers.delete(id); };
  win.requestAnimationFrame = (fn) => addTimer('raf', fn, 16, null, false);
  win.cancelAnimationFrame = (id) => { timers.delete(id); };
  win.requestIdleCallback = (fn) => addTimer('idle', () => fn({ didTimeout: false, timeRemaining: () => 50 }), 1, [], false);
  win.cancelIdleCallback = (id) => { timers.delete(id); };
  // codex r7 P1-1: QUEUED TASKS are virtualized too — window.postMessage is delivered through this task queue (a 0 ms
  // task), so settle() runs it and awaits the listeners' work; a chain of messages is a chain of tasks
  win.postMessage = (data, targetOrigin) => { addTimer('message', () => { win.dispatchEvent(new win.MessageEvent('message', { data, origin: win.location.origin, source: win })); }, 0, [], false); };
  // every EVENT LISTENER's returned promise (an async handler) is tracked work
  { const wrapped = new WeakMap(); const ET = win.EventTarget.prototype; const add = ET.addEventListener; const rem = ET.removeEventListener;
    const wrap = (l) => { if (typeof l !== 'function') return l; if (!wrapped.has(l)) wrapped.set(l, function (ev) { return runTracked((e) => l.call(this, e), [ev], `listener ${ev && ev.type}`); }); return wrapped.get(l); };
    ET.addEventListener = function (type, l, o) { return add.call(this, type, wrap(l), o); };
    ET.removeEventListener = function (type, l, o) { return rem.call(this, type, (typeof l === 'function' && wrapped.get(l)) || l, o); };
    let onmsg = null;
    Object.defineProperty(win, 'onmessage', { configurable: true, get: () => onmsg, set: (f) => { if (onmsg) win.removeEventListener('message', onmsg); onmsg = typeof f === 'function' ? f : null; if (onmsg) win.addEventListener('message', onmsg); } });
  }
  // FAIL CLOSED: a queued-task source the harness cannot virtualize must not exist silently
  // codex r8 P1 — the hazard is REMOVED, not checked for: each unvirtualizable queued-task source is a NON-CONFIGURABLE
  // accessor on the window (and on every nested frame's window) that THROWS on get and on set, and every define attempt
  // through Object.defineProperty / defineProperties / Reflect.defineProperty is refused AND recorded. Any attempt — at any
  // moment, mid-settle included — is a page error and makes settle() false (re-checked every loop and at the success return).
  const UNVIRTUALIZED = ['MessageChannel', 'BroadcastChannel', 'Worker', 'SharedWorker'];
  const channelAttempts = [];
  const attempt = (k, how) => { const m = `r3-page: ${how} of ${k} — a queued-task source settle() cannot virtualize (FAIL CLOSED)`; channelAttempts.push(m); errors.push(m); return m; };
  const guarded = new WeakSet();
  const guardWindow = (w) => {
    if (!w || guarded.has(w)) return; guarded.add(w);
    for (const k of UNVIRTUALIZED) {
      if (Object.prototype.hasOwnProperty.call(w, k) || typeof w[k] !== 'undefined') attempt(k, 'pre-existing exposure');
      Object.defineProperty(w, k, { configurable: false, enumerable: false, get() { throw new Error(attempt(k, 'access')); }, set() { throw new Error(attempt(k, 'assignment')); } });
    }
    const O = w.Object; const R = w.Reflect;
    const dp = O.defineProperty; const dps = O.defineProperties; const rdp = R.defineProperty;
    O.defineProperty = function (o, k, d) { if ((o === w || o === w.globalThis) && UNVIRTUALIZED.includes(String(k))) throw new w.TypeError(attempt(String(k), 'defineProperty')); return dp.call(this, o, k, d); };
    O.defineProperties = function (o, ds) { if (o === w) for (const k of Object.keys(ds || {})) if (UNVIRTUALIZED.includes(k)) throw new w.TypeError(attempt(k, 'defineProperties')); return dps.call(this, o, ds); };
    R.defineProperty = function (o, k, d) { if (o === w && UNVIRTUALIZED.includes(String(k))) { attempt(String(k), 'Reflect.defineProperty'); return false; } return rdp.call(this, o, k, d); };
  };
  guardWindow(win);
  const guardFrames = () => { for (const f of win.document.querySelectorAll('iframe')) { try { guardWindow(f.contentWindow); } catch (_) { /* detached */ } } };
  const fire = (t) => {
    if (t.every) t.due = Math.max(t.due + Math.max(t.delay, 4), now()); else timers.delete(t.id);   // browsers clamp a 0 ms interval
    if (typeof t.fn !== 'function') { try { vm.runInContext(String(t.fn), ctx); } catch (e) { errors.push(`timer (string): ${e && e.stack || e}`); } return; }
    runTracked(t.fn, t.kind === 'raf' ? [win.performance.now()] : t.args, t.kind);
  };
  // the timers currently scheduled (diagnostics): due within `withinMs` of now
  const dueSites = (withinMs = horizonMs) => [...timers.values()].filter((t) => t.due <= now() + withinMs).map((t) => `${t.kind} ${t.delay}ms due +${Math.max(0, t.due - now())}ms — ${t.cb} (${t.site})`);
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (!win.navigator.serviceWorker) Object.defineProperty(win.navigator, 'serviceWorker', { value: { register: async () => ({}), ready: new Promise(() => {}), addEventListener() {}, getRegistration: async () => null }, configurable: true });
  win.Notification = win.Notification || Object.assign(function Notification() {}, { permission: 'denied', requestPermission: async () => 'denied' });
  win.Audio = win.Audio || function Audio() { return { play: async () => {}, pause() {}, load() {}, addEventListener() {} }; };
  win.HTMLMediaElement.prototype.play = async function () {};
  win.scrollTo = () => {};
  // network effects are ordinary, AWAITED work (settle() waits for them); a beacon is fire-and-forget and recorded
  const baseFetch = fetchImpl || (async (u) => { refused.push(`fetch ${u}`); throw new Error(`r3-page: fetch ${u} is not routed in this harness`); });
  const beacons = [];
  win.fetch = (u, o) => trackP(baseFetch(u, o), 'fetch');
  Object.defineProperty(win.navigator, 'sendBeacon', { value: (u, d) => { beacons.push(String(u)); return true; }, configurable: true });
  { const xs = win.XMLHttpRequest.prototype.send; win.XMLHttpRequest.prototype.send = function (...x) { const k = `xhr${++seqT}`; io.add(k); this.addEventListener('loadend', () => io.delete(k)); try { return xs.apply(this, x); } catch (e) { io.delete(k); throw e; } }; }
  win.addEventListener('error', (e) => errors.push(`window error: ${e && (e.error && e.error.stack || e.message)}`));
  win.addEventListener('unhandledrejection', (e) => errors.push(`unhandled rejection: ${e && e.reason && (e.reason.stack || e.reason)}`));
  if (beforeScripts) beforeScripts(win);
  // a promise rejected inside the page's realm and never handled surfaces as a Node-process rejection: attribute it to
  // THIS page (while it is open) instead of letting it crash the suite unrecorded
  const onRejection = (reason) => { errors.push(`unhandled rejection: ${reason && (reason.stack || reason)}`); };
  process.on('unhandledRejection', onRejection);

  // ── the module graph ──
  const cache = new Map();
  const synth = (name) => {
    const key = `cdn:${name}`;
    if (cache.has(key)) return cache.get(key);
    const exp = host.modules[name];
    if (!exp) { refused.push(`import ${name}`); throw new Error(`r3-page: no adapter for ${name}`); }
    const m = new vm.SyntheticModule(Object.keys(exp), function () { for (const [k, v] of Object.entries(exp)) this.setExport(k, v); }, { context: ctx, identifier: key });
    cache.set(key, m); return m;
  };
  const fileModule = (abs) => {
    if (cache.has(abs)) return cache.get(abs);
    const m = new vm.SourceTextModule(fs.readFileSync(abs, 'utf8'), { context: ctx, identifier: abs, importModuleDynamically: dynImport });
    cache.set(abs, m); return m;
  };
  function resolve(spec, from) {
    const cdn = FIREBASE_CDN.exec(spec);
    if (cdn) return synth(cdn[1]);
    if (/^https?:/.test(spec)) { refused.push(`import ${spec}`); throw new Error(`r3-page: remote import ${spec} is not served by this harness`); }
    const base = from && from.startsWith('/') ? path.dirname(from) : pageDir;
    return fileModule(path.resolve(base, spec.split('?')[0]));
  }
  async function linker(spec, ref) { return resolve(spec, ref.identifier); }
  async function dynImport(spec, ref) { const m = resolve(spec, ref && ref.identifier); if (m.status === 'unlinked') await m.link(linker); if (m.status === 'linked') await m.evaluate(); return m; }

  // ── execute the scripts in document order ──
  const scripts = [...win.document.querySelectorAll('script')];
  for (const s of scripts) s.remove();
  const evaluated = [];
  for (const s of scripts) {
    const src = s.getAttribute('src'); const type = (s.getAttribute('type') || '').trim();
    const isModule = type === 'module';
    if (type && !isModule && !/javascript/.test(type)) continue;             // JSON / templates
    try {
      if (src && /^https?:/.test(src)) { skipped.push(src); continue; }
      if (isModule) {
        const m = src ? fileModule(path.join(pageDir, src.split('?')[0])) : new vm.SourceTextModule(s.textContent, { context: ctx, identifier: path.join(pageDir, `inline-module-${evaluated.length}.mjs`), importModuleDynamically: dynImport });
        await m.link(linker); await m.evaluate();
        evaluated.push(src || 'inline module');
      } else {
        const code = src ? fs.readFileSync(path.join(pageDir, src.split('?')[0]), 'utf8') : s.textContent;
        vm.runInContext(code, ctx, { filename: src || 'inline-classic.js' });
        evaluated.push(src || 'inline classic');
      }
    } catch (e) { errors.push(`script ${src || (isModule ? 'inline module' : 'inline classic')}: ${e && e.stack || e}`); }
  }
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  win.dispatchEvent(new win.Event('load'));

  // in flight = page work (timer / frame callbacks and the promises they returned, fetch, XHR) + the adapter's (subscription
  // callbacks that returned a promise, outstanding reads / writes / callables)
  // host: REAL I/O (ioInflight) vs page continuations (contInflight — callbacks' returned promises, which may await a
  // virtual timer); a host without the split counts all as I/O
  const hostIo = () => (host ? (typeof host.ioInflight === 'function' ? host.ioInflight() : (typeof host.inflight === 'function' ? host.inflight() : 0)) : 0);
  const hostCont = () => (host && typeof host.contInflight === 'function' ? host.contInflight() : 0);
  const ioInflight = () => io.size + hostIo();
  const contInflight = () => pending.size + hostCont();
  const inflight = () => contInflight() + ioInflight();
  const turn = () => new Promise((r) => setImmediate(r));
  // settle(horizonMs): fire every timer due within the horizon (virtual time jumps to each due time), awaiting all resulting
  // work; true only when nothing is due within the horizon AND nothing is in flight. Order: drain microtasks; while REAL I/O
  // is in flight, wait for it (real time — virtual time never runs ahead of an outstanding read / write / fetch); else fire
  // the next due timer (a page continuation may be waiting on it); when nothing is due, page continuations still pending
  // are stuck → wait, false at the cap. false also if the page schedules without end inside the horizon (> maxFirings).
  async function settle(horizon = horizonMs, { capMs = settleMs, maxFirings = 20000 } = {}) {
    const t0 = realNow(); const limit = now() + horizon; let fired = 0;
    const refused = () => { guardFrames(); return channelAttempts.length > 0; };   // any channel attempt, ever → never settled
    for (;;) {
      if (refused()) return false;
      for (let i = 0; i < 3; i++) await turn();          // drain the microtask queue: continuations a timer resolved run now
      if (ioInflight() > 0) { if (realNow() - t0 > capMs) return false; await new Promise((r) => setTimeout(r, 5)); continue; }
      let next = null;
      for (const t of timers.values()) if (t.due <= limit && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) {
        if (contInflight()) { if (realNow() - t0 > capMs) return false; await new Promise((r) => setTimeout(r, 5)); continue; }
        await turn(); await turn(); if (inflight() === 0 && ![...timers.values()].some((t) => t.due <= limit)) return !refused(); continue;
      }
      if (++fired > maxFirings) { errors.push(`settle: more than ${maxFirings} timer firings within a ${horizon} ms horizon — the page schedules without end`); return false; }
      if (next.due > vnow) vnow = next.due;
      fire(next);
    }
  }
  return { dom, win, doc: win.document, errors, consoleErrors, skipped, refused, evaluated, beacons, settle, inflight, dueSites, clock: { virtualMs: () => vnow }, close: () => { timers.clear(); process.off('unhandledRejection', onRejection); win.close(); } };
}

module.exports = { bootPage, REPO };
