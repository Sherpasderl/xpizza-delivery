// single-order-branch.test.js — HANDLER + interaction test for the SLICE1:SINGLE-ORDER-BRANCH gate.
// run: `node single-order-branch.test.js` (also in the xpizza-functions npm chain / mutation sweep).
//
// The `orders.length === 1` gate sits in renderActiveAndQueue, directly above the LIVE stacked flow, so a
// regression here would hijack the money path. This EXECUTES the REAL renderActiveAndQueue + the REAL
// attachSlideConfirm + the REAL attachActiveCardHandlers lifted from index.html (the endshift-confirm.test.js
// idiom) against a real jsdom DOM, with only the stacked render helpers replaced by DETERMINISTIC recording
// stubs and the server writes replaced by DEFERRED, test-controlled promises.
//
// Cells:
//   1 order        → the single-order view (real singleOrderCardHtml), .solo set, banners/queue cleared;
//   0 orders       → idle path, unchanged (renderIdleState; no solo);
//   2+ orders       → stacked render, byte-identical to baseline eac09cdd (both lifted with the SAME stubs);
//   spArrived      → 49 m ⇒ arrived ⇒ pickup REVIEW card; 51 m ⇒ to-restaurant card (the <50 m threshold);
//   review latch   → tapping btn-at-restaurant latches review CLIENT-ONLY (no XPD writer called);
//   latch RESET    → latch A → idle → delivery → pickup A far away ⇒ NOT review (codex r1 P2-3 repro);
//   INTERACTION    → through the REAL drag handler with deferred boundary writes:
//                    (a) 1→2 arriving while a slide drag is in progress → deferred, replayed on drag-end;
//                    (b) 2→1 while an action write is pending → deferred, replayed when the write settles;
//                    (c) a rejected write recovers (slider reset, no 'completed', toast shown);
//                    (d) the stacked markup equals baseline after a transition.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { singleOrderCardHtml } from './single-order-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');

