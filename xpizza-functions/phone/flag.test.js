'use strict';
// INTL PHONE S-core step 3 (build-order: CASE = FLAG, advisor-approved 2026-10-27) — PHONE_WIRE_STRICT = RTDB config/phone_wire_strict, the repo's cached-flag pattern
// (tracking/flag.js): fresh within 30 s → cached; only an explicit `true` is ON; absent / non-boolean / read error / 500 ms timeout → OFF
// (+ 5 s backoff); a stale `true` is never retained. Run: node phone/flag.test.js
const assert = require('assert');
const F = require('./flag');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T = Date.UTC(2026, 9, 27, 18, 0, 0);   // realistic epoch ms (the pattern's empty cache has at:0)
const dbOf = (fn) => ({ ref: (p) => ({ once: async () => { assert.strictEqual(p, 'config/phone_wire_strict', 'FLAG-PATH'); return { val: () => fn() }; } }) });

(async () => {
  assert.deepStrictEqual([F.FLAG_PATH, F.FLAG_TTL_MS, F.FLAG_REFRESH_TIMEOUT_MS, F.FLAG_BACKOFF_MS], ['config/phone_wire_strict', 30000, 500, 5000], 'FLAG-CONSTANTS');
  // step 5 (advisor ruling Option S): ON only for the census-backed object; anything else → OFF (+ an alarm when a value is present)
  const D = 86400e3;
  const GOOD = { enabled: true, enabled_at: T - D, census: { flip_safe: true, generated_at: T - 3 * D, orders_in_window: 120 } };
  const mut = (f) => { const v = JSON.parse(JSON.stringify(GOOD)); f(v); return v; };
  const CASES = [
    ['absent', null, false, null], ['bare true', true, false, 'not_an_object'], ['string', 'true', false, 'not_an_object'],
    ['enabled false', mut((v) => { v.enabled = false; }), false, null],
    ['no census', mut((v) => { delete v.census; }), false, 'census_missing'],
    ['flip_safe false', mut((v) => { v.census.flip_safe = false; }), false, 'census_not_flip_safe'],
    ['flip_safe "true"', mut((v) => { v.census.flip_safe = 'true'; }), false, 'census_not_flip_safe'],
    ['no generated_at', mut((v) => { delete v.census.generated_at; }), false, 'census_generated_at_invalid'],
    ['no orders_in_window', mut((v) => { delete v.census.orders_in_window; }), false, 'census_orders_in_window_invalid'],
    ['negative orders', mut((v) => { v.census.orders_in_window = -1; }), false, 'census_orders_in_window_invalid'],
    ['no enabled_at', mut((v) => { delete v.enabled_at; }), false, 'enabled_at_invalid'],
    ['enabled in the future', mut((v) => { v.enabled_at = T + 60e3; }), false, 'enabled_at_in_future'],
    ['census after enable', mut((v) => { v.census.generated_at = v.enabled_at + 1; }), false, 'census_after_enable'],
    ['census 7 d + 1 ms before enable', mut((v) => { v.census.generated_at = v.enabled_at - 7 * D - 1; }), false, 'census_stale'],
    ['census exactly 7 d before enable', mut((v) => { v.census.generated_at = v.enabled_at - 7 * D; }), true, null],
    ['good', GOOD, true, null],
    ['good, flipped 60 days ago (never expires)', mut((v) => { v.enabled_at = T - 60 * D; v.census.generated_at = T - 61 * D; }), true, null],
  ];
  for (const [label, v, want, alarm] of CASES) {
    F._resetForTest();
    const errs = []; const e = console.error; console.error = (...a) => errs.push(a);
    let got; try { got = await F.phoneWireStrict(dbOf(() => v), T); } finally { console.error = e; }
    assert.strictEqual(got, want, `FLAG-VALUE ${label}`);
    assert.deepStrictEqual(errs, alarm ? [['phone_wire_strict_refused', alarm]] : [], `FLAG-ALARM ${label}`);
  }
  ok('ON only for {enabled:true, enabled_at, census:{flip_safe:true, generated_at ≤ enabled_at ≤ now, ≤ 7 d apart, orders_in_window ≥ 0}}; every other present value → OFF + phone_wire_strict_refused <reason>; a valid flip never expires');

  F._resetForTest(); let reads = 0; let val = GOOD;
  const db = dbOf(() => { reads += 1; return val; });
  assert.strictEqual(await F.phoneWireStrict(db, T), true);
  val = null;
  assert.strictEqual(await F.phoneWireStrict(db, T + 29999), true, 'FLAG-CACHED-WITHIN-TTL');
  assert.strictEqual(reads, 1, 'FLAG-ONE-READ-WITHIN-TTL');
  assert.strictEqual(await F.phoneWireStrict(db, T + 30000), false, 'FLAG-REFRESHED-AFTER-TTL');
  ok('cached for 30 s, refreshed after');

  F._resetForTest();
  const broken = { ref: () => ({ once: async () => { throw new Error('rtdb down'); } }) };
  const err = console.error; console.error = () => {};
  assert.strictEqual(await F.phoneWireStrict(broken, T), false, 'FLAG-READ-ERROR-OFF');
  console.error = err;
  F._resetForTest();
  const hang = { ref: () => ({ once: () => new Promise(() => {}) }) };
  assert.strictEqual(await F.phoneWireStrict(hang, T), false, 'FLAG-TIMEOUT-OFF');
  ok('a read error or a 500 ms timeout → OFF (fail closed)');

  console.log(`phone-flag: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('phone-flag: FAILED —', e && e.stack || e); process.exit(1); });
