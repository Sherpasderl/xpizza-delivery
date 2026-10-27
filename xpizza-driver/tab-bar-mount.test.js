// tab-bar-mount.test.js — the HOST glue for the O6 bottom nav bar, driven through the REAL showScreen + the REAL
// syncTabBarForScreen / mountTabBar, with the LIFTED production gating constants (not injected). Covers the mounts
// (offshift + Cuenta), the data-gating, the central no-bar-with-active-work rule and the two Cuenta races, and the
// Inicio/Cuenta routing. The board-mount (idle vs active) lifecycle is covered through the REAL renderActiveAndQueue
// in slice2-branch.test.js. Kills: dropping the showScreen→sync call, and flipping the production Pedidos flag.
// Run: `node tab-bar-mount.test.js` (jsdom resolved from xpizza-functions, like the other harnesses).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tabBarHtml } from './tab-bar-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));   // resolve jsdom like the other harnesses
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
function liftConst(name) {   // lift a `const NAME = …;` statement VERBATIM (the real production value)
  const hits = [...SCRIPT.matchAll(new RegExp(`const ${name} = `, 'g'))];
  assert.equal(hits.length, 1, `const ${name} must appear exactly once (found ${hits.length})`);
  const start = hits[0].index, end = SCRIPT.indexOf(';', start);
  return SCRIPT.slice(start, end + 1);
}

const SCREENS = ['config', 'login', 'offshift', 'onshift', 'companion', 'cuenta', 'navApp'];
function boot() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + SCREENS.map((s) => `<div id="screen-${s}" class="hidden"></div>`).join('')
    + '<button id="duty-toggle-off"></button></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const calls = { render: 0, openCuenta: 0, origBack: 0 };
  const boardRef = { list: [] };
  const $ = (id) => document.getElementById(id);
  document.getElementById('screen-cuenta').innerHTML = '<button id="cuenta-back"></button>';   // as renderCuenta would leave it
  // the FROZEN slice2 cuenta-back listener (showScreen('offshift')) — the rebind must strip it
  document.getElementById('cuenta-back').addEventListener('click', () => { calls.origBack++; });

  const body =
    'function render(){ _calls.render++; }\n' +
    'function openCuenta(){ _calls.openCuenta++; }\n' +
    'function updateNotifBanners(){}\n' +
    liftConst('TAB_SHOW_PEDIDOS') + '\n' +
    liftConst('TAB_SHOW_GANANCIAS') + '\n' +
    liftFn('mountTabBar') + '\n' +
    liftFn('syncTabBarForScreen') + '\n' +
    liftFn('showScreen') + '\n' +
    'return { showScreen, syncTabBarForScreen, mountTabBar };';
  const api = (new Function('document', '$', 'tabBarHtml', 'drv2LiveBoard', '_calls', body))(
    document, $, tabBarHtml, () => boardRef.list, calls);
  return { api, document, window, calls, $, boardRef,
    bar: (id) => document.getElementById(id).querySelector(':scope > .tabs') };
}

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

t('REAL showScreen mounts the bar on offshift (Inicio) + Cuenta, data-gated to 2 tabs via the production constants', () => {
  const h = boot();
  h.api.showScreen('offshift');
  const ob = h.bar('screen-offshift');
  assert.ok(ob, 'offshift carries the bar (showScreen → syncTabBarForScreen)');
  assert.equal(ob.querySelectorAll('.tab-btn').length, 2, 'Inicio + Cuenta only — the real TAB_SHOW_* are false');
  assert.ok(ob.querySelector('.tab-btn.on[data-tab="inicio"]'), 'Inicio active');
  assert.ok(!ob.querySelector('[data-tab="pedidos"]') && !ob.querySelector('[data-tab="ganancias"]'), 'dormant tabs hidden (lifted production flags)');
  h.api.showScreen('cuenta');
  assert.equal(h.bar('screen-offshift'), null, 'leaving offshift removes its bar');
  assert.ok(h.bar('screen-cuenta').querySelector('.tab-btn.on[data-tab="cuenta"]'), 'Cuenta active on the Cuenta screen');
  h.api.showScreen('login');
  assert.equal(h.bar('screen-offshift'), null);
  assert.equal(h.bar('screen-cuenta'), null, 'no bar on an unrelated screen');
});

t('CENTRAL no-bar-with-active-work (P1): a Cuenta reopen over an active order bounces to the board, no bar', () => {
  const h = boot();
  h.boardRef.list = [{ orderId: 'x' }];   // an order arrived
  h.api.showScreen('cuenta');             // a delayed continuation reopened Cuenta
  assert.equal(h.calls.render, 1, 'bounced to the board via render()');
  assert.equal(h.bar('screen-cuenta'), null, 'no Cuenta bar over an active order');
  // offshift too: no bar while there is active work
  h.api.showScreen('offshift');
  assert.equal(h.bar('screen-offshift'), null, 'no offshift bar while an order is active');
});

t('Cuenta back button (P2.2) is rebound to render() — the frozen showScreen(offshift) listener is stripped', () => {
  const h = boot();
  h.api.showScreen('cuenta');   // rebinds cuenta-back
  const before = h.calls.render;
  h.document.getElementById('cuenta-back').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.render, before + 1, 'cuenta-back → render() (destination follows current state)');
  assert.equal(h.calls.origBack, 0, 'the frozen showScreen(offshift) listener no longer fires');
});

t('tab buttons route: Inicio → render(), Cuenta → openCuenta() (wired once)', () => {
  const h = boot();
  h.api.showScreen('offshift');
  const ob = h.bar('screen-offshift');
  ob.querySelector('[data-tab="cuenta"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.openCuenta, 1, 'Cuenta → openCuenta');
  const r0 = h.calls.render;
  ob.querySelector('[data-tab="inicio"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.render, r0 + 1, 'Inicio → render (go home)');
});

console.log(`✓ tab-bar-mount: ${passed} tests passed`);
