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

async function bootPage(dir, { host, url = 'https://r3.test/', beforeScripts = null, fetchImpl = null, settleMs = 4000, html: htmlOverride = null } = {}) {
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
  // codex r2 P1-3: EVERY application setTimeout is tracked (the KDS completion beat is 700 ms + 700 ms). Rules:
  //  · a timer due within HORIZON_MS blocks settling until its callback AND its returned promise finish;
  //  · a call site that RE-ARMS itself from inside its own callback is a periodic tick (clock / poll) → not blocking;
  //  · a timer due beyond HORIZON_MS is reported in longTimers() (a cell that depends on it must advance / await it);
  //  · setInterval is periodic by definition → reported, never blocking.
  const HORIZON_MS = 10000;
  const periodicSites = new Set(); const timerInfo = new Map(); const intervals = [];
  let runningSite = null;
  const siteOf = () => { const fr = String(new Error().stack).split('\n').slice(3, 4)[0] || ''; return fr.trim(); };
  const realST = win.setTimeout.bind(win); const realCT = win.clearTimeout.bind(win);
  win.setTimeout = (fn, ms, ...a) => {
    const delay = Number(ms || 0); const site = siteOf();
    if (runningSite && runningSite === site) periodicSites.add(site);          // re-armed from its own callback
    let id;
    const run = (...x) => {
      const prev = runningSite; runningSite = site;
      let r; try { r = fn(...x); } catch (e) { errors.push(`timer: ${e && e.stack || e}`); runningSite = prev; pending.delete(id); timerInfo.delete(id); return undefined; }
      runningSite = prev; timerInfo.delete(id); finish(id, r, 'timer'); return r;
    };
    id = realST(typeof fn === 'function' ? run : fn, ms, ...a);
    timerInfo.set(id, { site, delay, due: Date.now() + delay });
    if (delay <= HORIZON_MS && !periodicSites.has(site)) pending.add(id);
    return id;
  };
  win.clearTimeout = (id) => { pending.delete(id); timerInfo.delete(id); return realCT(id); };
  const realSI = win.setInterval.bind(win);
  win.setInterval = (fn, ms, ...a) => { const id = realSI(fn, ms, ...a); intervals.push({ id, ms: Number(ms || 0), site: siteOf() }); return id; };
  // a timer whose site turned out PERIODIC after it was armed stops blocking
  const reclassify = () => { for (const [id, t] of timerInfo) if (periodicSites.has(t.site)) pending.delete(id); };
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
  const inflight = () => { reclassify(); return pending.size + (host && typeof host.inflight === 'function' ? host.inflight() : 0); };
  const longTimers = () => [...timerInfo.values()].filter((t) => t.delay > HORIZON_MS && !periodicSites.has(t.site));
  async function settle(capMs = settleMs) {
    const t0 = Date.now(); let quiet = 0;
    while (Date.now() - t0 < capMs) {
      await new Promise((r) => setTimeout(r, 20));
      if (inflight() === 0) { quiet += 1; if (quiet >= 3) return true; } else quiet = 0;
    }
    return false;
  }
  return { dom, win, doc: win.document, errors, consoleErrors, skipped, refused, evaluated, settle, inflight, longTimers, periodic: () => [...periodicSites], intervals: () => intervals.slice(), close: () => { process.off('unhandledRejection', onRejection); win.close(); } };
}

module.exports = { bootPage, REPO };
