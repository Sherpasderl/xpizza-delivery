'use strict';
/**
 * «PAUSA» (PLAN-driver-pausa-server r1.1 §2 / §4 / §6) — the REAL assigners, sweep, timeout monitor and shift callables (index.js
 * handlers through .run, in-process against the RTDB emulator), plus the REAL startDriverShift batch replayed through the RULES as the
 * svc-assigner identity, plus the break_since rules matrix. Synthetic tb_ data only. Run: npm run test:pausa (~6 min: real 30 s grace + 60 s accept timers)
 *   P1 auto-assign: a PAUSED driver at the hub vs an available one farther away → the available one; only paused → no assignment +
 *      no_drivers_available.
 *   P2 sweep re-offer skips the paused driver; after RESUME the driver is offered again.
 *   P3 timeout reassign (a cell that starts BEFORE selection): the next driver skips a paused one.
 *   P7 the SELECTED driver pauses after ranking, before reassertAssignable (auto-assign AND sweep) → refused, claim rolled back.
 *   P4 the accepted residuals FORCED through the real writers (no seeded offers): (b) a pause after reassert → attempt-1 offer + push
 *      → cooldown + another driver / (b′) none eligible → no_drivers_available; (a) the timeout pick→claim gap → attempt-2 offer + push
 *      → cooldown + release + no_response_takeover; §3a the stale cancel-cleanup overwrite of a pause (pinned, accepted).
 *   P5 startDriverShift / endDriverShift clear break_since; the REAL shift-open batch is accepted by the rules for svc-assigner (the
 *      clear-only grant) — and svc-assigner may never SET break_since.
 *   P6 rules: own pause / resume / later ordinary targeted updates; staff; other driver / handheld / deactivated denied; a non-now /
 *      string break_since denied.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'pausa-secret';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
require('../lib/admin');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fns = require('../index');
Object.getPrototypeOf(getAuth()).getUser = async (uid) => ({ uid, disabled: false, tokensValidAfterTime: null });

const db = getDatabase();
assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
let n = 0;
const ok = (l) => console.log(`  ok ${++n} ${l}`);
const FAIL = (label, e) => new Error(`FAILED: ${label} — ${e && e.message}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const NOW = Date.now();
const HUB = { hub_lat: 15.53, hub_lng: -88.01 };
const IDENT = { name: 'Tb Pz', ...HUB, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 9, version: 1, active: true,
  hours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '00:00', end: '23:59' }])) };
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_pz', status: 'new', order_type: 'delivery', recipient_name: 'Cliente', total: 100, created_at: NOW - 10 * 60000, ...HUB, ...over });
const pk = (oid, over = {}) => ({ order_id: oid, type: 'pickup', status: 'pending', assigned_driver_id: null, restaurant_id: 'tb_pz', destination_lat: HUB.hub_lat, destination_lng: HUB.hub_lng, ...over });
const dl = (oid, over = {}) => ({ order_id: oid, type: 'delivery', status: 'pending', assigned_driver_id: null, ...over });
const tasksFor = (oid, over = {}) => ({ [`${oid}_pickup`]: pk(oid, over), [`${oid}_delivery`]: dl(oid, over) });
const driver = (name, over = {}) => ({ name, status: 'available', push_reachable: true, lat: HUB.hub_lat, lng: HUB.hub_lng, active: true, ...over });
const paused = (name, over = {}) => driver(name, { status: 'on_break', break_since: NOW - 60000, ...over });   // AT the hub: nearest
const far = (name, over = {}) => driver(name, { lat: HUB.hub_lat + 0.05, lng: HUB.hub_lng, ...over });       // ~5.5 km away
const written = (before, after, ref) => ({ params: { orderId: ref, taskId: ref }, data: { before: { val: () => before }, after: { val: () => after } } });
const alertsOf = async (oid) => Object.values((await val('dispatcher_alerts')) || {}).filter((a) => a && a.order_id === oid).map((a) => a.type);
const auto = (oid) => val(`orders/${oid}`).then((o) => fns.autoAssignOnOrderCreate.run(written(null, o, oid)));
const mon = (oid, drv) => fns.monitorAssignmentTimeout.run(written(null, drv, `${oid}_pickup`));

// capture the REAL root updates the callables write (to replay startDriverShift's exact batch through the rules)
// the reassertAssignable hold seam (tracking/hold.js — inert unless installed): `assign:hub:<orderId>` pauses right after the
// ranking chose a driver and before reassert's final reads
const holds = new Map();
globalThis.__trackerHold = async (name, ctx) => { const k = `${name}:${ctx.newOrderId || ctx.uid || ''}`; const h = holds.get(k); if (h) { holds.delete(k); h.reached(); await h.gate; } };
const hold = (key) => { let open, reached; const gate = new Promise((r) => { open = r; }); const at = new Promise((r) => { reached = r; }); holds.set(key, { gate, reached }); return { at, release: () => open() }; };
const rootUpdates = [];
(() => {
  let o = Object.getPrototypeOf(db.ref());
  while (o && !Object.prototype.hasOwnProperty.call(o, 'update')) o = Object.getPrototypeOf(o);
  const orig = o.update;
  o.update = function (v, ...rest) { if (decodeURIComponent(new URL(this.toString()).pathname) === '/') rootUpdates.push(v); return orig.call(this, v, ...rest); };
})();

(async () => {
  // ── P1 auto-assign ──
  await db.ref().set({
    config: { auto_assign_enabled: true },
    restaurants: { tb_pz: { identity: IDENT } },
    drivers: { dP: paused('P'), dF: far('F') },
    orders: { a1: order('a1'), a2: order('a2') },
    tasks: { ...tasksFor('a1'), ...tasksFor('a2') },
  });
  await auto('a1');
  assert.strictEqual(await val('tasks/a1_delivery/assigned_driver_id'), 'dF', 'P1: the paused driver at the hub is skipped; the available one farther away is offered');
  await db.ref('drivers/dF').update({ status: 'on_break', break_since: ServerValue.TIMESTAMP });
  await db.ref('tasks').update({ 'a1_pickup/assigned_driver_id': null, 'a1_delivery/assigned_driver_id': null, 'a1_pickup/status': 'pending', 'a1_delivery/status': 'pending' });
  await auto('a2');
  assert.strictEqual(await val('tasks/a2_delivery/assigned_driver_id'), null, 'P1: only paused drivers → no assignment');
  assert.ok((await alertsOf('a2')).includes('no_drivers_available'), 'P1: only paused drivers → no_drivers_available');
  ok('P1 auto-assign: paused-at-hub skipped for an available driver farther away; only paused → no assignment + no_drivers_available');

  // ── P2 sweep ──
  await db.ref().update({
    'config/sweep_pending_enabled': true,
    'drivers/dF': far('F'), 'drivers/dP': paused('P'),
    'orders/s1': order('s1', { created_at: NOW - 30 * 60000 }), ...Object.fromEntries(Object.entries(tasksFor('s1')).map(([k, v]) => [`tasks/${k}`, v])),
  });
  await fns.sweepPendingOrders.run({});
  assert.strictEqual(await val('tasks/s1_delivery/assigned_driver_id'), 'dF', 'P2: the sweep re-offer skips the paused driver');
  // RESUME (the 2f contract update) — and the only other driver goes off shift: the resumed driver is offered again
  await db.ref('drivers/dP').update({ status: 'available', break_since: null });
  await db.ref().update({ 'drivers/dF/status': 'off_shift', 'drivers/dF/active': false,
    'orders/s2': order('s2', { created_at: NOW - 30 * 60000 }), ...Object.fromEntries(Object.entries(tasksFor('s2')).map(([k, v]) => [`tasks/${k}`, v])) });
  await fns.sweepPendingOrders.run({});
  assert.strictEqual(await val('tasks/s2_delivery/assigned_driver_id'), 'dP', 'P2: after resume the driver is offered again');
  ok('P2 sweep: the re-offer skips the paused driver; after RESUME the driver is offered again');

  // ── P3 timeout reassign selection (starts BEFORE selection; the real 60 s accept timer runs) ──
  await db.ref().update({
    'drivers/dX': far('X', { status: 'assigned' }), 'drivers/dQ': paused('Q'), 'drivers/dG': far('G'), 'drivers/dP': paused('P'),
    'drivers/dF': far('F', { status: 'off_shift', active: false }),
    'orders/m1': order('m1', { status: 'preparing' }),
    ...Object.fromEntries(Object.entries(tasksFor('m1', { status: 'assigned', assigned_driver_id: 'dX', assignment_attempts: 1 })).map(([k, v]) => [`tasks/${k}`, v])),
  });
  await mon('m1', 'dX');
  const m1 = await val('tasks/m1_delivery/assigned_driver_id');
  assert.ok(m1 === 'dG', `P3: the timeout reassign skips the paused drivers at the hub and offers dG (got ${m1})`);
  ok(`P3 timeout reassign (starts BEFORE selection): next driver ${m1}, never a paused one`);

  // ── P7 (Codex r1 P2-2) the SELECTED driver pauses AFTER ranking, BEFORE reassertAssignable → refused (behavioural) ──
  const wipe = (keep) => db.ref('drivers').once('value').then((s) => db.ref().update(Object.fromEntries(Object.keys(s.val() || {}).filter((k) => !keep.includes(k)).map((k) => [`drivers/${k}/status`, 'off_shift']))));
  await db.ref().update({ 'drivers/dR': driver('R'), ...Object.fromEntries(['q1', 'q2'].flatMap((o) => [[`orders/${o}`, order(o, { created_at: NOW - 30 * 60000 })], ...Object.entries(tasksFor(o)).map(([k, v]) => [`tasks/${k}`, v])])) });
  await wipe(['dR']);
  // earlier scenarios' orders leave the assignable set, so the sweep can only consider q1 / q2
  await db.ref().update(Object.fromEntries(['a1', 'a2', 's1', 's2', 'm1'].map((o) => [`orders/${o}/status`, 'cancelled'])));
  for (const [oid, run] of [['q1', () => auto('q1')], ['q2', () => fns.sweepPendingOrders.run({})]]) {
    await db.ref('drivers/dR').update({ status: 'available', break_since: null });
    const h = hold(`assign:hub:${oid}`);
    const p = run();
    await h.at;                                                                          // ranking chose dR; reassert not yet read
    await db.ref('drivers/dR').update({ status: 'on_break', break_since: ServerValue.TIMESTAMP });
    h.release(); await p;
    assert.strictEqual(await val(`tasks/${oid}_delivery/assigned_driver_id`), null, `P7 ${oid}: the paused selection is REFUSED at reassert — no claim survives (rolled back)`);
    assert.strictEqual(await val(`tasks/${oid}_pickup/assigned_driver_id`), null, `P7 ${oid}: no pickup assignment either`);
    await db.ref(`orders/${oid}/status`).set('cancelled');   // out of the next sweep's way
  }
  ok('P7 auto-assign AND sweep: the selected driver pauses after ranking, before reassertAssignable → refused, claim rolled back');

  // ── P4 the ACCEPTED residuals, forced through the REAL writers (no seeded offers; no transactions added) ──
  // gap (b): AFTER reassertAssignable passed, BEFORE the delivery claim — the driver pauses; the offer lands (attempt 1) + push
  const gapAt = new Map();   // delivery path → async action run just before that claim transaction
  (() => {
    let o = Object.getPrototypeOf(db.ref('x'));
    while (o && !Object.prototype.hasOwnProperty.call(o, 'transaction')) o = Object.getPrototypeOf(o);
    const orig = o.transaction;
    o.transaction = async function (...a) {
      const pth = decodeURIComponent(new URL(this.toString()).pathname).replace(/^\//, '');
      const act = gapAt.get(pth); if (act) { gapAt.delete(pth); await act(); }
      return orig.apply(this, a);
    };
  })();
  const pushes = [];
  const wp = require('web-push'); wp.sendNotification = async (sub, body) => { pushes.push({ endpoint: sub && sub.endpoint, body: JSON.parse(body) }); return {}; };
  const SUB = (u) => ({ push_subscription: { endpoint: `https://tb.push/${u}`, keys: { p256dh: 'x', auth: 'y' } } });
  const pushTo = async (oid) => { const t = await val(`tasks/${oid}_pickup`); await fns.notifyDriverOnAssignment.run(written({ ...t, assigned_driver_id: null }, t, `${oid}_pickup`)); };
  const pauseNow = (u) => () => db.ref(`drivers/${u}`).update({ status: 'on_break', break_since: ServerValue.TIMESTAMP });

  // (b) attempt 1, another driver exists: offer to the now-paused dB1 + push; timeout → cooldown + ANOTHER (non-paused) driver
  await db.ref().update({ 'drivers/dB1': driver('B1', SUB('dB1')), 'drivers/dB2': far('B2', { status: 'off_shift' }),
    'orders/g1': order('g1'), ...Object.fromEntries(Object.entries(tasksFor('g1')).map(([k, v]) => [`tasks/${k}`, v])) });
  await wipe(['dB1']);
  gapAt.set('tasks/g1_delivery/assigned_driver_id', pauseNow('dB1'));
  await auto('g1');
  assert.strictEqual(await val('tasks/g1_delivery/assigned_driver_id'), 'dB1', 'P4(b): the offer lands on the driver who paused inside the gap (attempt 1)');
  assert.strictEqual(await val('drivers/dB1/status'), 'on_break', 'P4(b) premise: dB1 is paused');
  await pushTo('g1');
  assert.ok(pushes.some((x) => x.endpoint === 'https://tb.push/dB1' && x.body.title === '¡Nuevo pedido!'), 'P4(b): the assignment PUSH is still sent to the paused driver');
  await db.ref('drivers/dB2').update({ status: 'available', active: true });   // another eligible driver for the reassign
  await mon('g1', 'dB1');
  assert.ok((await val('drivers/dB1/timeout_until')) > NOW, 'P4(b) attempt 1: the paused holder gets the 3-min cooldown');
  assert.strictEqual(await val('tasks/g1_delivery/assigned_driver_id'), 'dB2', 'P4(b) attempt 1: ANOTHER (non-paused) driver is offered');
  ok('P4(b) forced gap after reassert: attempt-1 offer + push to the paused driver → timeout → cooldown + another driver');

  // (b′) attempt 1 with NO other eligible driver → cooldown + released + no_drivers_available
  await db.ref().update({ 'drivers/dB3': driver('B3', SUB('dB3')), 'orders/g2': order('g2'), ...Object.fromEntries(Object.entries(tasksFor('g2')).map(([k, v]) => [`tasks/${k}`, v])) });
  await wipe(['dB3']);
  gapAt.set('tasks/g2_delivery/assigned_driver_id', pauseNow('dB3'));
  await auto('g2');
  assert.strictEqual(await val('tasks/g2_delivery/assigned_driver_id'), 'dB3', 'P4(b′) premise: the attempt-1 offer landed on the paused driver');
  await mon('g2', 'dB3');
  assert.ok((await val('drivers/dB3/timeout_until')) > NOW, 'P4(b′): cooldown');
  for (const t of ['pickup', 'delivery']) assert.strictEqual(await val(`tasks/g2_${t}/assigned_driver_id`), null, `P4(b′): released to SIN ASIGNAR (${t})`);
  assert.ok((await alertsOf('g2')).includes('no_drivers_available'), 'P4(b′): no_drivers_available');
  ok('P4(b′) attempt 1 with no eligible driver → cooldown + released + no_drivers_available');

  // (a) the TIMEOUT path's pick→claim gap: the next driver pauses inside it → attempt-2 offer + push; timeout → cooldown + takeover
  await db.ref().update({ 'drivers/dT': driver('T', { status: 'assigned' }), 'drivers/dN': driver('N', SUB('dN')),
    'orders/h1': order('h1', { status: 'preparing' }),
    ...Object.fromEntries(Object.entries(tasksFor('h1', { status: 'assigned', assigned_driver_id: 'dT', assignment_attempts: 1 })).map(([k, v]) => [`tasks/${k}`, v])) });
  await wipe(['dT', 'dN']);
  await db.ref('drivers/dT/status').set('assigned');
  gapAt.set('tasks/h1_delivery/assigned_driver_id', pauseNow('dN'));
  await mon('h1', 'dT');
  assert.strictEqual(await val('tasks/h1_delivery/assigned_driver_id'), 'dN', 'P4(a): the attempt-2 offer lands on the driver who paused inside the pick→claim gap');
  assert.strictEqual(await val('tasks/h1_pickup/assignment_attempts'), 2, 'P4(a): attempt 2');
  await pushTo('h1');
  assert.ok(pushes.some((x) => x.endpoint === 'https://tb.push/dN'), 'P4(a): the assignment PUSH is sent to the paused driver');
  await mon('h1', 'dN');
  assert.ok((await val('drivers/dN/timeout_until')) > NOW, 'P4(a): cooldown');
  for (const t of ['pickup', 'delivery']) assert.strictEqual(await val(`tasks/h1_${t}/assigned_driver_id`), null, `P4(a): released (${t})`);
  assert.ok((await alertsOf('h1')).includes('no_response_takeover'), 'P4(a): no_response_takeover');
  ok('P4(a) forced timeout pick→claim gap: attempt-2 offer + push to the paused driver → cooldown + released + no_response_takeover');

  // §3a the stale-cleanup overwrite (ACCEPTED residual, pinned): the REAL cancel cleanup reads the driver, the driver empties +
  // pauses, the delayed write lands → the pause is overwritten to available (break_since left behind). No transaction is added.
  {
    const { cleanupTasksAndDriver } = require('../cancel-order-core');
    await db.ref().update({ 'drivers/dC': driver('C', { status: 'assigned', current_task_id: 'k1_pickup' }), 'orders/k1': order('k1'),
      ...Object.fromEntries(Object.entries(tasksFor('k1', { status: 'assigned', assigned_driver_id: 'dC' })).map(([k, v]) => [`tasks/${k}`, v])) });
    const staleDb = { ref: (p) => (p === 'drivers/dC'
      ? { once: async (...a) => { const snap = await db.ref(p).once(...a); await db.ref(p).update({ status: 'on_break', break_since: ServerValue.TIMESTAMP }); return snap; } }
      : db.ref(p)) };
    await cleanupTasksAndDriver({ db: staleDb }, 'k1', await val('orders/k1'), Date.now());
    const c = await val('drivers/dC');
    assert.strictEqual(c.status, 'available', 'P4(§3a) RESIDUAL PINNED: a stale cancel cleanup overwrites the pause to available (accepted, owner simplicity rule)');
    assert.strictEqual(typeof c.break_since, 'number', 'P4(§3a): break_since is left behind — the driver is ordinarily eligible again and re-pauses');
  }
  ok('P4(§3a) the accepted stale-cleanup residual, pinned through the REAL cancel cleanup: the pause is overwritten to available');

  // ── P5 shift start / end ──
  const U = 'tbPausaU';
  await db.ref(`drivers/${U}`).set({ name: 'Pz', status: 'on_break', break_since: NOW - 5000, active: false });
  await db.ref(`driver_accounts/${U}`).set({ enabled: true });
  rootUpdates.length = 0;
  await fns.startDriverShift.run({ auth: { uid: U, token: { uid: U } }, data: { platform: 'pwa' }, rawRequest: { headers: {} } });
  const s1 = await val(`drivers/${U}`);
  assert.deepStrictEqual([s1.status, s1.break_since ?? null, s1.active], ['available', null, true], 'P5: startDriverShift → available, break_since cleared');
  const batch = rootUpdates.find((u) => Object.prototype.hasOwnProperty.call(u, `drivers/${U}/break_since`));
  assert.ok(batch && batch[`drivers/${U}/break_since`] === null, 'P5 premise: the REAL shift-open batch carries the break_since clear');
  await db.ref(`drivers/${U}`).update({ status: 'on_break', break_since: ServerValue.TIMESTAMP });
  await fns.endDriverShift.run({ auth: { uid: U, token: { uid: U } }, data: {}, rawRequest: { headers: {} } });
  const s2 = await val(`drivers/${U}`);
  assert.deepStrictEqual([s2.status, s2.break_since ?? null], ['off_shift', null], 'P5: endDriverShift → off_shift, break_since cleared');
  ok('P5 startDriverShift / endDriverShift clear break_since (the real callables)');

  // ── P5 (rules) + P6: the real batch through the RULES as svc-assigner; the break_since matrix ──
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-pausa', database: { rules: RULES } });
  const admin = async (fn) => env.withSecurityRulesDisabled(async (ctx) => fn(ctx.database()));
  const yes = async (label, pr) => { try { await assertSucceeds(pr); } catch (e) { throw FAIL(label, e); } ok(label); };
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw FAIL(label, e); } ok(label); };
  const DR = 'u_tbpzdrv000000000000000', OT = 'u_tbpzoth000000000000000', DE = 'u_tbpzdea000000000000000', DISP = 'u_tbpzdsp000000000000000';
  await admin(async (rdb) => {
    await rdb.ref('/').set(null);
    await rdb.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await rdb.ref(`driver_accounts/${U}`).set({ enabled: true });
    await rdb.ref(`driver_accounts/${DR}`).set({ enabled: true });
    await rdb.ref(`driver_accounts/${DE}`).set({ deactivated: true });
    await rdb.ref(`drivers/${U}`).set({ name: 'Pz', status: 'on_break', break_since: 1, active: false });
    await rdb.ref(`drivers/${DR}`).set({ name: 'Dr', status: 'available', active: true, current_shift_id: 's1' });
    await rdb.ref(`drivers/${DE}`).set({ name: 'De', status: 'available', active: true });
  });
  const svc = env.authenticatedContext('svc-assigner', { svc_assigner: true }).database();
  const replay = batch;   // the exact object startDriverShift wrote ({'.sv':'timestamp'} sentinels pass through the client SDK)
  await yes('P5 rules: the REAL startDriverShift batch is accepted for svc-assigner (the clear-only break_since grant)', svc.ref().update(replay));
  await no('P5 rules: svc-assigner may never SET break_since', svc.ref(`drivers/${U}/break_since`).set({ '.sv': 'timestamp' }));
  const drv = env.authenticatedContext(DR).database();
  const TS = { '.sv': 'timestamp' };
  await yes('P6: the driver pauses itself (status + break_since = now, one update)', drv.ref(`drivers/${DR}`).update({ status: 'on_break', break_since: TS }));
  await yes('P6: a later ordinary targeted update while paused (last_ping) is allowed', drv.ref(`drivers/${DR}`).update({ last_ping: TS }));
  await yes('P6: the driver resumes itself (status available + break_since cleared)', drv.ref(`drivers/${DR}`).update({ status: 'available', break_since: null }));
  await no('P6: a non-now break_since is DENIED', drv.ref(`drivers/${DR}`).update({ status: 'on_break', break_since: 1 }));
  await no('P6: a string break_since is DENIED', drv.ref(`drivers/${DR}`).update({ status: 'on_break', break_since: 'now' }));
  await no('P6: another driver CANNOT pause this driver', env.authenticatedContext(OT).database().ref(`drivers/${DR}`).update({ status: 'on_break', break_since: TS }));
  await no('P6: a HANDHELD token with the driver uid is DENIED', env.authenticatedContext(DR, { handheld: true }).database().ref(`drivers/${DR}`).update({ status: 'on_break', break_since: TS }));
  await no('P6: a DEACTIVATED driver is DENIED', env.authenticatedContext(DE).database().ref(`drivers/${DE}`).update({ status: 'on_break', break_since: TS }));
  await yes('P6: staff (a dispatcher) can pause a driver', env.authenticatedContext(DISP).database().ref(`drivers/${DR}`).update({ status: 'on_break', break_since: TS }));
  await yes('P6: staff can resume a driver', env.authenticatedContext(DISP).database().ref(`drivers/${DR}`).update({ status: 'available', break_since: null }));
  await env.cleanup();

  console.log(`\npausa: ${n} passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
