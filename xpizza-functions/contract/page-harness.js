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
 *  · VIRTUAL TIME (codex r6 / advisor structural call): the page's setTimeout / setInterval / requestAnimationFrame / Date /
 *    performance.now run on a virtual clock — nothing fires on real time. settle(horizonMs) drains the microtask queue,
 *    then fires every timer due within the horizon (periodic ones included, as normal code), awaiting ALL resulting work:
 *    each callback's returned promise, fetch / XHR, and the adapter's reads / writes / callables (host.inflight()). It
 *    returns true only when nothing is due within the horizon and nothing is in flight. There is NO exemption: a display
 *    clock simply runs and does nothing; anything that writes is a normal, awaited effect.
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
  const RealDate = win.Date; const realNow = () => RealDate.now();
  let offset = 0; const now = () => realNow() + offset;    // browser time = real time + the virtual time advanced by settle()
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
  const t0v = now();
  win.requestAnimationFrame = (fn) => addTimer('raf', fn, 16, null, false);
  win.cancelAnimationFrame = (id) => { timers.delete(id); };
  class VDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now()); } static now() { return now(); } }
  win.Date = VDate;
  try { Object.defineProperty(win.performance, 'now', { value: () => now() - t0v, configurable: true }); } catch (_) { /* jsdom without performance */ }
  const fire = (t) => {
    if (t.every) t.due = Math.max(t.due + Math.max(t.delay, 4), now()); else timers.delete(t.id);   // browsers clamp a 0 ms interval
    if (typeof t.fn !== 'function') { try { vm.runInContext(String(t.fn), ctx); } catch (e) { errors.push(`timer (string): ${e && e.stack || e}`); } return; }
    runTracked(t.fn, t.kind === 'raf' ? [now() - t0v] : t.args, t.kind);
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
  const ioInflight = () => io.size + (host && typeof host.inflight === 'function' ? host.inflight() : 0);
  const inflight = () => pending.size + ioInflight();
  const turn = () => new Promise((r) => setImmediate(r));
  // settle(horizonMs): fire every timer due within the horizon (virtual time jumps to each due time), awaiting all resulting
  // work; true only when nothing is due within the horizon AND nothing is in flight. Order: drain microtasks; while REAL I/O
  // is in flight, wait for it (real time — virtual time never runs ahead of an outstanding read / write / fetch); else fire
  // the next due timer (a page continuation may be waiting on it); when nothing is due, page continuations still pending
  // are stuck → wait, false at the cap. false also if the page schedules without end inside the horizon (> maxFirings).
  async function settle(horizon = horizonMs, { capMs = settleMs, maxFirings = 20000 } = {}) {
    const t0 = realNow(); const limit = now() + horizon; let fired = 0;
    for (;;) {
      for (let i = 0; i < 3; i++) await turn();          // drain the microtask queue: continuations a timer resolved run now
      if (ioInflight() > 0) { if (realNow() - t0 > capMs) return false; await new Promise((r) => setTimeout(r, 5)); continue; }
      let next = null;
      for (const t of timers.values()) if (t.due <= limit && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) {
        if (pending.size) { if (realNow() - t0 > capMs) return false; await new Promise((r) => setTimeout(r, 5)); continue; }
        await turn(); await turn(); if (inflight() === 0 && ![...timers.values()].some((t) => t.due <= limit)) return true; continue;
      }
      if (++fired > maxFirings) { errors.push(`settle: more than ${maxFirings} timer firings within a ${horizon} ms horizon — the page schedules without end`); return false; }
      if (next.due > now()) offset += next.due - now();
      fire(next);
    }
  }
  return { dom, win, doc: win.document, errors, consoleErrors, skipped, refused, evaluated, beacons, settle, inflight, dueSites, clock: { now, skewMs: () => offset }, close: () => { timers.clear(); process.off('unhandledRejection', onRejection); win.close(); } };
}

module.exports = { bootPage, REPO };
