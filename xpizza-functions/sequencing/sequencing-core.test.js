'use strict';
// BUILD-stacked-seq-server r5 T2 — the pure core of stacked-delivery sequencing: the canonical stack id, the stack gate
// (D7: same-HUB pairs only; a cross-hub pair is "not a sequenced pair", today's rule), the decision formula (D2: +6 min,
// the unrounded 360 s boundary, the incumbent-first tie), the Routes element budget (D8) and the bounded race (r4 P2-4).
// Brand-agnostic synthetic tb_ fixtures throughout.
// Run: node sequencing/sequencing-core.test.js
const assert = require('assert');
const { stackIdFor } = require('./id');
const { stackGate } = require('./gate');
const { decide, H_S, PLUS_MAX_S } = require('./decide');
const { reserve, budgetKeys, DAY_CAP, MONTH_CAP, ELEMENTS_PER_CALL } = require('./budget');
const { bounded, isDeadline } = require('./bounded');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('sequencing-core: FAILED — exited without completing'); process.exitCode = 1; } });

// ── fixtures: two synthetic brands at two hubs, plus a third brand CO-LOCATED with the first (one pickup, D7 (a)) ──
const HUBS = { tb_centro: { lat: 15.5, lng: -88.0 }, tb_norte: { lat: 15.6, lng: -88.1 }, tb_vecino: { lat: 15.5, lng: -88.0 }, tb_nohub: null };
const FULL = (readyAt) => ({ committed_min: 20, extra_min: 0, accepted_at: readyAt - 20 * 60000, ready_at: readyAt });
const member = (oid, rid, { prep = FULL(1_000_000), lat = 15.55, lng = -88.05, order_type = 'delivery', pickup = {} } = {}) => ({
  oid,
  order: { order_type, prep, lat, lng, restaurant_id: rid },
  pickup: { restaurant_id: rid, destination_lat: HUBS[rid] ? HUBS[rid].lat : 1, destination_lng: HUBS[rid] ? HUBS[rid].lng : 1, ...pickup },
});
const gate = (inc, cand, otherCount = 1) => stackGate({ incumbent: inc, candidate: cand, otherCount, hubs: HUBS });

