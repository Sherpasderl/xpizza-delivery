// Offline banner (owner 10-25) — HANDLER test. Executes the REAL shipped offline-banner functions (offerIsOffline /
// offlineInHand / applyOfflineBanner / ensureOfflineBanner / stopOfflineBanner) AND the REAL host region bodies that
// wire them (OFFLINE-START-GEN-3 + OFFLINE-INIT-3 at shift start, OFFLINE-TEARDOWN-3 at cleanup, RENDER-OFFLINE-3 on
// every render into an active shift), all lifted from index.html, over a jsdom on-shift DOM. Proves: the banner shows
// only offline+in-hand; it follows the RTDB edge live; restoration (render) initializes it; a shift-start resolving
// after sign-out attaches nothing (the session gen); visibility refreshes after every board render; teardown
// unsubscribes. The in-source mutants Codex named die here: host init removed, host teardown removed.
// Run: `node offline-banner.test.js`.
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
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function regionBody(name) {
  const s = SCRIPT.indexOf(`SLICE3:${name}:START`);
  const bodyStart = SCRIPT.indexOf('\n', s) + 1;
  const end = SCRIPT.indexOf(`SLICE3:${name}:END`, bodyStart);
  return SCRIPT.slice(bodyStart, SCRIPT.lastIndexOf('/*', end));
}
// the contiguous offline-banner block only (stops BEFORE the gpsoff functions) — the module-state lets + OFFLINE_WIFI
// + offlineInHand/applyOfflineBanner/ensureOfflineBanner/stopOfflineBanner, verbatim.
const BANNER_BLOCK = SCRIPT.slice(SCRIPT.indexOf('let offlineBannerConnUnsub'), SCRIPT.indexOf('// SLICE3 gpsoff'));
const R_STARTGEN = regionBody('OFFLINE-START-GEN-3');   // const offlineStartGen = shiftSessionGen;
const R_INIT = regionBody('OFFLINE-INIT-3');            // if (offlineStartGen === shiftSessionGen) ensureOfflineBanner();
const R_TEARDOWN = regionBody('OFFLINE-TEARDOWN-3');    // shiftSessionGen += 1; stopOfflineBanner();
const R_RENDER = regionBody('RENDER-OFFLINE-3');        // ensureOfflineBanner(); applyOfflineBanner();

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

