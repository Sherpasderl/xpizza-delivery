// endshift.test.js — the «Terminar turno» idle slide (owner 2026-10-27), DARK behind DRV2_ENDSHIFT_SLIDE. Drives the
// REAL renderDisponible (slide markup + wiring) and renderStatusBar (duty-toggle hide), lifted from index.html with
// the flag forced true. Proves:
//   • the slide renders at the bottom of disponible ONLY when the flag is on (dark by default → no slide);
//   • it is wired through attachSlideConfirm to a doEndShift that runs the SAME end-shift path (handleEndShift → O4
//     → cuadre), behind the double-trigger (shiftBusy / effectiveActive) + stale-mount + session guards;
//   • when the slide is live, the top-right duty toggle is hidden on the idle header (the slide is the entry), and it
//     stays in the DOM so #btn-end-shift (delivery) still ends a shift; dark → the toggle stays as today.
// Run: `node endshift.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'))('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let s = SCRIPT.indexOf('function ' + name + '('); assert.notEqual(s, -1, name + ' not found');
  let d = 0, seen = false;
  for (let i = s; i < SCRIPT.length; i++) { if (SCRIPT[i] === '{') { d++; seen = true; } else if (SCRIPT[i] === '}') { d--; if (seen && d === 0) return SCRIPT.slice(s, i + 1); } }
  throw new Error('unbalanced ' + name);
}
const ARROW_LINE = SCRIPT.match(/const DRV2_SLIDE_ARROW = '[^']*';/)[0];

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error('✗ ' + name); throw e; } };