(async () => {
  // ── 1. id: canonical over the unordered pair, unambiguous, the driver part of the key ──────────────────────────
  {
    const a = stackIdFor('drv_1', 'ord_b', 'ord_a');
    const b = stackIdFor('drv_1', 'ord_a', 'ord_b');
    assert.deepStrictEqual(a, b, 'argument order is irrelevant');
    assert.match(a.stack_id, /^stk_[0-9a-f]{32}$/);
    assert.deepStrictEqual(a.pair, ['ord_a', 'ord_b'], 'the stored tuple is the sorted pair');
    assert.notStrictEqual(stackIdFor('drv_2', 'ord_a', 'ord_b').stack_id, a.stack_id, 'the uid is part of the key');
    // `_` inside ids cannot make two different tuples collide (JSON-array encoding, never a joined string)
    assert.notStrictEqual(stackIdFor('d', 'a_b', 'c').stack_id, stackIdFor('d_a', 'b', 'c').stack_id);
    assert.notStrictEqual(stackIdFor('d', 'a', 'b_c').stack_id, stackIdFor('d', 'a_b', 'c').stack_id);
    assert.throws(() => stackIdFor('d', 'a', 'a'), /distinct/, 'a pair of one order is refused');
    for (const bad of [null, '', 7]) assert.throws(() => stackIdFor(bad, 'a', 'b'), /stackIdFor/, `uid ${JSON.stringify(bad)}`);
    ok('stackIdFor: order-free, sorted tuple, uid in the key, no `_` collision, one-order pair and bad uid refused');
  }

  // ── 2. gate: every reason, and D7 — cross-hub is "not a sequenced pair" ───────────────────────────────────────
  {
    const I = member('ord_i', 'tb_centro');
    const N = member('ord_n', 'tb_centro');
    const g = gate(I, N);
    assert.strictEqual(g.ok, true, `same hub, full prep, coords → ok (${JSON.stringify(g)})`);
    assert.deepStrictEqual(g.hub, HUBS.tb_centro, 'the shared hub is returned');
    assert.strictEqual(g.hub_rid, 'tb_centro');
    // D7 (a): a co-located DIFFERENT restaurant is one pickup → same hub
    assert.strictEqual(gate(I, member('ord_n', 'tb_vecino')).ok, true, 'co-located restaurants share the hub (D7 (a))');
    // not_one: the driver must hold exactly one other order
    for (const c of [0, 2, 3]) assert.deepStrictEqual(gate(I, N, c), { ok: false, reason: 'not_one' }, `otherCount ${c}`);
    // cross_hub: different hubs, or either hub unresolvable — today's unsequenced rule; checked BEFORE prep/coords
    assert.deepStrictEqual(gate(I, member('ord_n', 'tb_norte')), { ok: false, reason: 'cross_hub' });
    assert.deepStrictEqual(gate(member('ord_i', 'tb_centro', { prep: null }), member('ord_n', 'tb_norte', { prep: null })), { ok: false, reason: 'cross_hub' }, 'cross-hub wins over no_prep');
    assert.deepStrictEqual(gate(I, member('ord_n', 'tb_nohub')), { ok: false, reason: 'cross_hub' }, 'an unresolvable hub is not a sequenced pair');
    assert.deepStrictEqual(gate(I, member('ord_n', 'tb_centro', { pickup: { destination_lat: 15.51 } })), { ok: false, reason: 'cross_hub' }, 'stamped coords off the hub → unresolvable');
    // not_delivery
    assert.deepStrictEqual(gate(I, member('ord_n', 'tb_centro', { order_type: 'pickup' })), { ok: false, reason: 'not_delivery' });
    // no_prep: either side without a FULL stored prep (vStoredPrep), or a ready_at that is not finite
    const withPrep = (oid, prep) => { const m = member(oid, 'tb_centro'); if (prep === 'ABSENT') delete m.order.prep; else m.order.prep = prep; return m; };
    for (const prep of [null, 'ABSENT', { ready_marked_at: 5 }, { ...FULL(1_000_000), extra: 1 }, { committed_min: 20 }]) {
      assert.deepStrictEqual(gate(I, withPrep('ord_n', prep)), { ok: false, reason: 'no_prep' }, `candidate prep ${JSON.stringify(prep)}`);
      assert.deepStrictEqual(gate(withPrep('ord_i', prep), N), { ok: false, reason: 'no_prep' }, `incumbent prep ${JSON.stringify(prep)}`);
    }
    // missing_coords: either order without finite lat/lng
    for (const [lat, lng] of [[null, -88], [15.5, undefined], [NaN, -88], ['15', -88]]) {
      const at = (oid) => { const m = member(oid, 'tb_centro'); m.order.lat = lat; m.order.lng = lng; return m; };
      assert.deepStrictEqual(gate(I, at('ord_n')), { ok: false, reason: 'missing_coords' }, `candidate ${lat},${lng}`);
      assert.deepStrictEqual(gate(at('ord_i'), N), { ok: false, reason: 'missing_coords' }, `incumbent ${lat},${lng}`);
    }
    // the incumbent is never the candidate
    assert.deepStrictEqual(gate(I, { ...N, oid: 'ord_i' }), { ok: false, reason: 'not_one' }, 'a pair of one order');
    ok('stackGate: ok for a same-hub full-prep pair (co-located restaurants included, D7 (a)); not_one, cross_hub (incl. unresolvable, before prep), not_delivery, no_prep, missing_coords');
  }

  // ── 3. decide: hand-computed sequences, the unrounded 360 s boundary, the tie, invalid legs ───────────────────
  {
    assert.strictEqual(H_S, 120, 'h = 120 s (D8)'); assert.strictEqual(PLUS_MAX_S, 360, '+6 min (D2)');
    const T = 1_000_000;
    // I-first: plusN = HI + h + IN − HN; N-first: plusI = HN + h + NI − HI
    // HI=600 HN=600 IN=100 NI=100 → plusN = 220, plusI = 220; sums equal → the tie goes to I-first
    assert.deepStrictEqual(decide({ T, legs: { HI: 600, HN: 600, IN: 100, NI: 100 } }), { stack: true, first: 'I', second: 'N', plus_s: 220, plus_min: 4 }, 'a tie → I-first');
    // N is much closer: I-first plusN = 900+120+300−300 = 1020 (over); N-first plusI = 300+120+300−900 = −180 → N-first
    assert.deepStrictEqual(decide({ T, legs: { HI: 900, HN: 300, IN: 300, NI: 300 } }), { stack: true, first: 'N', second: 'I', plus_s: -180, plus_min: -3 }, 'N-first when only it fits');
    // both fit (plusN = 600+120+50−650 = 120, plusI = 650+120+100−600 = 270); the lower arrival sum wins:
    // I-first 2·HI+h+IN = 1370 < N-first 2·HN+h+NI = 1520 → I-first
    assert.deepStrictEqual(decide({ T, legs: { HI: 600, HN: 650, IN: 50, NI: 100 } }), { stack: true, first: 'I', second: 'N', plus_s: 120, plus_min: 2 });
    // and the mirror: N-first has the lower sum → N-first (plusI = 600+120+50−650 = 120)
    assert.deepStrictEqual(decide({ T, legs: { HI: 650, HN: 600, IN: 100, NI: 50 } }), { stack: true, first: 'N', second: 'I', plus_s: 120, plus_min: 2 });
    // the boundary is UNROUNDED: plus = 360 passes, 360.000001 does not
    assert.strictEqual(decide({ T, legs: { HI: 400, HN: 400, IN: 240, NI: 1000 } }).plus_s, 360, '360 exactly → stacks (I-first)');
    assert.deepStrictEqual(decide({ T, legs: { HI: 400, HN: 400, IN: 240.000001, NI: 1000 } }), { stack: false, reason: 'over_6min' }, '360.000001 → over');
    assert.deepStrictEqual(decide({ T, legs: { HI: 300, HN: 300, IN: 900, NI: 900 } }), { stack: false, reason: 'over_6min' }, 'neither fits (D2)');
    // plus_min is the CEIL of the seconds
    assert.strictEqual(decide({ T, legs: { HI: 300, HN: 300, IN: 1, NI: 2000 } }).plus_min, 3, '121 s → 3 min');
    for (const legs of [{ HI: 0, HN: 1, IN: 1, NI: 1 }, { HI: 1, HN: -1, IN: 1, NI: 1 }, { HI: 1, HN: 1, IN: NaN, NI: 1 }, { HI: 1, HN: 1, IN: 1 }, { HI: 1, HN: 1, IN: 1, NI: Infinity }, null]) {
      assert.deepStrictEqual(decide({ T, legs }), { stack: false, reason: 'invalid_legs' }, `legs ${JSON.stringify(legs)}`);
    }
    ok('decide: the formula by hand, the lower arrival sum, the tie → I-first, 360 passes / 360.000001 does not, ceil minutes, invalid legs');
  }

  // ── 4. budget: one node, month total + day count, both caps checked atomically, null-first-safe ──────────────
  {
    assert.strictEqual(ELEMENTS_PER_CALL, 6); assert.strictEqual(DAY_CAP, 400); assert.strictEqual(MONTH_CAP, 4800);
    // Honduras time (UTC−6, no DST): 2026-11-01T03:00Z is still 31 Oct in Tegucigalpa
    assert.deepStrictEqual(budgetKeys(Date.UTC(2026, 10, 1, 3, 0)), { month: '2026-10', day: '31' });
    assert.deepStrictEqual(budgetKeys(Date.UTC(2026, 10, 1, 6, 0)), { month: '2026-11', day: '01' });
    assert.deepStrictEqual(reserve(null, '07'), { total: 6, days: { '07': 6 } }, 'null-first');
    assert.deepStrictEqual(reserve({ total: 6, days: { '07': 6 } }, '08'), { total: 12, days: { '07': 6, '08': 6 } });
    assert.strictEqual(reserve({ total: 0, days: { '07': 396 } }, '07'), undefined, 'over the day cap → abort');
    assert.deepStrictEqual(reserve({ total: 0, days: { '07': 394 } }, '07'), { total: 6, days: { '07': 400 } }, 'exactly the day cap → allowed');
    assert.strictEqual(reserve({ total: 4796, days: {} }, '07'), undefined, 'over the month cap → abort');
    assert.deepStrictEqual(reserve({ total: 4794, days: {} }, '07').total, 4800, 'exactly the month cap → allowed');
    for (const junk of [7, 'x', { total: 'a' }, { total: 1, days: 3 }, { total: -6, days: {} }]) assert.strictEqual(reserve(junk, '07'), undefined, `malformed ${JSON.stringify(junk)} → abort (fail closed)`);
    ok('budget: HN month/day keys, null-first, one node with both caps checked together, exact caps allowed, malformed → abort');
  }

  // ── 5. bounded: every await races the remaining budget and rejects `deadline` on expiry ──────────────────────
  {
    assert.strictEqual(await bounded(Promise.resolve(7), 50), 7, 'a settled promise wins');
    await assert.rejects(bounded(Promise.reject(new Error('boom')), 50), /boom/, 'its rejection passes through');
    const t0 = Date.now();
    await assert.rejects(bounded(new Promise(() => {}), 40), (e) => isDeadline(e), 'a never-settling promise → deadline');
    assert.ok(Date.now() - t0 < 200, 'returned within the budget + ε');
    await assert.rejects(bounded(new Promise(() => {}), 0), (e) => isDeadline(e), 'no budget left → deadline at once');
    await assert.rejects(bounded(new Promise(() => {}), -5), (e) => isDeadline(e), 'a negative budget → deadline');
    assert.strictEqual(isDeadline(new Error('deadline')), false, 'only the marked error counts');
    ok('bounded: a settled promise wins, a rejection passes through, a stall → `deadline` within the budget, no budget → at once');
  }

  FINISHED = true;
  console.log(`\nsequencing-core: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
