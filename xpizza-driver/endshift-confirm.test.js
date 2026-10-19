// O4 end-shift confirmation — HANDLER test. run: `node endshift-confirm.test.js` (no framework, repo idiom).
// EXECUTES the REAL shipped index.html handlers (handleEndShift + confirmEndShiftIfPendingDeliveries + the real
// endshift-sheet click handler, all lifted from source via new Function — the onboarding-host.test.js idiom) against
// a fake DOM + fake feed + the REAL endShiftPrompt. No source-grep assertions; proves the behaviours the advisor listed:
// N=0 → straight to the cuadre with zero sheet DOM; N≥1 → the sheet (correct copy + list); Cancelar → stay on shift,
// no cuadre, no close intent; Terminar igual → the existing cuadre path; double-tap Terminar igual → a single cuadre.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { endShiftPrompt } from './order-helpers.js';

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Lift a brace-matched `function <name>(` (keeps a leading `async `).
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
// Lift the top-level `$('endshift-sheet').addEventListener('click', …);` statement (paren-matched) — the REAL dispatch.
function liftClickHandler() {
  const start = SCRIPT.indexOf("$('endshift-sheet').addEventListener('click'");
  assert.notEqual(start, -1, 'endshift-sheet click handler not found');
  const parenStart = SCRIPT.indexOf('(', SCRIPT.indexOf('.addEventListener', start));
  let depth = 0;
  for (let i = parenStart; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '(') depth++;
    else if (SCRIPT[i] === ')') { depth--; if (depth === 0) { let end = i + 1; if (SCRIPT[end] === ';') end += 1; return SCRIPT.slice(start, end); } }
  }
  throw new Error('unbalanced endshift click handler');
}

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Minimal fake DOM: persistent elements by id, innerHTML, classList('open'), addEventListener('click'), ._finish.
function makeDom() {
  const els = {};
  function makeEl(id) {
    const el = { id, _html: '', _open: false, _click: null, _finish: null };
    Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = String(v); } });
    el.addEventListener = (ev, fn) => { if (ev === 'click') el._click = fn; };
    el.classList = { add: (c) => { if (c === 'open') el._open = true; }, remove: (c) => { if (c === 'open') el._open = false; }, contains: (c) => (c === 'open' ? el._open : false) };
    return el;
  }
  const $ = (id) => els[id] || (els[id] = makeEl(id));
  return { $, els };
}

// Build the REAL handlers in a sandbox with externals injected and closeGen/closeInFlight local.
function build({ driverOrders, showCuadre }) {
  const dom = makeDom();
  const XPD = { getDriverOrders: () => driverOrders };
  const ICONS = { warn: '<svg data-warn></svg>' };
  const body = `let closeGen = 0; let closeInFlight = false;\n`
    + liftFn('handleEndShift') + '\n'
    + liftFn('confirmEndShiftIfPendingDeliveries') + '\n'
    + liftClickHandler() + '\n'
    + 'return { handleEndShift, confirmEndShiftIfPendingDeliveries, getCloseGen: () => closeGen };';
  const fn = new Function('$', 'escapeHtml', 'XPD', 'currentUser', 'allTasks', 'allOrders', 'ICONS', 'endShiftPrompt', 'showCuadre', body);
  const api = fn(dom.$, escapeHtml, XPD, { uid: 'drv' }, {}, {}, ICONS, endShiftPrompt, showCuadre);
  api.dom = dom;
  return api;
}

const DO = (phase, order) => ({ orderId: order.order_id, phase, order, deliveryTask: {} });
let passed = 0;
const _pending = [];
function t(name, fn) { _pending.push(Promise.resolve().then(fn).then(() => { passed += 1; }, (e) => { console.error(`✗ ${name}`); throw e; })); }

