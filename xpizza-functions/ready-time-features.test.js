'use strict';

// Golden tests for the pure Ready-Time Phase-1 Step-0 feature/label helpers (ready-time-features.js).
// Run: node ready-time-features.test.js
// The immutable to:'new' feature contract + the self-guarding label extraction are pinned here — a
// wrong feature snapshot or a leaked negative delta silently poisons the model.
const assert = require('assert');
const {
  extractCreationFeatures, extractLabels,
  hourOf, daypartOf, loadBucketOf, itemCountBucketOf, bucketKeyExact, bucketKeyDaypart, pickNewEvent,
} = require('./ready-time-features');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const evRow = (over) => ({ to: 'new', at: 100, restaurant_id: 'x_pizza', kitchen_load_ahead: 2, drivers_available: 1, drivers_on_shift: 3, ...over });

// ── extractCreationFeatures — deterministic (at, eventId) selection of the to:'new' row ──
{
  const f = extractCreationFeatures({ '-Eb': evRow({ at: 200 }), '-Ea': evRow({ at: 100 }) }, { restaurant_id: 'x_pizza', items: [1, 2, 3] }, { new_at: 100 });
  assert.strictEqual(f.source_event_id, '-Ea'); ok('pick: earlier at wins (source_event_id = -Ea)');
  assert.deepStrictEqual({ k: f.features.kitchen_load_ahead, a: f.features.drivers_available, s: f.features.drivers_on_shift }, { k: 2, a: 1, s: 3 }); ok('pick: features copied from the CHOSEN event row');
}
{
  const f = extractCreationFeatures({ b: evRow({ at: 100 }), a: evRow({ at: 100 }) }, { restaurant_id: 'x_pizza' }, { new_at: 100 });
  assert.strictEqual(f.source_event_id, 'a'); ok('pick: same-ms at → lexicographically-smaller eventId (documented tie-break)');
}
{
  const f = extractCreationFeatures({ a: evRow({ at: 'x' }), b: evRow({ at: 500 }) }, { restaurant_id: 'x_pizza' }, { new_at: 500 });
  assert.strictEqual(f.source_event_id, 'b'); ok('pick: non-numeric at quarantined, later valid row wins');
}
assert.strictEqual(extractCreationFeatures({ a: evRow({ at: null }) }, {}, {}), null); ok('pick: all to:new rows non-numeric at → null');
assert.strictEqual(extractCreationFeatures({ a: { to: 'preparing', at: 100 } }, {}, {}), null); ok('pick: no to:new event → null');

// ── per-restaurant item_count (x_pizza only; la_musa null; never parse items_text) ──
{
  const fx = extractCreationFeatures({ a: evRow() }, { restaurant_id: 'x_pizza', items: [1, 2, 3] }, { new_at: 100 });
  assert.strictEqual(fx.features.item_count, 3); ok('item_count: x_pizza with 3 items → 3');
  const fl = extractCreationFeatures({ a: evRow({ restaurant_id: 'la_musa' }) }, { restaurant_id: 'la_musa', items_text: 'Ramen x2, Gyoza x1' }, { new_at: 100 });
  assert.strictEqual(fl.features.item_count, null); ok('item_count: la_musa (no items array; items_text present) → null, items_text NOT parsed');
}

// ── temporal features at fixed UTC−6 (NOT server-local) ──
{
  // Jan 2 2024 02:30:00 UTC → local (UTC−6) = Jan 1 2024 20:30 → hour 20, dow 1 (Mon). Naive-UTC would give hour 2, dow 2.
  const ms = Date.UTC(2024, 0, 2, 2, 30, 0);
  const f = extractCreationFeatures({ a: evRow({ at: ms }) }, { restaurant_id: 'x_pizza', items: [1] }, { new_at: ms });
  assert.strictEqual(f.features.hour_of_day, 20); ok('temporal: hour_of_day computed at UTC−6 (20, not naive-UTC 2)');
  assert.strictEqual(f.features.day_of_week, 1); ok('temporal: day_of_week at UTC−6 (Mon=1, not naive-UTC Tue=2)');
}

// ── accept_latency_ms feature ──
{
  const f1 = extractCreationFeatures({ a: evRow() }, { restaurant_id: 'x_pizza', items: [1] }, { new_at: 1000, preparing_at: 1600 });
  assert.strictEqual(f1.features.accept_latency_ms, 600); ok('accept_latency_ms: preparing−new when ordered → 600');
  const f2 = extractCreationFeatures({ a: evRow() }, { restaurant_id: 'x_pizza', items: [1] }, { new_at: 1000 });
  assert.strictEqual(f2.features.accept_latency_ms, null); ok('accept_latency_ms: preparing_at absent → null');
}

