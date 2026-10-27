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

function boot({ pagosLive = false, startImpl, suspended = false, dispatch = '+504 9999 8888' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-offshift" class="with-header hidden"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const calls = { start: 0, render: 0, openCuenta: 0, sync: 0, notif: 0 };
  const $ = (id) => document.getElementById(id);
  const computeShiftCash = () => ({ cashOwed: 1430, deliveries: 7 });
  const ICONS = new Proxy({}, { get: () => '<svg></svg>' });
  const fbRef = () => ({});
  const fbOnValue = (ref, cb) => { cb({ val: () => dispatch }); return () => {}; };   // one-shot: deliver the dispatch number
  const XPD = { getDb: () => ({}) };
  const body =
    'let shiftBusy = false;\nlet optimisticShift = null;\n' +
    'let companionSuspended = _suspended;\n' +
    'let driverState = _driverState;\nlet currentUser = _currentUser;\n' +
    'let slidingEl = null, renderPending = false; function renderActiveAndQueue(){}\n' +
    (pagosLive ? 'const PAGOS_LIVE = true;\n' : liftConst('PAGOS_LIVE') + '\n') +
    'function render(){ _calls.render++; }\n' +
    'function openCuenta(){ _calls.openCuenta++; }\n' +
    'function handleStartShift(){ _calls.start++; return _startImpl ? _startImpl() : Promise.resolve(); }\n' +
    'function companionSyncSuspendedNotice(){ _calls.sync++; }\n' +
    'function updateNotifBanners(){ _calls.notif++; }\n' +
    'function todayMidnightMs(){ return 0; }\n' +
    'const driverIdentityCutoverMs = null;\n' +
    liftFn('attachSlideConfirm') + '\n' +
    liftFn('driverRow') + '\n' +
    liftFn('renderOffshift') + '\n' +
    'return { renderOffshift, getShiftBusy: () => shiftBusy, getOptimistic: () => optimisticShift };';
  const names = ['document', '$', 'computeShiftCash', 'allOrders', 'SYSTEM_VERSION', 'toast', 'ICONS', 'fbOnValue', 'fbRef', 'XPD', '_suspended', '_driverState', '_currentUser', '_calls', '_startImpl'];
  const api = (new Function(...names, body))(
    document, $, computeShiftCash, {}, '2.5.3', () => {}, ICONS, fbOnValue, fbRef, XPD, suspended,
    { name: 'Marvin Posadas', active: false }, { uid: 'drv', email: 'marvin@x.pizza' }, calls, startImpl);
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
});

await t('PAGOS_LIVE → «Ganado hoy» appears as a second stat (no code change, just the flag)', () => {
  const h = boot({ pagosLive: true });
  h.api.renderOffshift();
  const html = h.host().innerHTML;
  assert.ok(/Ganado hoy/.test(html) && /L 490/.test(html), '«Ganado hoy» = deliveries×70 when PAGOS_LIVE');
  assert.ok(h.host().querySelector('.off2-stats.two'), 'two-stat layout');
});

await t('the «Iniciar turno» slide reaches the REAL handleStartShift on the shift-start path', async () => {
  const h = boot();
  h.api.renderOffshift();
  await h.slide();
  assert.equal(h.calls.start, 1, 'handleStartShift reached');
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

console.log(`✓ offshift: ${passed} tests passed`);
