'use strict';
// F4 — the persistent live-tracker harness shared by tracker-live.test.js and tracker-pins.test.js (BUILD-tracker-F4 §8 T3/T4).
// page() boots the tracker's REAL module script ONCE in a vm and keeps it alive across steps. Boundaries only are fake:
// Firebase onValue ROUTED BY PATH; Google Maps (Map / Marker / LatLngBounds; a DirectionsService whose answers the test releases);
// the REAL driver-glide.js behind a recorder; a virtual clock (Date.now / performance.now / setTimeout / rAF) whose timers fire
// exactly at their deadlines (or a chosen few ms early). Named *.test.cjs so the build stamp treats it as test code, not runtime.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const open = html.indexOf('<script type="module">');
const body = html.slice(open + '<script type="module">'.length, html.indexOf('</script>', open));
const IMPORT_RE = /^\s*import\s+\{[^}]*\}\s+from\s+'[^']+';\s*$/gm;
const UDM = '    async function updateDriverMap(data) {';
assert.strictEqual(body.split(UDM).length, 2, 'premise: one updateDriverMap');
// test-only instrumentation of the vm copy (the page file itself is pinned byte-for-byte by tracker-glide.guard): count ENTRIES
const script = body.replace(IMPORT_RE, '').replace(UDM, `${UDM} globalThis.__udm = (globalThis.__udm || 0) + 1;`);
const plain = (f) => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/^export\s+/gm, '');
const CLASSIC = ['status-view.js', 'eta-gate.js'].map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'));
assert.ok(html.includes('<script src="/status-view.js"></script>') && html.includes('<script src="/eta-gate.js"></script>'), 'premise: the page loads both classic modules');

const T0 = 1_800_000_000_000;
const TOKEN = 'TokLive123';
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function mkEl(id) {
  const classes = new Set(); const style = {};
  return {
    id, children: [], _text: '', _html: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this.children.length = 0; },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    appendChild(c) { this.children.push(c); return c; }, append(c) { this.children.push(c); },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; if (on) classes.add(c); else classes.delete(c); return on; } },
    style: new Proxy(style, { get: (t, k) => (k === 'setProperty' ? (a, b) => { t[a] = String(b); } : t[k]), set: (t, k, v) => { t[k] = String(v); return true; } }),
    _classes: classes,
  };
}

