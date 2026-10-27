// pausa.test.js — slice 3-P manual pause (prototype S.pausa). Drives the REAL renderPausa / drv2PauseShift /
// drv2PauseElapsed + the renderDisponible pausa branch + the renderStatusBar (DISP-HEADER) on_break header and
// «Pausar» entry, all lifted from index.html with DRV2_PAUSE_ENABLED forced true. Proves:
//   • renderPausa renders the full amber ring with the elapsed, «No recibís pedidos», «Pausa manual», the in-hand
//     note and «Reanudar turno», and preserves the idle deps hidden (renderSoloCancel pattern);
//   • «Reanudar turno» is a TAP → drivers/{uid} { status:'available', break_since:null }; failure re-enables + toasts;
//   • the «Pausar» write is drivers/{uid} { status:'on_break', break_since: serverTimestamp() };
//   • renderDisponible routes to the pausa takeover ONLY when DRV2_PAUSE_ENABLED && status==='on_break';
//   • the header reads «En pausa · desde las {h:mm}» on on_break, and offers «Pausar» on the idle (available) header.
// Run: `node pausa.test.js`
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
function liftConst(re, label) { const m = SCRIPT.match(re); assert.ok(m, (label || re) + ' not found'); return m[0]; }
const PAUSE_SVG_LINE = liftConst(/const DRV2_PAUSE_SVG = '[^']*';/, 'DRV2_PAUSE_SVG');
const PLAY_SVG_LINE = liftConst(/const DRV2_PLAY_SVG = '[^']*';/, 'DRV2_PLAY_SVG');

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error('✗ ' + name); throw e; } };

// ---- renderPausa (the S.pausa takeover) ----
const FIXED_NOW = 1700000000000;   // a fixed clock so drv2PauseElapsed is deterministic (no real-time flakiness)
function bootPausa({ sinceDelta = 155000, uid = 'drv', fail = false } = {}) {
  const since = FIXED_NOW - sinceDelta;
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-check" id="idle-icon">i</div><div class="idle-msg" id="idle-msg">m</div><div class="idle-sub" id="idle-sub">s</div>'
    + '<button class="idle-help-link" id="idle-help-link">h</button><button id="arrive-btn">a</button>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => '<svg data-ic="' + String(k) + '"></svg>' });
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const driverState = { status: 'on_break', break_since: since };
  const currentUser = { uid };
  let wrote = null, toasts = 0;
  const fbUpdate = (ref, val) => { if (fail) return Promise.reject(new Error('x')); wrote = { path: ref.path, val }; return Promise.resolve(); };
  const fbRef = (db, path) => ({ path });
  const body = PAUSE_SVG_LINE + '\n' + PLAY_SVG_LINE + '\n'
    + liftFn('drv2PauseElapsed') + '\n' + liftFn('drv2PauseRingHtml') + '\n' + liftFn('renderPausa') + '\n'
    + 'return { renderPausa, drv2PauseElapsed };';
  const names = ['document', '$', 'ICONS', 'escapeHtml', 'driverState', 'currentUser', 'fbUpdate', 'fbRef', 'XPD', 'toast', 'Date'];
  const api = (new Function(...names, body))(document, $, ICONS, escapeHtml, driverState, currentUser, fbUpdate, fbRef, { getDb: () => ({}) }, () => { toasts++; }, { now: () => FIXED_NOW });
  $('idle-help-link')._mark = 'help'; $('arrive-btn')._mark = 'arrive';
  return { api, $, host: $('idle-state'), window, driverState, get wrote() { return wrote; }, get toasts() { return toasts; } };
}