// ---- renderDisponible: the slide + its wiring ----
function bootDisp({ enabled = true, status = 'available', active = true, shiftBusy = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">m</div><div class="idle-sub" id="idle-sub">s</div>'
    + '<button class="idle-help-link" id="idle-help-link">h</button><button id="arrive-btn">a</button>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => '<svg data-ic="' + String(k) + '"></svg>' });
  const driverState = { status, active, last_ping: Date.now() };
  let confirms = [], endCalls = 0;
  const body =
    'const DRV2_ENDSHIFT_SLIDE = ' + enabled + '; const DRV2_PAUSE_ENABLED = false;\n'
    + ARROW_LINE + '\n'
    + 'let drv2SoloCancel = null; let optimisticShift = null; let shiftBusy = ' + shiftBusy + '; let authGen = 1;\n'
    + 'function renderPausa(){} function renderSoloCancel(){}\n'
    + 'function drv2GetReturnTarget(){ return null; } function drv2ClearReturnTarget(){}\n'
    + 'function attachSlideConfirm(id, cb){ _confirms.push({ id, cb }); }\n'
    + 'async function handleEndShift(){ _end(); }\n'
    + 'let NAVP_ICONS = {}; function navBtnHtml(){ return ""; } function drv2ReadNavPref(){ return "Waze"; }\n'
    + liftFn('renderDisponible') + '\n'
    + 'return { renderDisponible, confirmById: (id) => (_confirms.find(c => c.id === id) || {}).cb, setBusy: (b) => { shiftBusy = b; }, setOptimistic: (v) => { optimisticShift = v; } };';
  const names = ['document', '$', 'ICONS', 'driverState', 'escapeHtml', 'currentUser', 'XPD', 'window', '_confirms', '_end'];
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const api = (new Function(...names, body))(document, $, ICONS, driverState, escapeHtml, { uid: 'drv' }, { isStalePing: () => false, RESTAURANT: {} }, window, confirms, () => { endCalls++; });
  return { api, $, host: $('idle-state'), get endCalls() { return endCalls; } };
}

t('dark by default: DRV2_ENDSHIFT_SLIDE false → NO «Terminar turno» slide (no regression)', () => {
  const h = bootDisp({ enabled: false });
  h.api.renderDisponible();
  assert.ok(!h.$('btn-end-shift-slide'), 'no slide while dark');
  assert.ok(!/Terminar turno/.test(h.host.innerHTML), 'no end-shift copy while dark');
});
t('live: the «Terminar turno» slide renders at the bottom of disponible + mirrors the start-slide markup', () => {
  const h = bootDisp({ enabled: true, status: 'available' });
  h.api.renderDisponible();
  const sl = h.$('btn-end-shift-slide');
  assert.ok(sl, 'the slide is present');
  assert.ok(sl.classList.contains('slide-confirm') && sl.classList.contains('endshift'), 'slide-confirm endshift classes (mirrors .start)');
  assert.match(sl.querySelector('.slide-text').textContent, /Terminar turno/, 'the label');
  assert.ok(sl.querySelector('.slide-fill') && sl.querySelector('.slide-thumb') && sl.querySelector('.slide-hint'), 'the attachSlideConfirm markup (fill/thumb/hint)');
  assert.equal(sl.getAttribute('role'), 'button', 'keyboard-operable');
});
t('live: the slide is wired through attachSlideConfirm, and doEndShift runs the SAME end-shift path (handleEndShift)', async () => {
  const h = bootDisp({ enabled: true, status: 'available', active: true });
  h.api.renderDisponible();
  const cb = h.api.confirmById('btn-end-shift-slide');
  assert.equal(typeof cb, 'function', 'attachSlideConfirm was called for the slide');
  await cb();
  assert.equal(h.endCalls, 1, 'confirming the slide calls handleEndShift (→ O4 → cuadre)');
});
t('double-trigger guards: shiftBusy OR not-effectively-on-shift → doEndShift is a no-op (mirrors the start slide)', async () => {
  const busy = bootDisp({ enabled: true, active: true, shiftBusy: true });
  busy.api.renderDisponible();
  await busy.api.confirmById('btn-end-shift-slide')();
  assert.equal(busy.endCalls, 0, 'shiftBusy → no end-shift (no double-fire)');
  const off = bootDisp({ enabled: true, status: 'available', active: false });   // not on-shift
  off.api.renderDisponible();
  await off.api.confirmById('btn-end-shift-slide')();
  assert.equal(off.endCalls, 0, 'not effectively on-shift → no end-shift');
});

// ---- renderStatusBar: the duty-toggle hide ----
function bootHeader({ enabled = true, status = 'available' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="status-bar"><div id="status-dot"></div><div id="status-label"></div><div id="gps-meta"></div><button class="duty-toggle on" id="duty-toggle-on"></button></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const driverState = { status, break_since: Date.now() - 60000, shift_started_at: Date.now() - 600000, last_ping: Date.now() };
  const body = 'const DRV2_ENDSHIFT_SLIDE = ' + enabled + '; const DRV2_PAUSE_ENABLED = false; const DRV2_PAUSE_SVG = "";\n'
    + 'function drv2PauseShift(){}\n' + liftFn('renderStatusBar') + '\nreturn { renderStatusBar };';
  const api = (new Function('document', '$', 'driverState', 'fmtClockHM', 'XPD', body))(document, $, driverState, (ms) => new Date(ms).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: false }), { isStalePing: () => false });
  return { api, $, document };
}
t('live: the idle header hides the duty toggle (the slide is the end-shift entry) but keeps it in the DOM', () => {
  const h = bootHeader({ enabled: true, status: 'available' });
  h.api.renderStatusBar();
  const dt = h.$('duty-toggle-on');
  assert.ok(dt, 'the toggle stays in the DOM (so #btn-end-shift can still .click() it during a delivery)');
  assert.ok(dt.classList.contains('hidden'), 'but it is hidden on the idle header while the slide is live');
});
t('dark: the duty toggle is NOT hidden (today behavior unchanged)', () => {
  const h = bootHeader({ enabled: false, status: 'available' });
  h.api.renderStatusBar();
  assert.ok(!h.$('duty-toggle-on').classList.contains('hidden'), 'dark → the header toggle stays visible');
});

console.log(`✓ endshift: ${passed} tests passed`);
