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
import { execFileSync } from 'node:child_process';
import { cierreRechazadoHtml } from './stacked-view.js';
import { fmtClockHM } from './time-format.js';   // CUADRE-RENDER's date line now uses the shared formatter

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

function build(opts = {}) {
  const ackTimeout = opts.ackTimeout != null ? opts.ackTimeout : 100000;
  const dom = new JSDOM('<!doctype html><html><body><div id="cuadre-screen"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);

  const calls = { recordCuadre: 0, finalize: 0, lastPayload: null, toasts: [] };
  let pendingRecord = null;
  let pendingFinalize = null;
  let CASH = { deliveries: 6, totalCollected: 1430, paidOnlineTotal: 260, cashOrderCount: 5, cashOwed: 1430, provisional: false, legacy_provisional_count: 0, unresolved_count: 0 };
  const XPD = { recordCuadre: (uid, shiftId, payload) => { calls.recordCuadre++; calls.lastPayload = payload; pendingRecord = deferred(); return pendingRecord.promise; } };

  const ICONS = { check: '', store: '', wallet: '' };
  const escapeHtml = (s) => String(s == null ? '' : s);
  const deps = {
    document, window, $, ICONS, escapeHtml, cierreRechazadoHtml, fmtClockHM,
    toast: (m) => calls.toasts.push(m),
    shiftIdentity: () => ({ valid: true, shiftId: 's1', start: Date.now() - 60000 }),
    identityMatches: () => true,
    currentUser: { uid: 'drv' },
    allOrders: {}, driverIdentityCutoverMs: null,
    computeShiftCash: () => CASH,
    makeOpId: () => 'op_test',
    XPD,
    finalizeEndShift: async () => { calls.finalize++; if (opts.deferFinalize) { pendingFinalize = deferred(); return pendingFinalize.promise; } return opts.finalizeOk !== false; },   // success by default; opts.finalizeOk:false = failed close; opts.deferFinalize = controllable (resolveFinalize)
    showCerrado: (cash, start, closedAt) => { calls.cerrado = (calls.cerrado || 0) + 1; calls.cerradoArgs = { cash, start, closedAt }; },
    render: () => {},
    BLOCKED_CLOSE_TEXT: 'No se pudo registrar el cierre.',
    COMPLETION_SETTLE_TIMEOUT_MS: 100000,
  };

  const body = 'let closeGen = 0; let closeInFlight = false; let shiftBusy = false; let optimisticShift = null; let authGen = 0;\n'
    + 'let feedReady = true; let cutoverLoaded = true; let driverState = {}; let driverFeed = null;\n'
    + 'let slidingEl = null; let renderPending = false; function renderActiveAndQueue() {}\n'   // stacked-view globals attachSlideConfirm touches
    + 'const pendingCompletions = new Set();\n'
    + 'const PAGOS_LIVE = false;\n'   // O6: CUADRE-RENDER now reads the single Pagos flag (CUADRE_SHOW_EARNINGS = PAGOS_LIVE)
    + 'function refreshOpenCashSurfaces() { if (closeInFlight) return; if ($("cuadre-screen").classList.contains("open")) showCuadre(); }\n'
    + regionBody('CUADRE-RENDER') + '\n'
    + liftFn('attachSlideConfirm') + '\n'
    + liftFn('showCierreRechazado') + '\n'
    + regionBody('CUADRE-SUBMIT') + '\n'
    + 'return { showCuadre, onCuadreConfirm, showCierreRechazado, refreshOpenCashSurfaces, setInFlight: (v) => { closeInFlight = v; }, getGen: () => closeGen, getInFlight: () => closeInFlight, bumpAuth: () => { authGen++; } };';
  const names = Object.keys(deps);
  const fn = new Function(...names, 'let CUADRE_ACK_TIMEOUT_MS = ' + ackTimeout + ';\n' + body);
  const api = fn(...names.map((n) => deps[n]));
  return {
    api, calls, document, window, $, screen: $('cuadre-screen'),
    setCash: (c) => { CASH = c; },
    resolveRecord: (v) => pendingRecord.resolve(v),
    rejectRecord: (e) => pendingRecord.reject(e),
    resolveFinalize: (v) => pendingFinalize.resolve(v),
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

await t('LATE rejection after a REAL ack-timeout+refresh shows the ATTEMPT amount (1,430), not the refreshed screen._cash (2,000)', async () => {
  const h = build({ ackTimeout: 10 });
  h.api.showCuadre();
  slideToComplete(h); await tick();                 // submits cashOwed 1,430; screen._cash = 1,430
  h.setCash({ deliveries: 9, totalCollected: 2000, paidOnlineTotal: 260, cashOrderCount: 8, cashOwed: 2000, provisional: false, legacy_provisional_count: 0, unresolved_count: 0 });
  await new Promise((r) => setTimeout(r, 40));       // the REAL 10ms ack-timeout fires → closeInFlight=false → refreshOpenCashSurfaces re-renders screen._cash = 2,000
  assert.ok(/2,000/.test(h.screen.innerHTML), 'after the timeout refresh the NORMAL receipt now shows 2,000 (screen._cash moved)');
  h.rejectRecord(new Error('permission denied'));    // the LATE rejection of the original attempt
  await tick();
  const html = h.screen.innerHTML;
  assert.ok(/No se pudo cerrar el turno/.test(html), 'cierreRechazado shown on the late rejection');
  assert.ok(/1,430/.test(html) && !/2,000/.test(html), 'renders the SUBMITTED amount (1,430), NOT the refreshed 2,000 — kills showCierreRechazado() w/o the attempt cash');
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

// ───────── cerrado wiring (money): cerrado shows ONLY on a clean clock-out, with the SUBMITTED cuadre figures ─────────
await t('a successful clock-out shows cerrado ONCE, with the submitted cuadre cash + count (not before the ack)', async () => {
  const h = build();                       // finalizeOk defaults to true (clean clock-out)
  h.api.showCuadre();
  slideToComplete(h);
  await tick();
  assert.equal(h.calls.recordCuadre, 1, 'submitted');
  assert.ok(!h.calls.cerrado, 'cerrado is NOT shown before the server ack');
  h.resolveRecord({});                     // server acks the cuadre
  await tick(); await tick();
  assert.equal(h.calls.finalize, 1, 'clock-out ran');
  assert.equal(h.calls.cerrado, 1, 'cerrado shown exactly once, after finalize');
  assert.equal(h.calls.cerradoArgs.cash.cashOwed, 1430, 'cerrado cashOwed = the SUBMITTED cuadre value');
  assert.equal(h.calls.cerradoArgs.cash.deliveries, 6, 'cerrado deliveries = the SUBMITTED cuadre count');
  assert.equal(typeof h.calls.cerradoArgs.closedAt, 'number', 'a single captured closedAt instant is passed');
});

await t('a FAILED clock-out does NOT show cerrado (shown only on success)', async () => {
  const h = build({ finalizeOk: false });  // the clock-out reverts
  h.api.showCuadre();
  slideToComplete(h);
  await tick();
  h.resolveRecord({});
  await tick(); await tick();
  assert.equal(h.calls.finalize, 1, 'clock-out attempted');
  assert.ok(!h.calls.cerrado, 'cerrado is NOT shown when the clock-out failed');
});

await t('finalizeEndShift returns true + clock-out side effects on success, false + revert (byte-identical) on failure', async () => {
  function buildFin(fail) {
    const calls = { cleanup: 0, render: 0, toasts: [] };
    const deps = {
      isNative: () => false,
      currentUser: { uid: 'd' },
      XPD: { endShift: async () => { if (fail) throw new Error('clock-out failed'); return { ok: true }; }, getAuthInstance: () => ({ app: {} }) },
      stopNativeTracking: async () => ({ ok: true }),
      cleanupShift: async () => { calls.cleanup++; },
      toast: (m, k) => calls.toasts.push([m, k || '']),
      render: () => { calls.render++; },
    };
    const names = Object.keys(deps);
    const body = 'let optimisticShift = {};\n' + liftFn('finalizeEndShift') + '\nreturn { finalizeEndShift, getOptimistic: () => optimisticShift };';
    const api = new Function(...names, body)(...names.map((n) => deps[n]));
    return { api, calls };
  }
  const ok = buildFin(false);
  assert.equal(await ok.api.finalizeEndShift(), true, 'success → true');
  assert.equal(ok.calls.cleanup, 1, 'cleanupShift ran (success path unchanged)');
  assert.deepEqual(ok.calls.toasts, [['Turno terminado', '']], 'success toast unchanged');
  const bad = buildFin(true);
  assert.equal(await bad.api.finalizeEndShift(), false, 'failure → false');
  assert.equal(bad.calls.cleanup, 0, 'cleanupShift never reached on failure (ordering unchanged)');
  assert.equal(bad.api.getOptimistic(), null, 'the revert sets optimisticShift = null (unchanged)');
  assert.equal(bad.calls.render, 1, 'the revert re-renders (unchanged)');
  assert.deepEqual(bad.calls.toasts, [['Error al terminar turno', 'error']], 'error toast unchanged');
});

await t('an auth change WHILE the clock-out is pending drops cerrado (session-bound gate)', async () => {
  const h = build({ deferFinalize: true });
  h.api.showCuadre();
  slideToComplete(h);
  await tick();
  h.resolveRecord({});                 // server acks; p.then runs → awaits the (pending) clock-out
  await tick();
  h.api.bumpAuth();                    // a new session begins mid-clock-out
  h.resolveFinalize(true);            // the clock-out then succeeds
  await tick(); await tick();
  assert.equal(h.calls.finalize, 1, 'clock-out ran');
  assert.ok(!h.calls.cerrado, 'cerrado is NOT shown — the auth generation changed during finalize');
});

// REAL showCerrado (not stubbed): the modal + lifecycle + snapshot invariant Codex asked for.
await t('REAL showCerrado: modal (focus+Tab trap), «Listo» → render (not offshift), teardown dismisses, cash is a snapshot', async () => {
  const dom = new JSDOM('<!doctype html><html><body><button id="opener"></button></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const calls = { render: 0, showScreen: [] };
  const deps = { document, render: () => { calls.render++; }, showScreen: (s) => { calls.showScreen.push(s); } };
  const names = Object.keys(deps);
  const body = 'let authGen = 3; let drv2CerradoDismiss = null;\n'
    + liftFn('showCerrado') + '\n'
    + 'function teardown() { if (drv2CerradoDismiss) drv2CerradoDismiss(); }\n'
    + 'return { showCerrado, teardown, getDismiss: () => drv2CerradoDismiss };';
  const api = new Function(...names, body)(...names.map((n) => deps[n]));

  const snap = { cashOwed: 1430, deliveries: 6 };
  api.showCerrado(snap, 0, 116 * 60000);
  snap.cashOwed = 9999;                               // mutate the SOURCE after show — the summary must keep its snapshot
  const ov = document.getElementById('cerrado-screen');
  assert.ok(ov && ov.classList.contains('open'), 'overlay shown');
  assert.equal(ov.getAttribute('role'), 'dialog', 'modal: role=dialog');
  assert.equal(ov.getAttribute('aria-modal'), 'true', 'modal: aria-modal=true');
  assert.ok(/L 1,430/.test(ov.innerHTML) && !/9,999/.test(ov.innerHTML), 'shows the SUBMITTED snapshot (1,430), not the later-changed value');
  assert.ok(/6 entregas · 1 h 56 min/.test(ov.innerHTML), 'count + duration from the passed snapshot');
  const done = document.getElementById('cerrado-done');
  assert.equal(document.activeElement, done, 'initial focus on «Listo»');
  const ev = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, 'Tab is contained (preventDefault — background not keyboard-reachable)');
  assert.equal(document.activeElement, done, 'focus stays on «Listo»');
  done.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls.render, 1, '«Listo» routes through render()');
  assert.deepEqual(calls.showScreen, [], '«Listo» never forces showScreen(offshift)');
  assert.ok(!document.getElementById('cerrado-screen'), 'overlay removed on «Listo»');
  // teardown dismisses an OPEN summary (session change / sign-out)
  api.showCerrado(snap, 0, 116 * 60000);
  assert.ok(document.getElementById('cerrado-screen'), 're-shown');
  api.teardown();
  assert.ok(!document.getElementById('cerrado-screen'), 'teardown removes an open summary');
  assert.equal(api.getDismiss(), null, 'the dismiss hook is cleared after teardown');
});

await t('pay-rate reader = window.PayRate (carried byte-identical from platform/client/pay-rate.js, 2e 52ef3331) + byte-parity', () => {
  const _g = {}; new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(_g);   // load the classic pay-rate script (self.PayRate), exactly as the browser's PAYRATE-SCRIPT <script> does (the driver dir is type:module → it can't be require()d as CJS)
  const { rateCentsInEffect, shiftEarningsCents } = _g.PayRate;
  // rateCentsInEffect — the greatest effective_from ≤ t (versioned; never retro-apply)
  assert.equal(rateCentsInEffect(null, 100), null, 'no entries → null');
  assert.equal(rateCentsInEffect({}, 100), null, 'empty entries → null');
  const E = { a: { cents: 7000, effective_from: 0 }, b: { cents: 8000, effective_from: 1000 } };
  assert.equal(rateCentsInEffect(E, 500), 7000, 'before the 2nd entry → the 1st rate');
  assert.equal(rateCentsInEffect(E, 1000), 8000, 'at the 2nd effective_from → the new rate');
  assert.equal(rateCentsInEffect(E, 5000), 8000, 'after → the latest rate');
  assert.equal(rateCentsInEffect({ a: { cents: 7000, effective_from: 2000 } }, 1000), null, 'a delivery BEFORE the earliest entry → null (never retro-apply a later rate)');
  assert.equal(rateCentsInEffect({ a: { cents: 'x', effective_from: 0 } }, 100), null, 'malformed entry skipped');
  // shiftEarningsCents — over ORDER objects ({ delivered_at }); the shape renderOffshift passes (resolved.map(d=>d.order)).
  // sum of per-delivery rates; null when the rate is unknown or ANY delivery is uncovered.
  assert.equal(shiftEarningsCents([], null), null, 'rate unknown (no entries) → null');
  assert.equal(shiftEarningsCents([], E), 0, 'no deliveries + a known rate → 0');
  assert.equal(shiftEarningsCents([{ delivered_at: 500 }, { delivered_at: 1500 }], E), 7000 + 8000, 'each delivery at its OWN in-effect rate (a mid-period change is counted, not retro-applied)');
  assert.equal(shiftEarningsCents([{ delivered_at: 500 }, { delivered_at: -1 }], E), null, 'any uncovered delivery → null (never a partial/invented total)');
  assert.equal(shiftEarningsCents([{}], E), null, 'an order with no delivered_at → null');
  // ONE source: the driver copy is byte-identical to the canonical platform/client copy, and both ARE the 2e-reviewed
  // blob 52ef3331. EXPECTED_BLOB = `git rev-parse 52ef3331:xpizza-driver/pay-rate.js` (== platform/client's blob).
  const DRV = join(__dir, 'pay-rate.js'), CANON = join(__dir, '..', 'platform', 'client', 'pay-rate.js');
  assert.equal(Buffer.compare(readFileSync(DRV), readFileSync(CANON)), 0, 'xpizza-driver/pay-rate.js drifted from the canonical platform/client/pay-rate.js — re-carry/sync');
  const EXPECTED_BLOB = 'cce3755df6f3f65006b62cf118d2380e4fb34f0f';
  const gitHash = (p) => execFileSync('git', ['hash-object', p], { cwd: __dir }).toString().trim();
  assert.equal(gitHash(DRV), EXPECTED_BLOB, 'driver copy diverged from the 2e 52ef3331 reviewed blob');
  assert.equal(gitHash(CANON), EXPECTED_BLOB, 'platform/client copy diverged from the 2e 52ef3331 reviewed blob');
});

console.log(`✓ cuadre-submit: ${passed} checks passed`);
process.exit(passed === 14 ? 0 : 1);   // force-exit past the lifted handler's lingering ack-timeout timers
