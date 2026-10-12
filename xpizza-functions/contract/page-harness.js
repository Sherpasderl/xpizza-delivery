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

async function bootPage(dir, { host, url = 'https://r3.test/', beforeScripts = null, fetchImpl = null, settleMs = 4000 } = {}) {
  const pageDir = path.join(REPO, dir);
  const html = fs.readFileSync(path.join(pageDir, 'index.html'), 'utf8');
  const errors = []; const consoleErrors = []; const skipped = []; const refused = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(`jsdom: ${e && e.message}`));
  vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ').slice(0, 300)));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  const ctx = dom.getInternalVMContext();

  // ── environment the browser provides and jsdom does not ──
  const pending = new Set();
  const wrapTimer = (name, clear) => {
    const real = win[name].bind(win); const realClear = win[clear].bind(win);
    win[name] = (fn, ms, ...a) => {
      const short = name === 'setTimeout' && Number(ms || 0) <= 500;
      let id;
      const run = (...x) => { pending.delete(id); try { return fn(...x); } catch (e) { errors.push(`timer: ${e && e.stack || e}`); } };
      id = real(typeof fn === 'function' ? run : fn, ms, ...a);
      if (short) pending.add(id);
      return id;
    };
    win[clear] = (id) => { pending.delete(id); return realClear(id); };
  };
  wrapTimer('setTimeout', 'clearTimeout');
  const rawRaf = win.requestAnimationFrame.bind(win);
  win.requestAnimationFrame = (fn) => { let id; id = rawRaf((t) => { pending.delete(`raf${id}`); try { fn(t); } catch (e) { errors.push(`raf: ${e && e.stack || e}`); } }); pending.add(`raf${id}`); return id; };
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

  async function settle(capMs = settleMs) {
    const t0 = Date.now(); let quiet = 0;
    while (Date.now() - t0 < capMs) {
      await new Promise((r) => setTimeout(r, 20));
      if (pending.size === 0) { quiet += 1; if (quiet >= 3) return true; } else quiet = 0;
    }
    return false;
  }
  return { dom, win, doc: win.document, errors, consoleErrors, skipped, refused, evaluated, settle, close: () => win.close() };
}

module.exports = { bootPage, REPO };
