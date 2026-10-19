'use strict';
// S5 §3.3 — the tracker's PRE-EXTRACTION goldens. Run: node xpizza-track/tracker-status.golden.test.js [--write]
// Captured on the base BEFORE status-view.js exists, so the post-extraction comparison is not circular: the tracker's
// REAL module script (index.html) executes in a vm with only its four imports stubbed (firebase app/database, the glide
// engine, the driver-eta helpers' real source) and a recording fake DOM; Date.now is pinned and TZ is Tegucigalpa.
// The onValue callback is fed each fixture; everything the render writes is snapshotted:
//   headline/sub (text + class), the avatar, every segbar segment (class + --p), the bar's opacity, the live-updates
//   line, the driver map's visibility, the order line, the reward/claim cards, document.title + brand overrides.
// ETA-INPUT cells: the ETA text for delivery_eta_min present/absent × picked_up_at absent / 3 / 15 min ago (F4: never a countdown).
// F4: the page subscribes to TWO paths (the record + .info/serverTimeOffset); the fixture is routed to the record's callback.
// tracker-status.delta.test.js pins this golden against the frozen pre-F4 copy (tracker-status.golden.pre-f4.json).
process.env.TZ = 'America/Tegucigalpa';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
const GOLDEN = path.join(DIR, 'tracker-status.golden.json');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const NOW = Date.UTC(2026, 9, 14, 1, 30, 0);   // 2026-10-13 19:30 Tegucigalpa

// ── the real module script, imports removed (they are supplied as vm globals below) ──
const open = html.indexOf('<script type="module">');
assert.ok(open !== -1, 'the tracker module script is present');
const body = html.slice(open + '<script type="module">'.length, html.indexOf('</script>', open));
const IMPORT_RE = /^\s*import\s+\{[^}]*\}\s+from\s+'[^']+';\s*$/gm;
const imports = body.match(IMPORT_RE) || [];
assert.deepStrictEqual(imports.map((l) => l.trim().replace(/\s+/g, ' ')), [
  "import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';",
  "import { getDatabase, ref, onValue } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js';",
  "import { createGlideEngine } from './driver-glide.js';",
  "import { dueForRefresh, distanceMeters } from './driver-eta.js';",
], 'the tracker imports exactly the four modules the harness supplies');
const script = body.replace(IMPORT_RE, '');
// driver-eta.js is ESM; its two helpers are evaluated from the real source (export keywords stripped)
const CLASSIC = [...html.slice(0, open).matchAll(/<script src="(?!https?:)([^"]+)"><\/script>/g)].map((m) => m[1]).filter((f) => f !== 'sherpa-client.js');   // sherpa-client = the self-update shell (no render effect)
const etaSrc = fs.readFileSync(path.join(DIR, 'driver-eta.js'), 'utf8').replace(/^export\s+/gm, '');

// ── the recording fake DOM ──
function mkEl(id, tag) {
  const classes = new Set(); const style = {}; const attrs = {};
  const el = {
    id, tag: tag || 'div', children: [], _text: '', _html: '', href: '',
    get textContent() { return this._text; }, set textContent(v) { this._text = String(v); this.children.length = 0; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); this.children.length = 0; this._text = ''; },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    appendChild(c) { this.children.push(c); return c; },
    append(c) { this.children.push(c); },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null },
    addEventListener() {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; if (on) classes.add(c); else classes.delete(c); return on; },
    },
    style: new Proxy(style, { get: (t, k) => (k === 'setProperty' ? (a, b) => { t[a] = String(b); } : k === 'getPropertyValue' ? (a) => t[a] : t[k]), set: (t, k, v) => { t[k] = String(v); return true; } }),
    _classes: classes, _style: style,
  };
  return el;
}
const SNAP_IDS = ['loading', 'error', 'error-msg', 'tracking', 'order-id-display', 'segbar', 'driver-avatar', 'driver-name', 'driver-eta',
  'driver-map', 'summary-customer', 'summary-items', 'summary-address', 'summary-total', 'updated-text', 'reward-card', 'claim-card', 'claim-btn'];
function snapEl(e) {
  if (!e) return null;
  const o = { cls: e.className, text: e.textContent };
  if (e._html) o.html = e._html;
  if (e.href) o.href = e.href;
  if (Object.keys(e._style).length) o.style = { ...e._style };
  if (e.children.length) o.kids = e.children.map(snapEl);
  return o;
}

