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
const FULL = readFileSync(join(__dir, 'index.html'), 'utf8');
const SCRIPT = FULL.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let s = SCRIPT.indexOf('function ' + name + '('); assert.notEqual(s, -1, name + ' not found');
  let d = 0, seen = false;
  for (let i = s; i < SCRIPT.length; i++) { if (SCRIPT[i] === '{') { d++; seen = true; } else if (SCRIPT[i] === '}') { d--; if (seen && d === 0) return SCRIPT.slice(s, i + 1); } }
  throw new Error('unbalanced ' + name);
}
const ARROW_LINE = SCRIPT.match(/const DRV2_SLIDE_ARROW = '[^']*';/)[0];
// Lift a top-level statement (the delegated #cuadre-screen click listener) from its start marker through its own
// closing `\n});`. Its inner `if (…) { … }` branches are single-line, so the first `\n});` is the listener's close.
function liftStmt(startMarker) {
  const s = SCRIPT.indexOf(startMarker); assert.notEqual(s, -1, startMarker + ' not found');
  const e = SCRIPT.indexOf('\n});', s); assert.notEqual(e, -1, 'no close for ' + startMarker);
  return SCRIPT.slice(s, e + 4);
}

let passed = 0;
// P3 (Codex #190): the wrapper must AWAIT async cells — a prior version called fn() without awaiting, so a rejection
// or a post-await assertion inside an async cell never failed the suite. Register, then run sequentially under await.
const _tests = [];
const t = (name, fn) => { _tests.push([name, fn]); };

// ---- Go-live gate (owner 2026-10-27 YES to the slide; owner chose Option A; INVERTED at the flip, read FROM SOURCE) ----
t('production DRV2_ENDSHIFT_SLIDE is true (live) — read from the index.html source, not a supplied flag', () => {
  assert.match(SCRIPT, /const DRV2_ENDSHIFT_SLIDE = true;/, 'the shipped constant is true (the «Terminar turno» slide + Option A are live); reverting it to false in source → RED (the go-live gate)');
  assert.doesNotMatch(SCRIPT, /const DRV2_ENDSHIFT_SLIDE = false;/, 'no longer shipped dark');
});

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
  assert.ok(sl.querySelector('.slide-fill') && sl.querySelector('.slide-thumb'), 'the attachSlideConfirm markup (fill/thumb)');
  assert.ok(!sl.querySelector('.slide-hint'), 'hint-free slider (owner 2026-11-20: «deslizá» removed)');
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

