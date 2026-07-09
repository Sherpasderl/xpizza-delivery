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
// setOrderStatus's KDS return contract (#2): true = wrote · false = ownership-skip. resolveWrite() resolves
// a normal write (true); resolveSkip() resolves an ownership-skip (false); rejectWrite() throws.
const calls = [];
let resolveWrite, resolveSkip, rejectWrite;
const XPD = {
  KDS_RESTAURANT_ID: 'x_pizza',
  initDelivery() {}, onAuth(cb) { Promise.resolve().then(() => cb({ uid: 'u1' })); },
  isKitchen: async () => true,
  signIn: async () => {}, signOutUser: async () => {},
  subscribeToOrders(cb) { XPD._ordersCb = cb; return () => {}; },
  subscribeToOrderTimeline() { return () => {}; },
  subscribeReadyTimeThreshold() { return () => {}; },
  setOrderStatus(id, status) { calls.push({ id, status }); return new Promise((res, rej) => { resolveWrite = () => res(true); resolveSkip = () => res(false); rejectWrite = () => rej(new Error('boom')); }); },
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

// ══ Tile-Fill chevron expander — FULL render (measure-based; no count-slice); toggle writes NO status ══
// NOTE: the OVERFLOW measure (fade/chevron reveal) is layout-behavioral (scrollHeight/clientHeight are 0
// under this DOM shim), so it's verified on-device; here we assert the invariants that DON'T need layout:
// all items always render (no truncation), the chevron is a distinct toggleExpand control, and expanding
// releases the cap (.expanded) — all with ZERO status writes.
window.setTab('open'); await tick();
window.setLayoutMode('fill'); await tick();
XPD._ordersCb({ 'PZX-BIG': { order_id: 'PZX-BIG', status: 'new', customer_name: 'Big Order', items_text: '1x A | 1x B | 1x C | 1x D | 1x E', created_at: Date.now(), order_type: 'pickup' } });
const countItems = () => (getEl('ticket-grid').innerHTML.match(/class="card-item"/g) || []).length;
const collapsedHtml = getEl('ticket-grid').innerHTML;
assert.equal(countItems(), 5, 'Tile Fill renders ALL 5 items (no count-slice) — full renderItems string');
assert.ok(collapsedHtml.includes(`toggleExpand(event,'PZX-BIG')`) && collapsedHtml.includes('class="more'), 'collapsed → a subtle .more chevron with its OWN toggleExpand onclick (distinct control)');
assert.ok(collapsedHtml.includes('#i-chevd'), 'collapsed chevron points DOWN (#i-chevd)');
calls.length = 0;
window.toggleExpand({ stopPropagation() {}, preventDefault() {} }, 'PZX-BIG');
await tick();
const expandedHtml = getEl('ticket-grid').innerHTML;
assert.equal(countItems(), 5, 'expanded → still all 5 items');
assert.ok(/class="tk[^"]*\bexpanded\b/.test(expandedHtml), 'expanding releases the cap (card gets .expanded)');
assert.ok(expandedHtml.includes('#i-chevu') && expandedHtml.includes('Ver menos'), 'expanded chevron points UP (#i-chevu, "Ver menos")');
assert.equal(calls.length, 0, 'the expander performs NO setOrderStatus (never a status write)');
window.toggleExpand({ stopPropagation() {}, preventDefault() {} }, 'PZX-BIG'); await tick();   // collapse back
window.setLayoutMode('flex'); await tick();
assert.equal(countItems(), 5, 'Flex Rail shows all items (unchanged)');
assert.ok(!getEl('ticket-grid').innerHTML.includes('class="more'), 'Flex Rail → no chevron');
ok('Tile-Fill chevron: full render + distinct toggleExpand control + .expanded release; ZERO status write');

