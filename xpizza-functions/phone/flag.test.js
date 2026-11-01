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
    ['zero orders (codex r1 #3: matches the generator)', mut((v) => { v.census.orders_in_window = 0; }), false, 'census_orders_in_window_invalid'],
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

  // ── codex r1 #2: phoneWireStrictNow — SYNCHRONOUS, never awaited on a hot path (stale-while-revalidate) ──
  {
    F._resetForTest(); let reads = 0, resolveRead; let val = GOOD;
    const db = { ref: (p) => ({ once: () => { reads++; assert.strictEqual(p, 'config/phone_wire_strict', 'FLAG-NOW-PATH'); return new Promise((r) => { resolveRead = () => r({ val: () => val }); }); } }) };
    const v0 = F.phoneWireStrictNow(db, T);
    assert.strictEqual(v0, false, 'FLAG-NOW-COLD-IS-OFF (a boolean, not a Promise)');
    assert.strictEqual(reads, 1, 'FLAG-NOW-COLD-REFRESHES-IN-BACKGROUND');
    assert.strictEqual(F.phoneWireStrictNow(db, T), false, 'FLAG-NOW-STILL-OFF-WHILE-REFRESHING');
    assert.strictEqual(reads, 1, 'FLAG-NOW-ONE-INFLIGHT-REFRESH');
    resolveRead(); await new Promise((r) => setImmediate(r));
    assert.strictEqual(F.phoneWireStrictNow(db, T + 1000), true, 'FLAG-NOW-FRESH-AFTER-REFRESH');
    assert.strictEqual(reads, 1, 'FLAG-NOW-FRESH-NO-READ');
    val = null;
    assert.strictEqual(F.phoneWireStrictNow(db, T + 30000), true, 'FLAG-NOW-STALE-SERVES-CACHED-WHILE-REVALIDATING');
    assert.strictEqual(reads, 2, 'FLAG-NOW-STALE-TRIGGERS-ONE-REFRESH');
    resolveRead(); await new Promise((r) => setImmediate(r));
    assert.strictEqual(F.phoneWireStrictNow(db, T + 30001), false, 'FLAG-NOW-REVALIDATED-OFF');
    F._resetForTest();
    const broken = { ref: () => ({ once: async () => { throw new Error('down'); } }) };
    const e = console.error; console.error = () => {};
    try { assert.strictEqual(F.phoneWireStrictNow(broken, T), false, 'FLAG-NOW-ERROR-OFF'); await new Promise((r) => setImmediate(r)); assert.strictEqual(F.phoneWireStrictNow(broken, T + 1), false, 'FLAG-NOW-ERROR-STAYS-OFF'); } finally { console.error = e; }
    ok('phoneWireStrictNow: synchronous boolean; cold → OFF at once + ONE background refresh; fresh → cached, no read; stale → cached value while ONE refresh revalidates; error → OFF');
  }

  // TRACE-SUITE DETERMINISM (advisor ruling B, 2026-11-01 — order-control went RED 5–8 random cells after the intl merge): the
  // never-awaited revalidation landed inside whichever traced request crossed the 30 s TTL. The TTL now runs on an INJECTABLE
  // clock (a trace suite installs its catalog clock; production keeps Date.now), and _warmForTest puts the cache in a known
  // state — freshly read, any in-flight refresh settled first — before a recorded request. Last block: the clock is once per process.
  {
    const settle = () => new Promise((r) => setImmediate(r));
    F._resetForTest();
    const reads = [];
    const db = { ref: (p) => ({ once: async () => { reads.push(p); return { val: () => null }; } }) };
    let v = T; const realNow = Date.now;
    F._useClock(() => v);
    assert.throws(() => F._useClock(() => v), /once per process/, 'FLAG-CLOCK-ONCE');
    try {
      Date.now = () => realNow() + 3600e3;   // wall time jumps an hour: the hooked TTL must not notice
      const seq = [];
      for (const dt of [0, 1000, 29999, 30000, 30001, 59999, 60000]) { v = T + dt; const before = reads.length; F.phoneWireStrictNow(db); await settle(); seq.push(reads.length - before); }
      assert.deepStrictEqual(seq, [1, 0, 0, 1, 0, 0, 1], 'FLAG-CLOCK-READ-SET (exactly one read per expired TTL on the injected clock, none within it, whatever the wall clock does)');
      assert.deepStrictEqual([...new Set(reads)], ['config/phone_wire_strict'], 'FLAG-CLOCK-ONLY-PATH (the refresh never reads an order)');
      let release = null;
      const slow = { ref: (p) => ({ once: () => { reads.push(p); return new Promise((r) => { release = () => r({ val: () => null }); }); } }) };
      v += 45000; F.phoneWireStrictNow(slow);   // stale: ONE background read, still in flight
      assert.ok(release, 'premise — the background read is in flight');
      const n0 = reads.length;
      const w = F._warmForTest(db);
      await settle(); await settle();
      assert.strictEqual(reads.length, n0, 'FLAG-WARM-WAITS-FOR-INFLIGHT (no fresh read while the earlier refresh is still open)');
      release();
      assert.strictEqual(await w, false, 'FLAG-WARM-VALUE');
      assert.strictEqual(reads.length - n0, 1, 'FLAG-WARM-ONE-FRESH-READ');
      const n1 = reads.length; F.phoneWireStrictNow(db); F.phoneWireStrictNow(db); await settle();
      assert.strictEqual(reads.length, n1, 'FLAG-WARM-NEXT-REQUEST-ZERO-READS (a recorded request after the warm reads no flag)');
      v += 29999; F.phoneWireStrictNow(db); await settle();
      assert.strictEqual(reads.length, n1, 'FLAG-WARM-FULL-TTL (fresh for a whole TTL from the warm)');
      // a timed-out refresh backs off on the SAME injected clock (5 s), not on wall time
      const hang = { ref: (p) => ({ once: () => { reads.push(p); return new Promise(() => {}); } }) };
      F._resetForTest(); const e0 = console.error; console.error = () => {};
      try {
        F.phoneWireStrictNow(hang); await new Promise((r) => setTimeout(r, F.FLAG_REFRESH_TIMEOUT_MS + 100));
        const n2 = reads.length;
        v += F.FLAG_BACKOFF_MS - 1; F.phoneWireStrictNow(db); await settle();
        assert.strictEqual(reads.length, n2, 'FLAG-CLOCK-BACKOFF-HELD (inside the 5 s backoff on the injected clock: no read)');
        v += 1; F.phoneWireStrictNow(db); await settle();
        assert.strictEqual(reads.length, n2 + 1, 'FLAG-CLOCK-BACKOFF-ENDS (the backoff ends on the injected clock, not wall time)');
      } finally { console.error = e0; }
    } finally { Date.now = realNow; }
    ok('injectable TTL clock: one config/phone_wire_strict read per expired TTL on the injected clock, none within it, a wall-clock jump ignored, installed once; _warmForTest waits out an in-flight refresh, reads once, and the next request reads nothing for a full TTL; a timed-out refresh backs off 5 s on the injected clock');
  }

  console.log(`phone-flag: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('phone-flag: FAILED —', e && e.stack || e); process.exit(1); });
