// practica-demo.test.js — the Inicio (c) practica demo is CLIENT-ONLY with ZERO RTDB writes (O5), AND fully ISOLATED
// from the real order machinery (Codex r1 P1: a demo swipe must never reproduce a real write). This mounts the demo in
// a REAL jsdom document with the operational handlers PRESENT — the production slide binder (attachSlideConfirm) and a
// planted production slide node — drives REAL pointer gestures, runs assignment/shift/auth transitions, and spies at
// the SDK + XPD write boundary. Invariants proven:
//   1. The whole demo runs end-to-end with ZERO writes (RTDB set/update/push/transaction/remove AND XPD
//      acceptTask/pickupComplete/completeTask/submitDriverProfile), reaches the resumen and records practiceDone in the
//      PROGRESS store (never a real order).
//   2. ISOLATION: every demo node is NAMESPACED (cd-*), so no production id survives in the demo host; binding the REAL
//      attachSlideConfirm to a planted production `btn-pickup` and then swiping the DEMO's `cd-btn-pickup` advances the
//      demo and NEVER fires the real callback. (Reverting the namespacing turns this RED: the demo host would carry a
//      production id and the scoped `#cd-*` lookup would miss.)
//   3. alive() teardown: an order assigned / a shift going active / an auth transition mid-demo disposes the controller
//      (→ null) so a real order can never render underneath; a subsequent swipe is a no-op with zero writes.
//   4. START guard: the demo refuses to start while a shift is active or an order is assigned (nothing painted).
// The injected inline-write mutant dies on (1); the un-namespaced mutant dies on (2). Run: `node practica-demo.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { computeVuelto } from './cash-helpers.js';
import { activeCardHtml, pickupReviewHtml, deliverySummaryHtml } from './stacked-view.js';
import { singleOrderCardHtml } from './single-order-view.js';
import { practicaDemoOrder } from './practica-fixture.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');                       // the sanctioned driver jsdom harness (see slice2-branch.test.js)
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Lift a `function NAME(` declaration by balancing braces — fails CLOSED (a rename turns this red, never a silent stub).
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

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICONS = new Proxy({}, { get: () => '' });            // any icon → '' (we test writes + isolation, not glyphs)
const tick = () => new Promise((r) => setTimeout(r, 0));

// Boot a harness: a real jsdom document with #screen-onshift (to host production slide residue) + #screen-companion
// (the demo host). The REAL companionPracticeStart / companionDemoAlive / attachDemoSlide are lifted from index.html;
// the REAL production attachSlideConfirm is lifted so a cell can bind it to a production id. Every write path is spied.
function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-onshift"></div><div id="screen-companion"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const writes = { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0, raq: 0 };
  const dbSpy = { set: () => { writes.set++; }, update: () => { writes.update++; }, push: () => { writes.push++; }, transaction: () => { writes.transaction++; }, remove: () => { writes.remove++; } };
  const XPD = { RESTAURANT: { lat: 15.5074, lng: -88.0398 }, db: dbSpy,
    acceptTask: () => { writes.acceptTask++; }, pickupComplete: () => { writes.pickupComplete++; },
    completeTask: () => { writes.completeTask++; }, submitDriverProfile: () => { writes.submitDriverProfile++; } };
  const boardRef = { list: [] };                           // the "live board" the start guard + alive() read
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const $ = (id) => document.getElementById(id);           // DOCUMENT-WIDE — exactly production's `$`

  const body =
    "let companionDemo = null;\n" +
    "let companionStep = 'practice';\n" +
    "let companionProgressMem = {}; const companionProgressKey = (uid) => `sherpa_driver_checklist_progress_${uid}`;\n" +
    "let authGen = 0;\n" +
    "let driverState = _driverState;\n" +
    "let currentUser = _currentUser;\n" +
    "let slidingEl = null, renderPending = false;\n" +
    "function renderActiveAndQueue(){ _writes.raq++; }\n" +               // production attachSlideConfirm's tail — must NOT be reached by the demo
    liftFn('companionReadProgress') + "\n" +
    liftFn('companionWriteProgress') + "\n" +
    liftFn('companionDemoAlive') + "\n" +
    liftFn('attachDemoSlide') + "\n" +
    liftFn('attachSlideConfirm') + "\n" +
    liftFn('companionPracticeStart') + "\n" +
    "return { start: companionPracticeStart, alive: companionDemoAlive, attachSlideConfirm,\n" +
    "  getStep: () => companionStep, getDemo: () => companionDemo, store: () => companionProgressMem,\n" +
    "  setActive: (v) => { driverState = v ? { active: true } : null; }, bumpAuth: () => { authGen++; }, setUser: (u) => { currentUser = u; } };";

  const names = ['document', '$', 'XPD', 'escapeHtml', 'ICONS', 'localStorage', 'computeVuelto', 'scheduledBadge',
    'singleOrderCardHtml', 'pickupReviewHtml', 'activeCardHtml', 'deliverySummaryHtml', 'practicaDemoOrder',
    'drv2LiveBoard', 'showScreen', 'companionRenderOnboarding', 'toast', '_driverState', '_currentUser', '_writes'];
  const api = (new Function(...names, body))(
    document, $, XPD, escapeHtml, ICONS, localStorage, computeVuelto, () => '',
    singleOrderCardHtml, pickupReviewHtml, activeCardHtml, deliverySummaryHtml, practicaDemoOrder,
    () => boardRef.list, () => {}, () => {}, () => {}, null, { uid: 'A' }, writes);

  const host = () => document.getElementById('screen-companion');
  async function swipe(slideId) {
    const el = host().querySelector('#' + slideId);
    assert.ok(el, `demo slide #${slideId} present in the demo host`);
    const thumb = el.querySelector('.slide-thumb');
    el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
    thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
    thumb.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true }));
    await tick();
  }
  function clickDone() {
    const d = host().querySelector('#co-demo-done');
    assert.ok(d, 'resumen co-demo-done present');
    d.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  return {
    api, writes, document, window, host, swipe, clickDone,
    assignOrder: () => boardRef.list.push({ orderId: 'real-1' }),
    plantProductionSlide: () => { document.getElementById('screen-onshift').innerHTML =
      '<div class="slide-confirm pickup" id="btn-pickup"><div class="slide-fill"></div><div class="slide-text">Recogí</div><div class="slide-hint">deslizá</div><div class="slide-thumb">x</div></div>'; },
  };
}

