'use strict';
// BUILD-stacked-seq-server r5 T4 — planStack (pre-claim) and its ONE Admin commit transaction on stacks/{id}.
//   fresh reads → stackGate → stacks/{id} (committed → REUSE, no call; refused + same ready_at + unexpired → refuse, no call)
//   → key → budget txn → Routes → decide → the commit txn (null | refused → committed | refused; committed → abort + adopt).
// Every await is bounded by the decision deadline; a late completion is harmless (a later pairing reuses it).
// In-memory RTDB (merchant/_fake-db), a FAKE transport, synthetic tb_ brands.
// Run: node sequencing/plan-stack.test.js
const assert = require('assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { planStack, REFUSAL_TTL_MS } = require('./plan-stack');
const { stackIdFor } = require('./id');
const { budgetKeys } = require('./budget');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('plan-stack: FAILED — exited without completing'); process.exitCode = 1; } });

const KEY = 'tb_fake_routes_key';
const UID = 'drv_tb_1';
const HUB = { lat: 15.5, lng: -88.0 };
const NORTE = { lat: 15.6, lng: -88.1 };
const ident = (h) => ({ hub_lat: h.lat, hub_lng: h.lng, delivery_radius_km: 8, version: 1, active: true, name: 'TB', phone: '+50400000000' });
const prep = (readyAt) => ({ committed_min: 20, extra_min: 0, accepted_at: readyAt - 20 * 60000, ready_at: readyAt });
const R_I = 2_000_000_000_000; const R_N = R_I + 60000;
// the incumbent ord_a on the driver (accepted), the candidate ord_b unassigned
function seed({ aRid = 'tb_centro', bRid = 'tb_centro', aPrep = prep(R_I), bPrep = prep(R_N), extraOrder = false } = {}) {
  const hubs = { tb_centro: HUB, tb_norte: NORTE };
  const pick = (oid, rid, drv, status) => ({ order_id: oid, type: 'pickup', restaurant_id: rid, destination_lat: hubs[rid].lat, destination_lng: hubs[rid].lng, assigned_driver_id: drv, status });
  const del = (oid, drv, status) => ({ order_id: oid, type: 'delivery', assigned_driver_id: drv, status, destination_lat: 15.52, destination_lng: -88.02 });
  const tasks = {
    ord_a_pickup: pick('ord_a', aRid, UID, 'accepted'), ord_a_delivery: del('ord_a', UID, 'accepted'),
    ord_b_pickup: pick('ord_b', bRid, null, 'pending'), ord_b_delivery: del('ord_b', null, 'pending'),
  };
  if (extraOrder) { tasks.ord_c_pickup = pick('ord_c', 'tb_centro', UID, 'accepted'); tasks.ord_c_delivery = del('ord_c', UID, 'accepted'); }
  return createFakeDb({
    tasks,
    orders: {
      ord_a: { order_type: 'delivery', status: 'preparing', restaurant_id: aRid, lat: 15.52, lng: -88.02, prep: aPrep },
      ord_b: { order_type: 'delivery', status: 'preparing', restaurant_id: bRid, lat: 15.53, lng: -88.03, prep: bPrep },
    },
    restaurants: { tb_centro: { identity: ident(HUB) }, tb_norte: { identity: ident(NORTE) } },
  });
}
// a transport answering legs (seconds); counts calls
function transport(legs = { HI: 600, HN: 650, IN: 50, NI: 100 }) {
  const t = async () => {
    t.calls++;
    const el = (o, d, s) => ({ originIndex: o, destinationIndex: d, condition: 'ROUTE_EXISTS', duration: `${s}s` });
    return { ok: true, status: 200, text: async () => JSON.stringify([el(0, 0, legs.HI), el(0, 1, legs.HN), el(1, 1, legs.IN), el(2, 0, legs.NI)]) };
  };
  t.calls = 0; return t;
}
const NOW = R_I - 30 * 60000;
const plan = (db, extra = {}) => planStack({ db, uid: UID, newOid: 'ord_b', deadlineAt: Date.now() + 2000, transport: transport(), key: KEY, now: () => NOW, ...extra });
const ID = stackIdFor(UID, 'ord_a', 'ord_b').stack_id;
const month = budgetKeys(NOW).month;

// stall a db operation: the matching op never settles until `release()` (then it runs for real — a LATE completion)
function stalling(db, match) {
  let release; const gate = new Promise((r) => { release = r; });
  const ref = (path = '') => {
    const real = db.ref(path);
    const hit = (op) => match(op, String(path));
    return {
      ...real,
      once: (...a) => (hit('once') ? gate.then(() => real.once(...a)) : real.once(...a)),
      transaction: (...a) => (hit('transaction') ? gate.then(() => real.transaction(...a)) : real.transaction(...a)),
    };
  };
  return { db: { ...db, ref }, release: () => release() };
}