const scriptOf = (html) => html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const MY_SCRIPT = scriptOf(readFileSync(join(__dir, 'index.html'), 'utf8'));
const BASE_SCRIPT = scriptOf(
  execFileSync('git', ['show', 'eac09cdd:xpizza-driver/index.html'], { cwd: __dir, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'),
);

function liftFn(script, name) {
  let start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (script.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < script.length; i++) {
    if (script[i] === '{') { depth++; seen = true; }
    else if (script[i] === '}') { depth--; if (seen && depth === 0) return script.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVG = (k) => `<svg data-ic="${k}"></svg>`;
const ICONS = Object.fromEntries(['bell', 'bike', 'cash', 'check', 'close', 'mobile', 'nav', 'phone', 'pin', 'store', 'uturn', 'warn', 'whatsapp'].map((k) => [k, SVG(k)]));

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));   // flush microtasks + the async onUp continuation

// A deterministic stacked active card that carries a REAL slide element (so a stacked drag is drivable).
// Identical for mine and baseline, so cell (d)'s byte comparison still isolates the BRANCH, not the stub.
const STACK_SLIDE = '<div class="slide-confirm pickup" id="btn-pickup"><div class="slide-fill"></div><div class="slide-thumb"></div></div>';

// Deterministic recording stubs for the stacked render helpers — IDENTICAL for my version and baseline.
function stackedStubs(rec) {
  return {
    renderIncomingBanners: (p) => `IB[${(p || []).map((o) => o.orderId).join(',')}]`,
    renderActiveCard: (a, solo) => { rec.activeCard = { orderId: a.orderId, solo }; return `AC[${a.orderId},${solo}]${STACK_SLIDE}`; },
    renderQueue: (q) => `Q[${(q || []).map((o) => o.orderId).join(',')}]`,
    attachIncomingBannerHandlers: () => {},
    restaurantChip: () => '', displayOrderLabel: (o) => String((o && o.display_number) || ''),
    renderIdleState: () => { rec.idle = true; },
  };
}

// Run a given index.html's renderActiveAndQueue against a fresh jsdom DOM. `ctx.orders` is MUTABLE: tests
// change the feed between renders. Lifts the REAL renderActiveAndQueue + attachSlideConfirm +
// attachActiveCardHandlers so drags, drag-suppression (slidingEl), deferred writes and replay are genuine.
function run(script, { orders, driverState = null, dist = 999, latchInit = null, authGen = 0, realSingleCard = true }) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const ctx = { orders };
  const rec = { attached: [], idle: false, activeCard: null, toasts: [] };
  const writes = {};   // id → deferred() created lazily when a slide is confirmed
  const S = stackedStubs(rec);
  const XPD = {
    getDriverOrders: () => ctx.orders,
    RESTAURANT: { lat: 15.5, lng: -88.03 },
    haversineDistance: () => dist,
    emitDiag: () => {}, getDiagConnState: () => true, isActingDispatcher: () => false,
    acceptTask: () => (writes['btn-accept'] = deferred()).promise,
    pickupComplete: () => (writes['btn-pickup'] = deferred()).promise,
    completeTask: () => (writes['btn-delivered'] = deferred()).promise,
  };
  const $ = (id) => document.getElementById(id);
  const scheduledBadge = () => '';
  const computeVuelto = () => null;
  const toast = (msg, kind) => { rec.toasts.push([msg, kind]); };
  const resolveCompleteErrorMessage = async (err) => String((err && err.message) || err);
  const singleCard = realSingleCard ? singleOrderCardHtml : (() => '<div data-fake-card></div>');

  const body = 'let slidingEl = null; let renderPending = false;\n'
    + 'let queuedOrders = []; const collapsedBanners = new Set(); const pendingCompletions = new Set();\n'
    + 'let driverState = _driverState; let slice1ReviewLatchKey = _latchInit; let authGen = _authGen;\n'
    + liftFn(script, 'renderActiveAndQueue') + '\n'
    + liftFn(script, 'attachActiveCardHandlers') + '\n'
    + liftFn(script, 'attachSlideConfirm') + '\n'
    + 'return { render: renderActiveAndQueue, getLatch: () => slice1ReviewLatchKey, '
    + 'getQueued: () => queuedOrders, getSliding: () => slidingEl, getRenderPending: () => renderPending, '
    + 'bumpAuth: () => { authGen += 1; } };';
  const fn = new Function(
    'document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'renderIncomingBanners', 'renderActiveCard',
    'renderQueue', 'attachIncomingBannerHandlers', 'restaurantChip', 'displayOrderLabel', 'renderIdleState',
    'toast', 'resolveCompleteErrorMessage', '_driverState', '_latchInit', '_authGen', body,
  );
  const api = fn(
    document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS, computeVuelto, scheduledBadge,
    singleCard, S.renderIncomingBanners, S.renderActiveCard, S.renderQueue, S.attachIncomingBannerHandlers,
    S.restaurantChip, S.displayOrderLabel, S.renderIdleState, toast, resolveCompleteErrorMessage,
    driverState, latchInit, authGen,
  );
  // attachActiveCardHandlers pushes to rec.attached via a tiny real shim is NOT available (it's the real fn);
  // record attachment by observing the slides it binds instead. Expose a render that re-reads ctx.orders.
  const slot = (id) => document.getElementById(id);
  const ret = {
    document, window, rec, api, ctx, writes,
    render: () => api.render(),
    setOrders: (o) => { ctx.orders = o; },
    banner: () => slot('incoming-banner-slot').innerHTML,
    active: () => slot('active-order-slot').innerHTML,
    queue: () => slot('queue-slot').innerHTML,
    activeEl: () => slot('active-order-slot'),
    // Drive the REAL drag handler. Overrides rects (jsdom has no layout) then dispatches pointer events.
    prep(id) {
      const el = slot('active-order-slot').querySelector('#' + id) || document.getElementById(id);
      assert.ok(el, `slide #${id} present to drag`);
      const thumb = el.querySelector('.slide-thumb');
      el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
      thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
      return { el, thumb };
    },
    down({ thumb }) { thumb.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true })); },
    move(clientX) { document.dispatchEvent(new window.MouseEvent('mousemove', { clientX, bubbles: true, cancelable: true })); },
    async up(clientX) { document.dispatchEvent(new window.MouseEvent('mouseup', { clientX, bubbles: true, cancelable: true })); await tick(); },
  };
  api.render();
  return ret;
}

