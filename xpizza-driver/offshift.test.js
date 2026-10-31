// offshift.test.js — the offshift (disponible OFF) screen rebuilt to prototype S.offshift (renderOffshift). Lifts the
// REAL renderOffshift + attachSlideConfirm into a jsdom #screen-offshift and asserts: the prototype structure (greeting
// in NATURAL case, status chip, «Efectivo a entregar» stat, NO «Ganado hoy» while PAGOS_LIVE is false, NO «Recibís
// pedidos de», an «Iniciar turno» slide); that sliding it reaches the REAL handleStartShift on the SAME path as the
// duty-toggle (shiftBusy guard → optimistic on-shift → handleStartShift); and that a double-trigger cannot start two
// shifts (shiftBusy). Run: `node offshift.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { shiftDeliveries } from './cash-helpers.js';   // REAL resolved-deliveries source for the «Ganado hoy» earnings

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
function liftConst(name) {
  const hits = [...SCRIPT.matchAll(new RegExp(`const ${name} = `, 'g'))];
  assert.equal(hits.length, 1, `const ${name} once (found ${hits.length})`);
  const start = hits[0].index; return SCRIPT.slice(start, SCRIPT.indexOf(';', start) + 1);
}

function boot({ pagosLive = false, startImpl, suspended = false, dispatch = '+504 9999 8888', allOrders = {}, rateEntries = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-offshift" class="with-header hidden"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const calls = { start: 0, render: 0, openCuenta: 0, sync: 0, notif: 0 };
  const $ = (id) => document.getElementById(id);
  const computeShiftCash = () => ({ cashOwed: 1430, deliveries: 7 });
  const ICONS = new Proxy({}, { get: () => '<svg></svg>' });
  const fbRef = () => ({});
  const fbOnValue = (ref, cb) => { cb({ val: () => dispatch }); return () => {}; };   // one-shot: deliver the dispatch number
  // XPD.startShift IS the server clock-in SDK boundary the REAL handleStartShift drives (P2.5): count it, and let a
  // test substitute the impl to hang or reject. Removing the real `await XPD.startShift(...)` → this count stays 0 → RED.
  const XPD = { getDb: () => ({}), getAuthInstance: () => ({ app: {} }),
    startShift: () => { calls.start++; return startImpl ? startImpl() : Promise.resolve(); } };
  const body =
    'let shiftBusy = false;\nlet optimisticShift = null;\n' +
    'let companionSuspended = _suspended;\n' +
    'let driverState = _driverState;\nlet currentUser = _currentUser;\n' +
    'let slidingEl = null, renderPending = false; function renderActiveAndQueue(){}\n' +
    (pagosLive ? 'const PAGOS_LIVE = true;\n' : liftConst('PAGOS_LIVE') + '\n') +
    'function render(){ _calls.render++; }\n' +
    'function openCuenta(){ _calls.openCuenta++; }\n' +
    // P2.5: DON'T stub handleStartShift — lift the REAL one so the slide/keyboard path runs down to the mocked
    // XPD.startShift SDK boundary. These are its remaining (non-SDK) dependencies, stubbed inert (non-native path).
    'let shiftSessionGen = 0;\n' +
    'function isNative(){ return false; }\n' +
    'async function startNativeTracking(){ return { trackingOk: true }; }\n' +
    'async function acquireWakeLock(){}\n' +
    'function startGpsStream(){}\n' +
    'function ensureOfflineBanner(){}\n' +
    liftFn('handleStartShift') + '\n' +
    'function drv2ClearReturnTarget(){ _calls.clearReturn = (_calls.clearReturn||0)+1; }\n' +   // renderOffshift drops the returning nav target on off-shift/shift-end
    'function companionSyncSuspendedNotice(){ _calls.sync++; }\n' +
    'function updateNotifBanners(){ _calls.notif++; }\n' +
    'function todayMidnightMs(){ return 0; }\n' +
    'const driverIdentityCutoverMs = null;\n' +
    'let driverRateEntries = ' + JSON.stringify(rateEntries) + ';\n' +   // platform rate (seeded per cell)
    liftFn('rateCentsInEffect') + '\n' +
    liftFn('shiftEarningsCents') + '\n' +
    liftFn('attachSlideConfirm') + '\n' +
    liftFn('driverRow') + '\n' +
    liftFn('renderOffshift') + '\n' +
    'return { renderOffshift, getShiftBusy: () => shiftBusy, getOptimistic: () => optimisticShift };';
  const names = ['document', '$', 'computeShiftCash', 'allOrders', 'SYSTEM_VERSION', 'toast', 'ICONS', 'fbOnValue', 'fbRef', 'XPD', '_suspended', '_driverState', '_currentUser', '_calls', '_startImpl', 'shiftDeliveries'];
  const api = (new Function(...names, body))(
    document, $, computeShiftCash, allOrders, '2.5.3', () => {}, ICONS, fbOnValue, fbRef, XPD, suspended,
    { name: 'Marvin Posadas', active: false }, { uid: 'drv', email: 'marvin@x.pizza' }, calls, startImpl, shiftDeliveries);
  const host = () => document.getElementById('screen-offshift');
  async function slide(id = 'btn-start-shift') {
    const el = host().querySelector('#' + id);
    assert.ok(el, `slide #${id} present`);
    const thumb = el.querySelector('.slide-thumb');
    el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
    thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
    thumb.dispatchEvent(new window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
    document.dispatchEvent(new window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  }
  return { api, document, window, calls, host, slide };
}

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; };

await t('structure: greeting (natural case), status chip, «Efectivo a entregar» stat, NO «Ganado hoy» / «Recibís pedidos de», «Iniciar turno» slide', async () => {
  const h = boot();
  h.api.renderOffshift();
  const html = h.host().innerHTML;
  assert.equal(h.host().querySelector('#off-driver-name').textContent, 'Marvin', 'FIRST name only, natural case (not «Marvin Posadas», not uppercased)');
  assert.ok(/Fuera de turno/.test(html) && /GPS listo/.test(html), 'status chip + GPS');
  assert.ok(/Efectivo a entregar/.test(html) && /L 1,430/.test(html), '«Efectivo a entregar» = cashOwed');
  assert.ok(!/Ganado hoy/.test(html), '«Ganado hoy» hidden while PAGOS_LIVE is false (R2)');
  assert.ok(!/Recib[ií]s pedidos de/.test(html), '«Recibís pedidos de» OMITTED (no data source)');
  assert.ok(h.host().querySelector('.off2-stats.one') && !h.host().querySelector('.off2-stats.two'), 'single-stat layout');
  assert.ok(h.host().querySelector('.off2-cuenta'), 'Cuenta circle button (.off2-cuenta) present');
  assert.ok(!/version-tag/.test(html) && !/v2\.5\.3/.test(html), 'version line OMITTED (not in the prototype offshift frame)');
  assert.ok(h.host().querySelector('#btn-start-shift .slide-thumb'), '«Iniciar turno» slide present');
  assert.ok(h.host().querySelector('#duty-toggle-off.hidden'), 'the duty-toggle is kept (hidden) for the frozen references');
  assert.ok(h.calls.clearReturn >= 1, 'renderOffshift clears the returning nav target (off-shift / shift-end — advisor clear hook)');
});

// seed REAL resolved deliveries for this driver (uid 'drv'): orders delivered today (delivered_at ≥ 0) with the
// money-grade stamp — shiftDeliveries().resolved then drives shiftEarningsCents per delivery.
const ordersFor = (times) => { const m = {}; times.forEach((at, i) => { m['o' + i] = { delivered_at: at, delivered_by_driver_uid: 'drv' }; }); return m; };

await t('PAGOS_LIVE → «Ganado hoy» = the SUM of each delivery\'s platform rate (seeded orders + one rate entry)', () => {
  const h = boot({ pagosLive: true, allOrders: ordersFor([100, 200, 300, 400, 500, 600, 700]), rateEntries: { r1: { cents: 7000, effective_from: 0 } } });
  h.api.renderOffshift();
  const html = h.host().innerHTML;
  assert.ok(/Ganado hoy/.test(html) && /L 490/.test(html), '7 deliveries × 7000¢ = L 490 (N × cents/100, no hardcoded 70)');
  assert.ok(h.host().querySelector('.off2-stats.two'), 'two-stat layout');
});

await t('PAGOS_LIVE → a mid-day rate change applies PER DELIVERY (two entries; never retro-applied)', () => {
  // 2 deliveries at 7000¢ (before the change) + 2 at 9000¢ (after effective_from 1000)
  const h = boot({ pagosLive: true, allOrders: ordersFor([100, 100, 5000, 5000]), rateEntries: { a: { cents: 7000, effective_from: 0 }, b: { cents: 9000, effective_from: 1000 } } });
  h.api.renderOffshift();
  assert.ok(/Ganado hoy/.test(h.host().innerHTML) && /L 320/.test(h.host().innerHTML), '2×7000 + 2×9000 = 32000¢ = L 320 (not 4×70, not 4×90)');
});

await t('PAGOS_LIVE but NO rate entry → «Ganado hoy» renders NOTHING (never an invented number)', () => {
  const h = boot({ pagosLive: true, allOrders: ordersFor([100, 200]), rateEntries: null });
  h.api.renderOffshift();
  assert.ok(!/Ganado hoy/.test(h.host().innerHTML), 'no rate seeded → no «Ganado hoy» stat');
});

await t('the «Iniciar turno» slide drives the REAL handleStartShift down to the XPD.startShift clock-in (P2.5)', async () => {
  const h = boot();
  h.api.renderOffshift();
  await h.slide();
  assert.equal(h.calls.start, 1, 'the REAL handleStartShift reached the XPD.startShift SDK boundary once (removing the real clock-in → 0 → RED)');
  assert.equal(h.api.getOptimistic(), true, 'optimistic on-shift set');
  assert.ok(h.calls.render >= 1, 'render() driven (optimistic screen)');
});

await t('a double-trigger cannot start two shifts (shiftBusy)', async () => {
  let release;
  const h = boot({ startImpl: () => new Promise((r) => { release = r; }) });   // handleStartShift hangs
  h.api.renderOffshift();
  await h.slide();                       // #1 → shiftBusy true, handleStartShift pending
  assert.equal(h.calls.start, 1, 'first start in flight');
  h.api.renderOffshift();                // a fresh (not-confirmed) slide
  await h.slide();                       // #2 → shiftBusy still true → bails
  assert.equal(h.calls.start, 1, 'the second trigger did NOT start a second shift (shiftBusy)');
  release && release();
});

await t('mixed keyboard+pointer cannot double clock-in: Enter starts the shift, a HELD drag release then bails on the effective-on-shift guard — ONE clock-in (Codex r2 P2)', async () => {
  const h = boot();
  h.api.renderOffshift();
  const el = h.host().querySelector('#btn-start-shift');
  const thumb = el.querySelector('.slide-thumb');
  el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
  thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
  // 1) a pointer drag is HELD past threshold (mousedown + move, NO release yet)
  thumb.dispatchEvent(new h.window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
  // 2) Enter clocks in to completion: XPD.startShift resolves, shiftBusy clears, optimisticShift=true
  el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.start, 1, 'the keyboard start clocked in once');
  assert.equal(h.api.getShiftBusy(), false, 'shiftBusy already cleared — ONLY the effective-on-shift guard stands between here and a double-start');
  assert.equal(h.api.getOptimistic(), true, 'optimistic on-shift held (the guard reads this)');
  // 3) release the held drag → onUp → onConfirm → doStartShift again. Guarding on driverState.active ALONE would
  // let this through (feed hasn't reported active yet); the optimisticShift ?? active guard must bail.
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.start, 1, 'the drag release did NOT mint a second shift — exactly one clock-in (drop the optimisticShift guard → 2 → RED)');
});

await t('suspendida: warn banner + the two dispatch contact rows (tel/wa), NO «Iniciar turno» (prototype S.suspendida)', () => {
  const h = boot({ suspended: true });
  h.api.renderOffshift();
  const html = h.host().innerHTML;
  assert.ok(/Despacho pausó tu cuenta/.test(html), 'suspend banner title');
  assert.ok(/Podés terminar lo que tenés en mano/.test(html) && /Hablá con despacho para saber el motivo/.test(html), 'prototype banner copy');
  assert.ok(h.host().querySelector('#off-driver-name').textContent === 'Marvin', 'same first-name header');
  assert.ok(!h.host().querySelector('#btn-start-shift'), 'NO «Iniciar turno» slide while suspended');
  const call = h.host().querySelector('#off2-susp-call'), wa = h.host().querySelector('#off2-susp-wa');
  assert.ok(call && /^tel:\+?5049999 ?8888|^tel:\+?50499998888/.test(call.getAttribute('href') || ''), 'Llamar wired to tel:');
  assert.ok(wa && /wa\.me\/50499998888/.test(wa.getAttribute('href') || ''), 'WhatsApp wired to wa.me');
  assert.ok(!h.host().querySelector('#off2-susp-card').classList.contains('hidden'), 'contact card shown (valid number)');
  // prototype component structure (verbatim .banner / .row)
  assert.ok(h.host().querySelector('.pr-banner.warn'), 'prototype .banner.warn component');
  assert.ok(call.classList.contains('pr') && call.querySelector('.pr-ic') && call.querySelector('.pr-t') && call.querySelector('.pr-chev'), 'phone row = prototype .row: icon tile + bold .pr-t + chevron');
  assert.ok(wa.querySelector('.pr-ic.ok'), 'WhatsApp row has the green .ok icon tile');
});

await t('suspendida: an absent/invalid dispatch number hides the contact card (no dead affordance)', () => {
  const h = boot({ suspended: true, dispatch: null });
  h.api.renderOffshift();
  assert.ok(h.host().querySelector('#off2-susp-card').classList.contains('hidden'), 'contact card hidden when no number');
  assert.ok(/Despacho pausó tu cuenta/.test(h.host().innerHTML), 'the banner still shows');
});

await t('keyboard: Enter on the «Iniciar turno» slide reaches handleStartShift (the slide is a div — Codex P2.6)', async () => {
  const h = boot();
  h.api.renderOffshift();
  const el = h.host().querySelector('#btn-start-shift');
  assert.equal(el.tabIndex, 0, 'the slide is focusable (tabindex 0)');
  assert.equal(el.getAttribute('role'), 'button', 'the slide is a button for AT');
  el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.start, 1, 'Enter reaches handleStartShift through the guarded path');
});

await t('a stale release after the mount is detached does NOT start a shift (Codex P2 guard)', async () => {
  const h = boot();
  h.api.renderOffshift();
  const el = h.host().querySelector('#btn-start-shift');
  const thumb = el.querySelector('.slide-thumb');
  el.getBoundingClientRect = () => ({ width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64, x: 0, y: 0 });
  thumb.getBoundingClientRect = () => ({ width: 48, height: 48, left: 0, top: 0, right: 48, bottom: 48, x: 0, y: 0 });
  thumb.dispatchEvent(new h.window.MouseEvent('mousedown', { clientX: 0, bubbles: true, cancelable: true }));
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { clientX: 400, bubbles: true, cancelable: true }));
  el.remove();                                       // the mount is replaced mid-drag (offshift → suspendida)
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { clientX: 400, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(h.calls.start, 0, 'a detached/obsolete slide must not reach handleStartShift');
});

console.log(`✓ offshift: ${passed} tests passed`);
