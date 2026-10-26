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
  Object.defineProperty(window.navigator, 'vibrate', { value: () => true, configurable: true });

  const calls = { acceptSecond: 0, acceptTask: 0, attachActive: 0, attachBanner: 0 };
  const XPD = {
    acceptSecondOrder: () => { calls.acceptSecond++; return Promise.resolve({ ok: true }); },
    acceptTask: () => { calls.acceptTask++; return Promise.resolve({ ok: true }); },
    RESTAURANT: { lat: 15.507, lng: -88.04 }, haversineDistance: () => 9999,
  };
  const ICONS = {}; const escapeHtml = (s) => String(s == null ? '' : s);
  const deps = {
    document, window, navigator: window.navigator, $, XPD, ICONS, escapeHtml,
    singleOrderCardHtml, currentUser: { uid: 'drv' }, soundOn: true, allTasks: { B_pickup: { assigned_driver_id: 'drv', type: 'pickup', status: 'assigned' } },
    scheduledBadge: () => '', computeVuelto: () => null, drv2ReadNavPref: () => 'Waze',
  };
  const body = 'let queuedOrders = []; let slidingEl = null; let renderPending = false; function renderActiveAndQueue() {}\n'
    + 'let offerTakeoverGen = 0, offerTakeoverTimer = null, offerTakeoverTaskId = null;\n'   // module state the lifted takeover fns close over
    + 'const bannerSlot = $("incoming-banner-slot"), activeSlot = $("active-order-slot"), queueSlot = $("queue-slot");\n'
    + 'function attachActiveCardHandlers(o) { CALLS.attachActive++; }\n'   // count-only spy: if called in takeover, exclusivity is broken
    + 'function attachIncomingBannerHandlers(o) { CALLS.attachBanner++; }\n'
    + liftFn('attachSlideConfirm') + '\n'
    + liftFn('mountOfferTakeover') + '\n' + liftFn('startOfferRepeat') + '\n' + liftFn('stopOfferTakeover') + '\n'
    + 'function renderBranch(active, pendingAccept) {\n' + regionBody('OFFER-TAKEOVER') + '\n}\n'
    + 'return { renderBranch, hasTimer: () => offerTakeoverTimer != null };';
  const names = [...Object.keys(deps), 'CALLS'];
  const fn = new Function(...names, body);
  const api = fn(...names.map((n) => (n === 'CALLS' ? calls : deps[n])));
  return { api, calls, $, document, window };
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

console.log(`✓ offer-takeover: ${passed} checks passed`);
process.exit(passed === 5 ? 0 : 1);   // force-exit past any lingering interval