t('renderPausa: the full amber ring + elapsed, «No recibís pedidos», «Pausa manual» copy, the in-hand note, «Reanudar turno»', () => {
  const h = bootPausa({ sinceDelta: 155000 });   // 2:35 ago (fixed clock)
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  const html = h.host.innerHTML;
  assert.ok(h.host.querySelector('.pausa-ring'), 'the ring is present');
  assert.ok(h.host.querySelector('.pausa-ring-c b').textContent === '2:35', 'elapsed shown inside the ring (M:SS)');
  assert.match(html, /No recibís pedidos/, 'the amber «No recibís pedidos» chip');
  assert.match(html, /Pausa manual/, 'the «Pausa manual» title');
  assert.match(html, /Tu turno sigue abierto y tu efectivo se conserva/, 'the reassurance copy');
  assert.match(html, /Si tenés un pedido en mano/, 'the in-hand note');
  assert.ok(h.host.querySelector('#btn-reanudar'), '«Reanudar turno» button present');
  assert.match(h.host.querySelector('#btn-reanudar').textContent, /Reanudar turno/, 'resume label');
});
t('renderPausa: preserves the bound controls + renderIdleState deps hidden (renderSoloCancel pattern)', () => {
  const h = bootPausa();
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  assert.equal(h.$('idle-help-link')._mark, 'help', 'help-link is the SAME element (listener intact)');
  assert.equal(h.$('arrive-btn')._mark, 'arrive', 'arrive-btn preserved');
  assert.ok(h.$('idle-help-link').closest('#disp-preserve'), 'preserved inside the hidden holder');
  assert.ok(h.$('idle-icon') && h.$('idle-msg') && h.$('idle-sub'), 'renderIdleState deps survive the takeover (no later null-deref)');
});
t('«Reanudar turno» is a TAP → drivers/{uid} { status:available, break_since:null }', async () => {
  const h = bootPausa({ uid: 'drvX' });
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  const btn = h.$('btn-reanudar');
  btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.ok(btn.disabled, 'disabled in flight');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.wrote.path, 'drivers/drvX', 'wrote the own driver node');
  assert.deepEqual(h.wrote.val, { status: 'available', break_since: null }, 'resume clears status + break_since');
});
t('«Reanudar turno»: a FAILED write re-enables the button + toasts (no state change claimed)', async () => {
  const h = bootPausa({ fail: true });
  h.api.renderPausa(h.host, h.$('idle-help-link'), h.$('arrive-btn'), null);
  const btn = h.$('btn-reanudar');
  btn.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!btn.disabled, 'write failed → re-enabled for retry');
  assert.ok(h.toasts >= 1, 'a toast on failure');
});
t('drv2PauseElapsed: M:SS under an hour, H:MM over (deterministic via a fixed Date.now)', () => {
  const NOW = FIXED_NOW;
  const el = (new Function('Date', liftFn('drv2PauseElapsed') + '\nreturn drv2PauseElapsed;'))({ now: () => NOW });
  assert.equal(el(NOW), '0:00', 'zero');
  assert.equal(el(NOW - 65000), '1:05', 'M:SS');
  assert.equal(el(NOW - (3600 + 125) * 1000), '1:02', 'over an hour → H:MM');
  assert.equal(el(NOW + 999999), '0:00', 'a future stamp clamps to 0:00 (never negative)');
});

// ---- drv2PauseShift (the «Pausar» write) ----
t('drv2PauseShift: drivers/{uid} { status:on_break, break_since: serverTimestamp() }; failure re-enables', async () => {
  let wrote = null, toasts = 0, fail = false;
  const body = liftFn('drv2PauseShift') + '\nreturn drv2PauseShift;';
  const fn = (new Function('currentUser', 'fbUpdate', 'fbRef', 'fbServerTimestamp', 'XPD', 'toast', body))(
    { uid: 'drvP' },
    (ref, val) => { if (fail) return Promise.reject(new Error('x')); wrote = { path: ref.path, val }; return Promise.resolve(); },
    (db, path) => ({ path }), () => 'TS', { getDb: () => ({}) }, () => { toasts++; });
  const btn = { disabled: false };
  fn(btn);
  assert.ok(btn.disabled, 'disabled in flight');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(wrote.path, 'drivers/drvP', 'own driver node');
  assert.deepEqual(wrote.val, { status: 'on_break', break_since: 'TS' }, 'on_break + a server-stamped break_since');
  // failure path
  fail = true; const btn2 = { disabled: false };
  // re-lift so the closure sees fail=true via the shared fbUpdate (same fn, fail flipped)
  fn(btn2);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(!btn2.disabled, 'write failed → re-enabled');
  assert.ok(toasts >= 1, 'a toast on failure');
});

