// Cuadre SLIDE-to-confirm money submit — HANDLER test. run: `node cuadre-submit.test.js` (invoked from
// xpizza-functions in the npm chain). EXECUTES the REAL shipped index.html code — the CUADRE-RENDER + CUADRE-SUBMIT
// regions, showCierreRechazado, and the FROZEN attachSlideConfirm — lifted via new Function (the endshift-confirm.test.js
// idiom), rendered into a REAL jsdom DOM and driven by REAL pointer/keyboard events. computeShiftCash + recordCuadre
// are the only externals stubbed (controllable). Proves the money contract of the slide conversion (prototype S.cuadre):
//   - the overlay starts OPEN; a REAL slide drag submits EXACTLY ONE recordCuadre with the EXACT payload; ack ⇒ finalize + close;
//   - a 2nd drag while a close is in flight → still ONE recordCuadre (closeInFlight double-submit guard);
//   - keyboard Enter confirms through the SAME gates (one submission path);
//   - a server REJECTION shows cierreRechazado (no finalize) and renders the AMOUNT THIS ATTEMPT SUBMITTED, never a refreshed one;
//   - the hdr/foot BUTTONS never submit;
//   - a release from a STALE slide (replaced by a cash refresh mid-drag) is a NO-OP (generation guard).
// Mutants these kill (run with the index.html edit, must go RED): cashOwed:0; attachSlideConfirm call removed; the
// success overlay-close removed; the rejection closeInFlight latch removed; the stale-slide generation guard removed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { cierreRechazadoHtml } from './stacked-view.js';

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
function regionBody(name) {   // the source BETWEEN a SLICE3 region's START/END markers (consts + fns + eval-time wiring)
  const s = SCRIPT.indexOf(`SLICE3:${name}:START`);
  assert.notEqual(s, -1, `region ${name} not found`);
  const bodyStart = SCRIPT.indexOf('\n', s) + 1;
  const end = SCRIPT.indexOf(`SLICE3:${name}:END`, bodyStart);
  return SCRIPT.slice(bodyStart, SCRIPT.lastIndexOf('/*', end));
}
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
const tick = () => new Promise((r) => setTimeout(r, 0));

