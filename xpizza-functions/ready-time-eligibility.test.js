'use strict';

// Golden tests for the pure Ready-Time Phase-1 Step-0 eligibility/filter helpers
// (ready-time-eligibility.js). Run: node ready-time-eligibility.test.js
//
// These predicates decide which orders become training rows for the ready-time predictor. A wrong
// verdict silently poisons the model (trains on a test order) or silently starves it (drops a real
// one), so every branch of the rev-3 design (PHASE1_STEP0_SCHEMA_ELIGIBILITY.md §2-§4) is pinned here.
const assert = require('assert');
const {
  timelineSanity, isTrainingEligible, isValidModelVersion, assertNonzeroEligibleCounts,
} = require('./ready-time-eligibility');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const HOUR = 3600000;
// cfg: real (non-fail-closed) config used by most cases. Phone keys = normalizePhone output form (no '+').
const CFG = {
  max_plausible_prep_ms: 3 * HOUR,
  epoch_start_ms: { x_pizza: 1_600_000_000_000, la_musa: 1_600_000_000_000 },
  excluded_phones: { '50493736607': true },
  excluded_orders: { 'PZX-260702-145122': true },
};
const NEW = 1_700_000_000_000;              // well after epoch
// A fully clean, eligible x_pizza order (post-epoch, sane timeline, real-looking phone, has to:'new').
const cleanOrder = () => ({ order_id: 'ORD_ok', restaurant_id: 'x_pizza', customer_phone: '9999-8888' });
const cleanTimeline = () => ({ new_at: NEW, preparing_at: NEW + 60_000, ready_at: NEW + 600_000, out_for_delivery_at: NEW + 900_000 });
const cleanEvents = () => ({ '-Ea': { to: 'new', at: NEW, restaurant_id: 'x_pizza', kitchen_load_ahead: 2, drivers_available: 1, drivers_on_shift: 3 } });

// ── timelineSanity — monotonic ordering of present numeric stamps ──
{
  assert.deepStrictEqual(timelineSanity(cleanTimeline()), { ok: true, violation: null }); ok('sanity: fully ordered chain → ok');
  assert.deepStrictEqual(timelineSanity({ new_at: NEW, ready_at: NEW + 600_000 }), { ok: true, violation: null }); ok('sanity: missing intermediates allowed (new+ready only) → ok');
  assert.strictEqual(timelineSanity({ new_at: NEW, ready_at: NEW + 600_000, out_for_delivery_at: NEW + 300_000 }).violation, 'ready>ofd'); ok('sanity: ready_at > out_for_delivery_at → ready>ofd (batch-tap case)');
  assert.strictEqual(timelineSanity({ new_at: NEW, preparing_at: NEW + 600_000, ready_at: NEW + 300_000 }).violation, 'preparing>ready'); ok('sanity: preparing_at > ready_at → preparing>ready');
  assert.strictEqual(timelineSanity({ new_at: NEW + 600_000, preparing_at: NEW }).violation, 'new>preparing'); ok('sanity: new_at > preparing_at → new>preparing');
  assert.strictEqual(timelineSanity({ new_at: NEW + 600_000, ready_at: NEW }).violation, 'new>ready'); ok('sanity: new_at > ready_at (preparing absent) → new>ready');
}

