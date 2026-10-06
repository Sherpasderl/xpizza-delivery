// Stats S2 — the shared harness for the Ventas DOM tests (portal ventas.test.mjs and the functions-side
// REAL→REAL composition test). NOT a test file itself and NOT served (nothing in index.html reaches it).
//
// Same technique as app-loads.test.mjs: the DOM modules import auth.js → firebase.js → a CDN URL node
// cannot load, so the source of app.js / ventas.js is rewritten to import a local auth STUB for that one
// module and nothing else. Every other import (api.js, ventas-logic.js, editor.js …) is the real file.
// The stub and temp-module names are distinct from app-loads.test.mjs's, so the two suites can run in
// parallel processes without deleting each other's files.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DIR = dirname(fileURLToPath(import.meta.url));

// the ids app.js and ventas.js touch (app-loads.test.mjs's list + the S2 shell additions)
export const IDS = ['switcher', 'switchmenu', 'discard', 'review', 'pubback', 'pubbtn', 'scrim', 'mbody',
  'revSub', 'revFoot', 'revTitle', 'drawer', 'rail', 'detail', 'rbar', 'rbtxt', 'shopname', 'shopsub',
  'whoami', 'avatar', 'logout', 'detailempty',
  'navprod', 'navbiz', 'navventas', 'mnav', 'mnprod', 'mnventas', 'viewmenu', 'viewventas', 'app'];
// the classes index.html gives them, so `hidden` / `on` start where the real page starts
const INITIAL_CLASS = {
  navprod: 'nav on', navbiz: 'nlabel hidden', navventas: 'nav hidden', mnav: 'mnav', mnprod: 'mn on', mnventas: 'mn',
  viewmenu: 'main', viewventas: 'main vmain hidden', switchmenu: 'switchmenu hidden', app: 'app',
};

