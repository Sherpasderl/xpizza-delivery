// solo-cancel.test.js — the no-survivor cancellation that takes over the idle screen (prototype S.cancelado).
// Drives the REAL renderSoloCancel + wireDispatchCallRow (via the REAL renderDisponible branch), and runs the REAL
// SLICE3:SOLO-CANCEL capture snippet (extracted from source) for the solo-vs-survivor / active-work logic. Proves:
//   • renderDisponible shows the cancel banner (num + brand data-driven, fallback «al restaurante»), «Entendido»,
//     the «Disponible» card, «Tu cuadre no cambia», and the dispatch row (shown+tel: when a number exists, else hidden);
//   • «Entendido» clears drv2SoloCancel and re-renders;
//   • the startup-bound #idle-help-link / #arrive-btn survive the takeover (preserved, invisible);
//   • capture: a cancel with NO survivor on an EMPTY board sets it; a survivor cancel does NOT; active work clears it.
// Run: `node solo-cancel.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { computeShiftCash } from './cash-helpers.js';   // the «Tu cuadre no cambia» truth-check

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

function boot({ cancel, dispatch = '+504 9999 8888', realRaq = false, orders = [], drv2Cancel = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-onshift"></div>'
    + '<div id="incoming-banner-slot"></div><div id="active-order-slot"></div><div id="queue-slot"></div>'
    + '<div id="idle-state">'
    + '<div class="idle-top"><div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">x</div>'
    + '<div class="idle-sub" id="idle-sub">x</div><button class="idle-help-link" id="idle-help-link">h</button>'
    + '<button class="big-btn primary hidden" id="arrive-btn">Estoy en el restaurante</button></div>'
    + '<div class="statbar" id="idle-statbar"><div id="stat-deliveries">0</div><div id="stat-cash">L 0</div></div>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => `<svg data-ic="${String(k)}"></svg>` });
  const driverState = { status: 'available', last_ping: Date.now() };
  const XPD = { isStalePing: () => false, getDb: () => ({}), getDriverOrders: () => orders };
  const fbRef = () => ({});
  const fbOnValue = (ref, cb) => { cb(dispatch == null ? null : { val: () => dispatch }); return () => {}; };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const currentUser = { uid: 'drv' };
  $('idle-help-link')._mark = 'help'; $('arrive-btn')._mark = 'arrive';
  // Codex r2 P2-8: drive the REAL renderActiveAndQueue (not a stub) so the empty-board → SOLO-CANCEL capture →
  // renderIdleState path is exercised; a mutant that SKIPS the idle render then shows no cancel banner → RED.
  const raqBlock = realRaq
    ? ('let slidingEl = null, renderPending = false, allTasks = {}, allOrders = {}, queuedOrders = [], drv2Cancel = _drv2Cancel, drv2OfferExpired = null;\n'
       + 'const collapsedBanners = new Set();\n'
       + 'function applyOfflineBanner(){} function drv2ResolveActivePointer(){ return null; } function drv2NavArmed(){ return true; } function drv2Observe(){} function drv2ShowInterlude(){} function drv2DismissInterlude(){} function drv2ResetRun(){} function mountTabBar(){} function offerExpiredBannerHtml(){ return ""; }\n'
       + liftFn('renderActiveAndQueue') + '\n')
    : 'function renderActiveAndQueue(){ _calls.raq = (_calls.raq||0)+1; }\n';
  const body = 'const DRV2_PAUSE_ENABLED = false;\nfunction renderPausa(){}\nlet drv2SoloCancel = _cancel;\n' + raqBlock
    + 'let NAVP_ICONS = {}, navBtnHtml = () => "", drv2ReadNavPref = () => "Waze";\n'
    + 'function drv2GetReturnTarget(){ return null; } function drv2ClearReturnTarget(){}\n'
    + 'function applyGpsoff(){} function checkLocationStatus(){} function syncIdleStats(){}\n'
    + liftFn('renderSoloCancel') + '\n' + liftFn('wireDispatchCallRow') + '\n' + liftFn('renderDisponible') + '\n' + liftFn('renderIdleState') + '\n'
    + 'return { renderDisponible, renderIdleState, renderActiveAndQueue, getCancel: () => drv2SoloCancel, setCancel: (c) => { drv2SoloCancel = c; } };';
  const calls = {};
  const names = ['document', '$', 'ICONS', 'driverState', 'XPD', 'fbRef', 'fbOnValue', 'escapeHtml', 'currentUser', 'window', '_cancel', '_calls', '_drv2Cancel'];
  const api = (new Function(...names, body))(document, $, ICONS, driverState, XPD, fbRef, fbOnValue, escapeHtml, currentUser, window, cancel, calls, drv2Cancel);
  return { api, document, window, host: $('idle-state'), $, calls };
}

// the REAL capture snippet from the SLICE3:SOLO-CANCEL region — run it against (orders, drv2Cancel) to prove the logic
const CAPTURE = (() => {
  const m = SCRIPT.match(/SLICE3:SOLO-CANCEL:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:SOLO-CANCEL:END/);
  assert.ok(m, 'SOLO-CANCEL capture snippet not found');
  return m[1];
})();
function runCapture(orders, drv2Cancel, prior = null, uid = 'drv') {
  const fn = new Function('orders', 'drv2Cancel', 'drv2SoloCancel', 'currentUser', 'drv2ClearReturnTarget', CAPTURE + '\nreturn drv2SoloCancel;');
  return fn(orders, drv2Cancel, prior, { uid }, () => {});
}

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

const CANCEL = { cancelledNum: '#1042', cancelledName: 'Daniela', cancelledAmount: 385, survivorName: '', cancelledBrand: 'X. Pizza', _uid: 'drv' };

t('renderDisponible shows the S.cancelado takeover: banner (num + brand), «Entendido», «Disponible» card, «cuadre no cambia», dispatch row', () => {
  const h = boot({ cancel: CANCEL });
  h.api.renderDisponible();
  const html = h.host.innerHTML;
  assert.ok(h.host.querySelector('.disp-cancel-banner'), 'cancel banner present');
  assert.match(html, /Pedido #1042 cancelado por despacho/, 'banner title with the cancelled number');
  assert.match(html, /Regresá la comida a X\. Pizza/, 'brand is data-driven (cancelledBrand)');
  assert.match(html, /Queda a la vista hasta que toques “Entendido”/, 'the persistence chip');
  assert.ok(h.host.querySelector('#btn-solo-cancel-ack'), '«Entendido» button present');
  assert.equal(h.host.querySelector('.disp-chip span:last-child').textContent, 'Disponible', 'the «Disponible» status card');
  assert.match(html, /Tu cuadre no cambia/, 'cuadre-unchanged row');
  assert.ok(!h.host.querySelector('.disp-status + * .disp-statcard') && !/Esperando pedidos/.test(html), 'the normal idle «Esperando pedidos» body is replaced');
});

t('brand-agnostic fallback: no cancelledBrand → «Regresá la comida al restaurante» (never a literal)', () => {
  const h = boot({ cancel: { ...CANCEL, cancelledBrand: '' } });
  h.api.renderDisponible();
  assert.match(h.host.innerHTML, /Regresá la comida al restaurante/, 'neutral fallback');
  assert.doesNotMatch(h.host.innerHTML, /X\. Pizza|La Musa/, 'no hard-coded brand');
});

t('«Entendido» clears drv2SoloCancel and re-renders', () => {
  const h = boot({ cancel: CANCEL });
  h.api.renderDisponible();
  h.host.querySelector('#btn-solo-cancel-ack').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.api.getCancel(), null, 'the cancel state is cleared');
  assert.ok(h.calls.raq >= 1, 're-rendered via renderActiveAndQueue');
});

t('dispatch row: shown + tel: when a number exists; hidden when absent (no dead affordance)', () => {
  const h1 = boot({ cancel: CANCEL, dispatch: '+504 9999 8888' });
  h1.api.renderDisponible();
  const row = h1.host.querySelector('#disp-cancel-dispatch');
  assert.ok(row && !row.classList.contains('hidden'), 'dispatch row shown with a valid number');
  assert.match(row.textContent, /Llamá a despacho/, 'row label');
  const h2 = boot({ cancel: CANCEL, dispatch: null });
  h2.api.renderDisponible();
  assert.ok(h2.host.querySelector('#disp-cancel-dispatch').classList.contains('hidden'), 'row hidden when no dispatch number');
});

t('the startup-bound #idle-help-link and #arrive-btn survive the takeover (preserved, invisible)', () => {
  const h = boot({ cancel: CANCEL });
  h.api.renderDisponible();
  assert.equal(h.$('idle-help-link')._mark, 'help', 'help-link is the SAME element (not re-created)');
  assert.equal(h.$('arrive-btn')._mark, 'arrive', 'arrive-btn is the SAME element');
  assert.ok(h.$('idle-help-link').closest('#disp-preserve'), 'preserved inside the hidden holder');
});

// the capture logic (REAL snippet)
const RAW = { cancelledNum: '#1042', cancelledName: 'Daniela', cancelledAmount: 385, survivorName: '', cancelledBrand: 'X. Pizza' };   // drv2Cancel (no _uid); capture stamps it
t('capture: a NO-survivor cancel on an EMPTY board → drv2SoloCancel set, stamped with the uid (Codex P2-3)', () => {
  assert.deepEqual(runCapture([], RAW, null), { ...RAW, _uid: 'drv' }, 'solo cancel captured + uid-stamped');
});
t('capture: a SURVIVOR cancel → NOT captured (survivor path owns it)', () => {
  assert.equal(runCapture([], { ...RAW, survivorName: 'Carlos' }, null), null, 'survivor cancel not captured as solo');
});
t('capture: active work clears a prior solo-cancel (next order)', () => {
  assert.equal(runCapture([{ phase: 'pickup' }], null, CANCEL), null, 'cleared once there is active work');
});
t('capture: a new unaccepted OFFER clears a prior solo-cancel (Codex P2-3)', () => {
  assert.equal(runCapture([{ phase: 'awaiting_acceptance' }], null, CANCEL), null, 'cleared by any order, incl. an offer');
});
t('capture: persists across idle re-renders once drv2Cancel is nulled (no re-set, no clear)', () => {
  assert.deepEqual(runCapture([], null, CANCEL), CANCEL, 'idle re-render keeps the banner');
});
t('P2-8: the REAL renderActiveAndQueue on an EMPTY board captures the no-survivor cancel AND renders the idle takeover (kills the skip-idle-render + skip-capture mutants)', () => {
  // Drive the REAL board renderer (not the stub): empty board + a no-survivor drv2Cancel → the live SOLO-CANCEL
  // region captures it, then the empty-board branch calls renderIdleState → renderDisponible → renderSoloCancel.
  const h = boot({ cancel: null, realRaq: true, orders: [], drv2Cancel: { ...RAW } });   // drv2SoloCancel starts null
  h.api.renderActiveAndQueue();
  assert.ok(h.host.querySelector('.disp-cancel-banner'), 'the REAL render reached the idle cancel takeover (a skip-idle-render mutant → no banner → RED)');
  assert.match(h.host.innerHTML, /Pedido #1042 cancelado por despacho/, 'the captured cancel is actually shown');
  assert.deepEqual(h.api.getCancel(), { ...RAW, _uid: 'drv' }, 'the live SOLO-CANCEL region captured + uid-stamped it (a skip-capture mutant → null → RED)');
});

// «Tu cuadre no cambia» truth-check: a cancelled cash order never enters computeShiftCash (no delivered_at)
t('computeShiftCash: a CANCELLED cash order is NOT counted — the «Tu cuadre no cambia» claim holds', () => {
  const orders = {
    good: { total: 385, payment_method: 'cash', delivered_by_driver_uid: 'me', delivered_at: 3000 },
    cxl: { total: 500, payment_method: 'cash', status: 'cancelled', delivered_by_driver_uid: 'me' },   // never delivered → no delivered_at
  };
  const r = computeShiftCash(orders, 'me', 1000, 5000);
  assert.equal(r.cashOwed, 385, 'only the delivered order is in the cash — the cancelled one adds nothing');
  assert.equal(r.cashOrderCount, 1, 'the cancelled cash order is not a cash-owed order');
  assert.equal(r.deliveries, 1, 'the cancelled order is not a delivery');
});

t('P1 (Codex): cancel → «Entendido» → the idle screen re-renders with NO null-deref (idle-icon/msg/sub preserved)', () => {
  const h = boot({ cancel: CANCEL });
  h.api.renderIdleState();   // cancel takeover (renderSoloCancel), preserving idle-icon/msg/sub hidden
  assert.ok(h.host.querySelector('.disp-cancel-banner'), 'cancel screen shown');
  assert.ok(h.$('idle-icon') && h.$('idle-msg') && h.$('idle-sub'), 'the renderIdleState deps survive the takeover');
  h.api.setCancel(null);   // «Entendido»
  assert.doesNotThrow(() => h.api.renderIdleState(), 'idle re-renders without a null-deref (kills the stuck-cancel mutant)');
  assert.ok(h.host.querySelector('.disp-status') || /Esperando pedidos/.test(h.host.innerHTML), 'the normal idle body is back');
});
t('P2-3: a solo-cancel from a DIFFERENT account is NOT shown and is cleared (no cross-account leak)', () => {
  const h = boot({ cancel: { ...CANCEL, _uid: 'other' } });
  h.api.renderDisponible();
  assert.ok(!h.host.querySelector('.disp-cancel-banner'), 'another account’s cancel is not shown');
  assert.equal(h.api.getCancel(), null, 'and it is cleared (dropped), so A→B→A cannot resurrect it');
});

console.log(`✓ solo-cancel: ${passed} tests passed`);
