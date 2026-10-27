// pausa.test.js — slice 3-P manual pause (prototype S.pausa), ack-gated (Codex r1). Drives the REAL renderPausa /
// drv2WritePauseState / drv2PauseShift / drv2IsPaused / drv2PauseElapsed, the renderStatusBar on_break header + the
// ticking ring, and the SLICE3:PAUSE-BOARD board-boundary logic — all lifted from index.html with DRV2_PAUSE_ENABLED
// forced true and a controllable (deferred) RTDB write. Proves:
//   • the pause/resume state is CONFIRMED on the write ack, not the RTDB optimistic flip: a pending pause stays on
//     disponible (busy), a pending resume stays on pausa (busy), a rejection toasts and reverts (Codex r1 #1);
//   • «La pausa empieza al entregarlo»: a pause requested with work in hand defers (no on_break write); it applies via
//     the SAME writer when the board empties, and a fresh offer that tick wins (Codex r1 #3);
//   • unaccepted offers are suppressed at the board boundary while paused (Codex r1 #2);
//   • the ring ticks on the renderStatusBar interval (Codex r1 #4); the header test uses an injected clock (#5);
//   • the shipped DRV2_PAUSE_ENABLED is false (dark) read FROM SOURCE; the in-hand copy is pinned (kills the survivors).
// Run: `node pausa.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'))('jsdom');
const INDEX = readFileSync(join(__dir, 'index.html'), 'utf8');
const SCRIPT = INDEX.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let s = SCRIPT.indexOf('function ' + name + '('); assert.notEqual(s, -1, name + ' not found');
  let d = 0, seen = false;
  for (let i = s; i < SCRIPT.length; i++) { if (SCRIPT[i] === '{') { d++; seen = true; } else if (SCRIPT[i] === '}') { d--; if (seen && d === 0) return SCRIPT.slice(s, i + 1); } }
  throw new Error('unbalanced ' + name);
}
function liftConst(re, label) { const m = SCRIPT.match(re); assert.ok(m, (label || re) + ' not found'); return m[0]; }
const PAUSE_SVG_LINE = liftConst(/const DRV2_PAUSE_SVG = '[^']*';/, 'DRV2_PAUSE_SVG');
const PLAY_SVG_LINE = liftConst(/const DRV2_PLAY_SVG = '[^']*';/, 'DRV2_PLAY_SVG');
const INFO_SVG_LINE = liftConst(/const DRV2_INFO_SVG = '[^']*';/, 'DRV2_INFO_SVG');
const FIXED_NOW = 1700000000000;

let passed = 0;
const _tests = [];
const t = (name, fn) => { _tests.push({ name, fn }); };

// Shared harness: renderPausa + the ack-gated writer + drv2PauseShift + drv2IsPaused + state, over a controllable
// (deferred) fbUpdate and a render spy. `status`/`active` seed the optimistic driverState; `orders` the board.
function boot({ since = FIXED_NOW - 155000, uid = 'drv', status = 'on_break', active = false, orders = [] } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">m</div><div class="idle-sub" id="idle-sub">s</div>'
    + '<button class="idle-help-link" id="idle-help-link">h</button><button id="arrive-btn">a</button>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => '<svg data-ic="' + String(k) + '"></svg>' });
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const driverState = { status, active, break_since: since, last_ping: FIXED_NOW };
  let writes = [], toasts = 0, renders = 0;
  const fbUpdate = (ref, val) => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); writes.push({ path: ref.path, val, resolve: res, reject: rej }); return p; };
  const body = PAUSE_SVG_LINE + '\n' + PLAY_SVG_LINE + '\n' + INFO_SVG_LINE + '\n'
    + 'let drv2PauseWriteKind = null, drv2PausePendingIntent = false; let allTasks = {}, allOrders = {};\n'
    + 'function renderActiveAndQueue(){ _render(); }\n'
    + liftFn('drv2PauseElapsed') + '\n' + liftFn('drv2PauseRingHtml') + '\n'
    + liftFn('drv2IsPaused') + '\n' + liftFn('drv2WritePauseState') + '\n' + liftFn('drv2PauseShift') + '\n' + liftFn('renderPausa') + '\n'
    + 'return { renderPausa, drv2PauseShift, drv2IsPaused, drv2WritePauseState,'
    + ' state: () => ({ kind: drv2PauseWriteKind, intent: drv2PausePendingIntent }),'
    + ' setStatus: (s) => { driverState.status = s; } };';
  const names = ['document', '$', 'ICONS', 'escapeHtml', 'driverState', 'currentUser', 'fbUpdate', 'fbRef', 'fbServerTimestamp', 'XPD', 'toast', 'Date', '_render'];
  const api = (new Function(...names, body))(document, $, ICONS, escapeHtml, driverState, { uid },
    fbUpdate, (db, path) => ({ path }), () => 'TS', { getDb: () => ({}), getDriverOrders: () => orders }, () => { toasts++; }, { now: () => FIXED_NOW }, () => { renders++; });
  return { api, $, host: $('idle-state'), window, driverState, get writes() { return writes; }, get toasts() { return toasts; }, get renders() { return renders; } };
}

