// Cross-hub 2nd-order S.oferta TAKEOVER — HANDLER test. run: `node offer-takeover.test.js` (invoked from
// xpizza-functions in the npm chain). EXECUTES the REAL shipped OFFER-TAKEOVER branch + mountOfferTakeover /
// startOfferRepeat / stopOfferTakeover (LOGIC-3) + the frozen attachSlideConfirm + the real singleOrderCardHtml /
// incomingBannerHtml, lifted via new Function (the endshift-confirm.test.js idiom), in jsdom, driven by REAL pointer
// events. Proves: in takeover mode the accept slide calls acceptSecondOrder exactly once and acceptTask ZERO times
// across two consecutive renders (the acceptTask attach, attachActiveCardHandlers, is never called); offline the
// slide is disabled + unwired; the 5 s repeat is one interval cleared on exit; «otro hub» never ships.
// Mutants these kill on their markers: (a) attachActiveCardHandlers also runs in takeover; (b) the takeover wires
// acceptTask; (c) the offline gate is removed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { singleOrderCardHtml } from './single-order-view.js';
import { incomingBannerHtml } from './stacked-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function regionBody(name) {
  const s = SCRIPT.indexOf(`SLICE3:${name}:START`);
  const bodyStart = SCRIPT.indexOf('\n', s) + 1;
  const end = SCRIPT.indexOf(`SLICE3:${name}:END`, bodyStart);
  return SCRIPT.slice(bodyStart, SCRIPT.lastIndexOf('/*', end));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const OFFER = {
  orderId: 'B', phase: 'awaiting_acceptance',
  pickupTask: { id: 'B_pickup', assignment_deadline: Date.now() + 28000, destination_lat: 15.5, destination_lng: -88.0 },
  deliveryTask: { destination_lat: 15.4, destination_lng: -88.0 },
  order: { display_number: '47', total: 385, payment_method: 'cash', restaurant_id: 'x_pizza', lat: 15.4, lng: -88.0 },
};
const ACTIVE = { orderId: 'A', phase: 'delivery', pickupTask: { id: 'A_pickup' }, deliveryTask: {}, order: { customer_name: 'Ana', total: 200 } };

