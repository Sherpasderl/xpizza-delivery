'use strict';
/**
 * BRAND-AGNOSTIC SERVER X1 (PLAN-brand-agnostic-server r3 §D / §E) — the REAL assigners and the REAL ingest, in-process against
 * the RTDB emulator (index.js handlers through .run(event); ingest through its express export with a real native shift token).
 * Synthetic brands only: tb_norte HAS an identity hub; tb_sinhub has none. Run: npm run test:brand-hub-assign (~70 s: real timers)
 *   E1 autoAssignOnOrderCreate: a hub-less order → no task write, no claim, no attempt counter + exactly ONE keyed
 *      dispatcher_alerts/hub_unresolved_<orderId>; an unstamped tb_norte order is assigned from its identity hub (control).
 *   E2 sweepPendingOrders ×2: the hub-less order is skipped both times — still exactly one alert (set-if-absent, unchanged).
 *   E3 monitorAssignmentTimeout, a MANUALLY assigned hub-less order — first strike / two-strike (attempts 2) / held / held +
 *      attempts 2: the assignment is unchanged, exactly one alert, releaseToSinAsignar is never reached (spy on its CAS). The
 *      same four cases WITH a hub keep today's outcomes (reassign / takeover release + no_response_takeover).
 *   D1 reassertAssignable with the identity read HELD: the driver departs / clocks out / gains an order meanwhile → the recheck
 *      (final read AFTER the delay) refuses (en_route at cap / off_shift / at_cap); no change → assigned (control).
 *   D2 ingest with the hub lookup HELD: the driver's task / shift / status changes meanwhile → the geofence transition is
 *      dropped, the location is kept; no change → the transition commits (control).
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'hub-secret';

const assert = require('assert');
const http = require('http');
const express = require('express');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const fns = require('../index');
Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });

const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const NOW = Date.now();
const NORTE = { name: 'Norte', hub_lat: 15.53, hub_lng: -88.01, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 9, hours: { sun: { open: true, start: '00:00', end: '23:59' } }, active: true, version: 1 };
const order = (oid, rid, over = {}) => ({ order_id: oid, restaurant_id: rid, status: 'new', order_type: 'delivery', recipient_name: 'Cliente', total: 100, created_at: NOW - 10 * 60000, ...over });
const stamped = (oid, over = {}) => order(oid, 'tb_norte', { hub_lat: NORTE.hub_lat, hub_lng: NORTE.hub_lng, ...over });
const pk = (oid, rid, hub, over = {}) => ({ order_id: oid, type: 'pickup', status: 'pending', assigned_driver_id: null, restaurant_id: rid, destination_lat: hub ? hub.lat : null, destination_lng: hub ? hub.lng : null, ...over });
const dl = (oid, over = {}) => ({ order_id: oid, type: 'delivery', status: 'pending', assigned_driver_id: null, ...over });
const tasksFor = (oid, rid, hub, over = {}) => ({ [`${oid}_pickup`]: pk(oid, rid, hub, over), [`${oid}_delivery`]: dl(oid, over) });
const driver = (name, over = {}) => ({ name, status: 'available', push_reachable: true, lat: 15.5, lng: -88.0, active: true, ...over });
const written = (before, after, ref) => ({ params: { orderId: ref, taskId: ref }, data: { before: { val: () => before }, after: { val: () => after } } });
const NH = { lat: NORTE.hub_lat, lng: NORTE.hub_lng };

// spy: every transaction on a delivery's assigned_driver_id (releaseToSinAsignar's CAS = releaseDeliveryFromDriver)
const txPaths = [];
(() => {
  let o = Object.getPrototypeOf(db.ref('x'));
  while (o && !Object.prototype.hasOwnProperty.call(o, 'transaction')) o = Object.getPrototypeOf(o);
  const orig = o.transaction;
  o.transaction = function (...a) { txPaths.push(decodeURIComponent(new URL(this.toString()).pathname).replace(/^\//, '')); return orig.apply(this, a); };
})();
// the hold seam (tracking/hold.js — inert unless a test installs it)
const holds = new Map();
globalThis.__trackerHold = async (name, ctx) => { const k = `${name}:${ctx.newOrderId || ctx.uid || ''}`; const h = holds.get(k); if (h) { holds.delete(k); h.reached(); await h.gate; } };
const hold = (key) => { let open, reached; const gate = new Promise((r) => { open = r; }); const at = new Promise((r) => { reached = r; }); holds.set(key, { gate, reached }); return { at, release: () => open() }; };
const alertsOf = async (oid) => Object.entries((await val('dispatcher_alerts')) || {}).filter(([, a]) => a && a.order_id === oid);

(async () => {
  await db.ref().set({
    config: { auto_assign_enabled: true },
    restaurants: { tb_norte: { identity: NORTE } },
    drivers: { dA: driver('A'), dB: driver('B'), dT1: driver('T1'), dT2: driver('T2'), dT3: driver('T3'), dT4: driver('T4'), dH1: driver('H1'), dH2: driver('H2'), dH3: driver('H3'), dH4: driver('H4') },
    orders: {
      e1: order('e1', 'tb_sinhub'), c1: order('c1', 'tb_norte'),
      t1: order('t1', 'tb_sinhub'), t2: order('t2', 'tb_sinhub'), t3: order('t3', 'tb_sinhub', { cancel_claim_id: 'claim_t3' }), t4: order('t4', 'tb_sinhub', { cancel_claim_id: 'claim_t4' }),
      h1: stamped('h1'), h2: stamped('h2'), h3: stamped('h3', { cancel_claim_id: 'claim_h3' }), h4: stamped('h4', { cancel_claim_id: 'claim_h4' }),
    },
    tasks: {
      ...tasksFor('e1', 'tb_sinhub', null), ...tasksFor('c1', 'tb_norte', NH),
      ...tasksFor('t1', 'tb_sinhub', null, { status: 'assigned', assigned_driver_id: 'dT1' }),
      ...tasksFor('t2', 'tb_sinhub', null, { status: 'assigned', assigned_driver_id: 'dT2', assignment_attempts: 2 }),
      ...tasksFor('t3', 'tb_sinhub', null, { status: 'assigned', assigned_driver_id: 'dT3' }),
      ...tasksFor('t4', 'tb_sinhub', null, { status: 'assigned', assigned_driver_id: 'dT4', assignment_attempts: 2 }),
      ...tasksFor('h1', 'tb_norte', NH, { status: 'assigned', assigned_driver_id: 'dH1' }),
      ...tasksFor('h2', 'tb_norte', NH, { status: 'assigned', assigned_driver_id: 'dH2', assignment_attempts: 2 }),
      ...tasksFor('h3', 'tb_norte', NH, { status: 'assigned', assigned_driver_id: 'dH3' }),
      ...tasksFor('h4', 'tb_norte', NH, { status: 'assigned', assigned_driver_id: 'dH4', assignment_attempts: 2 }),
    },
  });

  // ── E1 + E3 in parallel (the real 30 s grace and 60 s accept timers run) ──
  const auto = (oid) => val(`orders/${oid}`).then((o) => fns.autoAssignOnOrderCreate.run(written(null, o, oid)));
  const mon = (oid, drv) => fns.monitorAssignmentTimeout.run(written(null, drv, `${oid}_pickup`));
  await Promise.all([auto('e1'), auto('c1'), ...['1', '2', '3', '4'].flatMap((k) => [mon(`t${k}`, `dT${k}`), mon(`h${k}`, `dH${k}`)])]);

  const e1 = { p: await val('tasks/e1_pickup'), d: await val('tasks/e1_delivery') };
  assert.deepStrictEqual([e1.p.assigned_driver_id ?? null, e1.d.assigned_driver_id ?? null, e1.p.status, e1.p.assignment_attempts ?? null], [null, null, 'pending', null], 'E1: no task write, no attempt counter');
  assert.ok(!txPaths.includes('tasks/e1_delivery/assigned_driver_id'), 'E1: no delivery claim attempted');
  const e1a = await alertsOf('e1');
  assert.deepStrictEqual(e1a.map(([k, a]) => [k, a.type, a.restaurant_id]), [['hub_unresolved_e1', 'hub_unresolved', 'tb_sinhub']], 'E1: exactly ONE keyed alert');
  const c1d = await val('tasks/c1_pickup/assigned_driver_id');
  assert.ok(c1d === 'dA' || c1d === 'dB', `E1 control: the unstamped tb_norte order is assigned from its identity hub (got ${c1d})`);
  ok(`E1 autoAssign: hub-less e1 → no task write / claim / attempt + ONE hub_unresolved alert; control c1 (identity hub) → ${c1d}`);

  for (const k of ['1', '2', '3', '4']) {
    const p = await val(`tasks/t${k}_pickup`); const d = await val(`tasks/t${k}_delivery`);
    assert.deepStrictEqual([p.assigned_driver_id, d.assigned_driver_id, p.status, p.assignment_attempts ?? null], [`dT${k}`, `dT${k}`, 'assigned', k === '2' || k === '4' ? 2 : null], `E3 t${k}: the manual assignment is unchanged`);
    assert.ok(!txPaths.includes(`tasks/t${k}_delivery/assigned_driver_id`), `E3 t${k}: releaseToSinAsignar never reached (no release CAS)`);
    const a = await alertsOf(`t${k}`);
    assert.deepStrictEqual(a.map(([key, x]) => [key, x.type]), [[`hub_unresolved_t${k}`, 'hub_unresolved']], `E3 t${k}: exactly one alert`);
  }
  ok('E3 timeout, MANUAL hub-less order — first strike / two-strike (attempts 2) / held / held + 2: assignment unchanged, ONE alert, no release CAS');

  const h1 = await val('tasks/h1_pickup/assigned_driver_id');
  assert.ok(h1 && h1 !== 'dH1', `E3 with a hub, first strike → reassigned to another driver (got ${h1})`);
  for (const k of ['2', '3', '4']) {
    for (const t of ['pickup', 'delivery']) assert.strictEqual(await val(`tasks/h${k}_${t}/assigned_driver_id`), null, `E3 h${k} ${t}: takeover released to SIN ASIGNAR`);
    assert.ok(txPaths.includes(`tasks/h${k}_delivery/assigned_driver_id`), `E3 h${k}: releaseToSinAsignar ran`);
    assert.ok((await alertsOf(`h${k}`)).some(([, a]) => a.type === 'no_response_takeover'), `E3 h${k}: no_response_takeover alert`);
  }
  for (const k of ['1', '2', '3', '4']) assert.ok(!(await alertsOf(`h${k}`)).some(([, a]) => a.type === 'hub_unresolved'), `E3 h${k}: no hub alert`);
  ok(`E3 the same four WITH a hub keep today's outcomes: h1 reassigned (${h1}); h2 / h3 / h4 takeover release + no_response_takeover`);

  // ── E2: the sweep ×2 — still exactly one alert, unchanged ──
  const first = (await alertsOf('e1'))[0][1];
  await db.ref('config/sweep_pending_enabled').set(true);
  await db.ref('drivers').update({ dC: driver('C') });
  await db.ref('orders/c2').set(stamped('c2')); await db.ref('tasks').update(tasksFor('c2', 'tb_norte', NH));
  await fns.sweepPendingOrders.run({});
  await fns.sweepPendingOrders.run({});
  assert.strictEqual(await val('tasks/e1_delivery/assigned_driver_id'), null, 'E2: never offered');
  const e2a = await alertsOf('e1');
  assert.deepStrictEqual([e2a.length, e2a[0][1]], [1, first], 'E2: still ONE alert, byte-identical (set-if-absent — no re-alert)');
  assert.ok(await val('tasks/c2_delivery/assigned_driver_id'), 'E2 control: a stamped order is offered');
  ok('E2 sweep ×2: the hub-less order is skipped both times; one alert, unchanged; the control is offered');

  // ── D1: reassertAssignable with the identity read HELD (driven through the sweep's claim → recheck, no grace timer) ──
  // a clean board per case: the case's order is the only sweepable one and its driver the only candidate
  const d1Cases = [
    ['dDepart', 'departs (en_route with 1 order) → at_cap', async (drv) => { await db.ref('tasks').update({ dx1_delivery: dl('dx1', { status: 'accepted', assigned_driver_id: drv }) }); await db.ref(`drivers/${drv}/status`).set('en_route_delivery'); }],
    ['dOff', 'clocks out → off_shift', async (drv) => { await db.ref(`drivers/${drv}/status`).set('off_shift'); }],
    ['dCap', 'gains two orders → at_cap', async (drv) => { await db.ref('tasks').update({ dy1_delivery: dl('dy1', { status: 'assigned', assigned_driver_id: drv }), dy2_delivery: dl('dy2', { status: 'assigned', assigned_driver_id: drv }) }); }],
    ['dCtl', 'no change (control)', async () => {}],
  ];
  for (const [drv, label, change] of d1Cases) {
    const oid = `r_${drv}`;
    await db.ref().update({ orders: { [oid]: stamped(oid) }, tasks: tasksFor(oid, 'tb_norte', NH), drivers: { [drv]: driver(drv) } });
    const h = hold(`assign:hub:${oid}`);
    const run = fns.sweepPendingOrders.run({});
    await h.at; await change(drv); h.release(); await run;
    const got = { d: await val(`tasks/${oid}_delivery/assigned_driver_id`), p: await val(`tasks/${oid}_pickup/assigned_driver_id`) };
    if (drv === 'dCtl') assert.deepStrictEqual(got, { d: drv, p: drv }, `D1 ${label}: placed`);
    else assert.deepStrictEqual(got, { d: null, p: null }, `D1 ${label}: the recheck (final read AFTER the delayed lookup) refused; the claim rolled back`);
  }
  ok('D1 reassertAssignable: identity read HELD while the driver departs / clocks out / gains orders → refused, claim rolled back (the final read follows the delay); no change → placed');

  // ── D2: ingest with the hub lookup HELD ──
  const U = 'u_hub_ingest_00000000000';
  let ingestN = 0;
  const ingest = async (token, lat, lng) => {
    ingestN += 1;
    const body = { locations: [{ ts: Date.now() - 1000 + ingestN, lat, lng, accuracy: 10 }] };
    const w = express(); w.use(express.json()); w.use(fns.ingestDriverLocation);
    return new Promise((resolve, reject) => {
      const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
        try { const r = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-driver-token': token }, body: JSON.stringify(body) }); server.close(() => resolve(r.status)); }
        catch (e) { server.close(() => reject(e)); }
      });
    });
  };
  const near = [NORTE.hub_lat + 0.00005, NORTE.hub_lng];   // ~5 m from the hub — inside the 50 m geofence
  const d2 = async (label, change) => {
    await db.ref(`drivers/${U}`).set({ name: 'Ing', status: 'off_shift', active: false });
    await db.ref(`driver_accounts/${U}`).set({ enabled: true });
    const { ingest_token: token } = await fns.startDriverShift.run({ auth: { uid: U, token: { uid: U } }, data: { platform: 'native' }, rawRequest: { headers: {} } });
    await db.ref(`drivers/${U}`).update({ status: 'returning', return_restaurant_id: 'tb_norte', lat: 15.6, lng: -88.2 });
    const h = hold(`ingest:hub:${U}`);
    const run = ingest(token, near[0], near[1]);
    await h.at; await change(); h.release();
    assert.strictEqual(await run, 200, `D2 ${label}: ingest accepted`);
    return val(`drivers/${U}`);
  };
  const ctl = await d2('control', async () => {});
  assert.deepStrictEqual([ctl.status, typeof ctl.arrived_at_restaurant_at, ctl.lat], ['at_restaurant', 'number', near[0]], 'D2 control: returning → at_restaurant (arrived) at the RETURN restaurant, location kept');
  const moved = await d2('task assigned meanwhile', async () => { await db.ref(`drivers/${U}`).update({ current_task_id: 'zz_pickup', status: 'assigned' }); });
  assert.deepStrictEqual([moved.status, moved.arrived_at_restaurant_at ?? null, moved.lat], ['assigned', null, near[0]], 'D2: a task assigned during the lookup → the transition is DROPPED, the location kept');
  const statusMoved = await d2('status changed meanwhile', async () => { await db.ref(`drivers/${U}/status`).set('on_break'); });
  assert.deepStrictEqual([statusMoved.status, statusMoved.lat], ['on_break', near[0]], 'D2: a status change during the lookup → the transition is DROPPED, the location kept');
  const shiftMoved = await d2('shift changed meanwhile', async () => { await db.ref(`drivers/${U}/current_shift_id`).set('another-shift'); });
  assert.deepStrictEqual([shiftMoved.status, shiftMoved.arrived_at_restaurant_at ?? null, shiftMoved.lat], ['returning', null, near[0]], 'D2: a shift change during the lookup → the transition is DROPPED, the location kept');
  ok('D2 ingest: hub lookup HELD while the task / status / shift changes → the geofence transition is dropped and the location kept; no change → returning → at_restaurant');

  console.log(`\nbrand-hub-assign: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('brand-hub-assign FAILED:', e && e.stack || e); process.exit(1); });
