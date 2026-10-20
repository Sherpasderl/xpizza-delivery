// O4 end-shift confirmation — HANDLER test. run: `node endshift-confirm.test.js` (invoked from xpizza-functions in
// the npm chain). EXECUTES the REAL shipped index.html handlers (handleEndShift + openEndShiftSheet, lifted from
// source via new Function — the onboarding-host.test.js idiom) against a REAL jsdom DOM. No source-grep assertions.
// Proves the behaviours Codex r1 required:
//   - N=0 → the clock-out runs SYNCHRONOUSLY in the same tick (no await), and NO sheet DOM is created;
//   - N≥1 → a proper modal: role=dialog/aria-modal/aria-labelledby, initial focus on Cancelar, focus trap,
//     Esc/backdrop = Cancelar, close REMOVES the sheet (nothing left focusable) and restores focus to the opener;
//   - Cancelar → no cuadre / no close intent; Terminar igual → the cuadre path; double-tap Terminar igual → one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { endShiftPrompt } from './order-helpers.js';
// jsdom is a DECLARED devDependency of xpizza-functions (devDependencies.jsdom ^30.0.1), the repo's established DOM
// test harness (contract/page-harness.js et al.). A bare specifier does not resolve from this directory, so require
// it BY NAME, resolved from xpizza-functions/ — no coupling to jsdom's internal file layout or node_modules path.
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1];

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

// Build the REAL handlers in a sandbox with a real jsdom document + window + externals injected.
// withCapacitorBack installs a fake window.Capacitor.Plugins.App (the native idiom) and records the back callback +
// listener-removal, so a hardware-back press can be simulated and its teardown asserted.
function build({ driverOrders, showCuadre, withCapacitorBack = false }) {
  const dom = new JSDOM('<!doctype html><html><body><button id="opener">turno</button></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const { document } = window;
  document.getElementById('opener').focus();                 // the duty toggle is the opener
  const back = { cb: null, removed: 0 };
  if (withCapacitorBack) {
    window.Capacitor = { Plugins: { App: { addListener: (ev, cb) => {
      if (ev === 'backButton') back.cb = cb;
      return Promise.resolve({ remove: () => { back.removed += 1; } });
    } } } };
  }
  const XPD = { getDriverOrders: () => driverOrders };
  const ICONS = { warn: '<svg data-warn></svg>' };
  const body = 'let closeGen = 0; let closeInFlight = false;\n'
    + liftFn('handleEndShift') + '\n' + liftFn('openEndShiftSheet') + '\n'
    + 'return { handleEndShift, getCloseGen: () => closeGen };';
  const fn = new Function('document', 'window', 'escapeHtml', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'ICONS', 'endShiftPrompt', 'showCuadre', body);
  const api = fn(document, window, escapeHtml, XPD, { uid: 'drv' }, {}, {}, ICONS, endShiftPrompt, showCuadre);
  api.document = document; api.window = window; api.back = back;
  return api;
}
const DO = (phase, order) => ({ orderId: order.order_id, phase, order, deliveryTask: {} });
const key = (api, k, shiftKey = false) => api.document.dispatchEvent(new api.window.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));

let passed = 0;
const _pending = [];
function t(name, fn) { _pending.push(Promise.resolve().then(fn).then(() => { passed += 1; }, (e) => { console.error(`✗ ${name}`); throw e; })); }

// ── N = 0: synchronous clock-out, NO sheet DOM (Codex r1 #1) ──
t('N=0: closeGen++ and showCuadre run SYNCHRONOUSLY (same tick, not awaited) and no sheet is created', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('pickup', { order_id: 'oP' })], showCuadre: () => cuadre.push(1) });
  const ret = api.handleEndShift();                          // do NOT await — assert the synchronous tick
  assert.equal(cuadre.length, 1, 'showCuadre ran synchronously');
  assert.equal(api.getCloseGen(), 1, 'closeGen++ ran synchronously');
  assert.equal(api.document.getElementById('endshift-sheet'), null, 'no sheet DOM created for N=0');
  await ret;
});

// ── N ≥ 1: modal semantics + content ──
t('N≥1: dialog semantics, initial focus on Cancelar, correct copy + list', async () => {
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'Col. Trejo' })], showCuadre: () => {} });
  api.handleEndShift();
  const sheet = api.document.getElementById('endshift-sheet');
  assert.ok(sheet, 'sheet created');
  const dialog = sheet.querySelector('.sheet');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'endshift-title');
  assert.equal(sheet.querySelector('#endshift-title').textContent, 'Todavía tenés 1 pedido en camino');
  assert.match(sheet.innerHTML, /¿Terminar turno igual\?/);
  assert.match(sheet.innerHTML, /#12/); assert.match(sheet.innerHTML, /Ana/); assert.match(sheet.innerHTML, /Col\. Trejo/);
  assert.equal(api.document.activeElement, sheet.querySelector('#endshift-cancel'), 'initial focus on Cancelar');
});