// ---- renderPausa builder (+ the in-hand copy survivor) ----
t('renderPausa: the amber ring + elapsed, «No recibís pedidos», «Pausa manual», the in-hand note (pinned copy), «Reanudar turno»', () => {
  const h = boot({ since: FIXED_NOW - 155000 });
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  assert.equal(h.host.querySelector('.pausa-ring-c b').textContent, '2:35', 'elapsed in the ring (M:SS, fixed clock)');
  assert.match(h.host.innerHTML, /No recibís pedidos/, 'the amber chip');
  assert.match(h.host.innerHTML, /Pausa manual/, 'the title');
  // Survivor pin (Codex r1): the in-hand semantics copy — changing it must RED this.
  assert.match(h.host.innerHTML, /Si tenés un pedido en mano/, 'in-hand note title');
  assert.match(h.host.innerHTML, /La pausa empieza al entregarlo; no corta nada en curso/, 'in-hand note body (exact semantics)');
  assert.ok(h.host.querySelector('#btn-reanudar'), '«Reanudar turno»');
});

// ---- Codex r1 #1: ack-gated resume ----
t('resume is ack-gated: pending stays PAUSED (busy); resolve confirms; reject toasts + stays paused', async () => {
  const h = boot({ status: 'on_break' });
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  const btn = h.$('btn-reanudar');
  btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(btn.disabled, 'button busy in flight');
  assert.equal(h.api.state().kind, 'resume', 'a resume write is in flight');
  assert.equal(h.api.drv2IsPaused(), true, 'STILL paused while the resume is pending (optimistic available is ignored)');
  assert.equal(h.writes[0].path, 'drivers/drv', 'wrote the own driver node');
  assert.deepEqual(h.writes[0].val, { status: 'available', break_since: null }, 'resume clears status + break_since');
  h.driverState.status = 'available';   // RTDB optimistic flip (server will confirm)
  h.writes[0].resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.api.state().kind, null, 'settled on ack');
  assert.equal(h.api.drv2IsPaused(), false, 'no longer paused once confirmed');
  // reject path
  const h2 = boot({ status: 'on_break' });
  h2.api.renderPausa(h2.host, h2.$('idle-help-link'), h2.$('arrive-btn'), null);
  const btn2 = h2.$('btn-reanudar');
  btn2.dispatchEvent(new h2.window.MouseEvent('click', { bubbles: true }));
  h2.driverState.status = 'on_break';   // the server rejects → RTDB reverts to on_break
  h2.writes[0].reject(new Error('x'));
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!btn2.disabled, 'rejected → re-enabled');
  assert.ok(h2.toasts >= 1, 'a toast on rejection');
  assert.equal(h2.api.drv2IsPaused(), true, 'stays PAUSED after a rejected resume');
});

// ---- Codex r1 #1: ack-gated pause (direct, no work in hand) ----
t('pause is ack-gated: drv2PauseShift with no work → pending is NOT-yet-paused (busy); resolve confirms; reject toasts', async () => {
  const h = boot({ status: 'available', orders: [] });
  const btn = { disabled: false };
  h.api.drv2PauseShift(btn);
  assert.ok(btn.disabled, 'busy in flight');
  assert.equal(h.api.state().kind, 'pause', 'a pause write is in flight');
  assert.equal(h.api.drv2IsPaused(), false, 'NOT yet paused while the pause is pending (no false «En pausa»)');
  assert.deepEqual(h.writes[0].val, { status: 'on_break', break_since: 'TS' }, 'on_break + server-stamped break_since');
  h.driverState.status = 'on_break';
  h.writes[0].resolve();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.api.drv2IsPaused(), true, 'confirmed paused on ack');
  const h2 = boot({ status: 'available', orders: [] });
  const b2 = { disabled: false };
  h2.api.drv2PauseShift(b2);
  h2.writes[0].reject(new Error('x'));
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!b2.disabled, 'rejected → re-enabled'); assert.ok(h2.toasts >= 1, 'toast on rejection');
});

// ---- Codex r1 #3: deferred pause with work in hand ----
t('drv2PauseShift with ACCEPTED work in hand → records a deferred intent, writes NO on_break now', () => {
  const h = boot({ status: 'available', orders: [{ phase: 'delivery' }] });
  const btn = { disabled: false };
  h.api.drv2PauseShift(btn);
  assert.equal(h.api.state().intent, true, 'a pending-pause intent is recorded');
  assert.equal(h.writes.length, 0, 'NO on_break write while orders are active (La pausa empieza al entregarlo)');
  assert.ok(btn.disabled, 'the button reflects the pending intent (busy)');
});

