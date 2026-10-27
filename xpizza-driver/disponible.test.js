// disponible.test.js — renderDisponible, the on-shift IDLE body rebuilt to prototype S.disponible. Lifts the REAL
// renderDisponible into jsdom and asserts: the prototype structure (status card «Disponible» chip + GPS freshness, the
// check «Esperando pedidos» block with the prototype copy, two stat cards «Entregas hoy» / «Efectivo a entregar»); the
// three idle status variants (available / returning / at_restaurant); GPS staleness; and that the two startup-bound
// controls (#idle-help-link, #arrive-btn) are PRESERVED across the rebuild (same element → listeners intact). Run:
// `node disponible.test.js`
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

function boot({ status = 'available', stale = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-top"><div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">x</div>'
    + '<div class="idle-sub" id="idle-sub">x</div><button class="idle-help-link" id="idle-help-link">¿Por qué no veo pedidos?</button>'
    + '<button class="big-btn primary hidden" id="arrive-btn">Estoy en el restaurante</button></div>'
    + '<div class="statbar" id="idle-statbar"><div class="num" id="stat-deliveries">0</div><div class="num" id="stat-cash">L 0</div></div>'
    + '</div></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => `<svg data-ic="${String(k)}"></svg>` });
  const driverState = { status, last_ping: Date.now() };
  const XPD = { isStalePing: () => stale };
  // tag the startup-bound controls so we can prove the SAME elements survive the rebuild
  $('idle-help-link')._boundMark = 'help'; $('arrive-btn')._boundMark = 'arrive';
  const body = liftFn('renderDisponible') + '\nreturn { renderDisponible };';
  const api = (new Function('document', '$', 'ICONS', 'driverState', 'XPD', body))(document, $, ICONS, driverState, XPD);
  api.renderDisponible();
  return { document, $, host: $('idle-state') };
}

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

t('available: status card (Disponible + GPS vivo), check «Esperando pedidos» + prototype copy, two stat cards', () => {
  const h = boot({ status: 'available' });
  const html = h.host.innerHTML;
  assert.ok(h.host.querySelector('.disp-status .disp-chip'), 'status card chip present');
  assert.equal(h.host.querySelector('#disp-chip-label').textContent, 'Disponible', 'chip «Disponible»');
  assert.match(h.host.querySelector('#disp-gps').textContent, /^GPS vivo · hace \d+ s$/, 'GPS freshness «GPS vivo · hace N s»');
  assert.ok(!h.host.querySelector('#disp-gps').classList.contains('stale'), 'not stale');
  assert.equal(h.host.querySelector('#idle-msg').textContent, 'Esperando pedidos', 'heading');
  assert.ok(/Te avisamos con sonido y vibración\. Dejá el app abierto o en segundo plano\./.test(html), 'prototype sub copy');
  assert.ok(/data-ic="check"/.test(h.host.querySelector('#idle-icon').innerHTML), 'the check illus icon');
  const stats = h.host.querySelectorAll('.disp-stat2 .disp-statcard');
  assert.equal(stats.length, 2, 'two stat cards');
  assert.ok(/Entregas hoy/.test(html) && /Efectivo a entregar/.test(html), 'sentence-case stat labels');
  assert.ok(h.host.querySelector('#stat-deliveries') && h.host.querySelector('#stat-cash'), 'stat ids preserved for syncIdleStats');
});

t('the startup-bound #idle-help-link and #arrive-btn are PRESERVED (same elements → listeners intact)', () => {
  const h = boot({ status: 'available' });
  assert.equal(h.$('idle-help-link')._boundMark, 'help', 'help link is the SAME element (not re-created)');
  assert.equal(h.$('arrive-btn')._boundMark, 'arrive', 'arrive button is the SAME element');
  assert.ok(h.host.querySelector('.idle-top #idle-help-link'), 'help link sits inside the rebuilt .idle-top');
});

t('returning: «Regresando al restaurante» + Disponible chip + the uturn icon', () => {
  const h = boot({ status: 'returning' });
  assert.equal(h.host.querySelector('#idle-msg').textContent, 'Regresando al restaurante');
  assert.equal(h.host.querySelector('#disp-chip-label').textContent, 'Disponible');
  assert.ok(/data-ic="uturn"/.test(h.host.querySelector('#idle-icon').innerHTML), 'uturn icon');
});

t('at_restaurant: «En restaurante» chip + «En el restaurante» + the store icon', () => {
  const h = boot({ status: 'at_restaurant' });
  assert.equal(h.host.querySelector('#idle-msg').textContent, 'En el restaurante');
  assert.equal(h.host.querySelector('#disp-chip-label').textContent, 'En restaurante');
  assert.ok(/data-ic="store"/.test(h.host.querySelector('#idle-icon').innerHTML), 'store icon');
});

t('a stale GPS ping → «GPS inactivo» + .stale', () => {
  const h = boot({ status: 'available', stale: true });
  assert.equal(h.host.querySelector('#disp-gps').textContent, 'GPS inactivo');
  assert.ok(h.host.querySelector('#disp-gps').classList.contains('stale'), 'stale class');
});

console.log(`✓ disponible: ${passed} tests passed`);