// one live page instance
function page({ hidden = false, deferMaps = false } = {}) {
  const clock = { now: T0 };
  let seq = 0; let timers = []; let earlyNext = 0;
  const setT = (fn, ms) => { const id = ++seq; let at = clock.now + Math.max(0, ms || 0); if (earlyNext) { at -= earlyNext; earlyNext = 0; } timers.push({ id, at, fn }); return id; };
  const clearT = (id) => { timers = timers.filter((t) => t.id !== id); };
  const reg = {}; const getEl = (id) => (reg[id] || (reg[id] = mkEl(id)));
  ['loading', 'error', 'error-msg', 'tracking', 'order-id-display', 'segbar', 'driver-avatar', 'driver-name', 'driver-eta', 'driver-map',
    'summary-customer', 'summary-items', 'summary-address', 'summary-total', 'updated-text', 'reward-card', 'claim-card', 'claim-btn', 'pins-map']
    .forEach((id) => getEl(id).classList.add(id === 'driver-map' || id === 'driver-avatar' || id === 'pins-map' ? 'hidden' : 'x'));
  const listeners = {};
  const cbs = {}; const routes = []; const glideLog = []; const markers = []; let realEngine = null;
  let mapsRelease; const mapsGate = deferMaps ? new Promise((r) => { mapsRelease = r; }) : null;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: FakeDate, Math, Number, String, Array, Object, JSON, Set, Map, Promise, URLSearchParams, Error, Infinity, NaN, isFinite, encodeURIComponent, Proxy,
    performance: { now: () => clock.now },
    setTimeout: setT, clearTimeout: clearT,
    requestAnimationFrame: (cb) => setT(() => cb(clock.now), 16), cancelAnimationFrame: clearT,
    location: { hostname: 'track.xpizza.hn', pathname: '/' + TOKEN },
    document: {
      title: 'X. Pizza · Sigue tu pedido', visibilityState: hidden ? 'hidden' : 'visible',
      getElementById: getEl, createElement: () => mkEl(), querySelector: () => null, head: { append() {} },
      documentElement: { style: { setProperty() {} } },
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    },
    initializeApp: () => ({}), getDatabase: () => ({}),
    ref: (_db, p) => ({ p }),
    onValue: (r, f) => { cbs[r.p] = f; return () => {}; },
    google: { maps: {
      importLibrary: () => (mapsGate ? mapsGate.then(() => ({})) : Promise.resolve({})),
      Map: class { fitBounds() {} },
      Marker: class { constructor(o) { this.pos = o.position; this.title = o.title; markers.push(this); } setPosition(p) { this.pos = p; } },
      LatLngBounds: class { extend() {} },
      SymbolPath: { CIRCLE: 0 }, TravelMode: { DRIVING: 'DRIVING' },
      DirectionsService: class { route(req, cb) { routes.push({ req, cb }); } },
    } },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // the REAL glide engine behind a recorder; the REAL driver-eta helpers
  vm.runInContext(`${plain('driver-glide.js')}\n;globalThis.__realGlide = createGlideEngine;`, ctx);
  vm.runInContext(`${plain('driver-eta.js')}\n;globalThis.dueForRefresh = dueForRefresh; globalThis.distanceMeters = distanceMeters;`, ctx);
  ctx.createGlideEngine = (opts) => {
    const real = ctx.__realGlide(opts); realEngine = real;
    return { update: (...a) => { glideLog.push(['update', a[0], a[1]]); return real.update(...a); },
      cancel: (...a) => { glideLog.push(['cancel', a[0]]); return real.cancel(...a); }, has: real.has, _state: real._state };
  };
  for (const src of CLASSIC) vm.runInContext(src, ctx);
  vm.runInContext(`(function () { 'use strict';\n${script}\n})();`, ctx);
  assert.ok(cbs[`order_tracking/${TOKEN}`] && cbs['.info/serverTimeOffset'], 'both subscriptions registered, each with its own callback');

  const api = {
    clock, routes, glideLog, markers, reg,
    async emit(rec) { cbs[`order_tracking/${TOKEN}`]({ val: () => rec }); await flush(); },
    emitSync(rec) { cbs[`order_tracking/${TOKEN}`]({ val: () => rec }); },   // no microtask flush: what render did synchronously
    udm: () => ctx.__udm || 0,
    async offset(o) { cbs['.info/serverTimeOffset']({ val: () => o }); await flush(); },
    async answer(i, travelSec, status = 'OK') {
      routes[i].cb(status === 'OK' ? { routes: [{ legs: [{ duration: { value: travelSec } }] }] } : null, status); await flush();
    },
    async advance(ms) {
      const target = clock.now + ms;
      let fired = 0;
      for (;;) {
        if (++fired > 200000) throw new Error('🔴 runaway timers: a re-arm loop never reached its deadline');
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers[0];
        if (!t || t.at > target) break;
        timers.shift(); clock.now = Math.max(clock.now, t.at); t.fn(); await flush();
      }
      clock.now = target; await flush();
    },
    early(ms) { earlyNext = ms; },
    async resolveMaps() { mapsRelease(); await flush(); },
    glideState: () => (realEngine ? realEngine._state('d') : null),
    timersNamed: (name) => timers.filter((t) => t.fn && t.fn.name === name).length,
    driverMarkers: () => markers.filter((m) => m.title !== 'Tu dirección' && m.title !== 'Restaurante'),
    dropTimers() { timers = []; },
    async visible(v) { ctx.document.visibilityState = v ? 'visible' : 'hidden'; (listeners.visibilitychange || []).forEach((f) => f()); await flush(); },
    sub: () => getEl('driver-eta').textContent,
    title: () => getEl('driver-name').textContent,
    mapShown: () => !getEl('driver-map')._classes.has('hidden'),
    pinsShown: () => !getEl('pins-map')._classes.has('hidden'),
    avatar: () => (getEl('driver-avatar')._classes.has('hidden') ? null : getEl('driver-avatar').textContent),
    cancels: () => glideLog.filter((e) => e[0] === 'cancel').length,
    updates: () => glideLog.filter((e) => e[0] === 'update').length,
    serverNow: (off = 0) => clock.now + off,
  };
  return api;
}

module.exports = { page, T0, TOKEN, flush };