// ══ #2 — ownership-skip (setOrderStatus → false) does NOT commit local state (no false-success bump) ══
window.setTab('open'); await tick();
XPD._ordersCb({ 'PZX-SKIP': { order_id: 'PZX-SKIP', status: 'preparing', customer_name: 'Not Ours', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' } });
const openBefore = getEl('count-open').textContent, compBefore = getEl('count-completed').textContent;
calls.length = 0;
window.listo('PZX-SKIP');
await tick();
assert.deepEqual(calls, [{ id: 'PZX-SKIP', status: 'ready' }], 'the write is attempted');
resolveSkip();   // server returns false (ownership-skip) — NOT written
await tick();
assert.equal(getEl('count-completed').textContent, compBefore, 'a false (ownership-skip) write does NOT bump to Completados');
assert.equal(getEl('count-open').textContent, openBefore, 'the card stays in the Open pool (frozen at `from`, no divergence)');
assert.ok(getEl('ticket-grid').innerHTML.includes(`dismissWrite('PZX-SKIP')`), 'shows a dismissable ownership-skip notice (no retry-loop write)');
ok('#2 ownership-skip (false) → NO local commit / NO bump; frozen with a dismissable notice');

// ══ #9 — an already server-ready order skips the redundant setOrderStatus('ready') ══
XPD._ordersCb({ 'PZX-RDY': { order_id: 'PZX-RDY', status: 'ready', customer_name: 'Already Ready', items_text: '1x Margherita', created_at: Date.now(), order_type: 'pickup' } });
calls.length = 0;
window.listo('PZX-RDY');   // op === 'listo' → straight to the local completion beat, NO write
await tick();
assert.equal(calls.length, 0, '#9 an already-ready order performs NO setOrderStatus (no redundant write)');
flushTimers();             // drive the local blue→green→bump beat
assert.ok(getEl('ticket-grid') && getEl('count-completed').textContent >= 1, 'it still bumps to Completados via the LOCAL beat (no write needed)');
assert.equal(calls.length, 0, 'still ZERO writes after the local bump');
ok('#9 already-ready → skips the redundant ready write, bumps via the local beat only');

// ══ FIX 2 — Archivar shows ONLY in the Abiertos tab; a cancelled card in Completados has no Archivar ══
window.setLayoutMode('flex'); await tick();
XPD._ordersCb({ 'PZX-CX': { order_id: 'PZX-CX', status: 'cancelled', customer_name: 'Kevin', items_text: '1x Carnívora', created_at: Date.now(), order_type: 'delivery' } });
window.setTab('open'); await tick();
assert.ok(getEl('ticket-grid').innerHTML.includes(`archiveCancel('PZX-CX')`), 'Abiertos: a cancelled card shows the Archivar button');
window.archiveCancel('PZX-CX');   // local bump → moves to Completados (op completed, estado still Cancelado)
await tick();
window.setTab('completed'); await tick();
const compHtml2 = getEl('ticket-grid').innerHTML;
assert.ok(!compHtml2.includes(`archiveCancel('PZX-CX')`), 'Completados: the cancelled+archived card has NO Archivar button');
assert.ok(compHtml2.includes(`recall('PZX-CX')`), 'Completados: it shows Recuperar Ticket (recall) instead');
ok('FIX 2 Archivar gated to Abiertos; Completados cancelled card → Recuperar only (no Archivar, nothing clips)');

// ══ Phase B — horizontal 1/2 Rails: mode wiring (accept + persist r1/r2) + render-skips-pagination ══
// The rail LAYOUT itself (grid-auto-flow/column, viewport÷N heights, scroll-inside) is BEHAVIORAL CSS —
// scrollHeight/clientHeight are 0 under this DOM shim, so it's verified on-device/headless. Here we assert
// the two invariants that DON'T need real layout: the mode string round-trips, and rail mode mounts the
// FULL ordered pool (no PAGE_SIZE=12 slice) while the pager modes still paginate.
const railStore = globalThis.localStorage;
window.setLayoutMode('r2'); await tick();
assert.equal(railStore.getItem('xpizza_kds_layout'), 'r2', 'setLayoutMode("r2") persists to localStorage xpizza_kds_layout');
window.setLayoutMode('r1'); await tick();
assert.equal(railStore.getItem('xpizza_kds_layout'), 'r1', 'r1 accepted + persisted');
window.setLayoutMode('r3'); await tick();
assert.equal(railStore.getItem('xpizza_kds_layout'), 'flex', 'r3 removed (3 Rails dropped) → falls back to flex');
window.setLayoutMode('bogus'); await tick();
assert.equal(railStore.getItem('xpizza_kds_layout'), 'flex', 'an unknown mode falls back to flex (accept-list guard)');
ok('Phase B mode wiring: setLayoutMode accepts + persists r1/r2; rejects r3/unknown → flex');

// Feed a fresh pool of 15 OPEN tickets (> PAGE_SIZE=12) and count mounted cards per mode.
const bigPool = {};
for (let i = 1; i <= 15; i++) bigPool['PZR-' + i] = { order_id: 'PZR-' + i, status: 'new', customer_name: 'R' + i, items_text: '1x Margarita', created_at: Date.now() - i * 1000, order_type: 'pickup' };
XPD._ordersCb(bigPool);
window.setTab('open'); await tick();
const cardCount = () => (getEl('ticket-grid').innerHTML.match(/id="card-PZR-/g) || []).length;
window.setLayoutMode('flex'); await tick();
assert.equal(cardCount(), 12, 'Flex Rail (pager mode) paginates to PAGE_SIZE=12 — UNCHANGED');
window.setLayoutMode('r2'); await tick();
assert.equal(cardCount(), 15, 'rail mode mounts the FULL 15-ticket pool (no PAGE_SIZE slice)');
window.setLayoutMode('r1'); await tick();
assert.equal(cardCount(), 15, 'r1 also mounts the full pool');
assert.equal(calls.length, 0, 'switching layout modes performs ZERO setOrderStatus (presentational only)');
window.setLayoutMode('flex'); await tick();   // restore
ok('Phase B render path: rail mounts the FULL pool (no pagination); pager modes still slice to PAGE_SIZE');

console.log(`kds-smoke: OK (${n} cases)`);