// ── isTrainingEligible — R1..R8 (all reasons collected, no short-circuit) ──
{
  const v = isTrainingEligible(cleanOrder(), cleanTimeline(), cleanEvents(), CFG);
  assert.deepStrictEqual(v, { eligible: true, reasons: [] }); ok('eligible: clean post-epoch sane real order → { eligible:true, reasons:[] }');
}
// R1 never_new: no to:'new' event with a numeric at
{
  const r = isTrainingEligible(cleanOrder(), cleanTimeline(), {}, CFG).reasons;
  assert.ok(r.includes('never_new'), r); ok('R1: no to:new event → never_new');
  const r2 = isTrainingEligible(cleanOrder(), cleanTimeline(), { '-Ex': { to: 'new', at: 'NaN-ish' } }, CFG).reasons;
  assert.ok(r2.includes('never_new'), r2); ok('R1: to:new with non-numeric at → never_new');
}
// R2 no_ready_label
{
  const t = cleanTimeline(); delete t.ready_at;
  assert.ok(isTrainingEligible(cleanOrder(), t, cleanEvents(), CFG).reasons.includes('no_ready_label')); ok('R2: ready_at absent → no_ready_label');
  const t2 = cleanTimeline(); t2.ready_at = 'x';
  assert.ok(isTrainingEligible(cleanOrder(), t2, cleanEvents(), CFG).reasons.includes('no_ready_label')); ok('R2: ready_at non-numeric → no_ready_label');
}
// R2b no_new_label (fold #3) — event exists but the label anchor is missing/non-numeric
{
  const t = cleanTimeline(); delete t.new_at;
  assert.ok(isTrainingEligible(cleanOrder(), t, cleanEvents(), CFG).reasons.includes('no_new_label')); ok('R2b: new_at absent (event present) → no_new_label');
  const t2 = cleanTimeline(); t2.new_at = null;
  assert.ok(isTrainingEligible(cleanOrder(), t2, cleanEvents(), CFG).reasons.includes('no_new_label')); ok('R2b: new_at non-numeric → no_new_label');
}
// R3 timeline_sanity:<edge>
{
  const t = cleanTimeline(); t.out_for_delivery_at = NEW + 300_000;   // ready(+600k) > ofd(+300k)
  assert.ok(isTrainingEligible(cleanOrder(), t, cleanEvents(), CFG).reasons.includes('timeline_sanity:ready>ofd')); ok('R3: ready>ofd → timeline_sanity:ready>ofd');
}
// R4 nonpositive_prep
{
  const t = cleanTimeline(); t.ready_at = NEW; delete t.preparing_at; delete t.out_for_delivery_at;  // ready == new
  assert.ok(isTrainingEligible(cleanOrder(), t, cleanEvents(), CFG).reasons.includes('nonpositive_prep')); ok('R4: ready_at == new_at → nonpositive_prep');
}
// R5 implausible_prep (default bound 3h)
{
  const t = cleanTimeline(); t.ready_at = NEW + 4 * HOUR; t.out_for_delivery_at = NEW + 4 * HOUR + 60_000;
  assert.ok(isTrainingEligible(cleanOrder(), t, cleanEvents(), CFG).reasons.includes('implausible_prep')); ok('R5: prep 4h > 3h bound → implausible_prep');
  const t2 = cleanTimeline(); t2.ready_at = NEW + (3 * HOUR - 60_000); t2.out_for_delivery_at = t2.ready_at + 60_000;
  assert.ok(!isTrainingEligible(cleanOrder(), t2, cleanEvents(), CFG).reasons.includes('implausible_prep')); ok('R5: prep 2h59m ≤ 3h bound → clears');
}
// R6 before_epoch + fail-closed on unset epoch
{
  const t = cleanTimeline(); t.new_at = CFG.epoch_start_ms.x_pizza - 100_000; t.preparing_at = t.new_at + 60_000; t.ready_at = t.new_at + 600_000; t.out_for_delivery_at = t.new_at + 900_000;
  const ev = { '-Ea': { ...cleanEvents()['-Ea'], at: t.new_at } };
  assert.ok(isTrainingEligible(cleanOrder(), t, ev, CFG).reasons.includes('before_epoch')); ok('R6: new_at before epoch → before_epoch');
  // epoch unset for restaurant → fail-closed (+Infinity) → before_epoch for any numeric new_at
  const cfgNoEpoch = { ...CFG, epoch_start_ms: {} };
  assert.ok(isTrainingEligible(cleanOrder(), cleanTimeline(), cleanEvents(), cfgNoEpoch).reasons.includes('before_epoch')); ok('R6: epoch unset → before_epoch (fail-closed)');
}
// R7 excluded_phone — every input form normalizes to the denylist key; invalid phone matches nothing
{
  for (const p of ['+504 9373-6607', '9373-6607', '50493736607']) {
    const o = cleanOrder(); o.customer_phone = p;
    assert.ok(isTrainingEligible(o, cleanTimeline(), cleanEvents(), CFG).reasons.includes('excluded_phone'), `phone ${p}`);
  }
  ok('R7: +504 9373-6607 / 9373-6607 / 50493736607 all → excluded_phone');
  const bad = cleanOrder(); bad.customer_phone = '123';   // normalizePhone → null
  assert.doesNotThrow(() => isTrainingEligible(bad, cleanTimeline(), cleanEvents(), CFG));
  assert.ok(!isTrainingEligible(bad, cleanTimeline(), cleanEvents(), CFG).reasons.includes('excluded_phone')); ok('R7: invalid phone (normalize→null) → not excluded, no throw');
}
// R8 excluded_order
{
  const o = cleanOrder(); o.order_id = 'PZX-260702-145122';
  assert.ok(isTrainingEligible(o, cleanTimeline(), cleanEvents(), CFG).reasons.includes('excluded_order')); ok('R8: order_id in excluded_orders → excluded_order');
}
// Multi-reason: pre-epoch AND denylisted phone → BOTH collected, no short-circuit
{
  const o = cleanOrder(); o.customer_phone = '50493736607';
  const t = cleanTimeline(); t.new_at = CFG.epoch_start_ms.x_pizza - 100_000; t.preparing_at = t.new_at + 60_000; t.ready_at = t.new_at + 600_000; t.out_for_delivery_at = t.new_at + 900_000;
  const ev = { '-Ea': { ...cleanEvents()['-Ea'], at: t.new_at } };
  const r = isTrainingEligible(o, t, ev, CFG).reasons;
  assert.ok(r.includes('before_epoch') && r.includes('excluded_phone'), r); ok('multi-reason: before_epoch + excluded_phone both collected');
}
// cfg missing entirely → built-in fail-closed defaults (nothing eligible until epoch set)
{
  const v = isTrainingEligible(cleanOrder(), cleanTimeline(), cleanEvents(), undefined);
  assert.strictEqual(v.eligible, false); assert.ok(v.reasons.includes('before_epoch')); ok('cfg undefined → fail-closed (before_epoch), not eligible');
}
// legacy order with no restaurant_id normalizes to x_pizza
{
  const o = cleanOrder(); delete o.restaurant_id;
  assert.deepStrictEqual(isTrainingEligible(o, cleanTimeline(), cleanEvents(), CFG), { eligible: true, reasons: [] }); ok('legacy no restaurant_id → normalized x_pizza, eligible');
}

