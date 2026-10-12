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
 *  · the page's own timers are counted so settle() can wait until no short timer (≤ 500 ms) or animation frame is pending.
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

async function bootPage(dir, { host, url = 'https://r3.test/', beforeScripts = null, fetchImpl = null, settleMs = 4000, html: htmlOverride = null, idleTimers = null } = {}) {
  const pageDir = path.join(REPO, dir);
  const html = htmlOverride !== null ? htmlOverride : fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');   // htmlOverride: the harness's own acceptance pages
  const errors = []; const consoleErrors = []; const skipped = []; const refused = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`jsdom: ${e && e.message}`));
  vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ').slice(0, 300)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  const ctx = dom.getInternalVMContext();

  // ── environment the browser provides and jsdom does not ──
  // codex r1 P1-5: a short timer / animation frame stays PENDING until its callback AND the promise it returns (an async
  // render) have finished — leaving the set when the callback merely STARTED certified unfinished renders.
  const pending = new Set();
  const finish = (key, r, what) => {
    if (r && typeof r.then === 'function') r.then(() => pending.delete(key), (e) => { errors.push(`${what} (async): ${e && e.stack || e}`); pending.delete(key); });
    else pending.delete(key);
  };
  // codex r3 P1-2: NO inference. EVERY application timer (setTimeout, any delay, and setInterval) BLOCKS settling unless its
  // call site is on the REVIEWED idle allowlist (contract/idle-timers.json: page dir + function + reason — e.g. a clock
  // tick). A RUNNING callback — allowlisted or not — is ALWAYS awaited through its returned promise.
  const IDLE = (idleTimers || (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'idle-timers.json'), 'utf8'))[dir] || []; } catch (_) { return []; } })());
  const timerInfo = new Map(); let seqT = 0;
  const siteOf = () => {
    const fr = (String(new Error().stack).split('\n').slice(3, 4)[0] || '').trim();
    const m = /^at (?:async )?([^\s(]+) \(/.exec(fr);
    return { fn: m ? m[1] : '<anonymous>', frame: fr };
  };
  const norm = (f) => (typeof f === 'function' ? String(f) : '').replace(/\s+/g, ' ').trim();
  const isIdle = (cbSrc) => IDLE.some((e) => cbSrc.startsWith(e.callback.replace(/\s+/g, ' ').trim()));
  const idleHits = new Set();
  const track = (kind, site, delay, fn) => {
    const key = `${kind}${++seqT}`; const cb = norm(fn);
    const idle = isIdle(cb); if (idle) idleHits.add(IDLE.find((e) => cb.startsWith(e.callback.replace(/\s+/g, ' ').trim())).callback);
    timerInfo.set(key, { kind, site, delay, idle, cb: cb.slice(0, 90) }); if (!idle) pending.add(key); return key;
  };
  const runTracked = (fn, x, what) => {   // the callback's own execution + its returned promise are ALWAYS awaited
    const ek = `exec${++seqT}`; pending.add(ek);
    let r; try { r = fn(...x); } catch (e) { errors.push(`${what}: ${e && e.stack || e}`); pending.delete(ek); return undefined; }
    finish(ek, r, what); return r;
  };
  const realST = win.setTimeout.bind(win); const realCT = win.clearTimeout.bind(win);
  const tKey = new Map();
  win.setTimeout = (fn, ms, ...a) => {
    const site = siteOf(); let id;
    const key = track('t', site, Number(ms || 0), fn);
    id = realST(typeof fn === 'function' ? (...x) => { pending.delete(key); timerInfo.delete(key); return runTracked(fn, x, 'timer'); } : fn, ms, ...a);
    tKey.set(id, key); return id;
  };
  win.clearTimeout = (id) => { const k = tKey.get(id); if (k) { pending.delete(k); timerInfo.delete(k); } return realCT(id); };
  const realSI = win.setInterval.bind(win); const realCI = win.clearInterval.bind(win);
  const iKey = new Map();
  win.setInterval = (fn, ms, ...a) => {
    const site = siteOf(); const key = track('i', site, Number(ms || 0), fn);
    const id = realSI(typeof fn === 'function' ? (...x) => runTracked(fn, x, 'interval') : fn, ms, ...a);
    iKey.set(id, key); return id;
  };
  win.clearInterval = (id) => { const k = iKey.get(id); if (k) { pending.delete(k); timerInfo.delete(k); } return realCI(id); };
  // the timers currently BLOCKING (for diagnostics / an allowlist review), and the idle ones the allowlist let through
  const pendingSites = () => [...timerInfo.entries()].filter(([k]) => pending.has(k)).map(([, t]) => `${t.kind === 'i' ? 'interval' : 'timeout'} ${t.delay}ms — callback: ${t.cb} (${t.site.frame.replace(/^at /, '').slice(0, 120)})`);
  const idleSites = () => [...idleHits];
  const rawRaf = win.requestAnimationFrame.bind(win);
  win.requestAnimationFrame = (fn) => { let id; id = rawRaf((t) => { let r; try { r = fn(t); } catch (e) { errors.push(`raf: ${e && e.stack || e}`); pending.delete(`raf${id}`); return; } finish(`raf${id}`, r, 'raf'); }); pending.add(`raf${id}`); return id; };
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (!win.navigator.serviceWorker) Object.defineProperty(win.navigator, 'serviceWorker', { value: { register: async () => ({}), ready: new Promise(() => {}), addEventListener() {}, getRegistration: async () => null }, configurable: true });
  win.Notification = win.Notification || Object.assign(function Notification() {}, { permission: 'denied', requestPermission: async () => 'denied' });
  win.Audio = win.Audio || function Audio() { return { play: async () => {}, pause() {}, load() {}, addEventListener() {} }; };
  win.HTMLMediaElement.prototype.play = async function () {};
  win.scrollTo = () => {};
  win.fetch = fetchImpl || (async (u) => { refused.push(`fetch ${u}`); throw new Error(`r3-page: fetch ${u} is not routed in this harness`); });
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

  // settled = no pending short timer / frame (incl. their async continuations) AND no adapter work in flight (subscription
  // callbacks that returned a promise, outstanding reads / writes), for 3 consecutive polls. Callers ASSERT it returned true.
  const inflight = () => pending.size + (host && typeof host.inflight === 'function' ? host.inflight() : 0);
  async function settle(capMs = settleMs) {
    const t0 = Date.now(); let quiet = 0;
    while (Date.now() - t0 < capMs) {
      await new Promise((r) => setTimeout(r, 20));
      if (inflight() === 0) { quiet += 1; if (quiet >= 3) return true; } else quiet = 0;
    }
    return false;
  }
  return { dom, win, doc: win.document, errors, consoleErrors, skipped, refused, evaluated, settle, inflight, pendingSites, idleSites, close: () => { process.off('unhandledRejection', onRejection); win.close(); } };
}

module.exports = { bootPage, REPO };
