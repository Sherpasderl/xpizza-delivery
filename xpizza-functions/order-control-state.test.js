'use strict';
// D4-c4 — the ONE pause-state interpretation (order-control-state.js; PLAN-D4c4 rev 13 §0.1/§0.2/§0.7). Run: node order-control-state.test.js
// Every decision-order cell, every malformed shape, the no-coercion cells, the clock edges (until − 1 ms / until), the
// pre-gate table and the hold — each disqualifier asserted on its own, so a mutant that drops one row is killed here.
const assert = require('assert');
const S = require('./order-control-state');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const eff = (cur, now = 1000) => S.effectiveState(cur, now);
const st = (cur, now) => eff(cur, now).state;

// (a) absent → OPEN
assert.deepStrictEqual(eff(null), { state: 'open', until: null });
assert.deepStrictEqual(eff(undefined), { state: 'open', until: null });
ok('(a) node absent (null / undefined) → OPEN');

// (b) `paused` absent or not a boolean → UNKNOWN — and a non-object node
for (const cur of [{}, { until: 5000 }, { paused: 'true' }, { paused: 1 }, { paused: 0 }, { paused: null }, { paused: {} }, { paused: [] }, { paused: 'false' },
  'paused', 1, true, false, [], [{ paused: true }], 0]) {
  assert.deepStrictEqual(eff(cur), { state: 'unknown', until: null }, `UNKNOWN for ${JSON.stringify(cur)}`);
}
// a non-object carrying the field (an array, a function) is still not a node — never read as a pause
assert.deepStrictEqual(eff(Object.assign([], { paused: true })), { state: 'unknown', until: null });
assert.deepStrictEqual(eff(Object.assign(() => {}, { paused: true })), { state: 'unknown', until: null });
assert.deepStrictEqual(eff(Object.assign([], { paused: false })), { state: 'unknown', until: null });
ok('(b) paused absent / non-boolean (incl. "true", 1, 0, null, "false") and non-object nodes (string, number, boolean, array, an array / function CARRYING paused) → UNKNOWN');

// (c) paused === false → OPEN, `until` ignored (lenient — ruling 3)
for (const until of [undefined, 5000, 1, -5, 'garbage', null, {}, NaN, Infinity]) {
  assert.deepStrictEqual(eff({ paused: false, ...(until === undefined ? {} : { until }) }), { state: 'open', until: null }, `paused:false + until ${String(until)}`);
}
ok('(c) paused:false → OPEN whatever `until` holds (absent, past, future, malformed)');

// (d) paused === true
assert.deepStrictEqual(eff({ paused: true }), { state: 'paused', until: null });
assert.deepStrictEqual(eff({ paused: true, reason: 'x', version: 3 }), { state: 'paused', until: null });
ok('(d) paused:true with `until` ABSENT → PAUSED, no expiry (the indefinite pause — RTDB drops nulls)');
assert.deepStrictEqual(eff({ paused: true, until: 5000 }, 4999), { state: 'paused', until: 5000 });
assert.deepStrictEqual(eff({ paused: true, until: 5000 }, 5000), { state: 'open', until: null });
assert.deepStrictEqual(eff({ paused: true, until: 5000 }, 5001), { state: 'open', until: null });
assert.deepStrictEqual(eff({ paused: true, until: 0 }, 0), { state: 'open', until: null });
assert.deepStrictEqual(eff({ paused: true, until: -1 }, -2), { state: 'paused', until: -1 });
ok('(d) timed: now = until − 1 ms → PAUSED (until reported); now = until → OPEN; past → OPEN (the auto-resume, no writer)');
for (const until of [null, '5000', '123', 'x', true, false, {}, [], NaN, Infinity, -Infinity]) {
  assert.deepStrictEqual(eff({ paused: true, until }, 1), { state: 'unknown', until: null }, `paused:true + until ${JSON.stringify(until)} (${typeof until})`);
}
ok('(d) paused:true with a malformed `until` (null, "5000", "123", boolean, object, array, NaN, ±Infinity) → UNKNOWN');
assert.strictEqual(st({ paused: 'true', until: '123' }), 'unknown');
assert.strictEqual(st({ paused: 'true', until: 9e15 }), 'unknown');
assert.strictEqual(st({ paused: true, until: '9999999999999' }, 1), 'unknown');
ok('NO COERCION: paused:"true" / until:"123" / until:"9999999999999" → UNKNOWN (never read as a pause or an end time)');