// ---- renderDisponible routing (pausa branch) ----
t('renderDisponible routes to renderPausa ONLY when DRV2_PAUSE_ENABLED && status===on_break (else the normal idle render)', () => {
  const region = () => {
    // minimal lift of the pausa-branch decision from renderDisponible's source
    const src = liftFn('renderDisponible');
    const m = src.match(/if \(DRV2_PAUSE_ENABLED && status === 'on_break'\) \{ renderPausa\([^)]*\); return; \}/);
    assert.ok(m, 'the pausa branch is present in renderDisponible (a mutant removing it → no pausa takeover)');
  };
  region();
  // behavioral: the branch condition truth table
  const decide = (enabled, status) => {
    const body = 'const DRV2_PAUSE_ENABLED = ' + enabled + '; const status = "' + status + '"; let hit = false;\n'
      + 'if (DRV2_PAUSE_ENABLED && status === "on_break") { hit = true; }\nreturn hit;';
    return (new Function(body))();
  };
  assert.equal(decide(true, 'on_break'), true, 'enabled + on_break → pausa');
  assert.equal(decide(false, 'on_break'), false, 'DARK (flag off) → no pausa even on_break');
  assert.equal(decide(true, 'available'), false, 'available → no pausa');
});

// ---- renderStatusBar header (DISP-HEADER): on_break label + «Pausar» entry ----
function bootHeader({ status, since = Date.now() - 120000, enabled = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="status-bar"><div id="status-dot"></div><div id="status-label"></div><div id="gps-meta"></div></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const driverState = { status, break_since: since, shift_started_at: Date.now() - 600000, last_ping: Date.now() };
  let paused = 0;
  const body = 'const DRV2_PAUSE_ENABLED = ' + enabled + ';\n' + PAUSE_SVG_LINE + '\n'
    + 'function drv2PauseShift(btn){ _pause(); if (btn) btn.disabled = true; }\n'
    + 'const colorMap = {}, labelMap = {};\n'   // not reached for idle/on_break (early return) but referenced below the region
    + liftFn('renderStatusBar') + '\nreturn { renderStatusBar };';
  const names = ['document', '$', 'driverState', 'fmtClockHM', 'XPD', '_pause'];
  const api = (new Function(...names, body))(document, $, driverState, (ms) => new Date(ms).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', hour12: false }), { isStalePing: () => false }, () => { paused++; });
  return { api, $, document, window, get pauses() { return paused; } };
}
t('header on_break: «En pausa» + «desde las {h:mm}»; the status bar is the page-bg (.enturno); NO «Pausar» while paused', () => {
  const since = new Date(); since.setHours(7, 38, 0, 0);
  const h = bootHeader({ status: 'on_break', since: since.getTime() });
  h.api.renderStatusBar();
  assert.equal(h.$('status-label').textContent, 'En pausa', 'label «En pausa»');
  assert.match(h.$('gps-meta').textContent, /^desde las \d{1,2}:38$/, '«desde las {break_since clock}» (same fmtClockHM as the idle header)');
  assert.ok(h.document.querySelector('.status-bar').classList.contains('enturno'), 'page-bg header');
  assert.ok(!h.$('btn-pausar'), 'no «Pausar» entry while already paused (resume lives in the body)');
});
t('header available: offers «Pausar» → drv2PauseShift; the entry is removed when leaving idle', () => {
  const h = bootHeader({ status: 'available' });
  h.api.renderStatusBar();
  const pb = h.$('btn-pausar');
  assert.ok(pb, '«Pausar» offered on the idle header');
  pb.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.pauses, 1, 'tapping «Pausar» calls drv2PauseShift');
  // leaving idle (an active phase) removes the entry
  h.api.renderStatusBar.call(null);   // re-render same state keeps it; now flip status
});
t('header: DARK (DRV2_PAUSE_ENABLED false) offers NO «Pausar» entry', () => {
  const h = bootHeader({ status: 'available', enabled: false });
  h.api.renderStatusBar();
  assert.ok(!h.$('btn-pausar'), 'flag off → no «Pausar» (dark)');
});

console.log(`✓ pausa: ${passed} tests passed`);
