'use strict';
// BUILD-stacked-seq-server r5 T5 — the writer-side helpers autoAssign and sweep call (index.js keeps only the hunks):
//   readSeqFlag    — config/stack_sequencing_enabled, read ONCE per invocation; only `true` is ON (absent / false / junk /
//                    read error → OFF)
//   filterEligible — the {stackFilter} candidate filter: a 1-order driver stays a candidate iff the pair is CROSS-HUB (D7:
//                    today's rule exactly) or same-hub AND the cheap gate passes; 0-order drivers untouched; read error → drop
//   planForWriter  — today (cross-hub / not one order) | single (any same-hub refusal, deadline, no time left) | stack
//   postClaimSeq   — the bounded (3 s) post-claim checks: changed | confirm false | ok; a stall throws `deadline`
// Run: node sequencing/writer.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const W = require('./writer');
const { isDeadline } = require('./bounded');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('writer: FAILED — exited without completing'); process.exitCode = 1; } });

const HUB = { lat: 15.5, lng: -88.0 }; const NORTE = { lat: 15.6, lng: -88.1 };
const ident = (h) => ({ hub_lat: h.lat, hub_lng: h.lng, delivery_radius_km: 8, version: 1, active: true, name: 'TB', phone: '+504' });
const R = 2_000_000_000_000;
const prep = (r) => ({ committed_min: 20, extra_min: 0, accepted_at: r - 1200000, ready_at: r });
const hubOf = { tb_centro: HUB, tb_norte: NORTE };
const pk = (oid, rid, drv, status) => ({ order_id: oid, type: 'pickup', restaurant_id: rid, destination_lat: hubOf[rid].lat, destination_lng: hubOf[rid].lng, assigned_driver_id: drv, status });
const dl = (oid, drv, status) => ({ order_id: oid, type: 'delivery', assigned_driver_id: drv, status });
const ord = (rid, over = {}) => ({ order_type: 'delivery', status: 'preparing', restaurant_id: rid, lat: 15.52, lng: -88.02, prep: prep(R), ...over });
// drivers: d0 free; d1 holds a tb_centro order WITH prep; d2 holds a tb_norte order; d3 holds a tb_centro order WITHOUT prep
function world(newRid = 'tb_centro', newOver = {}) {
  return createFakeDb({
    config: {},
    restaurants: { tb_centro: { identity: ident(HUB) }, tb_norte: { identity: ident(NORTE) } },
    tasks: {
      o1_pickup: pk('o1', 'tb_centro', 'd1', 'accepted'), o1_delivery: dl('o1', 'd1', 'accepted'),
      o2_pickup: pk('o2', 'tb_norte', 'd2', 'accepted'), o2_delivery: dl('o2', 'd2', 'accepted'),
      o3_pickup: pk('o3', 'tb_centro', 'd3', 'accepted'), o3_delivery: dl('o3', 'd3', 'accepted'),
      nx_pickup: pk('nx', newRid, null, 'pending'), nx_delivery: dl('nx', null, 'pending'),
    },
    orders: { o1: ord('tb_centro'), o2: ord('tb_norte'), o3: ord('tb_centro', { prep: null }), nx: ord(newRid, newOver) },
  });
}
const E = (driverId, orderCount) => ({ driverId, orderCount });
const ELIGIBLE = [E('d0', 0), E('d1', 1), E('d2', 1), E('d3', 1)];
const active = { d1: new Set(['o1']), d2: new Set(['o2']), d3: new Set(['o3']) };