// ---- drv2IsPaused truth table ----
t('drv2IsPaused: pause-in-flight=NOT paused; resume-in-flight=STILL paused; settled=status===on_break', () => {
  const mk = (seed) => {
    const body = 'let driverState = ' + JSON.stringify(seed.ds) + '; let drv2PauseWriteKind = ' + JSON.stringify(seed.kind) + ';\n' + liftFn('drv2IsPaused') + '\nreturn drv2IsPaused;';
    return (new Function(body))();
  };
  assert.equal(mk({ ds: { status: 'on_break' }, kind: 'pause' })(), false, 'pause pending → not confirmed');
  assert.equal(mk({ ds: { status: 'available' }, kind: 'resume' })(), true, 'resume pending → still paused');
  assert.equal(mk({ ds: { status: 'on_break' }, kind: null })(), true, 'settled on_break → paused (incl. committed-on-reload)');
  assert.equal(mk({ ds: { status: 'available' }, kind: null })(), false, 'settled available → not paused');
});

// ---- drv2PauseElapsed (deterministic) ----
t('drv2PauseElapsed: M:SS under an hour, H:MM over (fixed clock)', () => {
  const el = (new Function('Date', liftFn('drv2PauseElapsed') + '\nreturn drv2PauseElapsed;'))({ now: () => FIXED_NOW });
  assert.equal(el(FIXED_NOW), '0:00');
  assert.equal(el(FIXED_NOW - 65000), '1:05');
  assert.equal(el(FIXED_NOW - (3600 + 125) * 1000), '1:02');
  assert.equal(el(FIXED_NOW + 999999), '0:00', 'a future stamp clamps to 0:00');
});

// ---- Codex r1 #4/#5: the ticking ring + header with an injected clock ----
function bootHeader({ status = 'available', since = FIXED_NOW - 120000, enabled = true, now = FIXED_NOW, withRing = false } = {}) {
  const ring = withRing ? '<div id="idle-state"><div class="pausa-ring-c"><b>old</b></div></div>' : '';
  const dom = new JSDOM('<!doctype html><html><body>' + ring + '<div class="status-bar"><div id="status-dot"></div><div id="status-label"></div><div id="gps-meta"></div><button class="duty-toggle on" id="duty-toggle-on"></button></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const driverState = { status, break_since: since, shift_started_at: now - 600000, last_ping: now };
  let paused = 0;
  const body = 'const DRV2_PAUSE_ENABLED = ' + enabled + '; const DRV2_ENDSHIFT_SLIDE = false;\n' + PAUSE_SVG_LINE + '\n'
    + 'let drv2PauseWriteKind = null;\n' + liftFn('drv2IsPaused') + '\n'
    + 'function drv2PauseShift(){ _pause(); }\n'
    + liftFn('drv2PauseElapsed') + '\n' + liftFn('renderStatusBar') + '\nreturn { renderStatusBar };';
  const names = ['document', '$', 'driverState', 'fmtClockHM', 'XPD', 'Date', '_pause'];
  const api = (new Function(...names, body))(document, $, driverState,
    (ms) => new Date(ms).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: false }), { isStalePing: () => false }, { now: () => now }, () => { paused++; });
  return { api, $, document, window, get pauses() { return paused; } };
}
t('Codex r1 #4: the ring ticks on the renderStatusBar interval (advance the clock 60s → 2:35 → 3:35)', () => {
  const since = FIXED_NOW - 155000;   // 2:35 at FIXED_NOW
  const h = bootHeader({ status: 'on_break', since, now: FIXED_NOW, withRing: true });
  h.api.renderStatusBar();
  assert.equal(h.$('status-label').textContent, 'En pausa');
  assert.equal(h.document.querySelector('.pausa-ring-c b').textContent, '2:35', 'ring set on render');
  const h2 = bootHeader({ status: 'on_break', since, now: FIXED_NOW + 60000, withRing: true });   // the 30s tick re-calls renderStatusBar, clock +60s
  h2.api.renderStatusBar();
  assert.equal(h2.document.querySelector('.pausa-ring-c b').textContent, '3:35', 'the tick advanced the ring (not stuck at 2:35)');
});
t('Codex r1 #5: the on_break header uses the injected clock — «desde las {h:mm}» regardless of wall time', () => {
  const since = new Date(FIXED_NOW); since.setHours(7, 38, 0, 0);
  const h = bootHeader({ status: 'on_break', since: since.getTime(), now: since.getTime() + 120000 });
  h.api.renderStatusBar();
  assert.match(h.$('gps-meta').textContent, /^desde las \d{1,2}:38$/, 'subtitle present with the injected clock (no time-of-day flake)');
});
t('header available: offers «Pausar» → drv2PauseShift; dark → none', () => {
  const on = bootHeader({ status: 'available', enabled: true });
  on.api.renderStatusBar();
  const pb = on.$('btn-pausar'); assert.ok(pb, '«Pausar» offered');
  pb.dispatchEvent(new on.window.MouseEvent('click', { bubbles: true }));
  assert.equal(on.pauses, 1, 'tap → drv2PauseShift');
  const off = bootHeader({ status: 'available', enabled: false });
  off.api.renderStatusBar();
  assert.ok(!off.$('btn-pausar'), 'dark → no «Pausar»');
});

