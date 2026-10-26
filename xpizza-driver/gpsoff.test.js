// gpsoff — the location-off idle state. (1) gpsoffHtml builder output per cause/platform; (2) the REAL lifted
// gpsoffActive / applyGpsoff logic (index.html LOGIC-3) over a jsdom idle DOM: it swaps the idle content for the card
// only when location is off, routes «Abrir ajustes» by cause, and «Más tarde» dismisses. Run: `node gpsoff.test.js`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { gpsoffHtml } from './stacked-view.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const esc = (s) => String(s == null ? '' : s);

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

// ---------- (1) the builder ----------
t('builder native + permission DENIED: «Permiso de ubicación» «Negado», battery row, «Abrir ajustes» routes to permission', () => {
  const h = gpsoffHtml({ native: true, permission: 'denied', providerEnabled: true, batteryUnrestricted: true }, { esc });
  assert.match(h, /Activá tu ubicación/);
  assert.match(h, /Permiso de ubicación[\s\S]*Negado/);
  assert.match(h, /Bater[ií]a[\s\S]*Ok/, 'the battery row is native-only');
  assert.match(h, /id="gpsoff-settings" data-cause="permission"/, 'routes to app details for a permission cause');
  assert.match(h, /id="gpsoff-later"/);
});
t('builder native + PROVIDER off: a «Ubicación del teléfono» «Apagada» row, «Abrir ajustes» routes to provider', () => {
  const h = gpsoffHtml({ native: true, permission: 'granted', providerEnabled: false, batteryUnrestricted: true }, { esc });
  assert.match(h, /Ubicación del teléfono[\s\S]*Apagada/);
  assert.match(h, /data-cause="provider"/, 'routes to the location switch when the provider is off');
});
t('builder WEB: permission cause only — NO battery row, NO «Abrir ajustes», «Más tarde» only', () => {
  const h = gpsoffHtml({ native: false, permission: 'denied' }, { esc });
  assert.match(h, /Permiso de ubicación/);
  assert.ok(!/Bater[ií]a/.test(h), 'no battery row on web');
  assert.ok(!/gpsoff-settings/.test(h), 'no settings opener on web');
  assert.match(h, /id="gpsoff-later"/);
});

// ---------- (2) the lifted apply logic ----------
function build() {
  const dom = new JSDOM('<!doctype html><body><div id="idle-state"><div class="idle-top"><div id="idle-msg"></div><button id="idle-help-link">¿Por qué?</button></div><div class="statbar" id="idle-statbar"></div></div></body>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const deps = { document, window, $, gpsoffHtml, escapeHtml: esc };
  const body = 'let gpsoffState = null, gpsoffDismissed = false;\n'
    + liftFn('gpsoffActive') + '\n' + liftFn('applyGpsoff') + '\n'
    + 'return { apply: applyGpsoff, active: gpsoffActive, setState: (s) => { gpsoffState = s; }, setDismissed: (d) => { gpsoffDismissed = d; }, dismissed: () => gpsoffDismissed };';
  const names = Object.keys(deps);
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  return { api, $, document,
    cardShown: () => { const c = $('gpsoff-state'); return !!(c && !c.classList.contains('hidden')); },
    idleTopHidden: () => $('idle-state').querySelector('.idle-top').classList.contains('hidden') };
}

t('active: null/dismissed → false; permission denied OR provider off → true; all good → false', () => {
  const h = build();
  assert.equal(h.api.active(), false, 'no state → not active');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: true });
  assert.equal(h.api.active(), false, 'all good → not active');
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true });
  assert.equal(h.api.active(), true, 'permission denied → active');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: false });
  assert.equal(h.api.active(), true, 'provider off → active');
  h.api.setDismissed(true);
  assert.equal(h.api.active(), false, '«Más tarde» dismiss wins');
});

t('apply: location off → the card REPLACES the idle content (idle-top hidden); all good → idle content restored', () => {
  const h = build();
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true, batteryUnrestricted: true });
  h.api.apply();
  assert.equal(h.cardShown(), true, 'the gpsoff card shows');
  assert.equal(h.idleTopHidden(), true, 'the normal idle content (incl. the help link) is hidden');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: true });
  h.api.apply();
  assert.equal(h.cardShown(), false, 'card cleared when location is fine');
  assert.equal(h.idleTopHidden(), false, 'the idle content is restored');
});

t('apply: «Más tarde» dismisses the card (until the next recheck re-sets it)', () => {
  const h = build();
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true });
  h.api.apply();
  assert.equal(h.cardShown(), true);
  h.$('gpsoff-later').click();   // the real handler sets gpsoffDismissed = true + re-applies
  assert.equal(h.cardShown(), false, 'dismissed → hidden');
  assert.equal(h.api.dismissed(), true, 'the dismiss flag latched');
});

console.log(`✓ gpsoff: ${passed} checks passed`);
