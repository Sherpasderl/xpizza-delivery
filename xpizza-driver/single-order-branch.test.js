// single-order-branch.test.js — HANDLER test for the SLICE1:SINGLE-ORDER-BRANCH gate in index.html.
// run: `node single-order-branch.test.js` (also in the xpizza-functions npm chain / mutation sweep).
//
// The `orders.length === 1` gate sits in renderActiveAndQueue, directly above the LIVE stacked flow, so a
// regression here would hijack the money path. This EXECUTES the REAL renderActiveAndQueue lifted from
// index.html (the endshift-confirm.test.js idiom) against a real jsdom DOM, with the stacked render
// helpers replaced by DETERMINISTIC recording stubs. Cells:
//   1 order        → the single-order view (real singleOrderCardHtml), .solo set, banners/queue cleared;
//   2+ orders      → falls through to the stacked render — proven byte-identical to baseline eac09cdd by
//                    lifting BOTH versions with the SAME stubs and comparing the three slots' innerHTML;
//   0 orders       → idle path, unchanged (renderIdleState; no solo);
//   spArrived      → 49 m ⇒ arrived ⇒ pickup REVIEW card; 51 m ⇒ to-restaurant card (the <50 m threshold);
//   review latch   → tapping btn-at-restaurant latches review CLIENT-ONLY (no XPD writer called).
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

// Deterministic recording stubs for the stacked render helpers — IDENTICAL for my version and baseline,
// so any divergence in the compared output comes from the branch, not the stubs.
function stackedStubs(rec) {
  return {
    renderIncomingBanners: (p) => `IB[${(p || []).map((o) => o.orderId).join(',')}]`,
    renderActiveCard: (a, solo) => { rec.activeCard = { orderId: a.orderId, solo }; return `AC[${a.orderId},${solo}]`; },
    renderQueue: (q) => `Q[${(q || []).map((o) => o.orderId).join(',')}]`,
    attachActiveCardHandlers: (o) => { rec.attached.push(o.orderId); },
    attachIncomingBannerHandlers: () => {},
    restaurantChip: () => '', displayOrderLabel: (o) => String((o && o.display_number) || ''),
    renderIdleState: () => { rec.idle = true; },
  };
}

// Run a given index.html's renderActiveAndQueue against a fresh jsdom DOM. Returns an API exposing the
// three slots, the recorder, the captured slide callbacks, and the live latch.
function run(script, { orders, driverState = null, dist = 999, latchInit = null, realSingleCard = true }) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="idle-state"></div><div id="incoming-banner-slot"></div>'
    + '<div id="active-order-slot"></div><div id="queue-slot"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const rec = { attached: [], writes: [], idle: false, activeCard: null };
  const slides = {};
  const S = stackedStubs(rec);
  const XPD = {
    getDriverOrders: () => orders,
    RESTAURANT: { lat: 15.5, lng: -88.03 },
    haversineDistance: () => dist,
    acceptSecondOrder: (...a) => { rec.writes.push(['acceptSecondOrder', ...a]); return Promise.resolve({ ok: true }); },
  };
  const $ = (id) => document.getElementById(id);
  const scheduledBadge = () => '';
  const computeVuelto = () => null;
  const attachSlideConfirm = (id, cb) => { slides[id] = cb; };
  // the real builder (so the single-order card is genuinely rendered), unless a test wants it absent
  const singleCard = realSingleCard ? singleOrderCardHtml : (() => '<div data-fake-card></div>');

  const body = 'let slidingEl = null; let renderPending = false;\n'
    + 'let queuedOrders = []; const collapsedBanners = new Set();\n'
    + 'let driverState = _driverState; let slice1ReviewLatchOrderId = _latchInit;\n'
    + liftFn(script, 'renderActiveAndQueue') + '\n'
    + 'return { render: renderActiveAndQueue, getLatch: () => slice1ReviewLatchOrderId, '
    + 'getQueued: () => queuedOrders };';
  const fn = new Function(
    'document', 'window', '$', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'escapeHtml', 'ICONS',
    'computeVuelto', 'scheduledBadge', 'singleOrderCardHtml', 'attachActiveCardHandlers', 'attachSlideConfirm',
    'renderIncomingBanners', 'renderActiveCard', 'renderQueue', 'attachIncomingBannerHandlers',
    'restaurantChip', 'displayOrderLabel', 'renderIdleState', '_driverState', '_latchInit', body,
  );
  const api = fn(
    document, dom.window, $, XPD, { uid: 'drv' }, {}, {}, escapeHtml, ICONS, computeVuelto, scheduledBadge,
    singleCard, S.attachActiveCardHandlers, attachSlideConfirm, S.renderIncomingBanners, S.renderActiveCard,
    S.renderQueue, S.attachIncomingBannerHandlers, S.restaurantChip, S.displayOrderLabel, S.renderIdleState,
    driverState, latchInit,
  );
  api.render();
  const slot = (id) => document.getElementById(id);
  return {
    document, rec, slides, api,
    banner: slot('incoming-banner-slot').innerHTML,
    active: slot('active-order-slot').innerHTML,
    queue: slot('queue-slot').innerHTML,
    activeEl: slot('active-order-slot'),
  };
}

