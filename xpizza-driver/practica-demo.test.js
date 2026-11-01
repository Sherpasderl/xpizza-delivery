// practica-demo.test.js — the Inicio (c) practica demo is CLIENT-ONLY (ZERO RTDB writes, O5) AND fully ISOLATED from
// the real order machinery (Codex r1 P1 + r2 P2s). Mounted in a REAL jsdom document (runScripts:'dangerously' so an
// injected inline handler would execute — the inline-write mutant dies) with the operational handlers PRESENT (the
// production slide binder attachSlideConfirm + a planted production slide node), driven with REAL pointer gestures and
// the REAL teardown callback. Invariants:
//   1. Whole demo runs with ZERO writes, reaches the resumen, and the resumen's OWN «Listo» (cd-btn-resumen-done)
//      completes it + records practiceDone in the PROGRESS store.
//   2. ISOLATION: every demo node is NAMESPACED (cd-*); binding the REAL attachSlideConfirm to a planted production
//      `btn-pickup` and swiping the DEMO's `cd-btn-pickup` advances the demo and NEVER fires the real callback.
//   3. alive() teardown: order assigned / shift active / auth change mid-demo disposes the controller → no-op swipe.
//   4. START guard: refuses while a shift is active or an order is assigned.
//   5. Demo-local «Calcular vuelto» (P2-1): the scoped [data-vuelto-open] handler opens the calculator with the demo
//      order's numbers; the production delegate never fires here; zero writes.
//   6. Identity-bound callbacks (P2-2): a late pointer release from an earlier/disposed controller never advances a
//      later one; the REAL companionDemoTeardown removes in-flight document gesture listeners.
// Un-namespaced mutant dies on (2); inline-write mutant dies on (1). Run: `node practica-demo.test.js`
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
// Resolve jsdom from the functions package (same shim as llegue/slice2-branch/etc.) so this runs
// without NODE_PATH in a worktree that has no local node_modules.
const { JSDOM } = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'))('jsdom');
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

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ICONS = new Proxy({}, { get: () => '' });
const tick = () => new Promise((r) => setTimeout(r, 0));

