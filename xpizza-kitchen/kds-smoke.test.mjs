// Behavioral smoke test for the KDS inline module (the render/handler GLUE that node --check can't
// prove). Loads the REAL inline <script type="module"> from index.html, rewrites only its imports
// (firebase CDN stripped; XPD stubbed; the local pure modules kept real), runs it under a minimal DOM
// shim, drives one order through the subscription, and asserts the CONFIRMED-WRITE contract behaviorally:
//   • empezar → setOrderStatus('preparing')
//   • listo   → setOrderStatus('ready'); the local Completed bump commits ONLY after the write RESOLVES
//   • recall / toggleItem / prioritize → ZERO setOrderStatus (LOCAL only)
// Run: node kds-smoke.test.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./', import.meta.url));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── minimal DOM shim ──────────────────────────────────────────────────────────
class ClassList {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach(x => x && this.s.add(x)); }
  remove(...c) { c.forEach(x => this.s.delete(x)); }
  toggle(c, f) { const on = f === undefined ? !this.s.has(c) : !!f; on ? this.s.add(c) : this.s.delete(c); return on; }
  contains(c) { return this.s.has(c); }
}
class El {
  constructor(id) { this.id = id; this._text = ''; this._html = ''; this.classList = new ClassList(); this.disabled = false; this.style = {}; this.dataset = {}; this.children = []; }
  set textContent(v) { this._text = v; } get textContent() { return this._text; }
  set innerHTML(v) { this._html = v; } get innerHTML() { return this._html; }
  querySelectorAll() { return []; }        // augmentTickets checkbox injection → no-op in the shim
  querySelector() { return null; }
  addEventListener() {} removeEventListener() {}
  insertBefore() {} appendChild() {} remove() { }
  setAttribute() {} removeAttribute() {}
  closest() { return null; }
  cloneNode() { return new El(this.id); }
  focus() {} click() {}
}
const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
const doc = {
  getElementById: getEl,
  querySelector: () => new El('q'),
  querySelectorAll: () => [],
  createElement: () => new El('c'),
  addEventListener: () => {},
  body: new El('body'),
  get title() { return this._t || ''; }, set title(v) { this._t = v; },
  visibilityState: 'visible',
};
class MO { observe() {} disconnect() {} }

// ── XPD stub (controllable setOrderStatus) ──
const calls = [];
let resolveWrite, rejectWrite;
const XPD = {
  KDS_RESTAURANT_ID: 'x_pizza',
  initDelivery() {}, onAuth(cb) { Promise.resolve().then(() => cb({ uid: 'u1' })); },
  isKitchen: async () => true,
  signIn: async () => {}, signOutUser: async () => {},
  subscribeToOrders(cb) { XPD._ordersCb = cb; return () => {}; },
  subscribeToOrderTimeline() { return () => {}; },
  subscribeReadyTimeThreshold() { return () => {}; },
  setOrderStatus(id, status) { calls.push({ id, status }); return new Promise((res, rej) => { resolveWrite = () => res(); rejectWrite = () => rej(new Error('boom')); }); },
};

// ── globals the module touches at top level ──
const store = {};
globalThis.window = globalThis;
globalThis.document = doc;
globalThis.location = { hostname: 'localhost' };                 // unknown host → nudge inert
try { Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }); } catch (_) {}  // no wakeLock
globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
globalThis.setTimeout = (fn) => { return 0; }; globalThis.clearTimeout = () => {};
globalThis.requestAnimationFrame = () => 0;
globalThis.MutationObserver = MO;
globalThis.AudioContext = class { constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; } createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {} }, type: '' }; } createGain() { return { connect() {}, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; } resume() { return Promise.resolve(); } };
globalThis.initializeApp = () => ({});
globalThis.__XPD = XPD;