export function installDom() {
  const mk = (tag, id) => {
    const n = {
      tag, id, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, style: {}, parent: null,
      disabled: false, title: '', value: '', checked: false, textContent: '', clicks: 0,
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: {
        add: (c) => { if (!n.classList.contains(c)) n._class = `${n._class} ${c}`.trim(); },
        remove: (c) => { n._class = n._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on) => { if (on) n.classList.add(c); else n.classList.remove(c); },
        contains: (c) => n._class.split(/\s+/).includes(c),
      },
      append: (...cs) => { for (const c of cs) { if (c && typeof c === 'object') c.parent = n; } n.children.push(...cs); },
      replaceChildren: (...cs) => { n.children = []; n.append(...cs); },
      remove: () => { if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n); n.parent = null; },
      setAttribute: (k, v) => { n.attrs[k] = String(v); },
      getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
      removeAttribute: (k) => { delete n.attrs[k]; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      click: () => { n.clicks += 1; for (const fn of n.listeners.click || []) fn({ type: 'click' }); },
      querySelectorAll: (sel) => {
        const want = String(sel).split(',').map((x) => x.trim());
        const out = [];
        (function walkDown(node) {
          for (const c of node.children || []) {
            if (c && typeof c === 'object' && (want.includes(c.tag) || want.some((w) => w.startsWith('.') && String(c._class).split(/\s+/).includes(w.slice(1))))) out.push(c);
            if (c && typeof c === 'object') walkDown(c);
          }
        })(n);
        return out;
      },
      querySelector: (sel) => n.querySelectorAll(sel)[0] || null,
      contains: (el) => { let found = false; (function walkDown(node) { for (const c of node.children || []) { if (c === el) found = true; if (c && typeof c === 'object') walkDown(c); } })(n); return found; },
      closest: () => null,
      focus: () => { globalThis.document.activeElement = n; },
      blur: () => { if (globalThis.document.activeElement === n) globalThis.document.activeElement = null; },
    };
    return n;
  };
  const byId = new Map(IDS.map((id) => { const n = mk(id.startsWith('view') ? 'main' : 'div', id); n._class = INITIAL_CLASS[id] || ''; return [id, n]; }));
  const body = mk('body', null);
  globalThis.document = {
    _byId: byId,
    body,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => mk(t, null),
    createElementNS: (ns, t) => { const n = mk(t, null); n.ns = ns; return n; },
    createTextNode: (t) => ({ tag: '#text', textContent: String(t) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    _listeners: {},
    addEventListener: (ev, fn) => { (globalThis.document._listeners[ev] = globalThis.document._listeners[ev] || []).push(fn); },
    dispatchEvent: (evt) => { for (const fn of (globalThis.document._listeners[evt.type] || [])) fn(evt); return true; },
    documentElement: mk('html', null),
    activeElement: null,
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.CSS = { escape: (s) => String(s) };
  return byId;
}

// Every saved file, read back as text, with the name the anchor offered. URL.createObjectURL is wrapped
// (node has the real one), so the bytes asserted are the bytes the anchor would have handed the browser.
// Call AFTER installDom (it watches that document's body for the download anchor).
export function captureDownloads() {
  const saved = [];
  const real = URL.createObjectURL;
  URL.createObjectURL = (blob) => { saved.push({ blob, href: `blob:test/${saved.length + 1}`, name: null, clicked: false, text: null }); return saved[saved.length - 1].href; };
  const body = globalThis.document.body;
  const append = body.append;
  body.append = (...cs) => {
    for (const a of cs) {
      const rec = saved.find((r) => r.href === a.href);
      if (rec) { rec.name = a.download; const click = a.click; a.click = () => { rec.clicked = true; click(); }; }
    }
    append(...cs);
  };
  // RAW bytes: Blob.text() runs a UTF-8 decode that STRIPS a leading BOM, so it could not see one.
  const read = async () => { for (const r of saved) if (r.text === null) { r.bytes = Buffer.from(await r.blob.arrayBuffer()); r.text = r.bytes.toString('utf8'); } return saved; };
  return { saved, read, restore: () => { URL.createObjectURL = real; } };
}

export function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    calls.push({ fn, url: String(url), query: Object.fromEntries(u.searchParams), auth: opts && opts.headers && opts.headers.Authorization });
    return handler(fn, Object.fromEntries(u.searchParams), calls.length);
  };
  return calls;
}
export const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
export const errJson = (status, body) => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
export const okCsv = (text, { filename = null, next = null } = {}) => ({
  ok: true, status: 200, text: async () => text, json: async () => { throw new Error('not json'); },
  headers: { get: (h) => (/content-disposition/i.test(h) ? (filename ? `attachment; filename="${filename}"` : null) : /x-next-cursor/i.test(h) ? next : null) },
});

// Load the REAL modules (auth stubbed). `which`: ['app', 'ventas'] in that order — boot.js's order.
export async function loadModules(which = ['app', 'ventas'], transforms = {}) {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const stub = join(DIR, `__ventas-auth-stub.${tag}.mjs`);
  // token() can be HELD by a test (globalThis.__tokenHold = a promise) to land a context change inside the
  // one await that precedes every request — the window the guarded token exists to close.
  // globalThis.__onToken (one-shot) is queued as a MICROTASK from inside token(): it runs after the token resolves and
  // before the caller's continuation — the auth-change ordering codex S2 r2 probed.
  writeFileSync(stub, 'export const token = async () => { if (globalThis.__tokenHold) await globalThis.__tokenHold; const f = globalThis.__onToken; if (f) { globalThis.__onToken = null; queueMicrotask(f); } return "TK-test"; };\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmps = [];
  const mods = {};
  try {
    for (const name of which) {
      const tmp = join(DIR, `__ventas-under-test.${name}.${tag}.mjs`);
      tmps.push(tmp);
      const src = (transforms[name] || ((s) => s))(readFileSync(join(DIR, `${name}.js`), 'utf8'))
        .replace(/from '\.\/auth\.js'/g, `from './__ventas-auth-stub.${tag}.mjs'`);
      writeFileSync(tmp, src);
      mods[name] = await import(`${pathToFileURL(tmp).href}?t=${tag}`);
    }
    return mods;
  } finally {
    for (const f of [...tmps, stub]) { try { unlinkSync(f); } catch (_) { /* best effort */ } }
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
export async function settle(n = 12) { for (let i = 0; i < n; i++) await tick(); }
// all visible text under a node, in document order
export function textOf(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.tag === '#text') return node.textContent;
  return [node.textContent || '', ...(node.children || []).map(textOf)].join(' ').replace(/\s+/g, ' ').trim();
}
export function findAll(node, pred, out = []) {
  for (const c of (node && node.children) || []) { if (c && typeof c === 'object') { if (pred(c)) out.push(c); findAll(c, pred, out); } }
  return out;
}
export const byClass = (node, cls) => findAll(node, (c) => String(c._class || '').split(/\s+/).includes(cls));
export const hasClass = (n, c) => String(n._class || '').split(/\s+/).includes(c);