// ── N = 0: straight to the cuadre, zero sheet DOM ──
t('N=0: handleEndShift goes straight to showCuadre and never opens the sheet', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('pickup', { order_id: 'oP' })], showCuadre: () => cuadre.push(1) });
  await api.handleEndShift();
  assert.equal(cuadre.length, 1, 'showCuadre called once');
  assert.equal(api.dom.$('endshift-sheet')._open, false, 'sheet never opened');
  assert.equal(api.dom.els['endshift-sheet-body'], undefined, 'sheet body never rendered (zero sheet DOM)');
  assert.equal(api.getCloseGen(), 1, 'the normal close intent ran (closeGen bumped)');
});

// ── N = 1 / N = 2: the sheet, correct copy + list ──
t('N=1: opens the sheet with singular copy + one row; cuadre not yet called', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'Col. Trejo' })], showCuadre: () => cuadre.push(1) });
  api.handleEndShift();
  const html = api.dom.$('endshift-sheet-body').innerHTML;
  assert.equal(api.dom.$('endshift-sheet')._open, true, 'sheet open');
  assert.match(html, /Todavía tenés 1 pedido en camino/);
  assert.match(html, /¿Terminar turno igual\?/);
  assert.match(html, /#12/); assert.match(html, /Ana/); assert.match(html, /Col\. Trejo/);
  assert.match(html, /id="endshift-cancel"/); assert.match(html, /id="endshift-confirm"/);
  assert.equal(cuadre.length, 0, 'no cuadre while the sheet is up');
  assert.equal(api.getCloseGen(), 0, 'no close intent yet');
});

t('N=2: plural copy + two rows', async () => {
  const api = build({ driverOrders: [
    DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'A1' }),
    DO('delivery', { order_id: 'oD2', display_number: 13, customer_name: 'Beto', address_detected: 'A2' }),
  ], showCuadre: () => {} });
  api.handleEndShift();
  const html = api.dom.$('endshift-sheet-body').innerHTML;
  assert.match(html, /Todavía tenés 2 pedidos en camino/);
  assert.equal((html.match(/class="es-row"/g) || []).length, 2, 'two list rows');
  assert.match(html, /Ana/); assert.match(html, /Beto/);
});

// ── Cancelar: stay on shift, no cuadre, no close intent ──
t('Cancelar → no cuadre, no close intent, sheet closed', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.dom.$('endshift-sheet')._click({ target: { id: 'endshift-cancel' } });
  await p;
  assert.equal(cuadre.length, 0, 'showCuadre NOT called');
  assert.equal(api.getCloseGen(), 0, 'no close intent — nothing written');
  assert.equal(api.dom.$('endshift-sheet')._open, false, 'sheet closed');
});

t('backdrop tap = Cancelar (stay on shift)', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.dom.$('endshift-sheet')._click({ target: { id: 'endshift-sheet' } });
  await p;
  assert.equal(cuadre.length, 0);
  assert.equal(api.dom.$('endshift-sheet')._open, false);
});

// ── Terminar igual → the existing cuadre path, unchanged ──
t('Terminar igual → showCuadre runs (close intent + cuadre)', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.dom.$('endshift-sheet')._click({ target: { id: 'endshift-confirm' } });
  await p;
  assert.equal(cuadre.length, 1, 'showCuadre called after Terminar igual');
  assert.equal(api.getCloseGen(), 1, 'close intent ran');
  assert.equal(api.dom.$('endshift-sheet')._open, false, 'sheet closed');
});

// ── double-tap Terminar igual → a SINGLE end-shift ──
t('double-tap Terminar igual → showCuadre runs exactly once', async () => {
  const cuadre = [];
  const api = build({ driverOrders: [DO('delivery', { order_id: 'oD1', customer_name: 'Ana' })], showCuadre: () => cuadre.push(1) });
  const p = api.handleEndShift();
  api.dom.$('endshift-sheet')._click({ target: { id: 'endshift-confirm' } });
  api.dom.$('endshift-sheet')._click({ target: { id: 'endshift-confirm' } });
  await p;
  assert.equal(cuadre.length, 1, 'a double tap still ends the shift only once');
  assert.equal(api.getCloseGen(), 1, 'close intent ran once');
});

await Promise.all(_pending);
console.log(`✓ endshift-confirm (handler): ${passed} tests passed`);
