// New-assignment CHIME — HANDLER test. run: `node chime-fresh.test.js` (invoked from xpizza-functions in the npm
// chain). EXECUTES the REAL shipped detectNewAssignments (CHIME-FRESH region, lifted via new Function — the
// endshift-confirm.test.js idiom) against a REAL jsdom DOM, driven with the EXACT snapshot sequences the live feed
// produces (incl. the {} that driver-feed.js onTasksError publishes). Proves the chime-gap fix + Codex chime-r2:
//   - a SAME-HUB 2nd order (status 'accepted', auto-accepted) chimes like a cross-hub 'assigned' OFFER;
//   - a transient empty/error snapshot never forgets an order → a reconnect does NOT re-chime (P2-1);
//   - a status change on a seen id (in_progress→accepted, assigned→accepted) never chimes;
//   - boot is silent, but the FIRST order of a no-orders shift DOES chime.
// Mutants these kill on their markers: the old knownTaskIds.size>0 gate; forgetting ids (repeat chime); dropping the
// ownership or pickup-type filter; allowing in_progress/cancelled; ignoring soundOn.
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

function build({ soundOn = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><audio id="chime"></audio></body></html>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  const calls = { chime: 0, toasts: [], vibrates: [] };
  $('chime').play = () => { calls.chime++; return Promise.resolve(); };
  Object.defineProperty(window.navigator, 'vibrate', { value: (p) => { calls.vibrates.push(p); return true; }, configurable: true });
  const deps = { document, window, navigator: window.navigator, $, currentUser: { uid: 'drv' }, soundOn, toast: (m) => calls.toasts.push(m) };
  const body = 'let knownTaskIds = new Set(); let initialAssignmentsLoaded = false;\n'
    + liftFn('detectNewAssignments') + '\n'
    + 'return { detectNewAssignments, seenSize: () => knownTaskIds.size };';
  const names = Object.keys(deps);
  return { api: (new Function(...names, body))(...names.map((n) => deps[n])), calls };
}

const own = (status) => ({ assigned_driver_id: 'drv', type: 'pickup', status });
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok -', name); }

t('BOOT silent, then the FIRST order of a no-orders shift CHIMES (initialAssignmentsLoaded gate, not size>0)', () => {
  const h = build();
  h.api.detectNewAssignments({});                               // empty boot
  assert.equal(h.calls.chime, 0, 'silent boot');
  h.api.detectNewAssignments({ A_pickup: own('assigned') });    // first order ever
  assert.equal(h.calls.chime, 1, 'the first order after an empty boot chimes (kills the size>0 gate)');
});

t('a SAME-HUB 2nd order (status "accepted", no swipe) CHIMES + toasts + vibrates — the gap this closes', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // boot
  h.api.detectNewAssignments({ A_pickup: own('accepted'), B_pickup: own('accepted') });
  assert.equal(h.calls.chime, 1, 'same-hub accepted 2nd order chimed');
  assert.ok(h.calls.toasts.includes('¡Nuevo pedido asignado!'), 'toasted');
  assert.deepEqual(h.calls.vibrates, [[200, 100, 200]], 'vibrated');
});

t('a CROSS-HUB 2nd order (status "assigned", offer) chimes', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: own('accepted') });
  h.api.detectNewAssignments({ A_pickup: own('accepted'), B_pickup: own('assigned') });
  assert.equal(h.calls.chime, 1, 'cross-hub assigned offer chimed');
});

t('P2-1: a query-error {} snapshot never forgets an order → a RECONNECT does not re-chime', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // boot: A seen (silent)
  h.api.detectNewAssignments({});                               // driver-feed onTasksError publishes {} — must NOT forget A
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // reconnect re-emits A
  assert.equal(h.calls.chime, 0, 'A is still seen across the {} — no false re-chime on reconnect');
});

t('a status change on a SEEN id never chimes (assigned→accepted, and in_progress→accepted)', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: own('assigned') });    // boot: A seen
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // assigned→accepted, same id
  assert.equal(h.calls.chime, 0, 'assigned→accepted does not chime');
  const h2 = build();
  h2.api.detectNewAssignments({ B_pickup: own('in_progress') });// boot: B seen (owned, not a chime candidate)
  h2.api.detectNewAssignments({ B_pickup: own('accepted') });   // in_progress→accepted, same id
  assert.equal(h2.calls.chime, 0, 'in_progress→accepted does not chime (B was already seen)');
});

t('ownership + pickup-type + status filters: another driver / a delivery task / in_progress never chime', () => {
  const h = build();
  h.api.detectNewAssignments({ X: own('assigned') });           // boot
  h.api.detectNewAssignments({ X: own('assigned'), Y_other: { assigned_driver_id: 'OTHER', type: 'pickup', status: 'assigned' } });
  assert.equal(h.calls.chime, 0, "another driver's order never chimes (ownership)");
  h.api.detectNewAssignments({ X: own('assigned'), Z_deliv: { assigned_driver_id: 'drv', type: 'delivery', status: 'assigned' } });
  assert.equal(h.calls.chime, 0, 'a delivery task never chimes (pickup-type)');
  h.api.detectNewAssignments({ X: own('assigned'), W_inprog: own('in_progress') });
  assert.equal(h.calls.chime, 0, 'a fresh in_progress pickup never chimes (status)');
});

t('a FRESH pickup at ANY non-offer status never chimes (pending / in_progress / completed / cancelled)', () => {
  // TASK_STATUS (xpizza-delivery.js:61): pending, assigned, accepted, in_progress, completed, cancelled. Only the
  // pre-pickup assignment statuses (assigned|accepted) chime; a fresh arrival at any OTHER status must be silent.
  for (const st of ['pending', 'in_progress', 'completed', 'cancelled']) {
    const h = build();
    h.api.detectNewAssignments({ A_pickup: own('accepted') });                      // boot
    h.api.detectNewAssignments({ A_pickup: own('accepted'), T_pickup: own(st) });   // T_pickup newly appears at `st`
    assert.equal(h.calls.chime, 0, `a fresh ${st} pickup never chimes (kills the allow-${st} mutant)`);
  }
});

t('a KNOWN order never re-chimes (no forgetting after the chime)', () => {
  const h = build();
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // boot
  h.api.detectNewAssignments({ A_pickup: own('accepted'), B_pickup: own('accepted') });   // B chimes
  assert.equal(h.calls.chime, 1);
  h.api.detectNewAssignments({ A_pickup: own('accepted'), B_pickup: own('accepted') });   // same again
  assert.equal(h.calls.chime, 1, 'no repeat chime for a known order');
});

t('soundOn=false: toast + vibrate fire, but NO chime sound', () => {
  const h = build({ soundOn: false });
  h.api.detectNewAssignments({ A_pickup: own('accepted') });    // boot
  h.api.detectNewAssignments({ A_pickup: own('accepted'), B_pickup: own('accepted') });
  assert.equal(h.calls.chime, 0, 'no chime sound when soundOn is false');
  assert.ok(h.calls.toasts.includes('¡Nuevo pedido asignado!') && h.calls.vibrates.length === 1, 'still toasts + vibrates');
});

console.log(`✓ chime-fresh: ${passed} checks passed`);