function run(data, { hostname = 'track.xpizza.hn', token = 'TokAbc12345', snapshots = 1, nowMs = NOW } = {}) {
  const reg = {}; const getEl = (id) => (reg[id] || (reg[id] = mkEl(id)));
  SNAP_IDS.forEach(getEl);
  const docStyle = {};
  const cbs = {}; const issued = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(nowMs); } static now() { return nowMs; } },
    Math, Number, String, Array, Object, JSON, Set, Map, Promise, URLSearchParams, Error, Infinity, NaN, isFinite, encodeURIComponent,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    location: { hostname, pathname: '/' + token },
    document: {
      title: 'X. Pizza · Sigue tu pedido',
      getElementById: getEl, createElement: (t) => mkEl(undefined, t), querySelector: (s) => (s === '.brand-name' ? getEl('__brand-name') : s === '.error-icon' ? getEl('__error-icon') : null),
      head: { append() {} }, documentElement: { style: { setProperty: (k, v) => { docStyle[k] = v; } } },
      visibilityState: 'visible', addEventListener() {},
    },
    initializeApp: () => ({}), getDatabase: () => ({}),
    ref: (_db, p) => { issued.push(p); return { p }; },
    onValue: (r, f) => { cbs[r.p] = f; return () => {}; },
    setTimeout: () => 0, clearTimeout() {},
    createGlideEngine: () => ({ update() {}, cancel() {} }),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(etaSrc, ctx);
  // a classic local script the page loads before its module (status-view.js after the S5 extraction) runs first, as in a browser
  for (const src of CLASSIC) vm.runInContext(fs.readFileSync(path.join(DIR, src.replace(/^\//, '')), 'utf8'), ctx);
  // a module has its OWN scope (strict): its declarations never collide with a classic script's globals
  vm.runInContext(`(function () { 'use strict';\n${script}\n})();`, ctx);
  const cb = cbs[`order_tracking/${token}`];
  assert.ok(cb, 'the tracker subscribed to its record');
  for (let i = 0; i < snapshots; i += 1) cb({ val: () => data });
  const out = { title: ctx.document.title, brandVars: docStyle, path: issued };
  for (const id of SNAP_IDS) out[id] = snapEl(reg[id]);
  if (reg['__brand-name']) out.brandName = reg['__brand-name']._html;
  if (reg['__error-icon']) out.errorIcon = reg['__error-icon'].textContent;
  return out;
}

// ── the matrix ──
const MIN = 60000;
const base = { order_id: 'PZX-1', customer_name: 'Ana', items_text: '1x Pepperoni', total: 340, address_short: 'Col. Palmira', created_at: NOW - 20 * MIN };
const LOC = { lat: 15.5, lng: -88.02 };
const cases = {};
const add = (name, data, opts) => { cases[name] = { data, opts }; };
for (const type of ['delivery', 'pickup']) {
  for (const status of ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'weird_status', undefined]) {
    add(`${type}/${status}`, { ...base, order_type: type, status });
  }
  add(`${type}/delivered+at`, { ...base, order_type: type, status: 'delivered', delivered_at: NOW - 5 * MIN });
  add(`${type}/completed+at`, { ...base, order_type: type, status: 'completed', delivered_at: NOW - 61 * MIN });
  add(`${type}/ready+brand`, { ...base, order_type: type, status: 'ready', restaurant_display_name: '  La Musa  ' });
  add(`${type}/ready+blank-brand`, { ...base, order_type: type, status: 'ready', restaurant_display_name: '   ' });
}
const ofd = { ...base, order_type: 'delivery', status: 'out_for_delivery' };
add('ofd/driver/active', { ...ofd, driver_name: 'carlos', is_active_drop: true, driver_location: LOC, dest_lat: 15.51, dest_lng: -88.03 });
add('ofd/driver/active-no-dest', { ...ofd, driver_name: 'Carlos', is_active_drop: true, driver_location: LOC });
add('ofd/driver/active-bad-loc', { ...ofd, driver_name: 'Carlos', is_active_drop: true, driver_location: { lat: 'x', lng: 1 } });
add('ofd/driver/active-no-loc', { ...ofd, driver_name: 'Carlos', is_active_drop: true });
add('ofd/driver/stacked', { ...ofd, driver_name: 'Carlos', is_active_drop: false, driver_location: LOC });
add('ofd/driver/unknown', { ...ofd, driver_name: 'Carlos' });
add('ofd/no-driver', { ...ofd });
add('ofd/no-driver/stacked', { ...ofd, is_active_drop: false });
add('ofd/driver/active/2-snapshots', { ...ofd, driver_name: 'Carlos', is_active_drop: true, driver_location: LOC, dest_lat: 15.51, dest_lng: -88.03 }, { snapshots: 2 });
// ETA-INPUT goldens: delivery_eta_min present/absent × picked_up_at absent / 3 min / 15 min ago, in the computeEta-driven
// branches (unknown activity = the sub-line; active drop without Maps = fallbackEta)
for (const eta of [undefined, 7]) for (const ago of [undefined, 3, 15]) {
  const d = { ...ofd, driver_name: 'Carlos', ...(eta !== undefined ? { delivery_eta_min: eta } : {}), ...(ago !== undefined ? { picked_up_at: NOW - ago * MIN } : {}) };
  add(`eta/unknown/eta=${eta}/ago=${ago}`, d);
  add(`eta/active/eta=${eta}/ago=${ago}`, { ...d, is_active_drop: true, driver_location: LOC, dest_lat: 15.51, dest_lng: -88.03 });
}
// rewards / claim (guest vs profiled vs cancelled; earn_preview punch / point) — the render around the status block
add('guest/plain-claim', { ...base, order_type: 'delivery', status: 'new' });
add('guest/punch', { ...base, order_type: 'delivery', status: 'new', earn_preview: { unit: 'punch', delta: 2, welcome: 1, goal: 8 } });
add('guest/point/la_musa', { ...base, restaurant_id: 'la_musa', order_type: 'pickup', status: 'preparing', earn_preview: { unit: 'point', delta: 57, welcome: 50, goal: 200 } });
add('profiled', { ...base, order_type: 'delivery', status: 'new', has_profile: true, display_number: 47 });
add('summary-lines', { ...base, order_type: 'delivery', status: 'new', summary_lines: [{ qty: 2, name: 'Pepperoni', cents: 68000 }] });
add('null-record', null);
add('la_musa-host', { ...base, order_type: 'delivery', status: 'new' }, { hostname: 'track.lamusa.hn' });

const got = {};
for (const [name, c] of Object.entries(cases)) got[name] = run(c.data, c.opts);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
if (process.argv.includes('--write')) {
  fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), GOLDEN)} (${Object.keys(got).length} cells)`);
  process.exit(0);
}
const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
assert.deepStrictEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'the same cell set as the golden');
for (const k of Object.keys(want)) assert.deepStrictEqual(got[k], want[k], `🔴 tracker output drifted from the pre-extraction golden: ${k}`);
ok(`the tracker's render reproduces the pre-extraction golden byte-for-byte (${Object.keys(want).length} cells: status × type, driver/stacked/location, timestamps, ETA inputs, rewards/claim)`);

// non-vacuity: the golden really discriminates (a sample of distinct outputs)
assert.notDeepStrictEqual(want['delivery/new'], want['delivery/preparing']);
assert.notDeepStrictEqual(want['ofd/driver/active'], want['ofd/driver/stacked']);
// F4 (D1): the pickup time and delivery_eta_min no longer drive any countdown — those cells render identically, in the calm copy
assert.deepStrictEqual(want['eta/unknown/eta=undefined/ago=3'], want['eta/unknown/eta=undefined/ago=15'], 'no countdown from pickup');
assert.strictEqual(want['eta/unknown/eta=undefined/ago=15']['driver-eta'].text, 'Con Carlos · pronto llegará a tu dirección', 'the calm copy (option B)');
assert.strictEqual(want['eta/unknown/eta=7/ago=15']['driver-eta'].text, 'Con Carlos · pronto llegará a tu dirección', 'delivery_eta_min is ignored');
ok('non-vacuity: distinct states produce distinct goldens; no countdown from pickup or delivery_eta_min (F4 D1), the calm copy instead');
console.log(`\ntracker-status.golden: OK (${n})`);