// ---- renderPausa: the Option A paused-screen end-shift (owner 2026-11-19) ----
// With the slide live the header duty toggle is hidden (the two cells above), so the paused screen must carry the one
// end-shift affordance — a quiet secondary «Terminar turno» under «Reanudar turno». Drives the REAL renderPausa.
function bootPausa({ enabled = true, active = true, shiftBusy = false, paused = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">m</div><div class="idle-sub" id="idle-sub">s</div>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  let endCalls = 0;
  const driverState = { status: paused ? 'on_break' : 'available', active, break_since: Date.now() - 60000, last_ping: Date.now() };
  const body =
    'const DRV2_ENDSHIFT_SLIDE = ' + enabled + ';\n'
    + 'const DRV2_PAUSE_SVG = ""; const DRV2_INFO_SVG = ""; const DRV2_PLAY_SVG = ""; const DRV2_POWER_SVG = "<svg data-power=\\"1\\"></svg>";\n'
    + 'let shiftBusy = ' + shiftBusy + '; let authGen = 1; let optimisticShift = null; let drv2PauseWriteKind = null;\n'
    + 'function drv2PauseElapsed(){ return "0:00"; } function drv2PauseRingHtml(){ return ""; }\n'
    + 'function drv2WritePauseState(){}\n'
    + 'async function handleEndShift(){ _end(); }\n'
    + liftFn('renderPausa') + '\n'
    + 'return { renderPausa, endTap: () => { const b = document.getElementById("btn-terminar-pausa"); return b && b.onclick(); } };';
  const names = ['document', '$', 'driverState', 'currentUser', '_end'];
  const api = (new Function(...names, body))(document, $, driverState, { uid: 'drv' }, () => { endCalls++; });
  return { api, $, host: $('idle-state'), get endCalls() { return endCalls; } };
}
t('live: the paused screen shows a quiet secondary «Terminar turno» under «Reanudar turno» (Option A)', () => {
  const h = bootPausa({ enabled: true });
  h.api.renderPausa(h.host);
  const resume = h.$('btn-reanudar'), end = h.$('btn-terminar-pausa');
  assert.ok(resume && /Reanudar turno/.test(resume.textContent), 'the primary «Reanudar turno» is present');
  assert.ok(end, 'the secondary «Terminar turno» is present (the invariant: slide ON → a paused driver always has an end-shift path)');
  assert.ok(end.classList.contains('pausa-endshift'), 'it uses the quiet ghost pattern (.pausa-endshift)');
  assert.match(end.textContent, /Terminar turno/, 'the label');
  assert.ok(end.closest('.pausa-foot') && end.closest('.pausa-foot') === resume.closest('.pausa-foot'), 'it sits in the pausa footer beside «Reanudar turno»');
});
t('dark: DRV2_ENDSHIFT_SLIDE off → NO paused-screen «Terminar turno» (the header duty toggle is still the clock-out)', () => {
  const h = bootPausa({ enabled: false });
  h.api.renderPausa(h.host);
  assert.ok(!h.$('btn-terminar-pausa'), 'no paused end-shift control while dark');
  assert.ok(!/Terminar turno/.test(h.host.innerHTML), 'no end-shift copy while dark');
});
t('live: tapping the paused «Terminar turno» runs the SAME end-shift path (handleEndShift → O4 → cuadre)', async () => {
  const h = bootPausa({ enabled: true, active: true });
  h.api.renderPausa(h.host);
  await h.api.endTap();
  assert.equal(h.endCalls, 1, 'the tap reaches handleEndShift once');
});
t('guards: shiftBusy OR not-effectively-on-shift → the paused end-shift tap is a no-op (mirrors the slide)', async () => {
  const busy = bootPausa({ enabled: true, active: true, shiftBusy: true });
  busy.api.renderPausa(busy.host);
  await busy.api.endTap();
  assert.equal(busy.endCalls, 0, 'shiftBusy → no end-shift (no double-fire)');
  const off = bootPausa({ enabled: true, active: false });   // paused but the shift is not effectively active
  off.api.renderPausa(off.host);
  await off.api.endTap();
  assert.equal(off.endCalls, 0, 'not effectively on-shift → no end-shift');
});

// ---- renderDisponible + attachSlideConfirm + handleEndShift: the REAL gesture + handler (Codex #190 P3) ----
// Replaces the stubbed ON-path proof with the target's real slide, real entry handler (doEndShift → handleEndShift →
// O4 → cuadre) and real #cuadre-screen «Volver» listener — modeled on the reviewer's own repro. getBoundingClientRect
// is mocked (jsdom returns 0); a drag is mousedown → mousemove past the 0.85 threshold → mouseup; showCuadre counts opens.
function bootSlide({ active = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="screen-onshift"><div id="idle-state"></div></div>'
    + '<div id="cuadre-screen"><button class="cuadre-volver" type="button">Volver al turno</button></div>'
    + '</body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document } = dom.window;
  const W = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: () => '' });
  const driverState = { status: 'available', active, last_ping: Date.now() };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const body =
    'const DRV2_ENDSHIFT_SLIDE = true, DRV2_PAUSE_ENABLED = false;\n'
    + ARROW_LINE + '\n'
    + 'let drv2SoloCancel = null, optimisticShift = null, shiftBusy = false, authGen = 1, slidingEl = null, renderPending = false, closeGen = 0, closeInFlight = false;\n'
    + 'const currentUser = { uid: "a" }, allTasks = {}, allOrders = {};\n'
    + 'const XPD = { getDriverOrders: () => [], isStalePing: () => false, RESTAURANT: {} };\n'
    + 'let NAVP_ICONS = {}; function navBtnHtml(){ return ""; } function drv2ReadNavPref(){ return "Waze"; }\n'
    + 'function renderPausa(){} function renderSoloCancel(){} function drv2GetReturnTarget(){ return null; } function drv2ClearReturnTarget(){}\n'
    + 'function toast(){}\n'
    + 'let opens = 0; function showCuadre(){ opens += 1; setCuadreOpen(true); }\n'
    + 'function render(){ renderDisponible(); }\n'
    + liftFn('setCuadreOpen') + '\n'
    + liftFn('renderDisponible') + '\n'
    + liftFn('attachSlideConfirm') + '\n'
    + 'async ' + liftFn('handleEndShift') + '\n'
    + liftStmt("$('cuadre-screen').addEventListener('click'") + '\n'
    + 'return { renderDisponible, get opens(){ return opens; }, el: () => document.getElementById("btn-end-shift-slide") };';
  const names = ['document', '$', 'ICONS', 'driverState', 'escapeHtml', 'endShiftPrompt'];
  const api = (new Function(...names, body))(document, $, ICONS, driverState, escapeHtml, () => null);
  const settle = () => new Promise((r) => setImmediate(r));
  async function drag() {
    const el = api.el(); const thumb = el.querySelector('.slide-thumb');
    el.getBoundingClientRect = () => ({ width: 300 }); thumb.getBoundingClientRect = () => ({ width: 50 });
    thumb.dispatchEvent(new W.MouseEvent('mousedown', { clientX: 6, bubbles: true }));
    document.dispatchEvent(new W.MouseEvent('mousemove', { clientX: 244, bubbles: true }));
    document.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true }));
    await settle();
  }
  // A TAP = pointer down on the thumb then up with NO mousemove (the knob never leaves rest). reduce:true stubs
  // the window's matchMedia so prefers-reduced-motion resolves true (jsdom ships no matchMedia, so default = motion ON).
  async function tap({ reduce = false } = {}) {
    const el = api.el(); const thumb = el.querySelector('.slide-thumb');
    el.getBoundingClientRect = () => ({ width: 300 }); thumb.getBoundingClientRect = () => ({ width: 50 });
    if (reduce) W.matchMedia = () => ({ matches: true });
    thumb.dispatchEvent(new W.MouseEvent('mousedown', { clientX: 6, bubbles: true }));
    document.dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true }));
    await settle();
  }
  async function key(k) { api.el().dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true })); await settle(); }
  function clickVolver() { document.querySelector('.cuadre-volver').dispatchEvent(new W.MouseEvent('click', { bubbles: true })); }
  return { api, $, document, drag, tap, key, clickVolver, get opens() { return api.opens; } };
}
t('real gesture: a completed drag runs the REAL handleEndShift and opens the cuadre exactly once', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.drag();
  assert.ok(h.api.el().classList.contains('completed'), 'a full swipe latches the slide completed');
  assert.equal(h.opens, 1, 'the real doEndShift → handleEndShift → showCuadre opened the cuadre once');
});
t('P2-2 (real): Enter/Space while the cuadre is OPEN does not reopen it — the handleEndShift re-entry guard', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.drag();            // cuadre open, opens = 1
  await h.key('Enter');
  await h.key(' ');
  assert.equal(h.opens, 1, 'the open-cuadre guard blocks the keyboard refire (pre-fix this went 2 then 3)');
});
t('stale session (real): a drag while not effectively on-shift is a no-op (the doEndShift guard)', async () => {
  const h = bootSlide({ active: false });
  h.api.renderDisponible();
  await h.drag();
  assert.equal(h.opens, 0, 'not effectively on-shift → no end-shift');
});
t('P2-1 (real): «Volver al turno» re-renders a FRESH slide that accepts a new swipe', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.drag();            // opens = 1, the old slide latched completed
  assert.equal(h.opens, 1);
  h.clickVolver();           // the real .cuadre-volver listener → setCuadreOpen(false) + render() rebuild
  assert.ok(!h.$('cuadre-screen').classList.contains('open'), 'Volver closed the cuadre');
  await h.drag();            // the REBUILT slide must drive a fresh end-shift (pre-fix: stays latched → opens stays 1)
  assert.equal(h.opens, 2, 'the rebuilt slide is un-latched and runs a new end-shift');
});