(async () => {
  // ── 1. the flag: only `true` is ON ──────────────────────────────────────────────────────────────────────────
  {
    const db = createFakeDb({});
    assert.strictEqual(await W.readSeqFlag(db), false, 'absent → OFF');
    for (const v of [false, 'true', 1, {}]) { db.put('config/stack_sequencing_enabled', v); assert.strictEqual(await W.readSeqFlag(db), false, `${JSON.stringify(v)} → OFF`); }
    db.put('config/stack_sequencing_enabled', true); assert.strictEqual(await W.readSeqFlag(db), true, 'true → ON');
    db.failReads.add('config'); assert.strictEqual(await W.readSeqFlag(db), false, 'a read error → OFF');
    ok('readSeqFlag: only === true is ON; absent / false / junk / read error → OFF');
  }

  // ── 2. the candidate filter (D7) ────────────────────────────────────────────────────────────────────────────
  {
    const tasksOf = (db) => db.get('tasks');
    const ids = (xs) => xs.map((x) => x.driverId);
    // a tb_centro new order: d1 same-hub + prep → kept; d2 cross-hub → kept (today's rule); d3 same-hub no prep → dropped
    let db = world('tb_centro');
    assert.deepStrictEqual(ids(await W.filterEligible(db, tasksOf(db), ELIGIBLE, active, 'nx')), ['d0', 'd1', 'd2'], 'D7: d1 same-hub kept, d2 cross-hub kept, d3 dropped');
    // a tb_norte new order: d2 is now same-hub (+prep) → kept; d1 and d3 are cross-hub → kept regardless of prep
    db = world('tb_norte');
    assert.deepStrictEqual(ids(await W.filterEligible(db, tasksOf(db), ELIGIBLE, active, 'nx')), ['d0', 'd1', 'd2', 'd3'], 'cross-hub pairs keep today’s rule even without prep (D7)');
    // the NEW order has no prep: every same-hub 1-order driver is dropped, cross-hub ones stay
    db = world('tb_centro', { prep: null });
    assert.deepStrictEqual(ids(await W.filterEligible(db, tasksOf(db), ELIGIBLE, active, 'nx')), ['d0', 'd2']);
    // a read failure on an order → that 1-order driver is dropped (fail closed); 0-order drivers never read anything
    db = world('tb_centro'); db.failReads.add('orders/o1');
    assert.deepStrictEqual(ids(await W.filterEligible(db, tasksOf(db), ELIGIBLE, active, 'nx')), ['d0', 'd2'], 'd1 dropped on the read error (d3 has no prep)');
    ok('filterEligible: 0-order untouched; cross-hub 1-order kept (today’s rule, D7); same-hub kept only with the cheap gate (prep + coords); a read error drops');
  }

  // ── 3. planForWriter: today | single | stack ────────────────────────────────────────────────────────────────
  {
    const fake = (legs) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify([
      { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: `${legs[0]}s` }, { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', duration: `${legs[1]}s` },
      { originIndex: 1, destinationIndex: 1, condition: 'ROUTE_EXISTS', duration: `${legs[2]}s` }, { originIndex: 2, destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: `${legs[3]}s` }]) });
    const base = { uid: 'd1', newOid: 'nx', key: 'k', transport: fake([600, 650, 50, 100]), now: () => R - 3600000 };
    const far = Date.now() + 60000;
    let db = world('tb_centro');
    const s = await W.planForWriter({ db, ...base, invocationDeadline: far });
    assert.strictEqual(s.mode, 'stack'); assert.ok(s.decision && s.deadlineAt <= Date.now() + 5000, 'a planning deadline ≤ 5 s');
    db = world('tb_norte');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, invocationDeadline: far }), { mode: 'today', reason: 'cross_hub' }, 'cross-hub → today (D7)');
    db = world('tb_centro');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, uid: 'd0', invocationDeadline: far }), { mode: 'today', reason: 'not_one' }, 'no incumbent → today');
    db = world('tb_centro');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, transport: fake([300, 300, 900, 900]), invocationDeadline: far }), { mode: 'single', reason: 'over_6min' });
    db = world('tb_centro', { prep: null });
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, invocationDeadline: far }), { mode: 'single', reason: 'no_prep' });
    db = world('tb_centro');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, key: '', invocationDeadline: far }), { mode: 'single', reason: 'no_key' });
    // no time left (< 20 s of the invocation) — the GATE still runs, so a cross-hub pair keeps today's path; same-hub → single
    db = world('tb_centro'); let calls = 0; const counting = async (...a) => { calls++; return fake([600, 650, 50, 100])(...a); };
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, transport: counting, invocationDeadline: Date.now() + 19000 }), { mode: 'single', reason: 'no_time' });
    assert.strictEqual(calls, 0, 'no call without time');
    db = world('tb_norte');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, invocationDeadline: Date.now() + 19000 }), { mode: 'today', reason: 'cross_hub' }, 'no time + cross-hub → still today');
    // the caller's plan budget is spent (sweep: > 2 plans this tick) → same as no time
    db = world('tb_centro');
    assert.deepStrictEqual(await W.planForWriter({ db, ...base, invocationDeadline: far, mayPlan: false }), { mode: 'single', reason: 'no_time' });
    ok('planForWriter: stack (deadline ≤ 5 s); cross-hub / not one → today; over_6min / no_prep / no_key → single; < 20 s left or plan budget spent → gate only (cross-hub today, same-hub single, no call)');
  }

  // ── 4. postClaimSeq: bounded fresh reads → changed | confirm false | ok ─────────────────────────────────────
  {
    const decision = { stack_id: 'stk_x', pair: ['nx', 'o1'], ranks: { o1: 1, nx: 2 }, plus_min: 2, incumbentOid: 'o1' };
    const policy = { isAssignable: (o) => ['new', 'preparing', 'ready'].includes(o.status), isHeld: () => false };
    const claimed = () => { const db = world('tb_centro'); db.put('tasks/nx_delivery/assigned_driver_id', 'd1'); return db; };
    const run = (db, over = {}) => W.postClaimSeq({ db, uid: 'd1', newOid: 'nx', decision, reassert: async () => ({ ok: true }), parked: false, ...policy, ...over });
    assert.deepStrictEqual(await run(claimed()), { ok: true });
    let db = claimed(); db.put('tasks/nx_pickup/status', 'cancelled');
    assert.deepStrictEqual(await run(db), { changed: 'cancelled' });
    db = claimed(); db.put('orders/nx/dispatch_parked', true);
    assert.deepStrictEqual(await run(db, { sweep: true }), { changed: 'held' }, 'sweep reads parked fresh');
    db = claimed(); db.put('tasks/o1_pickup/status', 'completed');
    assert.deepStrictEqual(await run(db), { ok: false }, 'the incumbent picked up → confirm false');
    assert.deepStrictEqual(await run(claimed(), { reassert: async () => ({ ok: false, reason: 'off_shift' }) }), { ok: false }, 'reassert refuses → confirm false');
    // a stall → throws deadline within the 3 s budget (the caller's rollbackOrAlert)
    const t0 = Date.now();
    await assert.rejects(run(claimed(), { reassert: () => new Promise(() => {}), budgetMs: 80 }), (e) => isDeadline(e));
    assert.ok(Date.now() - t0 < 500);
    assert.strictEqual(W.POST_CLAIM_MS, 3000, 'a separate 3 s post-claim budget');
    ok('postClaimSeq: ok | changed (fresh, parked for sweep) | confirm false (incumbent moved, reassert refuses); a stall → deadline within budget');
  }

  FINISHED = true;
  console.log(`\nwriter: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