function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-onshift"></div><div id="screen-companion"></div></body></html>',
    { pretendToBeVisual: true, runScripts: 'dangerously' });   // runScripts: an injected inline write-handler would execute
  const { document, window } = dom.window;
  const writes = { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0, raq: 0 };
  const dbSpy = { set: () => { writes.set++; }, update: () => { writes.update++; }, push: () => { writes.push++; }, transaction: () => { writes.transaction++; }, remove: () => { writes.remove++; } };
  const XPD = { RESTAURANT: { lat: 15.5074, lng: -88.0398 }, db: dbSpy,
    acceptTask: () => { writes.acceptTask++; }, pickupComplete: () => { writes.pickupComplete++; },
    completeTask: () => { writes.completeTask++; }, submitDriverProfile: () => { writes.submitDriverProfile++; } };
  const vuelto = { calls: 0, args: null };
  const openVuelto = (total, tendered) => { vuelto.calls++; vuelto.args = [total, tendered]; };   // spy for the shared calculator (pure display in prod)
  const boardRef = { list: [] };
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const $ = (id) => document.getElementById(id);

  const body =
    "let companionDemo = null;\n" +
    "let companionStep = 'practice';\n" +
    "let companionProgressMem = {}; const companionProgressKey = (uid) => `sherpa_driver_checklist_progress_${uid}`;\n" +
    "let authGen = 0;\n" +
    "let driverState = _driverState;\n" +
    "let currentUser = _currentUser;\n" +
    "let slidingEl = null, renderPending = false;\n" +
    "let companionDemoDocCleanup = null;\n" +
    "function renderActiveAndQueue(){ _writes.raq++; }\n" +
    liftFn('companionReadProgress') + "\n" +
    liftFn('companionWriteProgress') + "\n" +
    liftFn('companionDemoTeardown') + "\n" +
    liftFn('companionDemoAlive') + "\n" +
    liftFn('attachDemoSlide') + "\n" +
    liftFn('attachSlideConfirm') + "\n" +
    liftFn('companionPracticeStart') + "\n" +
    "return { start: companionPracticeStart, alive: companionDemoAlive, teardown: companionDemoTeardown, attachSlideConfirm,\n" +
    "  getStep: () => companionStep, getDemo: () => companionDemo, store: () => companionProgressMem,\n" +
    "  setActive: (v) => { driverState = v ? { active: true } : null; }, bumpAuth: () => { authGen++; }, setUser: (u) => { currentUser = u; } };";

  const names = ['document', '$', 'XPD', 'escapeHtml', 'ICONS', 'localStorage', 'computeVuelto', 'scheduledBadge',
    'singleOrderCardHtml', 'pickupReviewHtml', 'activeCardHtml', 'deliverySummaryHtml', 'practicaDemoOrder',
    'drv2LiveBoard', 'showScreen', 'companionRenderOnboarding', 'toast', 'openVuelto', '_driverState', '_currentUser', '_writes'];
  const api = (new Function(...names, body))(
    document, $, XPD, escapeHtml, ICONS, localStorage, computeVuelto, () => '',
    singleOrderCardHtml, pickupReviewHtml, activeCardHtml, deliverySummaryHtml, practicaDemoOrder,
    () => boardRef.list, () => {}, () => {}, () => {}, openVuelto, null, { uid: 'A' }, writes);

  const host = () => document.getElementById('screen-companion');
  const stub = (el) => {
    const thumb = el.querySelector('.slide-thumb');
    el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
    thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
    return thumb;
  };
  async function swipe(slideId) {
    const el = host().querySelector('#' + slideId);
    assert.ok(el, `demo slide #${slideId} present`);
    const thumb = stub(el);
    thumb.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true }));
    await tick();
  }
  function dragStart(slideId) {           // begin a drag to completion WITHOUT releasing (registers document listeners)
    const el = host().querySelector('#' + slideId);
    assert.ok(el, `demo slide #${slideId} present`);
    const thumb = stub(el);
    thumb.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
  }
  const release = async () => { document.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true })); await tick(); };
  return {
    api, writes, vuelto, document, window, host, swipe, dragStart, release,
    tapVuelto: () => { const pw = host().querySelector('[data-vuelto-open]'); assert.ok(pw, 'paywith [data-vuelto-open] present'); pw.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); return pw; },
    clickResumenDone: () => { const d = host().querySelector('#cd-btn-resumen-done'); assert.ok(d, 'resumen «Listo» (cd-btn-resumen-done) present'); d.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); },
    assignOrder: () => boardRef.list.push({ orderId: 'real-1' }),
    plantProductionSlide: () => { document.getElementById('screen-onshift').innerHTML =
      '<div class="slide-confirm pickup" id="btn-pickup"><div class="slide-fill"></div><div class="slide-text">Recogí</div><div class="slide-hint">deslizá</div><div class="slide-thumb">x</div></div>'; },
  };
}

const zeroWrites = (w) => { const { raq, ...rest } = w; return rest; };
const ALL_ZERO = { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0 };

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; };

await t('(1) the whole demo runs with ZERO writes; the resumen «Listo» completes it + records practiceDone', async () => {
  const h = boot();
  h.api.start();
  assert.ok(h.host().querySelector('#cd-btn-accept'), 'offer rendered, namespaced');
  assert.equal(h.host().querySelector('#btn-accept'), null, 'NO production id in the demo host');
  await h.swipe('cd-btn-accept');
  assert.equal(h.api.getDemo().step, 1, 'advanced to recoger');
  await h.swipe('cd-btn-pickup');
  assert.equal(h.api.getDemo().step, 2, 'advanced to entregar');
  await h.swipe('cd-btn-delivered');
  assert.equal(h.api.getDemo().step, 3, 'advanced to the resumen');
  assert.equal(h.host().querySelector('#co-demo-done'), null, 'no extra demo button — the resumen uses its own «Listo»');
  h.clickResumenDone();
  assert.equal(h.api.getStep(), 'checklist', 'returned to the checklist');
  assert.equal(h.api.getDemo(), null, 'controller disposed at the end');
  assert.equal(h.api.store().A.practiceDone, true, 'practiceDone recorded in the PROGRESS store');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'ZERO writes across the whole demo');
  assert.equal(h.writes.raq, 0, 'never reaches production renderActiveAndQueue');
});

await t('(2) a demo swipe cannot reach a REAL production handler bound to a production id (P1 closed)', async () => {
  const h = boot();
  h.api.start();
  await h.swipe('cd-btn-accept');                          // → pickup, cd-btn-pickup present
  h.plantProductionSlide();
  h.api.attachSlideConfirm('btn-pickup', () => { h.writes.pickupComplete += 1; });
  assert.ok(h.document.getElementById('btn-pickup'), 'production btn-pickup exists');
  assert.equal(h.host().querySelector('#btn-pickup'), null, 'demo host has NO production id');
  await h.swipe('cd-btn-pickup');
  assert.equal(h.api.getDemo().step, 2, 'demo advanced on its own node');
  assert.equal(h.writes.pickupComplete, 0, 'the REAL pickupComplete was NEVER reached by a demo swipe');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'still zero real writes');
});