function build({ rtdb = true, online = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="screen-onshift"><main id="onshift-content"><div id="idle-state" class="hidden"></div><div id="active-order-slot"></div><div id="queue-slot"></div></main></div></body>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
  let rtdbConn = rtdb; const connCbs = [];
  const XPD = { getDiagConnState: () => rtdbConn, getDb: () => ({}) };
  const deps = {
    document, window, navigator: window.navigator, $, XPD,
    fbRef: (db, p) => ({ db, p }),
    fbOnValue: (ref, cb) => { connCbs.push(cb); cb(); return () => { const i = connCbs.indexOf(cb); if (i >= 0) connCbs.splice(i, 1); }; },
  };
  const body = 'let currentUser = { uid: "drv" };\n'
    + liftFn('offerIsOffline') + '\n' + BANNER_BLOCK + '\n'
    // the REAL host wiring, built from the shipped region bodies (a removed call in any region → a RED test):
    + 'function hostStartClean() {\n' + R_STARTGEN + '\n' + R_INIT + '\n}\n'
    + 'function hostStartAfterSignOut() {\n' + R_STARTGEN + '\ncurrentUser = null;\n' + R_TEARDOWN + '\n' + R_INIT + '\n}\n'
    + 'function hostRender() {\n' + R_RENDER + '\n}\n'
    + 'function hostCleanup() {\n' + R_TEARDOWN + '\n}\n'
    + 'return { startClean: hostStartClean, startAfterSignOut: hostStartAfterSignOut, render: hostRender, cleanup: hostCleanup,'
    + ' apply: applyOfflineBanner, setUser: (u) => { currentUser = u; },'
    + ' shown: () => { const b = $("offline-banner"); return !!(b && !b.classList.contains("hidden")); },'
    + ' noteShown: () => { const n = $("offline-foot-note"); return !!(n && !n.classList.contains("hidden")); } };';
  const names = Object.keys(deps);
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  const inHand = (yes) => { $('active-order-slot').innerHTML = yes ? '<div id="btn-delivered" class="sv-slide"></div>' : ''; };
  const setRtdb = (v) => { rtdbConn = v; connCbs.slice().forEach((cb) => cb()); };
  const setOnline = (v) => { Object.defineProperty(window.navigator, 'onLine', { value: v, configurable: true }); window.dispatchEvent(new window.Event(v ? 'online' : 'offline')); };
  return { api, $, window, inHand, setRtdb, setOnline, connCount: () => connCbs.length };
}

// ---------- visibility ----------
t('offline + an order in hand → the banner AND the «5 min» foot line show, above the card, with the owner copy', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  h.api.startClean();
  assert.equal(h.api.shown(), true, 'the banner shows');
  assert.equal(h.api.noteShown(), true, 'the foot line shows');
  const b = h.$('offline-banner');
  assert.match(b.textContent, /Sin conexión · lo que deslicés se envía al volver la señal\. No cierres la app\./, 'the OWNER copy verbatim');
  assert.ok(!/desde hace/.test(b.textContent), 'no «desde hace N s»');
  assert.ok(b.compareDocumentPosition(h.$('active-order-slot')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the banner sits ABOVE the order card');
  assert.ok(h.$('screen-onshift').classList.contains('offline-foot'), 'the .offline-foot class lifts the fixed slide for the note');
});
t('online + an order in hand → hidden', () => {
  const h = build({ rtdb: true, online: true });
  h.inHand(true); h.api.startClean();
  assert.equal(h.api.shown(), false);
  assert.ok(!h.$('screen-onshift').classList.contains('offline-foot'), 'no .offline-foot when connected');
});
t('offline but NO order in hand (idle / offer) → hidden (only «while an order is in hand»)', () => {
  const h = build({ rtdb: false });
  h.inHand(false); h.api.startClean();
  assert.equal(h.api.shown(), false);
});
t('LIVE: a connected banner follows the RTDB edge — socket down → shows, reconnect → hides (no re-render)', () => {
  const h = build({ rtdb: true });
  h.inHand(true); h.api.startClean();
  assert.equal(h.api.shown(), false, 'connected → hidden');
  h.setRtdb(false);
  assert.equal(h.api.shown(), true, 'socket drops → shown live');
  h.setRtdb(true);
  assert.equal(h.api.shown(), false, 'reconnect → hidden');
});
t('navigator.onLine ADDs offline-ness: onLine=false with RTDB up still shows', () => {
  const h = build({ rtdb: true, online: true });
  h.inHand(true); h.api.startClean();
  assert.equal(h.api.shown(), false);
  h.setOnline(false);
  assert.equal(h.api.shown(), true);
});

// ---------- P2-3: visibility refreshes after EVERY board render (via the render hook) ----------
t('render hook refreshes visibility across board changes (visible → offer-only board → hidden; hidden → accepted work → shown)', () => {
  const h = build({ rtdb: false });
  h.inHand(true); h.api.render();                 // accepted work, offline → shown
  assert.equal(h.api.shown(), true);
  h.inHand(false); h.api.render();                // board replaced by an offer (no in-hand slide) → hidden
  assert.equal(h.api.shown(), false, 'a visible banner hides when the board becomes offer-only');
  h.inHand(true); h.api.render();                 // accepted work appears while offline → shown again
  assert.equal(h.api.shown(), true, 'a hidden banner shows when accepted work appears');
});

// ---------- P2-1 restoration: a render into an active shift initializes it (not just shift-start) ----------
t('restoration: render() alone (app reopen) initializes the subscription', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  assert.equal(h.connCount(), 0, 'nothing before any entry');
  h.api.render();                                 // app reopen / restore path → RENDER-OFFLINE-3
  assert.ok(h.connCount() >= 1, 'the render path subscribed');
  assert.equal(h.api.shown(), true);
});

// ---------- P2-2 late start after sign-out: the session gen bails ----------
t('a shift-start that resolves AFTER sign-out attaches NOTHING (session generation)', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  h.api.startAfterSignOut();                       // START-GEN, then sign-out+teardown bumps the gen, then INIT
  assert.equal(h.connCount(), 0, 'the gen mismatch (and null user) make the pending init bail — zero subscriptions');
  assert.equal(h.api.shown(), false);
});

// ---------- teardown + mutant anchors ----------
t('teardown unsubscribes + hides; host init/teardown are load-bearing', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  h.api.startClean();                              // ← OFFLINE-INIT-3: remove its ensureOfflineBanner call and this RED
  assert.ok(h.connCount() >= 1, 'host init subscribed (mutant: host init removed → RED here)');
  assert.equal(h.api.shown(), true);
  h.api.cleanup();                                 // ← OFFLINE-TEARDOWN-3: remove its stopOfflineBanner call and this RED
  assert.equal(h.connCount(), 0, 'host teardown unsubscribed (mutant: host teardown removed → RED here)');
  assert.equal(h.api.shown(), false, 'hidden on teardown');
});

console.log(`✓ offline-banner: ${passed} checks passed`);