// ---- Tap-nudge: a tap (no drag) springs the knob instead of doing nothing (owner 2026-11-20 hint-free sliders) ----
// The hint text «deslizá» is gone, so a tap must TEACH the gesture: the knob nudges right then settles. Real gestures
// through the lifted attachSlideConfirm (mirrors the drag harness). prefers-reduced-motion suppresses the animation.
t('tap-nudge (real) a: a tap (no drag) adds .nudging so the knob springs right then settles', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.tap();
  assert.ok(h.api.el().classList.contains('nudging'), 'a tap nudges the knob (.nudging drives the keyframe)');
  assert.ok(!h.api.el().classList.contains('completed'), 'a tap never latches the slide completed');
  // Codex #278 P3: .nudging only springs the knob if the keyframes + animation wiring exist — assert the ACTUAL CSS so
  // a mutant that deletes the @keyframes or the animation (leaving .nudging inert) fails here, not just the class toggle.
  assert.match(FULL, /@keyframes slide-nudge\b/, 'the slide-nudge keyframes rule must exist (CSS-delete mutant dies)');
  assert.match(FULL, /\.slide-confirm\.nudging \.slide-thumb\s*\{[^}]*animation:\s*slide-nudge\b/,
    'the .nudging thumb must be wired to the slide-nudge animation (class→keyframe mutant dies)');
});
t('tap-nudge (real) b: prefers-reduced-motion suppresses the nudge (no .nudging class)', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.tap({ reduce: true });
  assert.ok(!h.api.el().classList.contains('nudging'), 'reduced-motion ⇒ no nudge animation');
});
t('tap-nudge (real) c: a full drag past threshold STILL confirms and never nudges (unchanged)', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.drag();
  assert.ok(h.api.el().classList.contains('completed'), 'a real swipe past 0.85 still confirms');
  assert.ok(!h.api.el().classList.contains('nudging'), 'a real swipe confirms — it never nudges');
  assert.equal(h.opens, 1, 'the drag fired onConfirm exactly once');
});
t('tap-nudge (real) d: a tap NEVER calls onConfirm (no end-shift)', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  await h.tap();
  assert.equal(h.opens, 0, 'a tap must not fire onConfirm — the cuadre never opens');
});
t('tap-nudge (real) e: a later tap supersedes the earlier settle timer — a stale timer cannot cut a fresh nudge short (Codex #278 P3)', async () => {
  const h = bootSlide({ active: true });
  h.api.renderDisponible();
  const timers = [];
  const realST = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };   // capture settle timers (settle() uses setImmediate, so awaits still flush)
  try {
    await h.tap();                                                 // tap 1 → gen 1, .nudging on, schedules timers[0]
    assert.ok(h.api.el().classList.contains('nudging'), 'tap 1 nudges');
    await h.tap();                                                 // tap 2 → gen 2, re-nudges, schedules timers[1]
    assert.ok(h.api.el().classList.contains('nudging'), 'tap 2 re-nudges');
    assert.equal(timers.length, 2, 'each tap scheduled exactly its own settle timer');
    timers[0]();                                                   // the STALE tap-1 timer fires (simulated +360 ms)
    assert.ok(h.api.el().classList.contains('nudging'),
      'the stale tap-1 timer must NOT strip tap-2 nudge — generation guard (pre-fix: the bare remove kills it → RED)');
    timers[1]();                                                   // tap-2 own timer fires → settles
    assert.ok(!h.api.el().classList.contains('nudging'), 'tap-2 own timer settles its nudge');
  } finally {
    globalThis.setTimeout = realST;
  }
});
t('a11y (real) f: the end-shift slide is a labelled button; Enter AND Space each end the shift once through attachSlideConfirm\'s shared gate — no per-slider keydown (Codex #278 P2)', async () => {
  for (const key of ['Enter', ' ']) {
    const h = bootSlide({ active: true });
    h.api.renderDisponible();
    assert.equal(h.api.el().getAttribute('role'), 'button', `[${key}] the slide-confirm is exposed as a button`);
    assert.equal(h.api.el().tabIndex, 0, `[${key}] the slide-confirm is focusable (keyboard reachable)`);
    assert.match(h.api.el().getAttribute('aria-label') || '', /Enter/, `[${key}] the accessible instruction names the Enter activation (the removed «deslizá» replaced for AT)`);
    await h.key(key);
    assert.equal(h.opens, 1, `[${key}] runs the REAL end-shift once through the shared single-fire gate`);
    await h.key(key);
    assert.equal(h.opens, 1, `[${key}] the shared gate blocks any repeat key activation (no double end-shift)`);
  }
});
t('a11y (real) g: a slider with NO per-slider handler (pickup / per-phase) is keyboard-operable PURELY via attachSlideConfirm\'s shared gate — Enter AND Space each fire onConfirm once (Codex #278 P2)', async () => {
  for (const key of ['Enter', ' ']) {
    const dom = new JSDOM('<!doctype html><body><div class="slide-confirm" id="pk"><div class="slide-fill"></div><div class="slide-text">Recoger pedido</div><div class="slide-thumb"></div></div></body>', { url: 'https://driver.test/', pretendToBeVisual: true });
    const document = dom.window.document, W = dom.window;
    const $ = (id) => document.getElementById(id);
    const body = 'let slidingEl = null, renderPending = false;\n'
      + 'function renderActiveAndQueue(){}\n'
      + 'function toast(){}\n'
      + liftFn('attachSlideConfirm') + '\n'
      + 'return { attach: (cb) => attachSlideConfirm("pk", cb) };';
    const api = (new Function('document', '$', body))(document, $);
    let fired = 0;
    api.attach(async () => { fired += 1; });
    const el = $('pk');
    assert.equal(el.tabIndex, 0, `[${key}] a gap slider becomes focusable PURELY from the shared gate`);
    assert.equal(el.getAttribute('role'), 'button', `[${key}] a gap slider becomes a button PURELY from the shared gate`);
    el.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(fired, 1, `[${key}] the shared gate fires onConfirm once for a slider that had NO keydown of its own`);
    el.dispatchEvent(new W.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await new Promise((r) => setImmediate(r));
    assert.equal(fired, 1, `[${key}] single-fire blocks a repeat`);
  }
});

// ---- Sliders: hint-free + «Aceptar» (owner 2026-11-20) — read FROM SOURCE ----
const STACKED_SRC = readFileSync(join(__dir, 'stacked-view.js'), 'utf8');
t('sliders carry NO «deslizá» hint node, and the accept label is «Aceptar» (owner 2026-11-20)', () => {
  // All driver sliders are now hint-free, including the pickup slider (the last index.html hint, inside
  // SLICE2:STACKED-BRANCH, now dropped via the SLICE3DEPS:PICKUP-HINT carve — slice3-freeze restores it to 07e5ab38).
  assert.equal((SCRIPT.match(/class="slide-hint">deslizá/g) || []).length, 0, 'NO «deslizá» hint node remains in index.html (pickup carved)');
  assert.doesNotMatch(STACKED_SRC, /class="slide-hint">deslizá/, 'no .slide-hint node in stacked-view.js sliders');
  assert.doesNotMatch(SCRIPT, /slide-text">Deslizá para aceptar/, 'index accept slider label is «Aceptar», not «Deslizá para aceptar»');
  assert.doesNotMatch(STACKED_SRC, /slide-text">Deslizá para aceptar/, 'stacked accept slider label is «Aceptar»');
  assert.match(SCRIPT, /class="slide-text">Aceptar<\/div>/, 'the index accept slider shows exactly «Aceptar»');
});

t('notif banner copy is voseo: «Habilitá notificaciones» + button «Habilitá» (owner 2026-11-20)', () => {
  // The not_enabled notification banner (renderNotifBanner). Voseo per standing rule 9; the body line is unchanged.
  assert.match(SCRIPT, /<strong>Habilitá notificaciones<\/strong>/, 'title is voseo «Habilitá notificaciones»');
  assert.match(SCRIPT, />Habilitá<\/button>/, 'the enable button reads «Habilitá»');
  assert.doesNotMatch(SCRIPT, /<strong>Habilita notificaciones<\/strong>/, 'no non-voseo «Habilita notificaciones»');
  assert.doesNotMatch(SCRIPT, />Habilitar<\/button>/, 'no non-voseo «Habilitar» button');
});

await (async () => {
  for (const [name, fn] of _tests) {
    try { await fn(); passed += 1; } catch (e) { console.error('✗ ' + name); throw e; }
  }
})();
console.log(`✓ endshift: ${passed} tests passed`);