// the request's decision
assert.strictEqual(S.decisionOf('open'), null);
assert.strictEqual(S.decisionOf('paused'), 'paused');
assert.strictEqual(S.decisionOf('unknown'), 'unavailable');
assert.strictEqual(S.decisionOf(undefined), null);
ok('decisionOf: OPEN → admit (null); PAUSED → "paused"; UNKNOWN → "unavailable"');

// the refusals: exact status, body (exact key set) and header
assert.deepStrictEqual(Object.keys(S.REFUSALS).sort(), ['paused', 'unavailable']);
assert.deepStrictEqual({ ...S.REFUSALS.paused.body }, { error: 'ordering_paused', detail: 'Este restaurante no está recibiendo pedidos en este momento. Probá de nuevo más tarde.' });
assert.strictEqual(S.REFUSALS.paused.status, 423);
assert.strictEqual(S.REFUSALS.paused.retryAfter, undefined);
assert.deepStrictEqual({ ...S.REFUSALS.unavailable.body }, { error: 'Service temporarily unavailable', detail: 'Tuvimos un problema momentáneo, probá de nuevo.', retryable: true });
assert.strictEqual(S.REFUSALS.unavailable.status, 503);
assert.strictEqual(S.REFUSALS.unavailable.retryAfter, '2');
assert.ok(Object.isFrozen(S.REFUSALS) && Object.isFrozen(S.REFUSALS.paused.body) && Object.isFrozen(S.REFUSALS.unavailable.body));
ok('REFUSALS: 423 {error:"ordering_paused", detail:<§5 Spanish>} (no Retry-After); 503 {error:"Service temporarily unavailable", detail:<§5 Spanish>, retryable:true} + Retry-After 2; frozen');

// the charge pre-gate (§3 + §0.2)
const FRESH = { willIssueFreshUrl: true };
const NON_FRESH = ['reuse', 'in_progress', 'already_paid', 'closed', 'conflict'].map((outcome) => ({ willIssueFreshUrl: false, outcome }));
assert.deepStrictEqual(S.chargePreGate(null, FRESH), { refuse: null, arm: null });
assert.deepStrictEqual(S.chargePreGate(null, null), { refuse: null, arm: null });
for (const c of NON_FRESH) assert.deepStrictEqual(S.chargePreGate(null, c), { refuse: null, arm: null });
ok('pre-gate OPEN: fresh, classifier-failed and every non-fresh class → admit, nothing armed (today\'s path)');
for (const d of ['paused', 'unavailable']) {
  assert.deepStrictEqual(S.chargePreGate(d, FRESH), { refuse: d, arm: null }, `${d} fresh`);
  assert.deepStrictEqual(S.chargePreGate(d, null), { refuse: 'unavailable', arm: null }, `${d} classifier failed`);
  assert.deepStrictEqual(S.chargePreGate(d, undefined), { refuse: 'unavailable', arm: null }, `${d} classifier undefined`);
  for (const c of NON_FRESH) assert.deepStrictEqual(S.chargePreGate(d, c), { refuse: null, arm: d }, `${d} ${c.outcome}`);
  // fresh means willIssueFreshUrl === true exactly
  assert.deepStrictEqual(S.chargePreGate(d, { willIssueFreshUrl: 'true' }), { refuse: null, arm: d });
  assert.deepStrictEqual(S.chargePreGate(d, {}), { refuse: null, arm: d });
}
ok('pre-gate PAUSED / UNKNOWN: fresh → refused with THAT kind (423 / 503); classifier failed → 503 for both; reuse / in_progress / already_paid / closed / conflict → honoured AND the race guard armed with the kind; "fresh" = willIssueFreshUrl === true exactly');

// the scheduled-release hold
assert.strictEqual(S.releaseHold(null), null);
assert.deepStrictEqual(S.releaseHold('paused'), { cause: 'paused' });
assert.deepStrictEqual(S.releaseHold('unavailable'), { cause: 'unavailable' });
ok('releaseHold: OPEN → release as today; PAUSED → {cause:"paused"}; UNKNOWN → {cause:"unavailable"}');

// a THIRD synthetic restaurant: nothing in the module knows a restaurant (brand-agnostic)
const src = require('fs').readFileSync(require.resolve('./order-control-state'), 'utf8');
assert.ok(!/x_pizza|la_musa|X\. Pizza|La Musa|Tegucigalpa|UTC-?6|-06:00/.test(src), 'no brand or timezone literal in the shared module');
ok('brand / timezone agnostic: the module names no restaurant and no timezone — any rid, incl. a third synthetic one, is read the same way');

console.log(`\norder-control-state: OK (${n})`);