const xp = { restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza', display_number: '1042', customer_name: 'Daniela', customer_phone: '99998888', payment_method: 'cash', total: 385, lat: 15.52, lng: -88.01 };
const pickup = (id = 'A') => ({ orderId: id, phase: 'pickup', pickupTask: { id: id + '_pickup', destination_lat: 15.5, destination_lng: -88.03, destination_address: 'Blvd' }, order: { ...xp, display_number: id } });
const delivery = (id = 'A') => ({ orderId: id, phase: 'delivery', pickupTask: { id: id + '_pickup' }, deliveryTask: { id: id + '_delivery', destination_lat: 15.4, destination_lng: -88.0, destination_address: 'addr' }, order: { ...xp, display_number: id, lat: 15.52, lng: -88.01 } });

let passed = 0;
const _p = [];
const t = (name, fn) => _p.push(Promise.resolve().then(fn).then(() => { passed += 1; }, (e) => { console.error(`✗ ${name}`); throw e; }));

// ── cell 1: exactly one order → the single-order view ──
t('1 order → single-order card in #active-order-slot, .solo set, banners+queue cleared', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  assert.ok(r.activeEl().classList.contains('solo'), 'active slot gets .solo');
  assert.ok(r.active().includes('sv-card'), 'single-order card rendered');
  assert.equal(r.banner(), '', 'banner cleared'); assert.equal(r.queue(), '', 'queue cleared');
  assert.equal(r.rec.activeCard, null, 'stacked renderActiveCard NOT called for 1 order');
});

// ── cell: zero orders → idle, unchanged ──
t('0 orders → idle path (renderIdleState), no .solo, slots cleared', () => {
  const r = run(MY_SCRIPT, { orders: [] });
  assert.equal(r.rec.idle, true, 'renderIdleState ran');
  assert.equal(r.activeEl().classList.contains('solo'), false, 'no solo on idle');
  assert.equal(r.active(), ''); assert.equal(r.banner(), ''); assert.equal(r.queue(), '');
  assert.equal(r.rec.activeCard, null, 'stacked path not reached');
});

// ── cell 2 / (d): 2+ orders → stacked render, byte-identical to baseline eac09cdd ──
t('2 orders → stacked render reached (not the single view); output byte-identical to baseline', () => {
  const orders = [delivery('A'), delivery('B')];
  const mine = run(MY_SCRIPT, { orders });
  const base = run(BASE_SCRIPT, { orders });
  assert.ok(mine.rec.activeCard, 'my version reaches the stacked renderActiveCard for 2 orders');
  assert.equal(mine.active(), base.active(), 'active slot identical to baseline');
  assert.equal(mine.banner(), base.banner(), 'banner slot identical to baseline');
  assert.equal(mine.queue(), base.queue(), 'queue slot identical to baseline');
  assert.equal(mine.queue(), 'Q[B]', 'second order is queued');
});

// ── cell 4: spArrived threshold (<50 m) → review vs to-restaurant ──
t('pickup @ 49 m → ARRIVED → review card (#btn-pickup)', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 49 });
  assert.ok(r.active().includes('id="btn-pickup"'), 'review card renders the pickup slide');
  assert.ok(!r.active().includes('id="btn-at-restaurant"'), 'not the to-restaurant card');
});
t('pickup @ 51 m → NOT arrived → to-restaurant card (#btn-at-restaurant)', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 51 });
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'to-restaurant card renders the client toggle');
  assert.ok(!r.active().includes('id="btn-pickup"'), 'not yet the review card');
});

// ── cell 5: review latch is CLIENT-ONLY (tap → review, no server write) ──
t('tap btn-at-restaurant → latches review client-side, re-renders to #btn-pickup, NO writer called', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'starts on the to-restaurant card');
  const d = r.prep('btn-at-restaurant');
  r.down(d); r.move(1000); await r.up(1000);                 // complete the client-only toggle slide
  assert.equal(r.api.getLatch(), '0:A', 'latch set to `${authGen}:${orderId}` (client-only)');
  assert.ok(r.document.getElementById('btn-pickup'), 're-rendered into the review card');
  assert.deepEqual(Object.keys(r.writes), [], 'NO XPD server write was called (client-only latch)');
});