// ── extractLabels — per-pair self-guard (fold #5, refined R2): a violation nulls ONLY its own delta ──
{
  const good = extractLabels({ new_at: 1000, preparing_at: 1060, ready_at: 1600, out_for_delivery_at: 1900 });
  assert.deepStrictEqual({ a: good.accept_latency_ms, p: good.prep_ms_from_preparing, nw: good.prep_ms_from_new, iss: good.label_issues },
    { a: 60, p: 540, nw: 600, iss: [] }); ok('labels: ordered timeline → all three deltas correct, no issues');

  const pgtr = extractLabels({ new_at: 1000, preparing_at: 1600, ready_at: 1200 });  // preparing > ready
  assert.strictEqual(pgtr.prep_ms_from_preparing, null); ok('labels: preparing>ready → prep_ms_from_preparing null');
  assert.strictEqual(pgtr.accept_latency_ms, 600); ok('labels: preparing>ready → accept_latency_ms STAYS valid (independent of ready_at)');
  assert.strictEqual(pgtr.prep_ms_from_new, 200); ok('labels: preparing>ready → prep_ms_from_new STAYS valid');
  assert.ok(pgtr.label_issues.includes('neg:prep_from_preparing')); ok('labels: preparing>ready → issue neg:prep_from_preparing only');

  const rltn = extractLabels({ new_at: 1600, ready_at: 1000 });  // ready < new, no preparing
  assert.strictEqual(rltn.prep_ms_from_new, null); assert.ok(rltn.label_issues.includes('neg:prep_from_new')); ok('labels: ready<new → prep_ms_from_new null + issue');
  assert.strictEqual(rltn.accept_latency_ms, null); ok('labels: preparing absent → accept_latency_ms null (no issue, missing allowed)');

  const ngtp = extractLabels({ new_at: 1600, preparing_at: 1000, ready_at: 2000 });  // new > preparing
  assert.strictEqual(ngtp.accept_latency_ms, null); assert.ok(ngtp.label_issues.includes('neg:accept_latency')); ok('labels: new>preparing → only accept_latency_ms null + issue');
  assert.strictEqual(ngtp.prep_ms_from_preparing, 1000); assert.strictEqual(ngtp.prep_ms_from_new, 400); ok('labels: new>preparing → other two deltas stay valid');

  const nn = extractLabels({ new_at: 1000, ready_at: 'x' });  // non-numeric present stamp
  assert.strictEqual(nn.prep_ms_from_new, null); assert.ok(nn.label_issues.includes('nonnum:ready_at')); ok('labels: non-numeric ready_at → prep_ms_from_new null + nonnum:ready_at');

  // invariant: no emitted delta is ever negative
  for (const lab of [good, pgtr, rltn, ngtp, nn]) {
    for (const k of ['accept_latency_ms', 'prep_ms_from_preparing', 'prep_ms_from_new']) {
      if (lab[k] !== null) assert.ok(lab[k] >= 0, `${k}=${lab[k]}`);
    }
  }
  ok('labels: invariant — no emitted delta is ever negative');
}

// ── Step-3 bucket helpers — take an EXPLICIT `at` anchor (event.at), never timeline.new_at (R2-#2) ──
{
  // Jan 2 2024 02:30 UTC → UTC−6 = Jan 1 20:30 → hour 20 (dinner). Naive-UTC would be hour 2 (late).
  const at = Date.UTC(2024, 0, 2, 2, 30, 0);
  assert.strictEqual(hourOf(at), 20); ok('hourOf: UTC−6 anchor (20, not naive 2)');
  assert.strictEqual(daypartOf(at), 'dinner'); ok('daypartOf: hour 20 → dinner');
  // daypart boundaries
  const H = (h) => Date.UTC(2024, 0, 1, h + 6, 0, 0); // local hour h → UTC h+6
  assert.deepStrictEqual([0, 5, 10, 11, 15, 16, 21, 22, 23].map((h) => daypartOf(H(h))),
    ['late', 'morning', 'morning', 'lunch', 'lunch', 'dinner', 'dinner', 'late', 'late']); ok('daypartOf: late<5 / morning5-10 / lunch11-15 / dinner16-21 / late22-4');
}
// loadBucketOf — SAME cut points as the quality monitor (0 / 1-2 / 3-5 / 6+); non-numeric → na
assert.deepStrictEqual([0, 1, 2, 3, 5, 6, 20, null, undefined, NaN].map(loadBucketOf),
  ['0', '1-2', '1-2', '3-5', '3-5', '6+', '6+', 'na', 'na', 'na']); ok('loadBucketOf: 0/1-2/3-5/6+/na');
// itemCountBucketOf — x_pizza composition; 0/invalid → na
assert.deepStrictEqual([1, 2, 3, 4, 10, 0, -1, null, 'x'].map(itemCountBucketOf),
  ['1', '2-3', '2-3', '4+', '4+', 'na', 'na', 'na', 'na']); ok('itemCountBucketOf: 1/2-3/4+/na');
// composite keys
{
  const at = Date.UTC(2024, 0, 2, 2, 30, 0); // hour 20 dinner
  assert.strictEqual(bucketKeyExact(at, 4, 2), '20|3-5|2-3'); ok('bucketKeyExact: hour|loadBucket|itemBucket');
  assert.strictEqual(bucketKeyDaypart(at, 4), 'dinner|3-5'); ok('bucketKeyDaypart: daypart|loadBucket');
  assert.strictEqual(bucketKeyExact(at, null, null), '20|na|na'); ok('bucketKeyExact: missing load/items → na segments (never throws)');
}

// ── pickNewEvent (Step 3, Trigger B) — deterministic (at, eventId) chosen to:'new' row ──
{
  assert.strictEqual(pickNewEvent({ b: { to: 'new', at: 200 }, a: { to: 'new', at: 100, kitchen_load_ahead: 4 } }).at, 100); ok('pickNewEvent: earliest at wins');
  assert.strictEqual(pickNewEvent({ b: { to: 'new', at: 100 }, a: { to: 'new', at: 100 } }).at, 100); ok('pickNewEvent: same-ms → lexicographic eventId tie-break (no throw)');
  assert.strictEqual(pickNewEvent({ a: { to: 'preparing', at: 100 } }), null); ok('pickNewEvent: no to:new → null');
  assert.strictEqual(pickNewEvent({ a: { to: 'new', at: 'x' } }), null); ok('pickNewEvent: non-numeric at → null');
}

console.log(`\n${n} passed`);
