// tab-bar-mount.test.js — the HOST glue for the O6 bottom nav bar, in a real jsdom document. Lifts the shipped
// mountTabBar + syncTabBarForScreen from index.html and drives them: the bar is mounted as the LAST child of the
// right screen, data-gated to Inicio + Cuenta (dormant Pedidos/Ganancias hidden), removed when visible=false (an
// active order), and its buttons route — Inicio → render(), Cuenta → openCuenta() — wired once. Run: `node tab-bar-mount.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tabBarHtml } from './tab-bar-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

function boot() {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-offshift"></div><div id="screen-onshift"></div><div id="screen-cuenta"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  const calls = { render: 0, openCuenta: 0 };
  const $ = (id) => document.getElementById(id);
  const body =
    'function render(){ _calls.render++; }\n' +
    'function openCuenta(){ _calls.openCuenta++; }\n' +
    liftFn('mountTabBar') + '\n' +
    liftFn('syncTabBarForScreen') + '\n' +
    'return { mountTabBar, syncTabBarForScreen };';
  const api = (new Function('document', '$', 'tabBarHtml', 'TAB_SHOW_PEDIDOS', 'TAB_SHOW_GANANCIAS', '_calls', body))(
    document, $, tabBarHtml, false, false, calls);
  return { api, document, window, calls, $, bar: (id) => document.getElementById(id).querySelector(':scope > .tabs') };
}

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

t('syncTabBarForScreen mounts the bar on offshift (Inicio) + Cuenta, data-gated to 2 tabs; not elsewhere', () => {
  const h = boot();
  h.api.syncTabBarForScreen('offshift');
  const ob = h.bar('screen-offshift');
  assert.ok(ob, 'offshift carries the bar');
  assert.equal(h.bar('screen-cuenta'), null, 'cuenta does not (not the shown screen)');
  assert.equal(ob.querySelectorAll('.tab-btn').length, 2, 'two tabs (Inicio + Cuenta; Pedidos/Ganancias dormant)');
  assert.ok(ob.querySelector('.tab-btn.on[data-tab="inicio"]'), 'Inicio active on offshift');
  assert.ok(!ob.querySelector('[data-tab="pedidos"]') && !ob.querySelector('[data-tab="ganancias"]'), 'no dormant tabs');

  h.api.syncTabBarForScreen('cuenta');
  assert.equal(h.bar('screen-offshift'), null, 'leaving offshift removes its bar');
  const cb = h.bar('screen-cuenta');
  assert.ok(cb && cb.querySelector('.tab-btn.on[data-tab="cuenta"]'), 'Cuenta active on the Cuenta screen');

  h.api.syncTabBarForScreen('login');
  assert.equal(h.bar('screen-offshift'), null);
  assert.equal(h.bar('screen-cuenta'), null, 'neither bar shows on an unrelated screen');
});

t('mountTabBar is the idle/active toggle for on-shift: visible mounts, invisible removes', () => {
  const h = boot();
  h.api.mountTabBar(h.$('screen-onshift'), 'inicio', true);
  assert.ok(h.bar('screen-onshift'), 'idle board shows the bar');
  h.api.mountTabBar(h.$('screen-onshift'), 'inicio', false);
  assert.equal(h.bar('screen-onshift'), null, 'an active order removes the bar');
  // idempotent re-mount leaves exactly one bar
  h.api.mountTabBar(h.$('screen-onshift'), 'inicio', true);
  h.api.mountTabBar(h.$('screen-onshift'), 'inicio', true);
  assert.equal(h.$('screen-onshift').querySelectorAll(':scope > .tabs').length, 1, 'never more than one bar');
});

t('the bar is the LAST child of its screen (sits at the bottom of the flex column)', () => {
  const h = boot();
  const off = h.$('screen-offshift');
  off.insertAdjacentHTML('beforeend', '<div class="offshift-content">x</div>');
  h.api.syncTabBarForScreen('offshift');
  assert.ok(off.lastElementChild.classList.contains('tabs'), 'the bar is appended last (below the content)');
});

t('tab buttons route: Inicio → render(), Cuenta → openCuenta() (wired once)', () => {
  const h = boot();
  h.api.syncTabBarForScreen('offshift');
  const ob = h.bar('screen-offshift');
  ob.querySelector('[data-tab="cuenta"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.openCuenta, 1, 'Cuenta → openCuenta');
  assert.equal(h.calls.render, 0, 'render not yet called');
  ob.querySelector('[data-tab="inicio"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.render, 1, 'Inicio → render (go home)');
  // re-sync (rebuild) then click again — still exactly one handler fires (wired once per node, no double-binding)
  h.api.syncTabBarForScreen('offshift');
  h.bar('screen-offshift').querySelector('[data-tab="inicio"]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.render, 2, 'exactly one render per Inicio tap after a rebuild');
});

console.log(`✓ tab-bar-mount: ${passed} tests passed`);