// ── isValidModelVersion (fold #6) — RTDB-path-safe key ──
{
  for (const good of ['v1', 'v2_median-hod', 'A'.repeat(64)]) assert.strictEqual(isValidModelVersion(good), true, good);
  ok('modelVersion: accepts v1 / v2_median-hod / 64-char');
  for (const bad of ['', 'A'.repeat(65), 'a.b', 'a/b', 'a$b', 'a#b', 'a[b', 'a]b', 'a b', 42, null, undefined]) assert.strictEqual(isValidModelVersion(bad), false, JSON.stringify(bad));
  ok('modelVersion: rejects empty / 65-char / . / $ # [ ] / whitespace / non-string');
}

// ── assertNonzeroEligibleCounts (fold #1) — zero-row guard, pure ──
{
  assert.deepStrictEqual(assertNonzeroEligibleCounts({ x_pizza: 5, la_musa: 2 }, ['x_pizza', 'la_musa']), { ok: true, counts: { x_pizza: 5, la_musa: 2 } }); ok('zero-guard: all active > 0 → { ok:true }');
  // a NON-active restaurant at 0 is intended-empty → no throw
  assert.doesNotThrow(() => assertNonzeroEligibleCounts({ x_pizza: 5, la_musa: 0 }, ['x_pizza'])); ok('zero-guard: non-active restaurant at 0 → no throw (intended-empty explicit)');
  // active restaurant at 0 → throws, offender carried
  let e1; try { assertNonzeroEligibleCounts({ x_pizza: 5, la_musa: 0 }, ['x_pizza', 'la_musa']); } catch (err) { e1 = err; }
  assert.ok(e1, 'expected throw'); assert.ok(e1.offenders.some((o) => o.restaurant_id === 'la_musa' && o.count === 0)); assert.deepStrictEqual(e1.counts, { x_pizza: 5, la_musa: 0 }); ok('zero-guard: active restaurant at 0 → throws with offender + full counts');
  // active restaurant MISSING from counts → treated as zero → throws
  let e2; try { assertNonzeroEligibleCounts({ x_pizza: 5 }, ['x_pizza', 'la_musa']); } catch (err) { e2 = err; }
  assert.ok(e2 && e2.offenders.some((o) => o.restaurant_id === 'la_musa')); ok('zero-guard: active restaurant missing from counts → throws');
}

console.log(`\n${n} passed`);
