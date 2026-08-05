/**
 * Unit tests for the pure driver-diag helpers (add-only diagnostics sink).
 * Run: `node driver-diag.test.js`. Mirrors the driver-ingest.test.js pattern.
 * Covers the bounded/validation/prune logic; the onRequest handler + admin writes stay thin.
 */
const assert = require('assert');
const { validateDiagEvents, computeDiagPrune } = require('./driver-diag');

let pass = 0;
function t(name, fn) { fn(); pass++; }

const DAY = 24 * 60 * 60 * 1000;

// ---------- validateDiagEvents(body, maxEvents) ----------
t('validate: non-{events:array} body → ok:false (handler 400s)', () => {
  assert.equal(validateDiagEvents(null).ok, false);
  assert.equal(validateDiagEvents({}).ok, false);
  assert.equal(validateDiagEvents({ events: 'x' }).ok, false);
});
t('validate: keeps well-formed {type, at} + primitive ctx', () => {
  const r = validateDiagEvents({ events: [{ type: 'accept_swipe', at: 1000, taskId: 'T1', connected: true }] });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0], { type: 'accept_swipe', at: 1000, taskId: 'T1', connected: true });
});
t('validate: drops events missing type or non-finite at', () => {
  const r = validateDiagEvents({ events: [
    { at: 1000 },              // no type
    { type: 'x' },             // no at
    { type: 'y', at: 'nope' }, // at not finite
    { type: '', at: 5 },       // empty type
    { type: 'good', at: 2000 },
  ]});
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'good');
});
t('validate: caps to maxEvents (≤50)', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ type: 'e', at: i }));
  assert.equal(validateDiagEvents({ events: many }, 50).events.length, 50);
});
t('validate: sanitizes ctx — primitives only, strings capped, objects/arrays dropped', () => {
  const e = validateDiagEvents({ events: [{
    type: 'accept_err', at: 1, err: 'x'.repeat(2000), nested: { a: 1 }, arr: [1, 2], latencyMs: 5,
  }]}).events[0];
  assert.equal(e.err.length, 500);   // string capped
  assert.equal(e.nested, undefined); // object dropped
  assert.equal(e.arr, undefined);    // array dropped
  assert.equal(e.latencyMs, 5);      // number kept
});
t('validate: prototype-pollution keys ignored, no global pollution', () => {
  const r = validateDiagEvents({ events: [JSON.parse('{"type":"e","at":1,"__proto__":{"polluted":true},"constructor":"x"}')] });
  assert.equal(({}).polluted, undefined);
  assert.equal(r.events.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(r.events[0], 'constructor'));  // unsafe key not copied as own
  assert.ok(!Object.prototype.hasOwnProperty.call(r.events[0], '__proto__'));
});
t('validate: keys with RTDB-illegal chars dropped', () => {
  const e = validateDiagEvents({ events: [{ type: 'e', at: 1, 'bad.key': 'v', okKey: 'v' }] }).events[0];
  assert.equal(e['bad.key'], undefined);
  assert.equal(e.okKey, 'v');
});

// ---------- computeDiagPrune(existing, opts) ----------
t('prune: drops events older than maxAgeMs', () => {
  const now = 100 * DAY;
  const existing = {
    a: { type: 'x', at: now - 8 * DAY },  // >7d → delete
    b: { type: 'x', at: now - 1 * DAY },  // keep
    c: { type: 'x', at: now },            // keep
  };
  assert.deepEqual(computeDiagPrune(existing, { now, maxKeep: 200, maxAgeMs: 7 * DAY }).sort(), ['a']);
});
t('prune: keeps only the newest maxKeep by at', () => {
  const now = 1000000, existing = {};
  for (let i = 0; i < 10; i++) existing['k' + i] = { type: 'x', at: i };  // at 0..9
  const del = computeDiagPrune(existing, { now, maxKeep: 3, maxAgeMs: 7 * DAY });
  assert.equal(del.length, 7);
  assert.ok(!del.includes('k9') && !del.includes('k8') && !del.includes('k7'));
  assert.ok(del.includes('k0') && del.includes('k6'));
});
t('prune: empty / null → nothing to delete', () => {
  assert.deepEqual(computeDiagPrune({}, { now: 1, maxKeep: 200, maxAgeMs: 7 * DAY }), []);
  assert.deepEqual(computeDiagPrune(null, { now: 1, maxKeep: 200, maxAgeMs: 7 * DAY }), []);
});

console.log(`✓ driver-diag: ${pass} tests passed`);
