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
  constructor(id) { this.id = id; this._text = ''; this._html = ''; this.classList = new ClassList(); this.disabled = false; this.style = { setProperty() {}, removeProperty() {} }; this.dataset = {}; this.children = []; this.offsetWidth = 0; }
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
// Controllable setTimeout: queue callbacks so the test can deterministically drive the post-resolve
// completion beat (blue "Completando" → green "Completado" → local bump). flushTimers() drains the queue,
// including callbacks scheduled by earlier callbacks (the sequence nests two setTimeouts).
const timerQ = [];
globalThis.setTimeout = (fn) => { if (typeof fn === 'function') timerQ.push(fn); return 0; };
globalThis.clearTimeout = () => {};
const flushTimers = () => { while (timerQ.length) { const fn = timerQ.shift(); try { fn(); } catch (_) {} } };
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

// ── listo → confirmed-write + the post-resolve completion beat (blue → green → bump) ──
// The write commits nothing until it RESOLVES; then the card plays the LOCAL blue→green beat IN the Open
// pool (still counted Open) before the bump to Completados. No status write happens in the beat.
calls.length = 0;
window.listo('PZX-1');
await new Promise((r) => setImmediate(r));
assert.deepEqual(calls, [{ id: 'PZX-1', status: 'ready' }], 'listo writes ONLY status:ready');
assert.equal(getEl('count-completed').textContent, 0, 'NOT yet bumped to Completed (write still in flight) — confirmed-write');
resolveWrite(); await new Promise((r) => setImmediate(r));
assert.equal(getEl('count-completed').textContent, 0, 'post-resolve blue "Completando" beat is IN the Open pool — not yet bumped');
assert.equal(getEl('count-open').textContent, 1, 'still in the Open pool during the completion beat');
assert.equal(calls.length, 1, 'the completion beat performs NO additional status write (the write already resolved)');
flushTimers();   // drive blue → green → bump
assert.equal(getEl('count-completed').textContent, 1, 'bumped to Completados only AFTER the beat (blue → green → bump)');
assert.equal(getEl('count-open').textContent, 0, 'left the Open pool once the beat bumps');
ok('listo → ready; post-resolve blue→green→bump beat, all local, NO extra write (confirmed-write)');

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

// ══ ★1 header-tap interaction surface — the card HEADER is the tap target (buttons removed) ══
// The reskin replaced the chunky Empezar/Completar buttons with a header tap. Prove the new surface
// (window.headerTap) routes through the SAME confirmed-write helper: advance ONLY after the write
// resolves, a rejected write doesn't advance, and the per-item ring stays progress-only (zero writes).
const tick = () => new Promise((r) => setImmediate(r));

// header-tap on a NUEVO ticket → Empezar (setOrderStatus 'preparing')
const N = { order_id: 'PZX-2', status: 'new', customer_name: 'Beto', items_text: '1x Diávola', created_at: Date.now(), order_type: 'pickup' };
XPD._ordersCb({ 'PZX-2': N });
calls.length = 0;
window.headerTap('PZX-2');
await tick();
assert.deepEqual(calls, [{ id: 'PZX-2', status: 'preparing' }], 'headerTap on NUEVO → setOrderStatus(preparing), single write');
resolveWrite(); await tick();
ok('headerTap on the NUEVO header → Empezar via the confirmed-write helper');