await t('(3) alive() disposes the demo when an order is assigned / a shift goes active / auth changes mid-demo', async () => {
  for (const trip of ['assign', 'shift', 'auth']) {
    const h = boot();
    h.api.start();
    if (trip === 'assign') h.assignOrder();
    else if (trip === 'shift') h.api.setActive(true);
    else h.api.bumpAuth();
    await h.swipe('cd-btn-accept');
    assert.equal(h.api.getDemo(), null, `disposed on: ${trip}`);
    assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, `zero writes after disposal on: ${trip}`);
  }
});

await t('(4) the demo refuses to START while a shift is active or an order is assigned (nothing painted)', async () => {
  const hA = boot();
  hA.api.setActive(true); hA.api.start();
  assert.equal(hA.api.getDemo(), null, 'no demo while a shift is active');
  assert.equal(hA.host().innerHTML, '', 'nothing painted');
  const hB = boot();
  hB.assignOrder(); hB.api.start();
  assert.equal(hB.api.getDemo(), null, 'no demo while an order is assigned');
  assert.equal(hB.host().innerHTML, '', 'nothing painted');
});

await t('(5) «Calcular vuelto» opens the calculator with the demo order numbers; the production delegate never fires; zero writes', async () => {
  const h = boot();
  h.api.start();
  await h.swipe('cd-btn-accept'); await h.swipe('cd-btn-pickup');   // → delivery step (cash → paywith row)
  const pw = h.tapVuelto();
  assert.equal(h.vuelto.calls, 1, 'the demo-local vuelto handler fired');
  assert.equal(h.vuelto.args[0], Number(pw.getAttribute('data-total')) || 0, 'opened with the demo order total');
  assert.equal(h.vuelto.args[0], 350, 'the demo order total');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'opening the calculator wrote nothing');
});

await t('(6) a late pointer release from an earlier/disposed controller never advances a later demo (P2-2)', async () => {
  // identity guard: controller A has a drag in flight; B replaces it; A releases → B must not advance.
  const h = boot();
  h.api.start();                       // controller A, step 0
  const A = h.api.getDemo();
  h.dragStart('cd-btn-accept');        // A begins a drag to completion (document listeners registered, not released)
  h.api.start();                       // controller B overwrites companionDemo (A's listeners still live, NO teardown)
  const B = h.api.getDemo();
  assert.notEqual(A, B, 'a new controller instance');
  assert.ok(h.host().querySelector('#cd-btn-accept'), 'B painted its step 0');
  await h.release();                   // A's onUp fires → the slide callback's identity check (companionDemo !== A) must bail
  // The discriminator is the SCREEN, not B.step: without the identity guard A advances ITSELF (self.step) and
  // A.render() repaints A's step-1 (pickup) OVER B's screen. With the guard A bails → the host still shows B's step 0.
  assert.equal(h.api.getDemo(), B, 'companionDemo is still B');
  assert.equal(h.api.getDemo().step, 0, 'B was NOT advanced');
  assert.ok(h.host().querySelector('#cd-btn-accept'), 'the screen still shows B at step 0');
  assert.equal(h.host().querySelector('#cd-btn-pickup'), null, 'A\'s late release did NOT advance+repaint over B (slide-callback identity guard held)');
  assert.deepEqual(zeroWrites(h.writes), ALL_ZERO, 'zero writes');

  // teardown removes in-flight document listeners (real companionDemoTeardown = the logout/auth-transition callback).
  const h2 = boot();
  h2.api.start();
  h2.dragStart('cd-btn-accept');
  h2.api.teardown();                   // the REAL teardown the auth reset calls
  assert.equal(h2.api.getDemo(), null, 'teardown disposed the controller');
  await h2.release();                  // listeners were removed → no-op
  assert.equal(h2.api.getDemo(), null, 'still disposed; nothing resurrected');
  assert.deepEqual(zeroWrites(h2.writes), ALL_ZERO, 'zero writes after teardown + late release');
  h2.api.start();                      // a fresh demo still works after teardown
  assert.ok(h2.host().querySelector('#cd-btn-accept'), 'a new demo starts cleanly after teardown');
});

console.log(`✓ practica-demo: ${passed} isolation + zero-write + P2 tests passed`);