function build() {
  const dom = new JSDOM('<!doctype html><html><body><div id="cuadre-screen"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);

  const calls = { recordCuadre: 0, finalize: 0, lastPayload: null, toasts: [] };
  let pendingRecord = null;
  let CASH = { deliveries: 6, totalCollected: 1430, paidOnlineTotal: 260, cashOrderCount: 5, cashOwed: 1430, provisional: false, legacy_provisional_count: 0, unresolved_count: 0 };
  const XPD = { recordCuadre: (uid, shiftId, payload) => { calls.recordCuadre++; calls.lastPayload = payload; pendingRecord = deferred(); return pendingRecord.promise; } };

  const ICONS = { check: '', store: '', wallet: '' };
  const escapeHtml = (s) => String(s == null ? '' : s);
  const deps = {
    document, window, $, ICONS, escapeHtml, cierreRechazadoHtml,
    toast: (m) => calls.toasts.push(m),
    shiftIdentity: () => ({ valid: true, shiftId: 's1', start: Date.now() - 60000 }),
    identityMatches: () => true,
    currentUser: { uid: 'drv' },
    allOrders: {}, driverIdentityCutoverMs: null,
    computeShiftCash: () => CASH,
    makeOpId: () => 'op_test',
    XPD,
    finalizeEndShift: async () => { calls.finalize++; },
    render: () => {},
    BLOCKED_CLOSE_TEXT: 'No se pudo registrar el cierre.',
    COMPLETION_SETTLE_TIMEOUT_MS: 100000,
  };

  const body = 'let closeGen = 0; let closeInFlight = false; let shiftBusy = false; let optimisticShift = null;\n'
    + 'let feedReady = true; let cutoverLoaded = true; let driverState = {}; let driverFeed = null;\n'
    + 'let slidingEl = null; let renderPending = false; function renderActiveAndQueue() {}\n'   // stacked-view globals attachSlideConfirm touches
    + 'const pendingCompletions = new Set();\n'
    + 'function refreshOpenCashSurfaces() { if (closeInFlight) return; if ($("cuadre-screen").classList.contains("open")) showCuadre(); }\n'
    + regionBody('CUADRE-RENDER') + '\n'
    + liftFn('attachSlideConfirm') + '\n'
    + liftFn('showCierreRechazado') + '\n'
    + regionBody('CUADRE-SUBMIT') + '\n'
    + 'return { showCuadre, onCuadreConfirm, showCierreRechazado, refreshOpenCashSurfaces, setInFlight: (v) => { closeInFlight = v; }, getGen: () => closeGen, getInFlight: () => closeInFlight };';
  const names = Object.keys(deps);
  const fn = new Function(...names, 'let CUADRE_ACK_TIMEOUT_MS = 100000;\n' + body);
  const api = fn(...names.map((n) => deps[n]));
  return {
    api, calls, document, window, $, screen: $('cuadre-screen'),
    setCash: (c) => { CASH = c; },
    resolveRecord: (v) => pendingRecord.resolve(v),
    rejectRecord: (e) => pendingRecord.reject(e),
  };
}

// Drive the REAL attachSlideConfirm to completion with REAL pointer events. jsdom has no layout, so we feed the
// element/thumb geometry the handler reads (getBoundingClientRect) — everything else (listeners, completion math,
// onConfirm) is the shipped code.
function slideToComplete(h) {
  const slide = h.$('cuadre-confirm');
  const thumb = slide.querySelector('.slide-thumb');
  slide.getBoundingClientRect = () => ({ width: 300, height: 60, left: 0, top: 0, right: 300, bottom: 60, x: 0, y: 0 });
  thumb.getBoundingClientRect = () => ({ width: 50, height: 50, left: 6, top: 6, right: 56, bottom: 56, x: 6, y: 6 });
  const ME = h.window.MouseEvent;
  thumb.dispatchEvent(new ME('mousedown', { clientX: 6, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new ME('mousemove', { clientX: 320, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new ME('mouseup', { bubbles: true }));
}

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('  ok -', name); }

await t('overlay starts OPEN; a REAL slide drag submits ONE recordCuadre with the EXACT payload; ack ⇒ finalize + close', async () => {
  const h = build();
  h.api.showCuadre();
  assert.ok(h.screen.classList.contains('open'), 'overlay OPEN after showCuadre');
  assert.ok(h.$('cuadre-confirm'), 'the confirm slide is mounted');
  slideToComplete(h);
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'exactly one recordCuadre');
  assert.deepEqual(h.calls.lastPayload, { deliveries: 6, totalCollected: 1430, paidOnlineTotal: 260, cashOrderCount: 5, cashOwed: 1430, provisional: false, legacy_provisional_count: 0, unresolved_count: 0, close_op_id: 'op_test' }, 'exact recordCuadre payload (incl. cashOwed 1430)');
  h.resolveRecord(); await tick();
  assert.equal(h.calls.finalize, 1, 'finalized on ack');
  assert.ok(!h.screen.classList.contains('open'), 'overlay closed');
});

await t('a 2nd drag while a close is in flight → still ONE recordCuadre (closeInFlight guard)', async () => {
  const h = build();
  h.api.showCuadre();
  slideToComplete(h); await tick();
  assert.equal(h.calls.recordCuadre, 1, 'first drag submitted');
  slideToComplete(h); await tick();   // a fresh slide got mounted by the re-render; drag it again mid-flight
  assert.equal(h.calls.recordCuadre, 1, 'the second drag did NOT fire a second recordCuadre');
  h.resolveRecord();
});

await t('keyboard Enter confirms through the SAME gates (one submission path)', async () => {
  const h = build();
  h.api.showCuadre();
  const slide = h.$('cuadre-confirm');
  slide.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'Enter submits exactly once');
  h.resolveRecord();
});

await t('server REJECTION shows cierreRechazado (no finalize) with the ATTEMPT amount, not a refreshed one', async () => {
  const h = build();
  h.api.showCuadre();
  slideToComplete(h); await tick();           // submits cashOwed 1430
  h.setCash({ ...{ deliveries: 9, totalCollected: 2000, paidOnlineTotal: 260, cashOrderCount: 8, cashOwed: 2000, provisional: false, legacy_provisional_count: 0, unresolved_count: 0 } });
  h.rejectRecord(new Error('permission denied'));
  await tick();
  assert.equal(h.calls.finalize, 0, 'never clock out on rejection');
  const html = h.screen.innerHTML;
  assert.ok(/No se pudo cerrar el turno/.test(html), 'cierreRechazado shown');
  assert.ok(/1,430/.test(html) && !/2,000/.test(html), 'renders the SUBMITTED amount (1,430), not the refreshed 2,000');
});

await t('a STALE slide release (replaced by a cash refresh mid-drag) is a NO-OP (generation guard)', async () => {
  const h = build();
  h.api.showCuadre();
  const slide = h.$('cuadre-confirm');
  const thumb = slide.querySelector('.slide-thumb');
  slide.getBoundingClientRect = () => ({ width: 300, height: 60, left: 0, top: 0, right: 300, bottom: 60, x: 0, y: 0 });
  thumb.getBoundingClientRect = () => ({ width: 50, height: 50, left: 6, top: 6, right: 56, bottom: 56, x: 6, y: 6 });
  const ME = h.window.MouseEvent;
  thumb.dispatchEvent(new ME('mousedown', { clientX: 6, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new ME('mousemove', { clientX: 320, bubbles: true, cancelable: true }));
  h.api.showCuadre();                         // a cash refresh REPLACES the slide mid-drag → bumps the generation
  h.document.dispatchEvent(new ME('mouseup', { bubbles: true }));   // the STALE slide's release
  await tick();
  assert.equal(h.calls.recordCuadre, 0, 'the stale slide release submitted NOTHING');
});

await t('the hdr/foot BUTTONS never submit — «Volver al turno» closes + supersedes, «Reintentar cierre» re-opens', async () => {
  const h = build();
  h.api.showCuadre();
  const genBefore = h.api.getGen();
  const volver = h.document.createElement('button'); volver.className = 'rc-volver cuadre-volver'; h.screen.appendChild(volver);
  volver.click(); await tick();
  assert.equal(h.calls.recordCuadre, 0, 'back never submits');
  assert.ok(h.api.getGen() > genBefore && !h.screen.classList.contains('open'), 'superseded + closed');
  const h2 = build(); h2.api.showCuadre();
  const retry = h2.document.createElement('button'); retry.className = 'rc-retry cuadre-reintentar'; h2.screen.appendChild(retry);
  retry.click(); await tick();
  assert.equal(h2.calls.recordCuadre, 0, 'retry never submits directly');
  assert.ok(h2.screen.querySelector('#cuadre-confirm'), 'retry re-opened the normal receipt (slide present)');
});

await t('showCierreRechazado LATCHES the surface so an observer refresh cannot clobber the rejection screen', async () => {
  const h = build();
  h.api.showCuadre();
  h.api.setInFlight(false);                        // simulate the post-timeout state (closeInFlight was reset)
  h.api.showCierreRechazado({ cashOwed: 1430 });
  assert.equal(h.api.getInFlight(), true, 'the rejection screen re-latches closeInFlight');   // mutant: latch removed ⇒ false
  assert.ok(/No se pudo cerrar el turno/.test(h.screen.innerHTML), 'cierreRechazado is shown');
  h.api.refreshOpenCashSurfaces();                 // an order-feed observer fires
  assert.ok(/No se pudo cerrar el turno/.test(h.screen.innerHTML), 'the rejection screen SURVIVES the refresh (latch held)');
});

console.log(`✓ cuadre-submit: ${passed} checks passed`);
process.exit(passed === 7 ? 0 : 1);   // force-exit past the lifted handler's lingering ack-timeout timers