(async () => {
  // ── 1. a same-hub pair: ONE call, the committed record, the budget reserved, the decision ───────────────────
  {
    const db = seed(); const t = transport();
    const r = await plan(db, { transport: t });
    assert.strictEqual(r.stack, true, JSON.stringify(r));
    // legs HI=600 HN=650 IN=50 NI=100 → I-first (plusN = 120 s) → ord_a rank 1, ord_b rank 2, +2 min
    assert.deepStrictEqual(r.decision, { stack_id: ID, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 2, incumbentOid: 'ord_a' });
    assert.strictEqual(t.calls, 1, 'one Routes call');
    const rec = db.get(`stacks/${ID}`);
    assert.deepStrictEqual(rec, { state: 'committed', driver_uid: UID, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 2, plus_s: 120, hub_rid: 'tb_centro',
      depart_at: R_N, ready_at: { ord_a: R_I, ord_b: R_N }, legs_s: { HI: 600, HN: 650, IN: 50, NI: 100 }, decided_at: NOW });
    assert.strictEqual(db.get(`counters/routes_elements/${month}`).total, 6, 'six elements reserved');
    ok('same-hub pair: one call, I-first decision, the committed record (depart_at = max(now, readies)), six budget elements');
  }

  // ── 1b. a NEGATIVE plus_s (advisor 2026-10-25: no server clamp) is stored as-is and the stack still commits ────
  {
    // HI=900 HN=300 IN=300 NI=300 → only N-first fits; plusI = 300+120+300−900 = −180 s → ceil = −3 min
    const db = seed(); const r = await plan(db, { transport: transport({ HI: 900, HN: 300, IN: 300, NI: 300 }) });
    assert.strictEqual(r.stack, true);
    assert.deepStrictEqual(r.decision.ranks, { ord_b: 1, ord_a: 2 }, 'N-first');
    assert.strictEqual(r.decision.plus_min, -3, 'the raw promise, unclamped');
    const rec = db.get(`stacks/${ID}`);
    assert.strictEqual(rec.state, 'committed'); assert.strictEqual(rec.plus_s, -180, 'plus_s stored as-is'); assert.strictEqual(rec.plus_min, -3);
    ok('a negative plus_s (rank 2 arrives earlier than solo): committed, stored raw (−180 s / −3 min), no clamp');
  }

  // ── 2. gate refusals: no call, no budget, no record ─────────────────────────────────────────────────────────
  {
    const cases = { cross_hub: seed({ bRid: 'tb_norte' }), no_prep: seed({ bPrep: null }), not_one: seed({ extraOrder: true }) };
    for (const [reason, db] of Object.entries(cases)) {
      const t = transport();
      assert.deepStrictEqual(await plan(db, { transport: t }), { stack: false, reason }, reason);
      assert.strictEqual(t.calls, 0, `${reason}: no call`);
      assert.strictEqual(db.get('stacks'), null, `${reason}: no record`);
      assert.strictEqual(db.get('counters'), null, `${reason}: no budget`);
    }
    const db0 = seed(); db0.put('tasks/ord_a_pickup', null); db0.put('tasks/ord_a_delivery', null);
    assert.deepStrictEqual(await plan(db0), { stack: false, reason: 'not_one' }, 'no other order');
    ok('gate refusals (cross_hub, no_prep, not_one, no other order): no call, no budget, no record');
  }

  // ── 3. reuse: a committed record is the decision, whichever member is now the incumbent — no call ──────────
  {
    const db = seed(); await plan(db);
    const t = transport({ HI: 100, HN: 900, IN: 900, NI: 50 });   // different traffic now: must NOT be consulted
    // the same pairing again
    assert.deepStrictEqual((await plan(db, { transport: t })).decision.ranks, { ord_a: 1, ord_b: 2 });
    // direction 1: ord_b became the incumbent (accepted on the driver), ord_a removed and re-offered
    db.put('tasks/ord_b_pickup/assigned_driver_id', UID); db.put('tasks/ord_b_pickup/status', 'accepted');
    db.put('tasks/ord_b_delivery/assigned_driver_id', UID); db.put('tasks/ord_b_delivery/status', 'accepted');
    db.put('tasks/ord_a_pickup/assigned_driver_id', null); db.put('tasks/ord_a_pickup/status', 'pending');
    db.put('tasks/ord_a_delivery/assigned_driver_id', null); db.put('tasks/ord_a_delivery/status', 'pending');
    const r1 = await plan(db, { transport: t, newOid: 'ord_a' });
    assert.deepStrictEqual(r1.decision, { stack_id: ID, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 2, incumbentOid: 'ord_b' }, 'A re-paired with surviving B: the SAME ranks + promise');
    // direction 2: back — ord_a the incumbent, ord_b re-offered
    const db2 = seed(); await plan(db2);
    const r2 = await plan(db2, { transport: t });
    assert.deepStrictEqual(r2.decision.ranks, { ord_a: 1, ord_b: 2 }, 'B re-paired with A: the same ranks');
    assert.strictEqual(t.calls, 0, 'no Routes call on reuse');
    assert.strictEqual(db.get(`counters/routes_elements/${month}`).total, 6, 'no budget on reuse');
    ok('reuse: a committed record is reused in BOTH removal directions (same ranks + promise), no call, no budget');
  }

  // ── 4. refusals are cached by reason, keyed on the ready_at pair; budget / no_key are not cached ────────────
  {
    // over_6min (deterministic) → 30 min; traffic_unverified (transient) → 5 min
    assert.strictEqual(REFUSAL_TTL_MS.over_6min, 30 * 60000); assert.strictEqual(REFUSAL_TTL_MS.invalid_legs, 30 * 60000);
    assert.strictEqual(REFUSAL_TTL_MS.traffic_unverified, 5 * 60000); assert.strictEqual(REFUSAL_TTL_MS.deadline, 5 * 60000);
    const db = seed(); const far = transport({ HI: 300, HN: 300, IN: 900, NI: 900 });
    assert.deepStrictEqual(await plan(db, { transport: far }), { stack: false, reason: 'over_6min' });
    const rec = db.get(`stacks/${ID}`);
    assert.deepStrictEqual(rec, { state: 'refused', driver_uid: UID, pair: ['ord_a', 'ord_b'], reason: 'over_6min', ready_at: { ord_a: R_I, ord_b: R_N }, at: NOW, expires_at: NOW + 30 * 60000 });
    // again, unexpired, same ready_at → refused with NO call
    const t2 = transport();
    assert.deepStrictEqual(await plan(db, { transport: t2 }), { stack: false, reason: 'over_6min' });
    assert.strictEqual(t2.calls, 0, 'a cached refusal makes no call');
    // a «más tiempo» moved ready_at → re-plan (a call), and a fitting answer COMMITS over the refusal
    db.put('orders/ord_b/prep', prep(R_N + 10 * 60000));
    const t3 = transport();
    assert.strictEqual((await plan(db, { transport: t3 })).stack, true, 'a changed ready_at re-plans');
    assert.strictEqual(t3.calls, 1); assert.strictEqual(db.get(`stacks/${ID}`).state, 'committed', 'refused → committed');
    // expiry: an expired refusal re-plans
    const dbx = seed(); await plan(dbx, { transport: transport({ HI: 300, HN: 300, IN: 900, NI: 900 }) });
    const t4 = transport();
    assert.strictEqual((await plan(dbx, { transport: t4, now: () => NOW + 30 * 60000 + 1 })).stack, true, 'an expired refusal re-plans');
    assert.strictEqual(t4.calls, 1);
    // a transient refusal → 5 min
    const dbt = seed(); const bad = async () => ({ ok: false, status: 503, text: async () => '' });
    assert.deepStrictEqual(await plan(dbt, { transport: bad }), { stack: false, reason: 'traffic_unverified' });
    assert.strictEqual(dbt.get(`stacks/${ID}`).expires_at, NOW + 5 * 60000);
    // the outage is over after 5 min → re-plan
    assert.strictEqual((await plan(dbt, { now: () => NOW + 5 * 60000 + 1 })).stack, true, 're-plan after the outage');
    // no key: no call, no budget, NOT cached; once the key arrives → plans
    const dbk = seed(); const tk = transport();
    assert.deepStrictEqual(await plan(dbk, { key: '', transport: tk }), { stack: false, reason: 'no_key' });
    assert.strictEqual(tk.calls, 0); assert.strictEqual(dbk.get('counters'), null, 'no budget without a key'); assert.strictEqual(dbk.get('stacks'), null, 'no_key is not cached');
    assert.strictEqual((await plan(dbk)).stack, true, 'the key arrives → plans');
    // budget: over the cap → refused, no call, NOT cached; after the reset (next day) → plans
    const dbb = seed(); dbb.put(`counters/routes_elements/${month}`, { total: 0, days: { [budgetKeys(NOW).day]: 396 } });
    const tb = transport();
    assert.deepStrictEqual(await plan(dbb, { transport: tb }), { stack: false, reason: 'budget' });
    assert.strictEqual(tb.calls, 0); assert.strictEqual(dbb.get('stacks'), null, 'budget is not cached');
    dbb.put(`counters/routes_elements/${month}/days/${budgetKeys(NOW).day}`, 0);
    assert.strictEqual((await plan(dbb)).stack, true, 'after the budget reset → plans');
    ok('refusals: over_6min/invalid_legs 30 min, transient 5 min, same ready_at → no call, changed ready_at / expiry / outage over → re-plan; no_key and budget not cached');
  }

  // ── 5. two concurrent planners on the same pair → ONE committed record, the SAME ranks ─────────────────────
  {
    const db = seed();
    const [x, y] = await Promise.all([plan(db, { transport: transport({ HI: 600, HN: 650, IN: 50, NI: 100 }) }), plan(db, { transport: transport({ HI: 650, HN: 600, IN: 100, NI: 50 }) })]);
    assert.strictEqual(x.stack && y.stack, true);
    assert.deepStrictEqual(x.decision.ranks, y.decision.ranks, 'both finalize with the SAME ranks');
    assert.deepStrictEqual(db.get(`stacks/${ID}`).ranks, x.decision.ranks, 'the one committed record is what both adopted');
    ok('two concurrent planners: one committed record, both adopt the same ranks (the commit transaction is the single arbiter)');
  }

  // ── 6. the deadline bounds EVERY await; a late commit completion is reused by a later pairing ──────────────
  {
    const points = {
      'the tasks read': (op, p) => op === 'once' && p === 'tasks',
      'the orders read': (op, p) => op === 'once' && p.startsWith('orders/'),
      'the hub read': (op, p) => op === 'once' && p.startsWith('restaurants/'),
      'the stacks read': (op, p) => op === 'once' && p.startsWith('stacks/'),
      'the budget txn': (op, p) => op === 'transaction' && p.startsWith('counters/'),
      'the commit txn': (op, p) => op === 'transaction' && p.startsWith('stacks/'),
    };
    for (const [label, match] of Object.entries(points)) {
      const s = stalling(seed(), match);
      const t0 = Date.now();
      const r = await plan(s.db, { deadlineAt: Date.now() + 120 });
      assert.deepStrictEqual(r, { stack: false, reason: 'deadline' }, label);
      assert.ok(Date.now() - t0 < 600, `${label}: returned within the budget + ε (${Date.now() - t0} ms)`);
      s.release();
    }
    // a stalled HTTP body
    const slow = async (u, init) => ({ ok: true, status: 200, text: () => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    const dbs = seed();
    assert.deepStrictEqual(await plan(dbs, { transport: slow, deadlineAt: Date.now() + 120 }), { stack: false, reason: 'deadline' }, 'a stalled HTTP body');
    // a deadline after the Routes call → the transient refusal is cached (5 min), best-effort; within it: no call
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(dbs.get(`stacks/${ID}`), { state: 'refused', driver_uid: UID, pair: ['ord_a', 'ord_b'], reason: 'deadline', ready_at: { ord_a: R_I, ord_b: R_N }, at: NOW, expires_at: NOW + 5 * 60000 });
    const tc = transport();
    assert.deepStrictEqual(await plan(dbs, { transport: tc }), { stack: false, reason: 'deadline' }); assert.strictEqual(tc.calls, 0, 'cached: no call');
    assert.strictEqual((await plan(dbs, { now: () => NOW + 5 * 60000 + 1 })).stack, true, 'after 5 min → re-plan');
    // a deadline BEFORE any Routes call (a stalled read) caches nothing
    const srDb = seed(); const sr = stalling(srDb, (op, p) => op === 'once' && p.startsWith('stacks/'));
    await plan(sr.db, { deadlineAt: Date.now() + 60 }); sr.release(); await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(srDb.get('stacks'), null, 'no Routes call → no cached refusal');
    // the LATE commit: the commit txn stalls past the deadline, then completes → a later pairing reuses it, no call
    const base = seed();
    const s = stalling(base, (op, p) => op === 'transaction' && p.startsWith('stacks/'));
    assert.deepStrictEqual(await plan(s.db, { deadlineAt: Date.now() + 120 }), { stack: false, reason: 'deadline' });
    s.release(); await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(base.get(`stacks/${ID}`).state, 'committed', 'premise: the late commit landed');
    const t = transport();
    const later = await plan(base, { transport: t });
    assert.strictEqual(later.stack, true); assert.strictEqual(t.calls, 0, 'reused, no call');
    ok('deadline: a stall at the tasks / orders / hub / stacks read, the budget txn, the commit txn, the HTTP body → `deadline` within budget; a post-call deadline is cached 5 min (none before a call); a late commit is reused later');
  }

  FINISHED = true;
  console.log(`\nplan-stack: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
