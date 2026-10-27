'use strict';
// INTL PHONE S-core step 3 — tools/phone-census-core.js: the owner's read-only census of STORED order phones, classed by what the
// strict wire contract (phone/intl.js parseSubmitted) would do with them. COUNTS ONLY — no phone, hash, suffix or order id is ever in
// the output. Run: node tools/phone-census-core.test.js
const assert = require('assert');
const C = require('./phone-census-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1. classes ──
const CASES = [
  ['+50497950000', 'accept:qualified:504'], ['+12197950000', 'accept:qualified:1'], ['+5016221234', 'accept:qualified:501'],
  ['97950000', 'accept:bare8'],
  ['50497950000', 'reject:cc_digits_no_plus'], ['12197950000', 'reject:cc_digits_no_plus'],
  ['+97950000', 'reject:plus_8'], ['+447911123456', 'reject:qualified_unsupported'], ['+5049795000', 'reject:qualified_wrong_length'],
  ['+50497950000123', 'reject:qualified_wrong_length'], ['2197950000', 'reject:bare_other'], ['979500', 'reject:bare_other'],
  ['(+504) 9795-0000', 'reject:cc_digits_no_plus'], ['00504 9795-0000', 'accept:qualified:504'],
  ['', 'empty'], [null, 'empty'], [undefined, 'empty'], [97950000, 'reject:non_string'], ['abc', 'reject:bare_other'],
];
for (const [v, want] of CASES) assert.strictEqual(C.classify(v), want, `CENSUS-CLASS ${JSON.stringify(v)}`);
ok(`classify: accept (qualified per CC / bare-8) vs reject (no-plus CC digits / +8 / unsupported / wrong length / bare other / non-string) / empty (${CASES.length})`);

// ── 2. the window + aggregation: per restaurant, totals, would_reject; counts only ──
const T = Date.UTC(2026, 9, 27, 12);
const orders = {
  a: { created_at: T - 1000, restaurant_id: 'tb_r1', customer_phone: '+50497950000' },
  b: { created_at: T - 2000, restaurant_id: 'tb_r1', customer_phone: '97950000' },
  c: { created_at: T - 3000, restaurant_id: 'tb_r2', customer_phone: '50497950000' },
  d: { created_at: T - 31 * 86400e3, restaurant_id: 'tb_r2', customer_phone: '+97950000' },   // outside a 30-day window
  e: { created_at: 'x', restaurant_id: 'tb_r2', customer_phone: '+97950000' },                 // no numeric timestamp
  f: null,
};
const r = C.aggregate(orders, { nowMs: T, days: 30 });
assert.deepStrictEqual(r, {
  window_days: 30, orders_in_window: 3, skipped_no_timestamp: 1,
  totals: { 'accept:qualified:504': 1, 'accept:bare8': 1, 'reject:cc_digits_no_plus': 1 },
  by_restaurant: { tb_r1: { 'accept:qualified:504': 1, 'accept:bare8': 1 }, tb_r2: { 'reject:cc_digits_no_plus': 1 } },
  would_reject: 1, flip_safe: false,
}, 'CENSUS-AGGREGATE');
const out = JSON.stringify(r);
for (const leak of ['9795', '+', '"a"', '"b"', '"c"', '"d"', '"e"']) assert.ok(!out.includes(leak), `CENSUS-NO-LEAK ${leak}`);
assert.strictEqual(C.aggregate({ a: orders.a }, { nowMs: T, days: 30 }).flip_safe, true, 'CENSUS-FLIP-SAFE when nothing would be rejected and no bare-8');
assert.strictEqual(C.aggregate({ a: orders.a, b: orders.b }, { nowMs: T, days: 30 }).flip_safe, false, 'CENSUS-NOT-FLIP-SAFE-WITH-BARE8 (Option S: bare-8 > 0 ⇒ STOP, Option D)');
assert.strictEqual(C.aggregate({}, { nowMs: T, days: 30 }).flip_safe, false, 'CENSUS-NOT-FLIP-SAFE-WITH-NO-ORDERS (no evidence is not evidence)');
ok('aggregate: the window by created_at, per restaurant + totals + would_reject + flip_safe; no phone / digits / order id in the output');

// ── 2b. the census → flag contract (FLIP-ORDER guard): what the census emits is exactly what the flag accepts ──
{
  const F = require('../phone/flag');
  const safe = C.aggregate({ a: orders.a }, { nowMs: T, days: 30 });
  const quietErr = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
  assert.strictEqual(F.evaluateStrict(C.flipConfig(safe, T, T + 3600e3), T + 3600e3), true, 'CENSUS-FLIP-CONFIG-ACCEPTED');
  assert.strictEqual(quietErr(() => F.evaluateStrict(C.flipConfig(safe, T, T + F.CENSUS_MAX_AGE_MS + 1), T + F.CENSUS_MAX_AGE_MS + 1)), false, 'CENSUS-FLIP-CONFIG-STALE-REFUSED');
  assert.strictEqual(C.flipConfig(C.aggregate(orders, { nowMs: T, days: 30 }), T, T), null, 'CENSUS-NO-FLIP-CONFIG-WHEN-UNSAFE');
  ok('flipConfig: a flip-safe census yields the exact value phone/flag.js accepts (within 7 days); stale → refused; unsafe → none');
}

// ── 3. strict args ──
assert.deepStrictEqual(C.parseArgs([]), { ok: true, days: 30 }, 'CENSUS-ARGS-DEFAULT');
assert.deepStrictEqual(C.parseArgs(['--days', '7']), { ok: true, days: 7 }, 'CENSUS-ARGS-DAYS');
assert.deepStrictEqual(C.parseArgs(['--project', 'tb-proj', '--days', '7']), { ok: true, days: 7 }, 'CENSUS-ARGS-PROJECT-IS-REQUIRE-PROJECTS');
assert.deepStrictEqual(C.parseArgs(['--project=tb-proj']), { ok: true, days: 30 }, 'CENSUS-ARGS-PROJECT-EQ');
for (const bad of [['--days', '0'], ['--days', '91'], ['--days', '1.5'], ['--days'], ['--apply'], ['--days', '7', '--days', '8'], ['--write']]) assert.strictEqual(C.parseArgs(bad).ok, false, `CENSUS-ARGS-REFUSED ${bad.join(' ')}`);
ok('args: --days 1..90 integer (default 30); anything else (incl. --apply / --write) refused');

console.log(`phone-census-core: OK (${n})`);
