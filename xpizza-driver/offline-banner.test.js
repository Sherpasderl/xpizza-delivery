// Offline banner (owner 10-25) — HANDLER test. Executes the REAL shipped LOGIC-3 offline-banner functions
// (offerIsOffline / offlineInHand / applyOfflineBanner / initOfflineBanner / stopOfflineBanner), lifted from
// index.html, over a jsdom on-shift DOM. Proves: the banner + the prototype foot line show ONLY while the RTDB socket
// is down AND an accepted order (a queued server slide) is in hand; they follow the connection edge live; they hide on
// the idle screen (no slide) and on reconnect; teardown unsubscribes. Run: `node offline-banner.test.js`.
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
// the contiguous offline-banner block (the module-state let + OFFLINE_WIFI + the 4 banner functions), verbatim
const BANNER_BLOCK = SCRIPT.slice(SCRIPT.indexOf('let offlineBannerConnUnsub'), SCRIPT.indexOf('/* ===== SLICE3:LOGIC-3:END'));

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

function build({ rtdb = true, online = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="onshift-content"><div id="idle-state" class="hidden"></div><div id="active-order-slot"></div><div id="queue-slot"></div></main></body>');
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
  const body = liftFn('offerIsOffline') + '\n' + BANNER_BLOCK + '\n'
    + 'return { init: initOfflineBanner, apply: applyOfflineBanner, stop: stopOfflineBanner,'
    + ' shown: () => { const b = $("offline-banner"); return !!(b && !b.classList.contains("hidden")); },'
    + ' noteShown: () => { const n = $("offline-foot-note"); return !!(n && !n.classList.contains("hidden")); } };';
  const names = Object.keys(deps);
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  const inHand = (yes) => { $('active-order-slot').innerHTML = yes ? '<div id="btn-delivered" class="sv-slide"></div>' : ''; };
  const setRtdb = (v) => { rtdbConn = v; connCbs.slice().forEach((cb) => cb()); };
  const setOnline = (v) => { Object.defineProperty(window.navigator, 'onLine', { value: v, configurable: true }); window.dispatchEvent(new window.Event(v ? 'online' : 'offline')); };
  return { api, $, window, inHand, setRtdb, setOnline, connCount: () => connCbs.length };
}

t('offline + an order in hand → the banner AND the «5 min» foot line show, above the card', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  h.api.init();
  assert.equal(h.api.shown(), true, 'the banner shows');
  assert.equal(h.api.noteShown(), true, 'the foot line shows');
  const b = h.$('offline-banner');
  assert.match(b.textContent, /Sin conexión · lo que deslicés se envía al volver la señal\. No cierres la app\./, 'the OWNER copy verbatim');
  assert.ok(!/desde hace/.test(b.textContent), 'no «desde hace N s» (not in the owner copy)');
  assert.ok(b.compareDocumentPosition(h.$('active-order-slot')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the banner sits ABOVE the order card');
});

t('online + an order in hand → hidden (connected, nothing to warn about)', () => {
  const h = build({ rtdb: true, online: true });
  h.inHand(true);
  h.api.init();
  assert.equal(h.api.shown(), false);
  assert.equal(h.api.noteShown(), false);
});

t('offline but NO order in hand (idle / offer screen) → hidden (only «while an order is in hand»)', () => {
  const h = build({ rtdb: false });
  h.inHand(false);              // no accepted-order slide present
  h.api.init();
  assert.equal(h.api.shown(), false, 'no banner without an order in hand');
  assert.equal(h.api.noteShown(), false);
});

t('LIVE: a connected banner follows the RTDB edge — socket down → shows, reconnect → hides (no re-render)', () => {
  const h = build({ rtdb: true });
  h.inHand(true);
  h.api.init();
  assert.equal(h.api.shown(), false, 'connected → hidden');
  h.setRtdb(false);
  assert.equal(h.api.shown(), true, 'the RTDB socket drops → the banner appears live');
  h.setRtdb(true);
  assert.equal(h.api.shown(), false, 'reconnect → hidden');
});

t('navigator.onLine ADDs offline-ness: onLine=false with RTDB up still shows (either signal offline ⇒ offline)', () => {
  const h = build({ rtdb: true, online: true });
  h.inHand(true);
  h.api.init();
  assert.equal(h.api.shown(), false);
  h.setOnline(false);
  assert.equal(h.api.shown(), true, 'the window offline edge alone shows it');
});

t('teardown unsubscribes + hides (shift end / sign-out)', () => {
  const h = build({ rtdb: false });
  h.inHand(true);
  h.api.init();
  assert.equal(h.api.shown(), true);
  assert.ok(h.connCount() >= 1, 'subscribed while live');
  h.api.stop();
  assert.equal(h.api.shown(), false, 'hidden on teardown');
  assert.equal(h.connCount(), 0, 'the .info/connected subscription is released');
});

console.log(`✓ offline-banner: ${passed} checks passed`);