function build({ online = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="incoming-banner-slot"></div><div id="active-order-slot"></div><div id="queue-slot"></div><audio id="chime"></audio></body></html>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });

  const calls = { acceptSecond: 0, acceptTask: 0, attachActive: 0, attachBanner: 0, vibrate: 0, chime: 0 };
  Object.defineProperty(window.navigator, 'vibrate', { value: () => { calls.vibrate++; return true; }, configurable: true });
  document.getElementById('chime').play = () => { calls.chime++; return Promise.resolve(); };   // jsdom has no media playback
  // controllable interval: capture the 5 s callback so a test fires it on demand, and observe clearInterval.
  const timers = { cb: null, id: 0, cleared: false };
  // the RTDB connection state (XPD.getDiagConnState / .info/connected) — THE app offline signal; onLine only ADDs offline-ness
  let rtdbConn = online;                 // true = connected, false = socket down, null = unknown-until-first
  const connCbs = [];                    // the .info/connected onValue subscribers
  const XPD = {
    acceptSecondOrder: () => { calls.acceptSecond++; return Promise.resolve({ ok: true }); },
    acceptTask: () => { calls.acceptTask++; return Promise.resolve({ ok: true }); },
    RESTAURANT: { lat: 15.507, lng: -88.04 }, haversineDistance: () => 9999,
    getDiagConnState: () => rtdbConn, getDb: () => ({}),
  };
  const ICONS = {}; const escapeHtml = (s) => String(s == null ? '' : s);
  const deps = {
    document, window, navigator: window.navigator, $, XPD, ICONS, escapeHtml,
    singleOrderCardHtml, currentUser: { uid: 'drv' }, soundOn: true, allTasks: { B_pickup: { assigned_driver_id: 'drv', type: 'pickup', status: 'assigned' } },
    scheduledBadge: () => '', computeVuelto: () => null, drv2ReadNavPref: () => 'Waze',
    overviewMapSvg: () => '<svg id="ofmap"></svg>', coloniaOf: () => '', readyTimeLabel: () => '',   // S.oferta deps the OFFER-TAKEOVER branch now computes
    setInterval: (cb) => { timers.cb = cb; timers.cleared = false; return ++timers.id; },
    clearInterval: (id) => { if (id === timers.id) timers.cleared = true; },
    fbRef: (db, path) => ({ db, path }), fbOnValue: (ref, cb) => { connCbs.push(cb); cb(); return () => { const i = connCbs.indexOf(cb); if (i >= 0) connCbs.splice(i, 1); }; },
  };
  const body = 'let queuedOrders = []; let slidingEl = null; let renderPending = false; function renderActiveAndQueue() {} const DRV2_PAUSE_ENABLED = false;\n'
    + 'const mapDriver2 = { lat: 15.47, lng: -88.01, heading: 40 }, mapStale2 = false;\n'   // computed in the SLICE2 stacked branch (lifted-out of scope here)
    + 'let offerTakeoverGen = 0, offerTakeoverTimer = null, offerTakeoverTaskId = null, offerConnHandler = null, offerConnUnsub = null;\n'   // module state the lifted takeover fns close over
    + 'const bannerSlot = $("incoming-banner-slot"), activeSlot = $("active-order-slot"), queueSlot = $("queue-slot");\n'
    + 'function attachActiveCardHandlers(o) { CALLS.attachActive++; }\n'   // count-only spy: if called in takeover, exclusivity is broken
    + 'function attachIncomingBannerHandlers(o) { CALLS.attachBanner++; }\n'
    + 'function toast(m) { (CALLS.toasts = CALLS.toasts || []).push(m); }\n'   // spy: attachSlideConfirm toasts err._userMessage on a thrown submit
    + liftFn('attachSlideConfirm') + '\n'
    + liftFn('offerIsOffline') + '\n'
    + liftFn('applyOfferSlideConn') + '\n'
    + liftFn('mountOfferTakeover') + '\n' + liftFn('startOfferRepeat') + '\n' + liftFn('stopOfferTakeover') + '\n'
    + 'function renderBranch(active, pendingAccept) {\n' + regionBody('OFFER-TAKEOVER') + '\n}\n'
    + 'return { renderBranch, hasTimer: () => offerTakeoverTimer != null, slideOff: () => { const s = $("btn-accept"); return !!(s && s.classList.contains("sv-slide-off")); } };';
  const names = [...Object.keys(deps), 'CALLS'];
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => (n === 'CALLS' ? calls : deps[n])));
  const setOnline = (v) => {   // navigator.onLine edge (ADDs offline-ness only)
    Object.defineProperty(window.navigator, 'onLine', { value: v, configurable: true });
    window.dispatchEvent(new window.Event(v ? 'online' : 'offline'));
  };
  const setRtdb = (v) => { rtdbConn = v; connCbs.slice().forEach((cb) => cb()); };   // the .info/connected edge (THE signal)
  const setConn = (v) => { setRtdb(v); setOnline(v); };   // both move together
  const fireTick = () => { if (timers.cb) timers.cb(); };
  return { api, calls, $, document, window, setConn, setRtdb, setOnline, fireTick, timers };
}

