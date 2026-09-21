// boot.test.mjs — actually EXECUTES index.html's module body.
//
// Why this exists: a codex gate caught a ReferenceError that 22 passing tests and `node --check`
// both missed. `applyTheme()` ran at module load and read `mapReady`, which was declared `let`
// further down the file — temporal dead zone. The module threw during evaluation, so
// `window.__startApp` was never assigned and the PWA booted to a blank screen.
//
// A syntax check cannot catch that class of bug, and the other tests import the six pure modules
// rather than the page. This test closes that gap: it stubs the two imports Node cannot resolve
// (the shared SDK, which pulls the Firebase CDN, and the CDN itself), stubs the DOM, and runs the
// module. Anything that throws while it evaluates fails here — a temporal dead zone, a typo'd
// global, or a dereference of an element id that is not in the markup (getElementById resolves
// ONLY real ids; see the id test below).
//
// WHAT IT DOES NOT COVER: this is not a browser. No layout, paint, gesture, or real Firebase. It
// proves the module evaluates and registers its entrypoints — nothing about how it looks or
// behaves. The owner's on-device check stays blocking.
//
// No filesystem writes: the module is imported from a data: URL, so this runs in a read-only
// sandbox. An earlier temp-file version hit EPERM inside the codex gate, which meant the gate
// could not run the very test it was gating on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

// Ids that legitimately do NOT exist in static markup because the module generates them.
// Anything else the module reaches for must be in the HTML, or the id test below fails.
const DYNAMIC_IDS = new Set([
  'confirm-yes',   // rendered inside the confirm sheet by openConfirm(); commitAssign() guards on it
]);

// Static ids = ids in the MARKUP only. The script block is stripped first, otherwise an id inside
// a JS template literal (confirm-yes is written into the confirm sheet) counts as static markup and
// the stub would resolve an element that does not exist until that sheet renders.
const markupOnly = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');
const staticIds = new Set([...markupOnly.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

function fakeEl(id = '') {
  return {
    id, style: {}, dataset: {}, hidden: false, disabled: false,
    textContent: '', innerHTML: '', value: '', scrollTop: 0, offsetHeight: 100,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    appendChild() {}, scrollIntoView() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  };
}

function installDom() {
  const doc = {
    documentElement: fakeEl('html'),
    head: { append() {}, querySelector() { return null; } },
    body: fakeEl('body'),
    addEventListener() {},
    createElement() { return fakeEl(); },
    // Only ids that really exist in the markup resolve. A renamed or misspelled id therefore
    // surfaces as a TypeError during boot instead of silently working against an invented element.
    getElementById(id) { return staticIds.has(id) ? fakeEl(id) : null; },
    querySelector() { return fakeEl(); },
    querySelectorAll() { return []; },
  };
  const win = {
    innerHeight: 844,
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'node-boot-test' },   // no serviceWorker / PushManager → those blocks skip
    location: { hash: '' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
  };
  // Node 21+ exposes `navigator` and `location` as getter-only accessors on globalThis,
  // so plain assignment throws. Redefine them instead.
  const put = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  put('window', win);
  put('document', doc);
  put('navigator', win.navigator);
  put('location', win.location);
  put('localStorage', win.localStorage);
  put('matchMedia', win.matchMedia);
  put('requestAnimationFrame', win.requestAnimationFrame);
  put('cancelAnimationFrame', win.cancelAnimationFrame);

  globalThis.__XPD_STUB__ = {
    DRIVER_STATUS: { OFF_SHIFT: 'off_shift' },
    initDelivery() {},
    // Deliberately stricter than reality: real Firebase always defers onAuthStateChanged to a
    // microtask, so a callback reading later-declared state would survive in the browser. Firing it
    // synchronously proves the module is load-order-safe regardless — which is the property that
    // broke here. It caught `started` being declared below this callback.
    onAuth(cb) { cb(null); },
    signIn: async () => {}, signOutUser: async () => {},
    subscribeToOrders() {}, subscribeToScheduledOrders() {},
    subscribeToDrivers() {}, subscribeToTasks() {},
    isStalePing: () => false, getAuthInstance: () => ({ currentUser: null }), getDb: () => ({}),
    assignOrderToDriver: async () => ({ ok: true }), reassignOrder: async () => ({ ok: true }),
  };
  globalThis.__FB_STUB__ = { ref: () => ({}), set: async () => {}, onValue() {}, serverTimestamp: () => 0 };
}

function moduleSource() {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'index.html must carry exactly one <script type="module">');
  return m[1]
    .replace(/import \* as XPD from '\.\/xpizza-delivery\.js';/, 'const XPD = globalThis.__XPD_STUB__;')
    .replace(/import \{[^}]*\} from 'https:\/\/[^']*';/g,
      'const { ref, set, onValue, serverTimestamp } = globalThis.__FB_STUB__;')
    // The six pure modules are imported for real; absolutise them so a data: URL can resolve them.
    .replace(/from '\.\/([\w.-]+\.js)'/g, (_, f) => `from '${pathToFileURL(join(here, f)).href}'`);
}

test('every element id the module reaches for exists in the markup', () => {
  const src = moduleSource();
  const referenced = new Set([...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  assert.ok(referenced.size > 10, 'expected the module to reference many ids; the regex may have drifted');
  const missing = [...referenced].filter((id) => !staticIds.has(id) && !DYNAMIC_IDS.has(id));
  assert.deepEqual(missing, [],
    `used by the module but present in neither the markup nor DYNAMIC_IDS: ${missing.join(', ')}`);
  // Keep the allowlist honest: an id that gains static markup should leave DYNAMIC_IDS.
  const stale = [...DYNAMIC_IDS].filter((id) => staticIds.has(id));
  assert.deepEqual(stale, [], `DYNAMIC_IDS lists ids that now exist statically: ${stale.join(', ')}`);
});

test('index.html module evaluates without throwing (TDZ / load-order regression guard)', async () => {
  installDom();
  const url = 'data:text/javascript;base64,' + Buffer.from(moduleSource(), 'utf8').toString('base64');
  await import(url);
  assert.equal(typeof globalThis.window.__startApp, 'function',
    'window.__startApp must be registered — if it is not, the module threw during evaluation and the PWA boots blank');
  assert.equal(typeof globalThis.window.__onMapaShown, 'function', 'map entrypoint must be registered');
  assert.equal(typeof globalThis.window.__focusOrderOnMap, 'function', 'per-order map focus must be registered');
});