const xp = { restaurant_id: 'x_pizza', restaurant_display_name: 'X. Pizza', display_number: '1042', customer_name: 'Daniela', customer_phone: '99998888', payment_method: 'cash', total: 385, lat: 15.52, lng: -88.01 };
const pickup = () => ({ orderId: 'A', phase: 'pickup', pickupTask: { destination_lat: 15.5, destination_lng: -88.03, destination_address: 'Blvd' }, order: xp });
const delivery = (id) => ({ orderId: id, phase: 'delivery', deliveryTask: { destination_lat: 15.4, destination_lng: -88.0, destination_address: 'addr' }, order: { ...xp, display_number: id } });

let passed = 0;
const _p = [];
const t = (name, fn) => _p.push(Promise.resolve().then(fn).then(() => { passed += 1; }, (e) => { console.error(`✗ ${name}`); throw e; }));

// ── cell 1: exactly one order → the single-order view ──
t('1 order → single-order card in #active-order-slot, .solo set, banners+queue cleared', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  assert.ok(r.activeEl.classList.contains('solo'), 'active slot gets .solo');
  assert.ok(r.active.includes('sv-card'), 'single-order card rendered');
  assert.equal(r.banner, '', 'banner cleared'); assert.equal(r.queue, '', 'queue cleared');
  assert.equal(r.rec.activeCard, null, 'stacked renderActiveCard NOT called for 1 order');
  assert.deepEqual(r.rec.attached, ['A'], 'attachActiveCardHandlers bound the solo order');
});

// ── cell 3: zero orders → idle, unchanged ──
t('0 orders → idle path (renderIdleState), no .solo, slots cleared', () => {
  const r = run(MY_SCRIPT, { orders: [] });
  assert.equal(r.rec.idle, true, 'renderIdleState ran');
  assert.equal(r.activeEl.classList.contains('solo'), false, 'no solo on idle');
  assert.equal(r.active, ''); assert.equal(r.banner, ''); assert.equal(r.queue, '');
  assert.equal(r.rec.activeCard, null, 'stacked path not reached');
});

// ── cell 2: 2+ orders → stacked render, byte-identical to baseline eac09cdd ──
t('2 orders → stacked render reached (not the single view); output byte-identical to baseline', () => {
  const orders = [delivery('A'), delivery('B')];
  const mine = run(MY_SCRIPT, { orders });
  const base = run(BASE_SCRIPT, { orders });
  assert.ok(mine.rec.activeCard, 'my version reaches the stacked renderActiveCard for 2 orders');
  assert.equal(mine.active, base.active, 'active slot identical to baseline');
  assert.equal(mine.banner, base.banner, 'banner slot identical to baseline');
  assert.equal(mine.queue, base.queue, 'queue slot identical to baseline');
  assert.equal(mine.active, 'AC[A,false]', 'active = stacked card for the first order (not solo)');
  assert.equal(mine.queue, 'Q[B]', 'second order is queued');
});

// ── cell 4: spArrived threshold (<50 m) → review vs to-restaurant ──
t('pickup @ 49 m → ARRIVED → review card (#btn-pickup)', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 49 });
  assert.ok(r.active.includes('id="btn-pickup"'), 'review card renders the pickup slide');
  assert.ok(!r.active.includes('id="btn-at-restaurant"'), 'not the to-restaurant card');
});
t('pickup @ 51 m → NOT arrived → to-restaurant card (#btn-at-restaurant)', () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 51 });
  assert.ok(r.active.includes('id="btn-at-restaurant"'), 'to-restaurant card renders the client toggle');
  assert.ok(!r.active.includes('id="btn-pickup"'), 'not yet the review card');
});

// ── cell 5: review latch is CLIENT-ONLY (tap → review, no server write) ──
t('tap btn-at-restaurant → latches review client-side, re-renders to #btn-pickup, NO writer called', async () => {
  const r = run(MY_SCRIPT, { orders: [pickup()], driverState: { lat: 15.5, lng: -88.03 }, dist: 999 });
  assert.ok(r.active.includes('id="btn-at-restaurant"'), 'starts on the to-restaurant card');
  assert.equal(typeof r.slides['btn-at-restaurant'], 'function', 'the toggle slide is bound');
  await r.slides['btn-at-restaurant']();                       // simulate the confirmed slide
  assert.equal(r.api.getLatch(), 'A', 'latch set to the order id (client-only)');
  assert.ok(r.document.getElementById('btn-pickup'), 're-rendered into the review card');
  assert.equal(r.rec.writes.length, 0, 'NO XPD writer was called (client-only latch)');
});

await Promise.all(_p);
console.log(`✓ single-order-branch (handler): ${passed} tests passed`);