// ── cell: latch RESET on discontinuity — the exact codex r1 P2-3 repro ──
t('latch A → idle → delivery → pickup A FAR AWAY ⇒ NOT review (stale latch cleared on phase change)', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  const d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);   // latch A
  assert.equal(r.api.getLatch(), '0:A', 'latched');
  r.setOrders([]); r.render();                              // idle (order gone)
  r.setOrders([delivery('A')]); r.render();                 // A comes back as a DELIVERY → phase change clears latch
  assert.equal(r.api.getLatch(), null, 'latch cleared on the delivery render (phase !== pickup)');
  r.setOrders([pickup('A')]); r.render();                   // A as pickup again, still 999 m away
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'to-restaurant card, NOT review');
  assert.ok(!r.active().includes('id="btn-pickup"'), 'review did NOT re-open from the stale latch');
});
t('latch also clears on a DIFFERENT order and on an auth/session change', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  let d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  r.setOrders([pickup('B')]); r.render();                   // different order
  assert.equal(r.api.getLatch(), null, 'latch cleared for a different order');
  assert.ok(r.active().includes('id="btn-at-restaurant"'), 'B shows to-restaurant, not a stale review');
  // re-latch A, then bump authGen (session change) → cleared
  r.setOrders([pickup('A')]); r.render();
  d = r.prep('btn-at-restaurant'); r.down(d); r.move(1000); await r.up(1000);
  assert.equal(r.api.getLatch(), '0:A');
  r.api.bumpAuth(); r.render();
  assert.equal(r.api.getLatch(), null, 'latch cleared after an auth/session change (authGen bump)');
});

// ── (a) 1→2 arriving while a drag is in progress → deferred, replayed on drag-end ──
t('(a) 1→2 while a slide drag is in progress → render DEFERS, replays to stacked on drag-end', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  const d = r.prep('btn-at-restaurant');
  r.down(d);                                                // drag begins → slidingEl set
  assert.ok(r.api.getSliding(), 'slidingEl set during the drag');
  r.setOrders([delivery('A'), delivery('B')]);
  r.render();                                               // 2 orders arrive mid-drag
  assert.equal(r.api.getRenderPending(), true, 'render DEFERRED (not applied mid-drag)');
  assert.ok(r.active().includes('sv-card'), 'DOM still shows the single card during the drag');
  r.move(20); await r.up(20);                               // release below threshold → reset + replay
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared on drag-end');
  assert.ok(r.rec.activeCard, 'the deferred render replayed into the stacked path');
  assert.ok(!r.active().includes('sv-card'), 'single card replaced by the stacked render');
});

// ── (b) 2→1 while an action write is pending → deferred, replayed when the write settles ──
t('(b) 2→1 while a pickup write is PENDING → deferred during the await, single view on settle', async () => {
  const r = run(MY_SCRIPT, { orders: [delivery('A'), pickup('B')], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  assert.ok(r.rec.activeCard, 'starts stacked (2 orders)');
  const d = r.prep('btn-pickup');                           // the stacked active card's real slide
  r.down(d); r.move(1000);
  await r.up(1000);                                         // completes → onConfirm (pickupComplete) PENDING
  assert.ok(r.writes['btn-pickup'], 'the pickup write is in flight');
  assert.ok(r.api.getSliding(), 'slidingEl held while the write is pending');
  r.setOrders([delivery('A')]); r.render();                // feed drops to 1 while pending
  assert.equal(r.api.getRenderPending(), true, 'render deferred while the write is pending');
  r.writes['btn-pickup'].resolve();                        // write settles
  await tick();
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared after the write settled');
  assert.ok(r.active().includes('sv-card'), 'replayed into the single-order view (1 order)');
});

// ── (c) a rejected write recovers: slider reset, not completed, toast shown ──
t('(c) rejected pickup write → slider RESETS (no .completed), toast shown, slidingEl cleared', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup('A')], driverState: { lat: 15.5, lng: -88.03 }, dist: 49 });  // review card → btn-pickup
  assert.ok(r.active().includes('id="btn-pickup"'), 'review card with the server pickup slide');
  const d = r.prep('btn-pickup');
  r.down(d); r.move(1000);
  const upDone = r.up(1000);                                // completes → pickupComplete pending
  await tick();
  assert.ok(r.writes['btn-pickup'], 'write in flight');
  r.writes['btn-pickup'].reject(new Error('boom'));         // the write fails
  await upDone; await tick();
  assert.equal(d.el.classList.contains('completed'), false, 'slider reset — not left in the completed state');
  assert.ok(r.rec.toasts.some(([, k]) => k === 'error'), 'an error toast was shown');
  assert.equal(r.api.getSliding(), null, 'slidingEl cleared on the error path');
});

await Promise.all(_p);
console.log(`✓ single-order-branch: ${passed} tests passed`);