// ── load + rewrite the inline module ──
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
let mod = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
mod = mod
  .replace(/import\s*\{\s*initializeApp\s*\}\s*from\s*['"][^'"]+['"];?/, '')
  .replace(/import \* as XPD from '\.\/xpizza-delivery\.js\?v=\d+';/, 'const XPD = globalThis.__XPD;')
  .replace(/from '\.\/ready-nudge\.js\?v=\d+'/, `from '${new URL('./ready-nudge.js', import.meta.url).href}'`)
  .replace(/from '\.\/rail-count\.js\?v=\d+'/, `from '${new URL('./rail-count.js', import.meta.url).href}'`)
  .replace(/from '\.\/card-model\.js\?v=\d+'/, `from '${new URL('./card-model.js', import.meta.url).href}'`);

await import('data:text/javascript,' + encodeURIComponent(mod));
await new Promise((r) => setImmediate(r));   // let onAuth microtask + startOrdersSubscription run
ok('inline module evaluated + subscription wired (no reference errors at runtime)');

// ── drive one preparing order through the subscription ──
const ORDER = { order_id: 'PZX-1', status: 'preparing', customer_name: 'Ana', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' };
XPD._ordersCb({ 'PZX-1': ORDER });
ok('render() ran for a live order (Open tab)');
assert.equal(getEl('count-open').textContent, 1, 'order appears in the Open count');
assert.equal(getEl('count-completed').textContent, 0, 'not completed yet');
ok('Open=1, Completed=0 before any action');

// ── empezar → setOrderStatus('preparing') ──
calls.length = 0;
window.empezar('PZX-1');
await new Promise((r) => setImmediate(r));
assert.deepEqual(calls, [{ id: 'PZX-1', status: 'preparing' }], 'empezar writes ONLY status:preparing');
resolveWrite(); await new Promise((r) => setImmediate(r));
ok('empezar → setOrderStatus(preparing), single write');

// ── listo → confirmed-write: completed bump commits ONLY after the write resolves ──
calls.length = 0;
window.listo('PZX-1');
await new Promise((r) => setImmediate(r));
assert.deepEqual(calls, [{ id: 'PZX-1', status: 'ready' }], 'listo writes ONLY status:ready');
assert.equal(getEl('count-completed').textContent, 0, 'NOT yet bumped to Completed (write still in flight) — confirmed-write');
resolveWrite(); await new Promise((r) => setImmediate(r));
assert.equal(getEl('count-completed').textContent, 1, 'bumped to Completed ONLY after the write RESOLVED');
assert.equal(getEl('count-open').textContent, 0, 'left the Open pool on completion');
ok('listo → ready; Completed bump commits ONLY after the write resolves (confirmed-write)');

// ── recall → LOCAL un-bump, ZERO status write (never reverts /orders.status) ──
calls.length = 0;
window.recall('PZX-1');
await new Promise((r) => setImmediate(r));
assert.equal(calls.length, 0, 'recall performs NO setOrderStatus');
assert.equal(getEl('count-open').textContent, 1, 'recall returns the ticket to Open (local)');
assert.equal(getEl('count-completed').textContent, 0, 'no longer completed');
ok('recall → local un-bump, ZERO status write (never reverts ready)');

// ── toggleItem + prioritize → LOCAL only, ZERO status write ──
calls.length = 0;
window.toggleItem('PZX-1', 0);
window.prioritize('PZX-1');
await new Promise((r) => setImmediate(r));
assert.equal(calls.length, 0, 'toggleItem + prioritize perform NO setOrderStatus');
ok('toggleItem + prioritize → LOCAL only, ZERO status write');

// ── error path: a rejected listo write must NOT bump to Completed ──
calls.length = 0;
window.listo('PZX-1');
await new Promise((r) => setImmediate(r));
rejectWrite(); await new Promise((r) => setImmediate(r));
assert.equal(getEl('count-completed').textContent, 0, 'failed write NEVER commits the Completed bump');
assert.equal(getEl('count-open').textContent, 1, 'ticket stays in Open after a failed write');
ok('failed listo write → NO Completed bump, ticket stays Open (error path, no divergence)');

console.log(`kds-smoke: OK (${n} cases)`);
