// New-assignment CHIME — HANDLER test. run: `node chime-fresh.test.js` (invoked from xpizza-functions in the npm
// chain). EXECUTES the REAL shipped detectNewAssignments (CHIME-FRESH region, lifted via new Function — the
// endshift-confirm.test.js idiom) against a REAL jsdom DOM. Proves the chime-gap fix: a 2nd order that lands with
// status 'accepted' (a SAME-HUB auto-accept stack) chimes just like a status-'assigned' cross-hub OFFER, which the
// old 'status === assigned'-only code missed. Boot stays silent; a known order never re-chimes; terminal statuses
// never chime. Mutant: revert the status filter to only 'assigned' ⇒ the same-hub 'accepted' check goes RED.
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

function build() {
  const dom = new JSDOM('<!doctype html><html><body><audio id="chime"></audio></body></html>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const calls = { chime: 0, toasts: [], vibrates: [] };
  const chimeEl = $('chime');
  chimeEl.play = () => { calls.chime++; return Promise.resolve(); };
  Object.defineProperty(window.navigator, 'vibrate', { value: (p) => { calls.vibrates.push(p); return true; }, configurable: true });

  const deps = { document, window, navigator: window.navigator, $, currentUser: { uid: 'drv' }, soundOn: true, toast: (m) => calls.toasts.push(m) };
  const body = 'let knownTaskIds = new Set(); let initialAssignmentsLoaded = false;\n'
    + liftFn('detectNewAssignments') + '\n'
    + 'return { detectNewAssignments, getKnown: () => knownTaskIds, loaded: () => initialAssignmentsLoaded };';
  const names = Object.keys(deps);
  const fn = new Function(...names, body);
  return { api: fn(...names.map((n) => deps[n])), calls };
}

const pickup = (status) => ({ assigned_driver_id: 'drv', type: 'pickup', status });
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok -', name); }

t('BOOT is silent: the first snapshot never chimes (initialAssignmentsLoaded gate)', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: pickup('assigned') });
  assert.equal(h.calls.chime, 0, 'no chime on the first snapshot');
  assert.ok(h.api.loaded(), 'initialAssignmentsLoaded set after the first snapshot');
});

t('a SAME-HUB 2nd order (status "accepted", no swipe) CHIMES + toasts + vibrates — the gap this fix closes', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: pickup('accepted') });                 // boot (silent)
  h.api.detectNewAssignments({ A_pickup: pickup('accepted'), B_pickup: pickup('accepted') });   // B newly appears
  assert.equal(h.calls.chime, 1, 'the same-hub accepted 2nd order chimed');
  assert.ok(h.calls.toasts.includes('¡Nuevo pedido asignado!'), 'toasted');
  assert.deepEqual(h.calls.vibrates, [[200, 100, 200]], 'vibrated');
});

t('a CROSS-HUB 2nd order (status "assigned", offer) still chimes', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: pickup('accepted') });
  h.api.detectNewAssignments({ A_pickup: pickup('accepted'), B_pickup: pickup('assigned') });
  assert.equal(h.calls.chime, 1, 'the cross-hub assigned offer chimed');
});

t('a KNOWN order never re-chimes (fresh = the null→me transition, not a status change)', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: pickup('assigned') });                  // boot
  h.api.detectNewAssignments({ A_pickup: pickup('accepted') });                  // SAME id, status assigned→accepted
  assert.equal(h.calls.chime, 0, 'a status change of a known order does not chime');
});

t('a TERMINAL-status own pickup never chimes (a late-syncing completed order stays silent)', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: pickup('accepted') });                  // boot
  h.api.detectNewAssignments({ A_pickup: pickup('accepted'), C_pickup: pickup('completed') });
  assert.equal(h.calls.chime, 0, 'a newly-appearing completed pickup does not chime');
});

console.log(`✓ chime-fresh: ${passed} checks passed`);