// ---- Codex r1 #2/#3: the SLICE3:PAUSE-BOARD board-boundary region ----
function runBoard({ paused = false, intent = false, kind = null, orders = [] } = {}) {
  const region = SCRIPT.match(/SLICE3:PAUSE-BOARD:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:PAUSE-BOARD:END/)[1];
  const dom = new JSDOM('<!doctype html><body><div id="screen-onshift"></div><div id="idle-state"></div><div id="incoming-banner-slot">b</div><div id="active-order-slot">a</div><div id="queue-slot">q</div></body>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  let idle = 0, tab = 0, wrote = null, returned = false;
  const body = 'const DRV2_PAUSE_ENABLED = true; let drv2PausePendingIntent = ' + intent + '; let drv2PauseWriteKind = ' + JSON.stringify(kind) + ';\n'
    + 'function drv2IsPaused(){ return ' + paused + '; }\n'
    + 'function drv2WritePauseState(k){ _wrote(k); } function mountTabBar(){ _tab(); } function renderIdleState(){ _idle(); }\n'
    + 'const idleSlot = $("idle-state"), bannerSlot = $("incoming-banner-slot"), activeSlot = $("active-order-slot"), queueSlot = $("queue-slot");\n'
    + 'function run(){ ' + region + '\n return "fell-through"; }\n'
    + 'return { run, intent: () => drv2PausePendingIntent };';
  const api = (new Function('$', 'orders', '_idle', '_tab', '_wrote', 'document', body))($, orders, () => { idle++; }, () => { tab++; }, (k) => { wrote = k; }, document);
  const result = api.run();
  return { result, idle, tab, wrote, intent: api.intent(), $, bannerCleared: $('incoming-banner-slot').innerHTML === '' };
}
t('#2: CONFIRMED paused + no accepted work → the pausa screen (renderIdleState) + return (suppresses a late offer)', () => {
  const r = runBoard({ paused: true, orders: [{ phase: 'awaiting_acceptance' }] });   // a late unaccepted offer only
  assert.notEqual(r.result, 'fell-through', 'the region returns — the offer branch below never runs');
  assert.equal(r.idle, 1, 'renderIdleState → renderDisponible → renderPausa');
  assert.ok(r.bannerCleared, 'the offer banner slot is cleared');
});
t('#2: paused WITH accepted work → falls through (accepted work stays accessible, not the pausa takeover)', () => {
  const r = runBoard({ paused: true, orders: [{ phase: 'delivery' }] });
  assert.equal(r.result, 'fell-through', 'accepted work renders normally below');
});
t('#3: pending intent + TRULY empty board → applies on_break via the SAME writer', () => {
  const r = runBoard({ paused: false, intent: true, orders: [] });
  assert.equal(r.wrote, 'pause', 'drv2WritePauseState("pause") — the deferred pause applies');
  assert.equal(r.intent, false, 'the intent is consumed');
});
t('#3 race: pending intent but a fresh OFFER arrived this tick → the offer wins, the intent WAITS (no write)', () => {
  const r = runBoard({ paused: false, intent: true, orders: [{ phase: 'awaiting_acceptance' }] });
  assert.equal(r.wrote, null, 'NO pause write — the offer (orders not empty) wins');
  assert.equal(r.intent, true, 'the intent stays pending');
});

// ---- Survivor (Codex r1): the SHIPPED flag is false, read FROM SOURCE ----
t('production DRV2_PAUSE_ENABLED is false (dark) — read from the index.html source, not a supplied flag', () => {
  assert.match(INDEX, /const DRV2_PAUSE_ENABLED = false;/, 'the shipped constant is false; flipping it true in source → RED (kills the flag-flip survivor)');
  assert.doesNotMatch(INDEX, /const DRV2_PAUSE_ENABLED = true;/, 'never shipped true');
});

await (async () => {
  for (const { name, fn } of _tests) {
    try { await fn(); passed += 1; } catch (e) { console.error('✗ ' + name); throw e; }
  }
})();
console.log(`✓ pausa: ${passed} tests passed`);
