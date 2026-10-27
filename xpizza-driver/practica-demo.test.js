// practica-demo.test.js — the Inicio (c) practica demo is CLIENT-ONLY with ZERO RTDB writes (O5). It lifts the REAL
// shipped companionPracticeStart, renders it against a spying SDK + spying XPD write methods, drives every step with
// actual clicks, and asserts: no firebase write (set/update/push/transaction/remove) and no XPD order-write
// (acceptTask/pickupComplete/completeTask/submitDriverProfile) is ever reached; the demo reaches the end and marks
// practiceDone in the PROGRESS store (never a real order). Run: `node practica-demo.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeVuelto } from './cash-helpers.js';
import { activeCardHtml, pickupReviewHtml, deliverySummaryHtml } from './stacked-view.js';
import { singleOrderCardHtml } from './single-order-view.js';

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// minimal fake DOM: elements appear after screen-companion's innerHTML names them; click() runs the registered handler.
function makeDom() {
  const els = {}; const exists = new Set(['screen-companion']);
  const mkEl = (id) => ({ value: '', _html: '', _h: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (id === 'screen-companion') { exists.clear(); exists.add('screen-companion'); for (const m of String(v).matchAll(/id="([\w-]+)"/g)) exists.add(m[1]); } },
    addEventListener(ev, fn) { this._h[ev] = fn; }, click() { return this._h.click && this._h.click(); },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, querySelectorAll() { return []; }, closest() { return this; }, getAttribute() { return null; },
    insertAdjacentHTML() {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } });
  const $ = (id) => (exists.has(id) ? (els[id] || (els[id] = mkEl(id))) : null);
  return { $, has: (id) => exists.has(id) };
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Spying SDK: the ONLY ways to write RTDB. If the demo were not client-only, one of these would fire.
const writes = { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0 };
const dbSpy = { set: () => { writes.set++; }, update: () => { writes.update++; }, push: () => { writes.push++; }, transaction: () => { writes.transaction++; }, remove: () => { writes.remove++; } };
const XPD = { RESTAURANT: { lat: 15.5074, lng: -88.0398 }, db: dbSpy,
  acceptTask: () => { writes.acceptTask++; }, pickupComplete: () => { writes.pickupComplete++; },
  completeTask: () => { writes.completeTask++; }, submitDriverProfile: () => { writes.submitDriverProfile++; } };

// Build a runnable companionPracticeStart with the real builders + progress store + spying externals injected.
function build({ dom }) {
  const body = [liftFn('companionReadProgress'), liftFn('companionWriteProgress'), liftFn('companionPracticeStart')].join('\n');
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const ICONS = new Proxy({}, { get: () => '' });                 // any icon → '' (we test writes, not glyphs)
  const fn = new Function(
    '$', 'escapeHtml', 'showScreen', 'ICONS', 'XPD', 'currentUser', 'computeVuelto', 'scheduledBadge',
    'singleOrderCardHtml', 'pickupReviewHtml', 'activeCardHtml', 'deliverySummaryHtml',
    'companionRenderOnboarding', 'localStorage', '__out',
    `let companionStep = 'practice';\nlet companionProgressMem = {}; const companionProgressKey = (uid) => \`sherpa_driver_checklist_progress_\${uid}\`;\n` +
    `${body}\n` +
    'return { companionPracticeStart, companionReadProgress, store: () => companionProgressMem, getStep: () => companionStep };',
  );
  const api = fn(dom.$, escapeHtml, () => {}, ICONS, XPD, { uid: 'A' }, computeVuelto, () => '',
    singleOrderCardHtml, pickupReviewHtml, activeCardHtml, deliverySummaryHtml,
    () => {}, localStorage, {});
  return api;
}

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

t('the whole demo runs with ZERO RTDB writes and ZERO order-writes, then returns to the checklist with practiceDone', () => {
  const dom = makeDom();
  const host = build({ dom });
  host.companionPracticeStart();                            // step 0: the offer
  assert.ok(dom.has('btn-accept'), 'the offer screen rendered (btn-accept present)');
  dom.$('btn-accept').click();                              // → recoger
  assert.ok(dom.has('btn-pickup'), 'the recoger/review screen rendered (btn-pickup present)');
  dom.$('btn-pickup').click();                              // → entregar
  assert.ok(dom.has('btn-delivered'), 'the delivery screen rendered (btn-delivered present)');
  dom.$('btn-delivered').click();                           // → resumen
  assert.ok(dom.has('co-demo-done'), 'the resumen rendered (co-demo-done present)');
  dom.$('co-demo-done').click();                            // → back to checklist
  // the writes: EVERY counter must be 0 — no write path is reachable from the demo controller.
  assert.deepEqual(writes, { set: 0, update: 0, push: 0, transaction: 0, remove: 0, acceptTask: 0, pickupComplete: 0, completeTask: 0, submitDriverProfile: 0 },
    'the practica demo must perform ZERO writes (RTDB set/update/push/transaction/remove AND XPD order-writes)');
  assert.equal(host.getStep(), 'checklist', 'the demo returned to the checklist at the end');
  assert.equal(host.store().A.practiceDone, true, 'practiceDone recorded in the PROGRESS store (never a real order)');
});

console.log(`✓ practica-demo: ${passed} test passed — zero writes (${Object.values(writes).reduce((a, b) => a + b, 0)} total)`);
