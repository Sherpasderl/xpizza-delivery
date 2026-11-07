// IDLE-3 help-link gate — the «¿Por qué no veo pedidos?» idle-help-link shows ONLY when the driver is AVAILABLE
// (owner): on a returning / at-restaurant / off-shift idle screen the "why no orders" diagnosis is irrelevant.
// EXECUTES the REAL shipped SLICE3:IDLE-3 region body (lifted from index.html), driven over a jsdom idle DOM.
// Run: `node idle-help-gate.test.js` (invoked from xpizza-functions in the npm chain).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function regionBody(name) {
  const s = SCRIPT.indexOf(`SLICE3:${name}:START`);
  const bodyStart = SCRIPT.indexOf('\n', s) + 1;
  const end = SCRIPT.indexOf(`SLICE3:${name}:END`, bodyStart);
  return SCRIPT.slice(bodyStart, SCRIPT.lastIndexOf('/*', end));
}
const IDLE3 = regionBody('IDLE-3');

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

// render the idle screen for a given status (start the link HIDDEN, as the DOM default is) and report whether it shows
function shows(status) {
  const dom = new JSDOM('<!doctype html><body><button id="idle-help-link" class="hidden">¿Por qué no veo pedidos?</button></body>');
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  new Function('status', '$', 'applyOfflineBanner', 'applyGpsoff', 'checkLocationStatus', IDLE3)(status, $, () => {}, () => {}, () => {});   // the region reads `status`/`$` + calls applyOfflineBanner/applyGpsoff/checkLocationStatus (stubbed — their own tests cover them)
  return !$('idle-help-link').classList.contains('hidden');
}

t('the help link SHOWS only when AVAILABLE', () => assert.equal(shows('available'), true));
t('HIDDEN when returning to the restaurant', () => assert.equal(shows('returning'), false));
t('HIDDEN at the restaurant', () => assert.equal(shows('at_restaurant'), false));
t('HIDDEN off-shift / unknown status (never leaks on a non-available idle screen)', () => {
  assert.equal(shows('off_shift'), false);
  assert.equal(shows(undefined), false);
});
// it also HIDES a link that was previously shown (toggle, not one-way) — an available→returning transition re-hides it
t('the gate is a toggle: an already-visible link re-hides when status leaves available', () => {
  const dom = new JSDOM('<!doctype html><body><button id="idle-help-link">¿Por qué no veo pedidos?</button></body>');   // starts VISIBLE
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  new Function('status', '$', 'applyOfflineBanner', 'applyGpsoff', 'checkLocationStatus', IDLE3)('returning', $, () => {}, () => {}, () => {});
  assert.equal($('idle-help-link').classList.contains('hidden'), true, 'a visible link is hidden when not available');
});

console.log(`✓ idle-help-gate: ${passed} checks passed`);