// header-tap on an EN-PREPARACIÓN ticket → Completar (confirmed-write ready)
const P = { order_id: 'PZX-3', status: 'preparing', customer_name: 'Cata', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' };
XPD._ordersCb({ 'PZX-3': P });
calls.length = 0;
window.headerTap('PZX-3');
await tick();
assert.deepEqual(calls, [{ id: 'PZX-3', status: 'ready' }], 'headerTap on PREP → setOrderStatus(ready), single write');
assert.equal(getEl('count-completed').textContent, 0, 'header-tap does NOT bump to Completed until the ready write RESOLVES');
resolveWrite(); await tick();
assert.equal(getEl('count-completed').textContent, 0, 'post-resolve completion beat is IN the Open pool — not yet bumped');
flushTimers();   // blue → green → bump
assert.equal(getEl('count-completed').textContent, 1, 'bumped to Completed only AFTER the beat (header-tap routes through the SAME confirmed-write + beat)');
ok('headerTap on the PREP header → Completar; blue→green→bump beat, all local, after the write resolves');

// header-tap with a REJECTED write → the ticket must NOT advance (no divergence)
const R = { order_id: 'PZX-4', status: 'preparing', customer_name: 'Dani', items_text: '1x Pepperoni', created_at: Date.now(), order_type: 'pickup' };
XPD._ordersCb({ 'PZX-3': P, 'PZX-4': R });      // PZX-3 stays completed; PZX-4 is a fresh Open prep ticket
calls.length = 0;
window.headerTap('PZX-4');
await tick();
assert.deepEqual(calls, [{ id: 'PZX-4', status: 'ready' }], 'headerTap issues the ready write');
rejectWrite(); await tick();
assert.equal(getEl('count-completed').textContent, 1, 'a REJECTED header-tap write NEVER bumps to Completed (still just PZX-3)');
assert.equal(getEl('count-open').textContent, 1, 'PZX-4 stays Open after the rejected header-tap write');
ok('headerTap with a rejected write → does NOT advance (confirmed-write, no divergence)');

// per-item check via the ring surface → LOCAL only, ZERO writes (ring is progress-only, never auto-ready)
calls.length = 0;
window.toggleItem('PZX-4', 0);
await tick();
assert.equal(calls.length, 0, 'per-item check performs NO setOrderStatus (ring progress-only; never auto-fires ready)');
ok('per-item ring check → ZERO status write (progress-only, explicit completion preserved)');

// ══ headerState golden — TIME-BASED aging on EVERY card (aging-warn restored; prep = light blue) ══
// Drive orders of known age through the real render and read data-s off the rendered card. Precedence:
// aging-late(15m+) > aging-warn(8–15m) > prep(<8m, light blue) > nuevo(<8m, gray) — so aging escalates
// by TIME and aging-warn/late WIN over the prep tint.
const AGE = (m) => Date.now() - m * 60000;
XPD._ordersCb({
  'PZX-PREP': { order_id: 'PZX-PREP', status: 'preparing', customer_name: 'Fresh Prep', items_text: '1x Margherita', created_at: AGE(2) },
  'PZX-WARN': { order_id: 'PZX-WARN', status: 'preparing', customer_name: 'Warn Prep',  items_text: '1x Margherita', created_at: AGE(10) },
  'PZX-LATE': { order_id: 'PZX-LATE', status: 'preparing', customer_name: 'Late Prep',  items_text: '1x Margherita', created_at: AGE(20) },
  'PZX-NEW':  { order_id: 'PZX-NEW',  status: 'new',        customer_name: 'Fresh New',  items_text: '1x Margherita', created_at: AGE(2) },
});
const gridHtml = getEl('ticket-grid').innerHTML;
const dataS = (id) => (gridHtml.match(new RegExp(`data-s="([^"]+)" id="card-${id}"`)) || [, '(none)'])[1];
assert.equal(dataS('PZX-PREP'), 'prep',  'a freshly-started order (<8m) → prep (light blue)');
assert.equal(dataS('PZX-NEW'),  'nuevo', 'a fresh new order (<8m) → nuevo (gray)');
assert.equal(dataS('PZX-WARN'), 'warn',  'an 8–15m preparing order → warn (amber) — aging-warn RESTORED + beats prep');
assert.equal(dataS('PZX-LATE'), 'late',  'a 15m+ preparing order → late (red) — beats prep');
ok('headerState: time-based aging on every card — fresh-prep=prep, 8–15m=warn, 15m+=late, warn/late beat prep');

// ══ "Recuperar Ticket" gating (fix #2a) — ONLY on a locally-bumped card, NOT a server-delivered one ══
// A locally-bumped card (this session's completedSet member) shows the recall button; a server-delivered
// order (estado Archivado, not a local bump) does NOT — recall is local-only and would be a no-op there.
XPD._ordersCb({ 'PZX-REC': { order_id: 'PZX-REC', status: 'preparing', customer_name: 'Local Bump', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' } });
calls.length = 0;
window.listo('PZX-REC'); await tick(); resolveWrite(); await tick(); flushTimers();   // bump PZX-REC locally
XPD._ordersCb({
  'PZX-REC': { order_id: 'PZX-REC', status: 'preparing', customer_name: 'Local Bump', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' },
  'PZX-DEL': { order_id: 'PZX-DEL', status: 'delivered', customer_name: 'Server Delivered', items_text: '1x Pepperoni', created_at: Date.now(), order_type: 'pickup' },
});
window.setTab('completed'); await tick();
const compHtml = getEl('ticket-grid').innerHTML;
assert.ok(compHtml.includes(`recall('PZX-REC')`) && compHtml.includes('recall-btn'), 'locally-bumped card → "Recuperar Ticket" shown');
assert.ok(!compHtml.includes(`recall('PZX-DEL')`), 'server-delivered card → NO "Recuperar Ticket" button (recall would be a no-op)');
calls.length = 0;
window.recall('PZX-DEL'); await tick();
assert.equal(calls.length, 0, 'recall on a server-delivered non-member performs NO status write (local no-op, never reverts status)');
ok('Recuperar Ticket gated to locally-bumped cards; server-delivered → no button + recall is a local no-op');

// ══ Tile-Fill "Ver todo" expander (Phase A #3) — truncates items; writes NO status, fires NO item-✓ ══
window.setTab('open'); await tick();
window.setLayoutMode('fill'); await tick();
XPD._ordersCb({ 'PZX-BIG': { order_id: 'PZX-BIG', status: 'new', customer_name: 'Big Order', items_text: '1x A | 1x B | 1x C | 1x D | 1x E', created_at: Date.now(), order_type: 'pickup' } });
const countItems = () => (getEl('ticket-grid').innerHTML.match(/class="card-item"/g) || []).length;
const collapsedHtml = getEl('ticket-grid').innerHTML;
assert.equal(countItems(), 4, 'Tile Fill collapsed → only the first 4 item lines rendered (truncated)');
assert.ok(collapsedHtml.includes('Ver todo · +1') && collapsedHtml.includes(`toggleExpand(event,'PZX-BIG')`), 'shows "Ver todo · +1" with its OWN toggleExpand onclick (a distinct control)');
calls.length = 0;
window.toggleExpand({ stopPropagation() {}, preventDefault() {} }, 'PZX-BIG');
await tick();
const expandedHtml = getEl('ticket-grid').innerHTML;
assert.equal(countItems(), 5, 'expanded → ALL 5 item lines rendered');
assert.ok(expandedHtml.includes('Ver menos'), 'expanded label becomes "Ver menos"');
assert.equal(calls.length, 0, 'the expander performs NO setOrderStatus (never a status write)');
window.setLayoutMode('flex'); await tick();   // restore default; also proves flex shows all items
assert.equal(countItems(), 5, 'Flex Rail shows all items (no truncation)');
ok('Tile-Fill expander truncates + reveals items; ZERO status write, distinct control (not header-tap/item-✓)');

console.log(`kds-smoke: OK (${n} cases)`);