function slide(h) {
  const el = h.$('btn-accept'); const thumb = el.querySelector('.slide-thumb');
  el.getBoundingClientRect = () => ({ width: 300, height: 60, left: 0, top: 0, right: 300, bottom: 60, x: 0, y: 0 });
  thumb.getBoundingClientRect = () => ({ width: 50, height: 50, left: 6, top: 6, right: 56, bottom: 56, x: 6, y: 6 });
  const ME = h.window.MouseEvent;
  thumb.dispatchEvent(new ME('mousedown', { clientX: 6, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new ME('mousemove', { clientX: 320, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new ME('mouseup', { bubbles: true }));
}

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok -', name); }

await t('TAKEOVER (active accepted + pending): acceptTask NEVER attached; the real slide → acceptSecondOrder once, acceptTask zero, across TWO renders', async () => {
  const h = build();
  h.api.renderBranch(ACTIVE, [OFFER]);                 // render 1
  h.api.renderBranch(ACTIVE, [OFFER]);                 // render 2 (re-render while mounted)
  assert.equal(h.calls.attachActive, 0, 'attachActiveCardHandlers (the acceptTask attach) is NEVER called in takeover — mutant (a) dies here');
  assert.ok(h.$('btn-accept'), 'the offer accept slide is mounted (S.oferta reused)');
  slide(h); await tick();
  assert.equal(h.calls.acceptSecond, 1, 'the slide called acceptSecondOrder exactly once');
  assert.equal(h.calls.acceptTask, 0, 'acceptTask was called ZERO times — mutant (b) dies here');
});

await t('NON-takeover (active accepted, no pending): attachActiveCardHandlers IS called; no offer slide', async () => {
  const h = build();
  h.api.renderBranch(ACTIVE, []);
  assert.equal(h.calls.attachActive, 1, 'the normal active-card handlers run when there is no offer');
  assert.equal(h.calls.acceptSecond, 0, 'no acceptSecondOrder without an offer');
});

await t('OFFLINE: the accept slide is disabled (sv-slide-off) + unwired → sliding does NOT accept (mutant (c) dies)', async () => {
  const h = build({ online: false });
  h.api.renderBranch(ACTIVE, [OFFER]);
  const el = h.$('btn-accept');
  assert.ok(el.classList.contains('sv-slide-off'), 'the slide shows the truthful offline state');
  slide(h); await tick();
  assert.equal(h.calls.acceptSecond, 0, 'offline: sliding accepts NOTHING (acceptSecondOrder is runTransaction, not queued)');
});

await t('the 5 s repeat is ONE interval, cleared when the takeover exits', async () => {
  const h = build();
  h.api.renderBranch(ACTIVE, [OFFER]);
  assert.ok(h.api.hasTimer(), 'the repeat interval started while mounted');
  h.api.renderBranch(ACTIVE, [OFFER]);                 // re-render for the SAME offer must not stack a 2nd interval
  assert.ok(h.api.hasTimer(), 'still one interval across re-renders');
  h.api.renderBranch(ACTIVE, []);                      // left takeover
  assert.ok(!h.api.hasTimer(), 'the interval is cleared on exit');
});

await t('«otro hub» never ships: the incoming banner render carries no «otro hub» sub-label', async () => {
  const html = incomingBannerHtml([OFFER], { esc: (s) => String(s == null ? '' : s) });
  assert.ok(!/otro hub/.test(html), 'the legacy «otro hub» string is gone from the banner render');
});

// ---- P1 (Codex r1): offline gating FOLLOWS connectivity, live, with a submit-time recheck ----
await t('CONNECTIVITY EDGE: an online-mounted slide disables on `offline` and re-enables on `online` — no re-render', async () => {
  const h = build({ online: true });
  h.api.renderBranch(ACTIVE, [OFFER]);
  assert.equal(h.api.slideOff(), false, 'mounted online → the slide is enabled');
  h.setConn(false);                                    // window `offline` edge, NO re-render
  assert.equal(h.api.slideOff(), true, 'going offline disables the slide immediately (sv-slide-off)');
  h.setConn(true);                                     // window `online` edge, NO re-render
  assert.equal(h.api.slideOff(), false, 'reconnecting re-enables the slide without waiting for a render');
});

await t('SUBMIT RECHECK: connectivity dropped after mount (class not yet toggled) → the slide does NOT accept, it toasts', async () => {
  const h = build({ online: true });
  h.api.renderBranch(ACTIVE, [OFFER]);
  Object.defineProperty(h.window.navigator, 'onLine', { value: false, configurable: true });   // dropped, but NO edge fired yet
  slide(h); await tick();
  assert.equal(h.calls.acceptSecond, 0, 'the submit-time recheck blocks acceptSecondOrder when offline');
  assert.ok((h.calls.toasts || []).some((m) => /Sin conexión/.test(m)), 'the driver is told why (toast)');
});

// Codex r2 R1-1: THE signal is the RTDB connection state — navigator.onLine can lie (a WebView says online with the
// socket down). A mutant that gated on navigator.onLine ONLY would leave the slide live here → this cell is RED for it.
await t('RTDB SIGNAL: onLine=true but the RTDB socket is DOWN → the slide disables live + accepts nothing; reconnect re-enables (no re-render)', async () => {
  const h = build({ online: true });
  h.api.renderBranch(ACTIVE, [OFFER]);
  assert.equal(h.api.slideOff(), false, 'connected → enabled');
  h.setRtdb(false);                                    // RTDB drops; navigator.onLine stays TRUE (no window edge)
  assert.equal(h.window.navigator.onLine, true, 'the WebView still reports online — only the RTDB socket is down');
  assert.equal(h.api.slideOff(), true, 'the slide disables on the RTDB edge alone (onLine-only gating would miss this)');
  slide(h); await tick();
  assert.equal(h.calls.acceptSecond, 0, 'and the submit recheck blocks acceptSecondOrder while the socket is down');
  h.setRtdb(true);                                     // socket back
  assert.equal(h.api.slideOff(), false, 'reconnect re-enables the slide without a re-render');
});

// ---- P2 (Codex r1): the repeat alert self-terminates on expiry and on unmount ----
await t('LIFECYCLE: a live tick chimes+vibrates (positive control); a tick past the real deadline does NEITHER and clears the interval', async () => {
  const live = build();
  live.api.renderBranch(ACTIVE, [OFFER]);              // future deadline, still offered, mounted
  live.fireTick();
  assert.equal(live.calls.chime, 1, 'a live tick chimes'); assert.equal(live.calls.vibrate, 1, 'and vibrates');
  assert.equal(live.timers.cleared, false, 'the interval keeps running while live');

  const expired = build();
  const PAST = { ...OFFER, pickupTask: { ...OFFER.pickupTask, assignment_deadline: Date.now() - 1000 } };
  expired.api.renderBranch(ACTIVE, [PAST]);            // allTasks still says 'assigned' (a stale feed), but the deadline passed
  expired.fireTick();
  assert.equal(expired.calls.chime, 0, 'past the deadline: NO chime'); assert.equal(expired.calls.vibrate, 0, 'and NO vibrate');
  assert.equal(expired.timers.cleared, true, 'the interval is cleared (self-terminate on expiry)');
});

await t('LIFECYCLE: the offer card removed from the DOM → the next tick clears the interval (no orphan alerts)', async () => {
  const h = build();
  h.api.renderBranch(ACTIVE, [OFFER]);
  h.$('active-order-slot').innerHTML = '';             // DOM gone WITHOUT a stopOfferTakeover render
  h.fireTick();
  assert.equal(h.calls.chime, 0, 'no chime once the card is gone'); assert.equal(h.calls.vibrate, 0, 'no vibrate');
  assert.equal(h.timers.cleared, true, 'the interval is cleared on DOM removal');
});

// ---- P5 (Codex r1): the km chip needs EVERY leg's coordinates, and reads «{X} km» (never «km total») ----
await t('KM: all three points valid → a «{X} km» chip; a leg missing coordinates → NO chip (no misleading total)', async () => {
  const ok = build();
  ok.api.renderBranch(ACTIVE, [OFFER]);                // driver + hub + stop all have coords (haversine stub = 9999 m)
  const okHtml = ok.$('active-order-slot').innerHTML;
  assert.ok(/of-dist/.test(okHtml) && / km</.test(okHtml) && !/km total/.test(okHtml), 'valid legs → «{X} km» chip, never «km total»');

  const bad = build();
  const NOCOORDS = { ...OFFER, order: { ...OFFER.order, lat: undefined, lng: undefined }, deliveryTask: {} };
  bad.api.renderBranch(ACTIVE, [NOCOORDS]);            // the stop has no coordinates → an incomplete leg
  assert.ok(!/of-dist/.test(bad.$('active-order-slot').innerHTML), 'an incomplete leg omits the km chip entirely');
});

console.log(`✓ offer-takeover: ${passed} checks passed`);
process.exit(passed === 11 ? 0 : 1);   // force-exit past any lingering interval
