'use strict';
/**
 * RELEASE RACE (PLAN-release-race r2.1, owner edge-case rule) — the REAL sweepPendingOrders, in-process against the RTDB
 * emulator. When the strand healer CONFIRMS a mismatch (its half_claim_since marker ≥ 120 s old) and its heal COMMITS, ONE
 * create-only dispatcher_alerts/assignment_conflict_{oid} carrying order_id is written; nothing else about the healer changes.
 *   1 split / partial release / abandoned claim, persisted → healed exactly as today + ONE alert; a re-sweep → still one
 *   2 transient (no marker → marked; marker < 120 s → wait), consistent, terminal → no alert
 *   3 a heal ABORTED (the delivery re-claimed between the batch read and the heal CAS) → no alert
 *   4 the alert write REJECTED / NEVER SETTLING → the sweep finishes within the bound, the next order is still healed + alerted
 *   5 dedup that can see an overwrite: a pre-seeded, distinguishable alert survives a heal of the same order byte-identical
 * Synthetic ids only. Run: npm run test:release-race-heal
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const fns = require('../index');

const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const clone = (x) => JSON.parse(JSON.stringify(x));
const STALE = () => Date.now() - 200000;   // ≥ HALF_CLAIM_STALE_MS (120 s)
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', status: 'new', order_type: 'delivery', created_at: Date.now() - 600000, ...over });
const legs = (oid, del, pick, delOver = {}, pickOver = {}) => ({
  [`${oid}_delivery`]: { order_id: oid, type: 'delivery', status: 'assigned', ...(del ? { assigned_driver_id: del } : {}), ...delOver },
  [`${oid}_pickup`]: { order_id: oid, type: 'pickup', status: 'assigned', ...(pick ? { assigned_driver_id: pick } : {}), ...pickOver },
});
const healedShape = (t) => { const c = clone(t); delete c.assigned_driver_id; delete c.half_claim_since; return c; };
const conflict = (oid) => val(`dispatcher_alerts/assignment_conflict_${oid}`);
// codex build r1 P2: the EXACT tasks tree after each sweep (marker timestamps normalized to 'MARK') — the healer's writes unchanged
const norm = (tree) => { const c = clone(tree || {}); for (const t of Object.values(c)) if (t && typeof t.half_claim_since === 'number') t.half_claim_since = 'MARK'; return c; };
const assertTree = async (expected, label) => assert.deepStrictEqual(norm(await val('tasks')), norm(expected), `${label}: the ENTIRE tasks tree equals the expected baseline`);
const allAlerts = async () => (await val('dispatcher_alerts')) || {};

// one-shot hooks on a transaction PATH: 'reclaim' (re-own the delivery just before the heal CAS), 'reject', 'hang'
const hooks = new Map();
(() => {
  let o = Object.getPrototypeOf(db.ref('x'));
  while (o && !Object.prototype.hasOwnProperty.call(o, 'transaction')) o = Object.getPrototypeOf(o);
  const orig = o.transaction;
  o.transaction = async function (...a) {
    const p = decodeURIComponent(new URL(this.toString()).pathname).replace(/^\//, '');
    const h = hooks.get(p);
    if (h) {
      hooks.delete(p);
      if (h === 'reject') throw new Error('injected alert write failure');
      if (h === 'hang') return new Promise(() => {});
      if (typeof h === 'function') await h();
    }
    return orig.apply(this, a);
  };
})();

(async () => {
  // ── 1–3: every shape in ONE sweep ──
  const T = {
    ...legs('s1', 'dB', 'dA', { half_claim_since: STALE() }),              // split, persisted
    ...legs('p1', null, 'dA', { half_claim_since: STALE() }),              // partial release (delivery null, pickup old)
    ...legs('a1', 'dB', null, { half_claim_since: STALE() }),              // abandoned claim (delivery claimed, pickup null)
    ...legs('m1', 'dB', 'dA'),                                             // transient: no marker yet
    ...legs('w1', 'dB', 'dA', { half_claim_since: Date.now() - 30000 }),   // transient: marker < 120 s
    ...legs('c1', 'dA', 'dA'), ...legs('c2', null, null, {}, { status: 'pending' }),
    ...legs('c3', 'dA', 'dA', {}, { status: 'completed' }),                // the post-pickup shape
    ...legs('t1', 'dB', 'dA', { half_claim_since: STALE() }),              // terminal order
    ...legs('r1', 'dB', 'dA', { half_claim_since: STALE() }),              // heal aborted (re-claimed)
  };
  await db.ref().set({
    orders: Object.fromEntries(['s1', 'p1', 'a1', 'm1', 'w1', 'c1', 'c2', 'c3', 'r1'].map((o) => [o, order(o)]).concat([['t1', order('t1', { status: 'cancelled' })]])),
    tasks: T,
  });
  hooks.set('tasks/r1_delivery/assigned_driver_id', async () => { await db.ref('tasks/r1_delivery/assigned_driver_id').set('dC'); });
  await fns.sweepPendingOrders.run({});

  const EXP1 = clone(T);
  for (const oid of ['s1', 'p1', 'a1']) for (const leg of ['delivery', 'pickup']) EXP1[`${oid}_${leg}`] = healedShape(T[`${oid}_${leg}`]);
  EXP1.m1_delivery.half_claim_since = 1;                                                       // marked (pass one)
  EXP1.r1_delivery = { ...healedShape(T.r1_delivery), assigned_driver_id: 'dC' };              // marker cleared first, heal CAS aborted
  await assertTree(EXP1, 'sweep 1');
  for (const [oid, d, p] of [['s1', 'dB', 'dA'], ['p1', null, 'dA'], ['a1', 'dB', null]]) {
    assert.deepStrictEqual(await val(`tasks/${oid}_delivery`), healedShape(T[`${oid}_delivery`]), `${oid}: the delivery healed exactly as today`);
    assert.deepStrictEqual(await val(`tasks/${oid}_pickup`), healedShape(T[`${oid}_pickup`]), `${oid}: the pickup healed exactly as today`);
    const a = await conflict(oid);
    assert.ok(a && typeof a.created_at === 'number', `${oid}: ONE assignment_conflict alert`);
    const { created_at, ...rest } = a;
    assert.deepStrictEqual(rest, { type: 'assignment_conflict', order_id: oid, ...(d ? { delivery_driver_id: d } : {}), ...(p ? { pickup_driver_id: p } : {}) }, `${oid}: alert carries order_id (Torre click-through) + both stranded owners`);
  }
  ok('split / partial release / abandoned claim persisted ≥ 120 s → healed EXACTLY as today + ONE alert each, carrying order_id and the stranded owners');

  assert.strictEqual(typeof (await val('tasks/m1_delivery/half_claim_since')), 'number', 'm1: marked (pass one)');
  assert.deepStrictEqual(await val('tasks/w1_delivery'), T.w1_delivery, 'w1: untouched (wait)');
  for (const oid of ['c1', 'c2', 'c3']) for (const leg of ['delivery', 'pickup']) assert.deepStrictEqual(await val(`tasks/${oid}_${leg}`), T[`${oid}_${leg}`], `${oid}: consistent → no write`);
  assert.deepStrictEqual([await val('tasks/t1_delivery'), await val('tasks/t1_pickup')], [T.t1_delivery, T.t1_pickup], 't1: terminal → skipped as today');
  for (const oid of ['m1', 'w1', 'c1', 'c2', 'c3', 't1']) assert.strictEqual(await conflict(oid), null, `${oid}: no alert`);
  ok('transient (no marker → marked; marker < 120 s → wait), consistent (incl. post-pickup) and terminal → NO alert; healer writes as today');

  assert.strictEqual(await val('tasks/r1_delivery/assigned_driver_id'), 'dC', 'r1: the re-claim survives (the heal CAS aborted)');
  assert.strictEqual(await conflict('r1'), null, 'r1: an aborted heal raises no alert');
  ok('a heal ABORTED by a re-claim between the batch read and the heal CAS → no alert');

  const snap1 = await allAlerts();
  const EXP3 = clone(EXP1); EXP3.r1_delivery.half_claim_since = 1;                            // r1 (dC vs dA) is now a fresh mismatch: marked, then waits
  await fns.sweepPendingOrders.run({});
  await assertTree(EXP3, 're-sweep 1 (r1 marked; m1 / w1 waiting)');
  await fns.sweepPendingOrders.run({});
  await assertTree(EXP3, 're-sweep 2 (everything waiting — unchanged)');
  const snap2 = await allAlerts();
  for (const oid of ['s1', 'p1', 'a1']) assert.deepStrictEqual(snap2[`assignment_conflict_${oid}`], snap1[`assignment_conflict_${oid}`], `${oid}: re-sweeps leave the alert byte-identical`);
  assert.strictEqual(Object.keys(snap2).filter((k) => k.startsWith('assignment_conflict_')).length, 3, 'still exactly three conflict alerts');
  assert.ok(snap2.assignment_conflict_m1 === undefined && snap2.assignment_conflict_w1 === undefined, 'the transient ones still raise none on re-sweep (now inside their window)');
  ok('re-sweeps ×2 → still ONE alert per order, byte-identical');

  // ── 4: the alert write REJECTED / NEVER SETTLING — bounded, the sweep moves on ──
  for (const mode of ['reject', 'hang']) {
    await db.ref().set({ orders: { f1: order('f1'), f2: order('f2') }, tasks: { ...legs('f1', 'dB', 'dA', { half_claim_since: STALE() }), ...legs('f2', 'dB', 'dA', { half_claim_since: STALE() }) } });
    hooks.set('dispatcher_alerts/assignment_conflict_f1', mode);
    const t0 = Date.now();
    await fns.sweepPendingOrders.run({});
    const took = Date.now() - t0;
    assert.ok(took < 15000, `${mode}: the sweep finished within the bound (${took} ms)`);
    for (const oid of ['f1', 'f2']) assert.strictEqual((await val(`tasks/${oid}_delivery/assigned_driver_id`)) ?? null, null, `${mode}: ${oid} healed`);
    const seeded = { ...legs('f1', 'dB', 'dA', { half_claim_since: 1 }), ...legs('f2', 'dB', 'dA', { half_claim_since: 1 }) };
    await assertTree(Object.fromEntries(Object.entries(seeded).map(([k, t]) => [k, healedShape(t)])), `${mode}`);
    assert.strictEqual(await conflict('f1'), null, `${mode}: f1's alert write failed / stalled — none written`);
    assert.ok(await conflict('f2'), `${mode}: the NEXT order (f2) is still healed AND alerted`);
  }
  ok('the alert write REJECTED or NEVER SETTLING → bounded (3 s), logged; the next stale order is still healed and alerted; heals unaffected');

  // ── 5: a pre-seeded distinguishable alert survives (create-only) ──
  const PRE = { type: 'assignment_conflict', order_id: 'd1', sentinel: 'pre', created_at: 1 };
  await db.ref().set({ orders: { d1: order('d1') }, tasks: legs('d1', 'dB', 'dA', { half_claim_since: STALE() }), dispatcher_alerts: { assignment_conflict_d1: PRE } });
  await fns.sweepPendingOrders.run({});
  assert.strictEqual((await val('tasks/d1_delivery/assigned_driver_id')) ?? null, null, 'd1 healed');
  assert.deepStrictEqual(await conflict('d1'), PRE, 'the pre-seeded alert is byte-identical (create-only: never overwritten)');
  await assertTree(Object.fromEntries(Object.entries(legs('d1', 'dB', 'dA', { half_claim_since: 1 })).map(([k, t]) => [k, healedShape(t)])), 'dedup');
  ok('dedup that can SEE an overwrite: a pre-seeded distinguishable alert survives a heal of the same order byte-identical');

  await db.ref().set(null);
  console.log(`\nrelease-race-heal: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('release-race-heal FAILED:', e && e.stack || e); process.exit(1); });