t('N=2: plural copy + two rows', async () => {
  const api = build({ driverOrders: [
    DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'A1' }),
    DO('delivery', { order_id: 'oD2', display_number: 13, customer_name: 'Beto', address_detected: 'A2' }),
  ], showCuadre: () => {} });
  api.handleEndShift();
  const sheet = api.document.getElementById('endshift-sheet');
  assert.equal(sheet.querySelector('#endshift-title').textContent, 'Todavía tenés 2 pedidos en camino');
  assert.equal(sheet.querySelectorAll('.es-row').length, 2);
});

// ── focus trap ──
t('focus trap: Tab from Terminar igual wraps to Cancelar; Shift+Tab from Cancelar wraps to Terminar igual', async () => {
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => {} });
  api.handleEndShift();
  const sheet = api.document.getElementById('endshift-sheet');
  const cancel = sheet.querySelector('#endshift-cancel'), confirm = sheet.querySelector('#endshift-confirm');
  confirm.focus(); key(api, 'Tab');
  assert.equal(api.document.activeElement, cancel, 'Tab from last wraps to first');
  cancel.focus(); key(api, 'Tab', true);
  assert.equal(api.document.activeElement, confirm, 'Shift+Tab from first wraps to last');
});

// ── Esc / backdrop = Cancelar: no close-state change, sheet removed, focus restored ──
t('Esc = Cancelar: no cuadre, no close intent, sheet removed, focus restored to opener', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  key(api, 'Escape');
  await p;
  assert.equal(cuadre.length, 0, 'showCuadre NOT called');
  assert.equal(api.getCloseGen(), 0, 'no close intent');
  assert.equal(api.document.getElementById('endshift-sheet'), null, 'sheet removed from DOM (not merely hidden)');
  assert.equal(api.document.activeElement, api.document.getElementById('opener'), 'focus restored to opener');
});

t('backdrop tap = Cancelar (stay on shift, sheet removed)', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.document.getElementById('endshift-sheet').click();     // click the backdrop itself
  await p;
  assert.equal(cuadre.length, 0);
  assert.equal(api.document.getElementById('endshift-sheet'), null);
});

// ── Android hardware BACK = Cancelar (Codex r2) ──
t('Android back = Cancelar: listener registered while open + removed on close; no cuadre, sheet removed, focus restored', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1), withCapacitorBack: true });
  const p = api.handleEndShift();
  assert.equal(typeof api.back.cb, 'function', 'a backButton listener is registered while the sheet is open');
  api.back.cb();                            // simulate the Android hardware back press
  await p;
  assert.equal(cuadre.length, 0, 'back did not end the shift (no cuadre)');
  assert.equal(api.getCloseGen(), 0, 'close state unchanged');
  assert.equal(api.document.getElementById('endshift-sheet'), null, 'sheet removed on back');
  assert.equal(api.document.activeElement, api.document.getElementById('opener'), 'focus restored to opener');
  assert.ok(api.back.removed >= 1, 'the backButton listener was removed on close (no leak past the sheet)');
});

// ── Cancelar / Terminar igual buttons ──
t('Cancelar button → no cuadre, no close intent', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.document.getElementById('endshift-cancel').click();
  await p;
  assert.equal(cuadre.length, 0); assert.equal(api.getCloseGen(), 0);
  assert.equal(api.document.getElementById('endshift-sheet'), null);
});

t('Terminar igual → showCuadre runs (close intent + cuadre), sheet removed', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.document.getElementById('endshift-confirm').click();
  await p;
  assert.equal(cuadre.length, 1); assert.equal(api.getCloseGen(), 1);
  assert.equal(api.document.getElementById('endshift-sheet'), null);
});

// ── double-tap Terminar igual → a SINGLE end-shift ──
t('double-tap Terminar igual → showCuadre runs exactly once', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  const confirm = api.document.getElementById('endshift-confirm');
  confirm.click(); confirm.click();
  await p;
  assert.equal(cuadre.length, 1, 'a double tap still ends the shift only once');
  assert.equal(api.getCloseGen(), 1);
});

await Promise.all(_pending);
console.log(`✓ endshift-confirm (handler): ${passed} tests passed`);