const zeroWrites = (w) => { const { raq, ...rest } = w; return rest; };
const ALL_ZERO = { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0 };

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; };

await t('(1) the whole demo runs with ZERO writes, reaches the resumen and records practiceDone', async () => {
  const h = boot();
  h.api.start();                                           // step 0: the offer
  assert.equal(h.api.getStep(), 'practice', 'still in practice while the demo runs');
  assert.ok(h.host().querySelector('#cd-btn-accept'), 'the offer rendered with a NAMESPACED slide');
  assert.equal(h.host().querySelector('#btn-accept'), null, 'NO production id survives in the demo host (isolation by construction)');
  await h.swipe('cd-btn-accept');
  assert.equal(h.api.getDemo().step, 1, 'a real swipe advanced to recoger');
  await h.swipe('cd-btn-pickup');
  assert.equal(h.api.getDemo().step, 2, 'advanced to entregar');
  await h.swipe('cd-btn-delivered');
  assert.equal(h.api.getDemo().step, 3, 'advanced to the resumen');
  h.clickDone();
  assert.equal(h.api.getStep(), 'checklist', 'the demo returned to the checklist');
  assert.equal(h.api.getDemo(), null, 'the controller is disposed at the end');
  assert.equal(h.api.store().A.practiceDone, true, 'practiceDone recorded in the PROGRESS store (never a real order)');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'ZERO writes across the whole demo');
  assert.equal(h.writes.raq, 0, 'the demo never reaches production renderActiveAndQueue');
});

await t('(2) a demo swipe cannot reach a REAL production handler bound to a production id (P1 closed)', async () => {
  const h = boot();
  h.api.start();
  await h.swipe('cd-btn-accept');                          // → step 1, cd-btn-pickup present
  // Operational handlers PRESENT: a production slide node left in #screen-onshift, bound via the REAL attachSlideConfirm
  // to a real write. This is the exact P1 geometry (a live board underneath the demo).
  h.plantProductionSlide();
  h.api.attachSlideConfirm('btn-pickup', () => { h.writes.pickupComplete += 1; });
  assert.ok(h.document.getElementById('btn-pickup'), 'the production btn-pickup exists in the document');
  assert.equal(h.host().querySelector('#btn-pickup'), null, 'the demo host carries NO production id');
  await h.swipe('cd-btn-pickup');                          // swipe the DEMO node
  assert.equal(h.api.getDemo().step, 2, 'the demo advanced on its own node');
  assert.equal(h.writes.pickupComplete, 0, 'the REAL pickupComplete was NEVER reached by a demo swipe');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'still zero real writes');
});

await t('(3) alive() disposes the demo when an order is assigned / a shift goes active / auth changes mid-demo', async () => {
  for (const trip of ['assign', 'shift', 'auth']) {
    const h = boot();
    h.api.start();                                         // step 0, cd-btn-accept present
    if (trip === 'assign') h.assignOrder();
    else if (trip === 'shift') h.api.setActive(true);
    else h.api.bumpAuth();
    await h.swipe('cd-btn-accept');                        // onConfirm gates on alive() → false → no advance, dispose
    assert.equal(h.api.getDemo(), null, `the demo is disposed on: ${trip}`);
    assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, `zero writes after disposal on: ${trip}`);
  }
});

await t('(4) the demo refuses to START while a shift is active or an order is assigned (nothing painted)', async () => {
  const hA = boot();
  hA.api.setActive(true);
  hA.api.start();
  assert.equal(hA.api.getDemo(), null, 'no demo while a shift is active');
  assert.equal(hA.host().innerHTML, '', 'nothing painted');
  assert.deepEqual(zeroWrites(hA.writes), ALL_ZERO, 'zero writes');
  const hB = boot();
  hB.assignOrder();
  hB.api.start();
  assert.equal(hB.api.getDemo(), null, 'no demo while an order is assigned');
  assert.equal(hB.host().innerHTML, '', 'nothing painted');
});

console.log(`✓ practica-demo: ${passed} isolation + zero-write tests passed`);
