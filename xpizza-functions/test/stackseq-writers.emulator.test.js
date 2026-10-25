'use strict';
/**
 * BUILD-stacked-seq-server r5 T5 — the REAL writers (index.js handlers through .run(event)) against the RTDB emulator, with a FAKE
 * Routes transport (globalThis.fetch stubbed; the egress guard blocks every socket) and a FAKE in-process key. Synthetic tb_ brands.
 * Run: npm run test:stackseq-writers (~4 min: real 30 s grace / 60 s accept timers)
 *
 *   autoAssign, flag ON (one parallel batch; each scenario has its OWN distant hub, so its own driver is always the nearest):
 *     A1 a same-hub pair → stacked: the committed record, the five copies on BOTH deliveries in the ONE finalize, provenance valid
 *     A2 D7: a cross-restaurant pair at DIFFERENT hubs → today's unsequenced offer, no Routes call, no copies, no record
 *     A3 the new order cancelled during Routes → rolled back, never revived
 *     A4 the incumbent picked up during Routes → single: rolled back + the existing no_drivers_available alert
 *     A5 a planning-deadline expiry (Routes stalls) → single, NO claim, the existing alert
 *     A6 a post-claim expiry (the post-claim reassert held > 3 s) → the existing rollbackOrAlert
 *     A7 over +6 min → single, no claim, the existing alert
 *   autoAssign, flag ABSENT: A2's twin and a same-hub twin → byte-identical to today (A2 ON ≡ A2 OFF, normalized)
 *   sweep, flag ON (one tick per scenario): S1 stacked; S2 cross-hub ≡ OFF; S3 parked during Routes → rollback, skip;
 *     S4 incumbent picked up during Routes → rollback, skip; S5 planning deadline → waiting, no claim; S6 three same-hub pairs in
 *     one tick → at most TWO Routes calls, the third single; S7 post-claim expiry → rollbackOrAlert
 *   timeout (D12): a reassign onto a same-hub 1-order driver and a two-strike release, flag ON ≡ flag false (normalized)
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.ROUTES_API_KEY = 'tb-fake-routes-key';   // a FAKE, in-process only (emulator-run scrubs any real one from the env)

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const fns = require('../index');
const { validPair } = require('../sequencing/validity');
const { stackIdFor } = require('../sequencing/id');

const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('stackseq-writers: FAILED — exited without completing'); process.exitCode = 1; } });
const val = async (p) => (await db.ref(p).once('value')).val();
const NOW = Date.now();
const READY = NOW + 20 * 60000;
const prep = { committed_min: 20, extra_min: 0, accepted_at: READY - 20 * 60000, ready_at: READY };

// ── the fake Routes transport: keyed by the NEW order's latitude (unique per scenario) ─────────────────────────
const routes = new Map();   // lat → { legs, hook, stall }
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const lat = body.origins[2].waypoint.location.latLng.latitude;
  const sc = routes.get(lat) || {};
  calls.push(lat);
  if (sc.hook) await sc.hook();
  if (sc.stall) return new Promise(() => {});
  const L = sc.legs || [600, 650, 50, 100];
  const el = (o, d, s) => ({ originIndex: o, destinationIndex: d, condition: 'ROUTE_EXISTS', duration: `${s}s` });
  return { ok: true, status: 200, text: async () => JSON.stringify([el(0, 0, L[0]), el(0, 1, L[1]), el(1, 1, L[2]), el(2, 0, L[3])]) };
};
// the hold seam (tracking/hold.js), used to hold the POST-claim reassert past its 3 s budget
const holds = new Map();
// a hold = { skip, ms }: let `skip` calls through, then hold the next one for `ms` (one-shot)
globalThis.__trackerHold = async (name, ctx) => { const k = `${name}:${ctx.newOrderId || ''}`; const h = holds.get(k); if (!h) return; if (h.skip > 0) { h.skip--; return; } holds.delete(k); await new Promise((r) => setTimeout(r, h.ms)); };

// ── one scenario = its own restaurant(s) + hub, ONE driver holding ONE accepted order, ONE new order ──────────
const ident = (h) => ({ name: 'TB', phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 9, active: true, version: 1, hub_lat: h.lat, hub_lng: h.lng, hours: { sun: { open: true, start: '00:00', end: '23:59' } } });
function scenario(k, { newStatus = 'new', crossHub = false } = {}) {
  const Q = { lat: 10 + k * 0.5, lng: -87 };                 // the new order's hub (and the driver's position)
  const P = crossHub ? { lat: Q.lat + 0.2, lng: -87 } : Q;     // the incumbent's hub
  const rq = `tb_q${k}`; const rp = crossHub ? `tb_p${k}` : rq;
  const d = `d_s${k}`; const i = `i_s${k}`; const nn = `n_s${k}`;
  const nLat = Q.lat + 0.01;
  const ord = (rid, h, status, lat) => ({ order_id: null, restaurant_id: rid, hub_lat: h.lat, hub_lng: h.lng, status, order_type: 'delivery', recipient_name: 'Cliente', total: 100, created_at: NOW - 10 * 60000, lat, lng: -87.01, prep });
  const pk = (oid, rid, h, drv, status, extra = {}) => ({ order_id: oid, type: 'pickup', restaurant_id: rid, destination_lat: h.lat, destination_lng: h.lng, assigned_driver_id: drv, status, ...extra });
  const dl = (oid, drv, status, extra = {}) => ({ order_id: oid, type: 'delivery', assigned_driver_id: drv, status, destination_lat: 15, destination_lng: -87, ...extra });
  const assigned = { assigned_at: NOW - 5 * 60000, accepted_at: NOW - 4 * 60000 };
  return {
    k, d, i, n: nn, nLat, rq, rp,
    seed: {
      [`restaurants/${rq}/identity`]: ident(Q), [`restaurants/${rp}/identity`]: ident(P),
      [`drivers/${d}`]: { name: d, status: 'at_restaurant', push_reachable: true, lat: Q.lat, lng: Q.lng, active: true },
      [`orders/${i}`]: { ...ord(rp, P, 'preparing', P.lat + 0.02), order_id: i },
      [`orders/${nn}`]: { ...ord(rq, Q, newStatus, nLat), order_id: nn },
      [`tasks/${i}_pickup`]: pk(i, rp, P, d, 'accepted', assigned), [`tasks/${i}_delivery`]: dl(i, d, 'accepted', assigned),
      [`tasks/${nn}_pickup`]: pk(nn, rq, Q, null, 'pending'), [`tasks/${nn}_delivery`]: dl(nn, null, 'pending'),
    },
  };
}
const seedAll = async (scs, flag) => {
  await db.ref().set({ config: { auto_assign_enabled: true, sweep_pending_enabled: true, ...(flag === undefined ? {} : { stack_sequencing_enabled: flag }) } });
  const u = {}; for (const s of scs) Object.assign(u, s.seed); await db.ref().update(u);
};
// autoAssign fires on the order BECOMING new
const fireAuto = async (oid) => { const o = await val(`orders/${oid}`); return fns.autoAssignOnOrderCreate.run({ params: { orderId: oid }, data: { before: { val: () => null }, after: { val: () => o } } }); };
const alertsFor = async (oid) => Object.values((await val('dispatcher_alerts')) || {}).filter((a) => a && a.order_id === oid).map((a) => a.type);
const COPY = ['stack_id', 'stop_seq', 'stack_uid', 'stack_at', 'stack_plus_min'];
const hasCopies = (t) => !!t && COPY.some((c) => c in t);
const T_KEYS = new Set(['assigned_at', 'accepted_at', 'assignment_deadline', 'created_at', 'stack_at', 'last_swept']);
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (T_KEYS.has(k) && typeof x === 'number' ? '<t>' : x)));
// every stacks/ record that touches THIS scenario — its orders (pair) or its driver — under ANY id: a stray write under an
// unexpected id is caught, while other scenarios' records in the same batch are not
const stacksTouching = async (s) => Object.fromEntries(Object.entries((await val('stacks')) || {})
  .filter(([, r]) => r && ((Array.isArray(r.pair) && r.pair.some((o) => o === s.i || o === s.n)) || r.driver_uid === s.d)));
const snap = async (s) => norm({
  tasks: Object.fromEntries(await Promise.all([`${s.i}_pickup`, `${s.i}_delivery`, `${s.n}_pickup`, `${s.n}_delivery`].map(async (t) => [t.replace(/_s\d+/, ''), await val(`tasks/${t}`)]))),
  driver: await val(`drivers/${s.d}`), alerts: await alertsFor(s.n), stacks: await stacksTouching(s),
});
const expectStacked = async (s, label) => {
  const nd = await val(`tasks/${s.n}_delivery`); const idl = await val(`tasks/${s.i}_delivery`);
  assert.strictEqual(nd.assigned_driver_id, s.d, `${label}: the new order is on the driver`);
  const { stack_id } = stackIdFor(s.d, s.i, s.n);
  const rec = await val(`stacks/${stack_id}`);
  assert.ok(rec && rec.state === 'committed', `${label}: the committed record`);
  assert.strictEqual(nd.stack_id, stack_id); assert.strictEqual(idl.stack_id, stack_id);
  assert.deepStrictEqual({ [s.i]: idl.stop_seq, [s.n]: nd.stop_seq }, rec.ranks, `${label}: copies carry the record's ranks`);
  assert.ok(validPair(idl, nd), `${label}: the §1 provenance holds on both copies`);
  assert.strictEqual(nd.stack_at, nd.assigned_at, `${label}: stack_at is the finalize's own assigned_at`);
  return rec;
};
const expectUntouched = async (s, label) => {
  const nd = await val(`tasks/${s.n}_delivery`); const np = await val(`tasks/${s.n}_pickup`);
  assert.strictEqual(nd.assigned_driver_id || null, null, `${label}: no claim left on the new order`);
  assert.strictEqual(np.assigned_driver_id || null, null, `${label}: the pickup is unassigned`);
  assert.ok(!hasCopies(nd) && !hasCopies(await val(`tasks/${s.i}_delivery`)), `${label}: no copies`);
};

(async () => {
  // ═════ autoAssign, flag ON ═════
  const A = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((k) => [k, scenario(k, { crossHub: k === 2 })]));
  routes.set(A[3].nLat, { hook: async () => { await db.ref().update({ [`orders/${A[3].n}/status`]: 'cancelled', [`tasks/${A[3].n}_pickup/status`]: 'cancelled', [`tasks/${A[3].n}_delivery/status`]: 'cancelled' }); } });
  routes.set(A[4].nLat, { hook: async () => { await db.ref().update({ [`tasks/${A[4].i}_pickup/status`]: 'completed', [`orders/${A[4].i}/picked_up_at`]: Date.now() }); } });
  routes.set(A[5].nLat, { stall: true });
  routes.set(A[6].nLat, { hook: async () => { holds.set(`assign:hub:${A[6].n}`, { skip: 0, ms: 6000 }); } });   // autoAssign: the next reassert IS the post-claim one
  routes.set(A[7].nLat, { legs: [300, 300, 900, 900] });
  await seedAll(Object.values(A), true);
  calls.length = 0;
  await Promise.all(Object.values(A).map((s) => fireAuto(s.n)));
  {
    const rec = await expectStacked(A[1], 'A1');
    const nd = await val(`tasks/${A[1].n}_delivery`);
    assert.strictEqual(nd.status, 'accepted', 'A1: same-hub force-accept kept (D4)');
    assert.strictEqual(rec.plus_min, 2); assert.strictEqual(nd.stack_plus_min, 2, 'A1: rank 2 carries +2');
    assert.strictEqual((await val(`tasks/${A[1].i}_delivery`)).stack_plus_min ?? null, null, 'A1: rank 1 has no +N');
    ok('A1 autoAssign same-hub: committed record, both copies in the one finalize (ranks, +N on rank 2), provenance valid, force-accept kept');
  }
  {
    const nd = await val(`tasks/${A[2].n}_delivery`);
    assert.strictEqual(nd.assigned_driver_id, A[2].d, 'A2: assigned as today');
    assert.strictEqual(nd.status, 'assigned', 'A2: a cross-hub second order stays swipe-to-accept (today)');
    assert.ok(!hasCopies(nd) && !hasCopies(await val(`tasks/${A[2].i}_delivery`)), 'A2: no copies');
    assert.ok(!calls.includes(A[2].nLat), 'A2: no Routes call for a cross-hub pair');
    ok('A2 autoAssign D7 cross-restaurant / different hubs: today’s unsequenced offer, no Routes call, no copies');
  }
  await expectUntouched(A[3], 'A3');
  assert.strictEqual((await val(`tasks/${A[3].n}_pickup`)).status, 'cancelled', 'A3: never revived');
  ok('A3 autoAssign: the order cancelled during Routes → rolled back, not revived, no copies');
  await expectUntouched(A[4], 'A4');
  assert.ok((await alertsFor(A[4].n)).includes('no_drivers_available'), 'A4: the existing alert');
  ok('A4 autoAssign: the incumbent picked up during Routes → single: rolled back + the existing no_drivers_available alert');
  await expectUntouched(A[5], 'A5');
  assert.ok((await alertsFor(A[5].n)).includes('no_drivers_available'), 'A5: the existing alert');
  ok('A5 autoAssign: a planning-deadline expiry → single with NO claim + the existing alert');
  await expectUntouched(A[6], 'A6');
  ok('A6 autoAssign: a post-claim expiry (reassert held > 3 s) → the existing rollbackOrAlert, no copies');
  await expectUntouched(A[7], 'A7');
  assert.ok((await alertsFor(A[7].n)).includes('no_drivers_available'));
  ok('A7 autoAssign: over +6 min → single, no claim, the existing alert');
  const A2on = await snap(A[2]);

  // ═════ autoAssign, flag ABSENT: byte-identical to today ═════
  const B2 = scenario(2, { crossHub: true }); const B1 = scenario(1);
  await seedAll([B1, B2], undefined);
  calls.length = 0;
  await Promise.all([fireAuto(B1.n), fireAuto(B2.n)]);
  assert.deepStrictEqual(await snap(B2), A2on, '🔴 A2 cross-hub: flag ON differs from flag OFF');
  {
    const nd = await val(`tasks/${B1.n}_delivery`);
    assert.strictEqual(nd.assigned_driver_id, B1.d); assert.strictEqual(nd.status, 'accepted', 'OFF same-hub: today’s force-accept');
    assert.ok(!hasCopies(nd), 'OFF: no copies'); assert.strictEqual(await val('stacks'), null, 'OFF: no record'); assert.strictEqual(calls.length, 0, 'OFF: no Routes call');
  }
  ok('flag absent: a same-hub pair is today’s force-accept (no record, copies or call); the cross-hub pair is BYTE-IDENTICAL to flag ON (normalized)');

  // ═════ sweep, flag ON ═════
  const tick = () => fns.sweepPendingOrders.run({});
  {
    const s = scenario(11, { newStatus: 'preparing' }); await seedAll([s], true); await tick();
    await expectStacked(s, 'S1'); assert.strictEqual((await val(`tasks/${s.n}_delivery`)).retry_count, 1, 'S1: the sweep bookkeeping is kept');
    ok('S1 sweep same-hub: stacked in the one finalize (record, copies, provenance), retry_count bumped as today');
  }
  {
    const s = scenario(12, { newStatus: 'preparing', crossHub: true });
    await seedAll([s], true); calls.length = 0; await tick(); const on = await snap(s);
    assert.ok(!calls.length, 'S2: no Routes call');
    await seedAll([s], false); await tick(); const off = await snap(s);
    assert.deepStrictEqual(on, off, '🔴 S2: flag ON differs from flag false');
    assert.strictEqual(on.tasks.n_delivery.assigned_driver_id, s.d, 'S2: offered as today');
    ok('S2 sweep D7 cross-hub: flag ON ≡ flag false (normalized), offered as today, no Routes call');
  }
  {
    const s = scenario(13, { newStatus: 'preparing' });
    routes.set(s.nLat, { hook: async () => { await db.ref(`orders/${s.n}/dispatch_parked`).set(true); } });
    await seedAll([s], true); await tick(); await expectUntouched(s, 'S3');
    ok('S3 sweep: parked during Routes → rolled back, skipped, no copies');
  }
  {
    const s = scenario(14, { newStatus: 'preparing' });
    routes.set(s.nLat, { hook: async () => { await db.ref(`tasks/${s.i}_pickup/status`).set('completed'); } });
    await seedAll([s], true); await tick(); await expectUntouched(s, 'S4');
    ok('S4 sweep: the incumbent picked up during Routes → rolled back, skipped');
  }
  {
    const s = scenario(15, { newStatus: 'preparing' }); routes.set(s.nLat, { stall: true });
    await seedAll([s], true); await tick(); await expectUntouched(s, 'S5');
    ok('S5 sweep: a planning-deadline expiry → waiting, NO claim');
  }
  {
    const scs = [16, 17, 18].map((k) => scenario(k, { newStatus: 'preparing' }));
    await seedAll(scs, true); calls.length = 0; await tick();
    assert.strictEqual(calls.length, 2, `S6: at most two Routes calls per tick (got ${calls.length})`);
    const placed = await Promise.all(scs.map(async (s) => (await val(`tasks/${s.n}_delivery`)).assigned_driver_id === s.d));
    assert.strictEqual(placed.filter(Boolean).length, 2, 'S6: two stacked, the third waits (single, no claim)');
    ok('S6 sweep: three same-hub pairs in one tick → exactly two Routes calls; the third is single (waits), no claim');
  }
  {
    const s = scenario(19, { newStatus: 'preparing' });
    routes.set(s.nLat, { hook: async () => { holds.set(`assign:hub:${s.n}`, { skip: 1, ms: 6000 }); } });   // sweep: skip its existing recheck, hold the post-claim one
    await seedAll([s], true); await tick(); await expectUntouched(s, 'S7');
    ok('S7 sweep: a post-claim expiry → the existing rollbackOrAlert, no copies');
  }

  // ═════ timeout (D12): byte-identical with the flag ON and false ═════
  const timeoutWorld = (k) => {
    const s = scenario(k, { newStatus: 'preparing' });
    // the NEW order is offered to a timed-out driver d_t{k}; the next candidate is s.d (same hub, 1 accepted order, prep)
    const t = `d_t${k}`;
    Object.assign(s.seed, {
      [`drivers/${t}`]: { name: t, status: 'assigned', push_reachable: true, lat: 0, lng: 0, active: true },
      [`tasks/${s.n}_pickup/assigned_driver_id`]: t, [`tasks/${s.n}_pickup/status`]: 'assigned', [`tasks/${s.n}_pickup/assignment_attempts`]: 1,
      [`tasks/${s.n}_delivery/assigned_driver_id`]: t, [`tasks/${s.n}_delivery/status`]: 'assigned', [`tasks/${s.n}_delivery/assignment_attempts`]: 1,
    });
    return { s, t };
  };
  const mon = (oid, drv) => fns.monitorAssignmentTimeout.run({ params: { taskId: `${oid}_pickup` }, data: { before: { val: () => null }, after: { val: () => drv } } });
  const runTimeout = async (flag) => {
    const re = timeoutWorld(21); const two = timeoutWorld(22);
    two.s.seed[`tasks/${two.s.n}_pickup/assignment_attempts`] = 2; two.s.seed[`tasks/${two.s.n}_delivery/assignment_attempts`] = 2;
    await seedAll([re.s, two.s], flag); calls.length = 0;
    await Promise.all([mon(re.s.n, re.t), mon(two.s.n, two.t)]);
    const a = await snap(re.s); const b = await snap(two.s);
    for (const t of [re.t, two.t]) { const d = await val(`drivers/${t}`); a[t] = norm({ ...d, timeout_until: d && d.timeout_until ? '<t>' : null }); }
    return { a, b, calls: calls.length };
  };
  const on = await runTimeout(true); const off = await runTimeout(false);
  assert.deepStrictEqual(on, off, '🔴 D12: the timeout writer differs with the flag ON');
  assert.strictEqual(on.a.tasks.n_delivery.assigned_driver_id, 'd_s21', 'premise: reassigned onto the 1-order same-hub driver (today)');
  assert.ok(!hasCopies(on.a.tasks.n_delivery), 'no copies on a timeout reassign');
  assert.strictEqual(on.calls, 0, 'no Routes call from the timeout writer');
  ok('timeout (D12): a reassign onto a same-hub 1-order driver and a two-strike release are BYTE-IDENTICAL with the flag ON and false; no copies, no call');

  FINISHED = true;
  console.log(`\nstackseq-writers(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
