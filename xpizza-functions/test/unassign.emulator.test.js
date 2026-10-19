'use strict';
// UNASSIGN (PLAN-unassign-prepickup r1.2) — the REAL unassignOrder endpoint on the emulator (index.js, express adapter as in
// ingest-liveness; RECON_SECRET bearer for dispatcher auth; a stubbed Auth verifyIdToken for the 403 case).
// Run: npm run test:unassign
require('./_emulator-required')('database');
const assert = require('assert');
const http = require('http');
const express = require('express');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.RECON_SECRET = 'unassign-recon';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const core = require('../unassign-core');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const admin = require('firebase-admin');
const { releaseDeliveryFromDriver } = require('../claim-delivery');
// the REAL timeout-path release, LIFTED from index.js (brace-matched, as in driver-assignment-parity) — the parity reference
function liftFn(src, name) {
  let at = src.indexOf(`function ${name}(`); assert.notStrictEqual(at, -1, `lift ${name}`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let i = src.indexOf('{', at), d = 0, end = i; for (; end < src.length; end++) { if (src[end] === '{') d++; else if (src[end] === '}') { d--; if (!d) break; } }
  return src.slice(at, end + 1);
}
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const releaseToSinAsignar = new Function('releaseDeliveryFromDriver', 'console', `${liftFn(INDEX_SRC, 'releaseToSinAsignar')}; return releaseToSinAsignar;`)(releaseDeliveryFromDriver, console);
const DISP = 'u_disp_unassign0000000';
const db = getDatabase();
Object.getPrototypeOf(getAuth()).verifyIdToken = async (t) => { if (t === 'tok-nondispatcher') return { uid: 'u_not_disp' }; throw new Error('bad'); };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const A = 'u_drvA', B = 'u_drvB';
function call({ method = 'POST', bearer = process.env.RECON_SECRET, body = {}, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(app.unassignOrder);
    const server = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const r = await fetch(`http://127.0.0.1:${port}/`, { method, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
        const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
        server.close(() => resolve({ status: r.status, json, headers: r.headers }));
      } catch (e) { server.close(() => reject(e)); }
    });
  });
}
const v = async (p) => (await db.ref(p).once('value')).val();
const snapAll = async () => JSON.stringify({ t: await v('tasks'), d: await v('drivers'), e: await v('order_events') });
async function seed({ pickupStatus = 'accepted', pOwner = A, dOwner = A, orderStatus = 'ready', pointer = 'O1_pickup', drvStatus = 'assigned', driver = true } = {}) {
  assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/);
  await db.ref('/').set(null);
  const u = {
    'orders/O1': { order_id: 'O1', status: orderStatus, restaurant_id: 'tb_centro', created_at: 1 },
    'tasks/O1_pickup': { order_id: 'O1', type: 'pickup', status: pickupStatus, assigned_driver_id: pOwner, assignment_deadline: 999, created_at: 1 },
    'tasks/O1_delivery': { order_id: 'O1', type: 'delivery', status: pickupStatus === 'assigned' ? 'assigned' : 'accepted', assigned_driver_id: dOwner, half_claim_since: 5, created_at: 1 },
  };
  u[`dispatchers/${DISP}`] = { name: 'Disp' };
  if (driver) u[`drivers/${A}`] = { name: 'a', status: drvStatus, current_task_id: pointer, active: true };
  await db.ref().update(u);
}
const body = (extra = {}) => ({ orderId: 'O1', expectedFromDriver: A, opId: 'op-1', ...extra });

(async () => {
  const watchdog = setTimeout(() => { console.error('unassign: FAIL — timed out'); process.exit(1); }, 180000);
  // happy path (accepted order, U1-b)
  await seed();
  let r = await call({ body: body() });
  assert.deepStrictEqual([r.status, r.json], [200, { ok: true }]);
  const p = await v('tasks/O1_pickup'), d = await v('tasks/O1_delivery');
  assert.strictEqual(p.status, 'pending'); assert.strictEqual(p.assigned_driver_id ?? null, null); assert.strictEqual(p.assignment_deadline ?? null, null);
  assert.strictEqual(d.status, 'pending'); assert.strictEqual(d.assigned_driver_id ?? null, null); assert.strictEqual(d.half_claim_since ?? null, null);
  const drv = await v(`drivers/${A}`);
  assert.strictEqual(drv.current_task_id ?? null, null); assert.strictEqual(drv.status, 'available'); assert.strictEqual(drv.name, 'a'); assert.strictEqual(drv.active, true);
  const ev = await v('order_events/O1/unassign_op-1');
  assert.deepStrictEqual(Object.keys(ev).sort(), ['action', 'at', 'by', 'by_kind', 'by_uid', 'from_driver'].filter((k) => k !== 'by_uid' || ev.by_uid !== undefined).sort());
  assert.strictEqual(ev.action, 'unassign'); assert.strictEqual(ev.by, 'recon_secret'); assert.strictEqual(ev.by_kind, 'recon_secret'); assert.strictEqual(ev.from_driver, A);
  ok('accepted order: released (both legs pending, owners/deadlines/marker null — the timeout path\'s release), driver pointer cleared + available (other fields kept), ONE exact audit record');

  // driver statuses (cancel-core allowlist)
  for (const st of ['assigned', 'at_restaurant', 'en_route_delivery', 'off_shift', 'on_break']) {
    await seed({ drvStatus: st });
    r = await call({ body: body() }); assert.strictEqual(r.json.ok, true);
    const dd = await v(`drivers/${A}`);
    assert.strictEqual(dd.current_task_id ?? null, null);
    assert.strictEqual(dd.status, ['assigned', 'at_restaurant', 'en_route_delivery'].includes(st) ? 'available' : st, `status from ${st}`);
  }
  await seed({ pointer: 'OTHER_pickup' }); r = await call({ body: body() });
  assert.strictEqual(r.json.ok, true); assert.strictEqual((await v(`drivers/${A}`)).current_task_id, 'OTHER_pickup', 'a competing pointer is untouched');
  await seed({ driver: false }); r = await call({ body: body() });
  assert.strictEqual(r.json.ok, true); assert.strictEqual(await v(`drivers/${A}`), null, 'a missing driver node stays missing');
  ok('U1-b mirrors the cancel core: available only from assigned/at_restaurant/en_route_delivery; off_shift/on_break kept; competing pointer untouched; missing driver stays missing');

  // unaccepted (status assigned) — exactly the timeout path's case
  await seed({ pickupStatus: 'assigned', pointer: null, drvStatus: 'available' });
  r = await call({ body: body() }); assert.deepStrictEqual(r.json, { ok: true });
  assert.strictEqual((await v('tasks/O1_pickup')).status, 'pending');
  ok('unaccepted (assigned) order: released exactly as the timeout path would');

  // no-op outcomes — each with ZERO writes
  const zero = async (label, s, req, expect) => {
    await seed(s); const before = await snapAll();
    const rr = await call(req || { body: body() });
    assert.deepStrictEqual([rr.status, rr.json], expect, label);
    assert.strictEqual(await snapAll(), before, `${label}: zero writes`);
  };
  await zero('reassigned (delivery owned by B)', { dOwner: B, pOwner: B }, null, [200, { ok: false, reason: 'reassigned' }]);
  await zero('split (pickup B, delivery A)', { pOwner: B }, null, [200, { ok: false, reason: 'reassigned' }]);
  await zero('picked_up (pickup completed)', { pickupStatus: 'completed' }, null, [200, { ok: false, reason: 'picked_up' }]);
  await zero('picked_up (order out_for_delivery)', { orderStatus: 'out_for_delivery' }, null, [200, { ok: false, reason: 'picked_up' }]);
  await zero('terminal (cancelled)', { orderStatus: 'cancelled' }, null, [409, { error: 'terminal' }]);
  await zero('state (pickup pending but owned)', { pickupStatus: 'pending' }, null, [409, { error: 'state', status: 'pending' }]);
  await zero('state (pickup cancelled)', { pickupStatus: 'cancelled' }, null, [409, { error: 'state', status: 'cancelled' }]);
  await zero('missing order', {}, { body: body({ orderId: 'NOPE' }) }, [404, { error: 'not_found' }]);
  for (const bad of ['', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'a/b', 'x'.repeat(129), 'a\u0001b']) {
    await zero(`bad key ${JSON.stringify(bad).slice(0, 12)}`, {}, { body: body({ opId: bad }) }, [400, { error: 'bad_request' }]);
  }
  ok('no-ops and refusals write NOTHING: reassigned, split, picked_up ×2, terminal, state ×2, not_found, 400 for each invalid key class');

  // missing leg → 404, each leg separately: the order and the OPPOSITE leg are kept, and nothing is written
  for (const leg of ['O1_delivery', 'O1_pickup']) {
    await seed(); await db.ref(`tasks/${leg}`).set(null);
    const other = leg === 'O1_delivery' ? 'O1_pickup' : 'O1_delivery';
    assert.ok(await v('orders/O1') && await v(`tasks/${other}`), `premise: the order and ${other} exist`);
    const pre = await snapAll();
    r = await call({ body: body({ opId: `op-miss-${leg}` }) });
    assert.deepStrictEqual([r.status, r.json], [404, { error: 'not_found' }], `${leg} missing → 404`);
    assert.strictEqual(await snapAll(), pre, `${leg} missing: zero writes (tasks, drivers, audit)`);
  }
  // already released → not_assigned + pointer repair
  await seed({ pickupStatus: 'pending', pOwner: null, dOwner: null, pointer: 'O1_pickup', drvStatus: 'assigned' });
  r = await call({ body: body() }); assert.deepStrictEqual(r.json, { ok: false, reason: 'not_assigned' });
  assert.strictEqual((await v(`drivers/${A}`)).current_task_id ?? null, null, 'the stale pointer is repaired');
  await seed({ pickupStatus: 'pending', pOwner: null, dOwner: null, pointer: 'OTHER_pickup' });
  r = await call({ body: body() }); assert.deepStrictEqual(r.json, { ok: false, reason: 'not_assigned' });
  assert.strictEqual((await v(`drivers/${A}`)).current_task_id, 'OTHER_pickup', 'a pointer naming another order is untouched');
  ok('missing delivery leg / missing pickup leg (each with the order + opposite leg present) → 404 with ZERO writes; already released → not_assigned AND the stale pointer repaired (another order\'s pointer untouched)');

  // crash after the release on the first attempt → the retry repairs (E-U2)
  await seed();
  const logs = [];
  const crashDeps = { db, now: () => 1, log: (m) => logs.push(m), release: async (dbx, oid, drv) => {
    await dbx.ref(`tasks/${oid}_delivery/half_claim_since`).set(null);
    await dbx.ref().update({ [`tasks/${oid}_delivery/assigned_driver_id`]: null, [`tasks/${oid}_pickup/assigned_driver_id`]: null, [`tasks/${oid}_pickup/status`]: 'pending', [`tasks/${oid}_delivery/status`]: 'pending' });
    throw new Error('crash after release');
  } };
  await assert.rejects(core.runUnassign(crashDeps, { orderId: 'O1', expectedFromDriver: A, opId: 'op-c', actor: 'x', uid: null, byKind: 'recon_secret' }), /crash/);
  assert.strictEqual((await v(`drivers/${A}`)).current_task_id, 'O1_pickup', 'the crash left the pointer stale');
  r = await call({ body: body({ opId: 'op-c' }) }); assert.deepStrictEqual(r.json, { ok: false, reason: 'not_assigned' });
  assert.strictEqual((await v(`drivers/${A}`)).current_task_id ?? null, null, 'the retry repaired it');
  ok('E-U2: a crash after the release leaves the pointer stale; the retry takes the already-released branch and repairs it');

  // retryable mapping: the CAS does not commit (owner stays A) — only the inherited marker clear is permitted
  await seed();
  let releases = 0;
  const before = { p: await v('tasks/O1_pickup'), d: await v('tasks/O1_delivery'), drv: await v(`drivers/${A}`) };
  const rr = await core.runUnassign({ db, now: () => 1, log: () => {}, release: async (dbx, oid) => { releases += 1; await dbx.ref(`tasks/${oid}_delivery/half_claim_since`).set(null); return false; } },
    { orderId: 'O1', expectedFromDriver: A, opId: 'op-r', actor: 'x', uid: null, byKind: 'recon_secret' });
  assert.deepStrictEqual(rr, { status: 503, body: { error: 'retryable' } });
  assert.strictEqual(releases, 1, 'exactly one release attempt');
  const dAfter = await v('tasks/O1_delivery');
  assert.deepStrictEqual({ ...dAfter, half_claim_since: before.d.half_claim_since }, before.d, 'the delivery leg is unchanged except the inherited half_claim_since clear');
  assert.deepStrictEqual(await v('tasks/O1_pickup'), before.p); assert.deepStrictEqual(await v(`drivers/${A}`), before.drv);
  assert.strictEqual(await v('order_events/O1/unassign_op-r'), null, 'no audit');
  ok('retryable: CAS not committed → 503, ONE release attempt, only the inherited half_claim_since clear, no pointer write, no audit');

  // the release did not commit because the order MOVED concurrently: re-read the owner → reassigned (moved to B) / not_assigned (+ repair)
  for (const [label, moveTo, expect] of [['moved to B', B, { ok: false, reason: 'reassigned' }], ['already released by the timeout path', null, { ok: false, reason: 'not_assigned' }]]) {
    await seed();
    const rc = await core.runUnassign({ db, now: () => 1, log: () => {}, release: async (dbx, oid) => {
      await dbx.ref().update({ [`tasks/${oid}_delivery/assigned_driver_id`]: moveTo, [`tasks/${oid}_pickup/assigned_driver_id`]: moveTo, [`tasks/${oid}_pickup/status`]: moveTo ? 'assigned' : 'pending', [`tasks/${oid}_delivery/status`]: moveTo ? 'assigned' : 'pending' });
      return false;
    } }, { orderId: 'O1', expectedFromDriver: A, opId: 'op-mv', actor: 'x', uid: null, byKind: 'recon_secret' });
    assert.deepStrictEqual(rc, { status: 200, body: expect }, label);
    assert.strictEqual((await v(`drivers/${A}`)).current_task_id ?? null, moveTo ? 'O1_pickup' : null, `${label}: pointer ${moveTo ? 'left alone' : 'repaired'}`);
    assert.strictEqual(await v('order_events/O1/unassign_op-mv'), null, `${label}: no audit`);
  }
  ok('release not committed because the order moved: owner now B → reassigned (pointer untouched); owner now null → not_assigned + pointer repaired; no audit either way');

  // audit immutability: release → reassigned to A again → delayed retry with the same opId → audit unchanged
  await seed();
  r = await call({ body: body({ opId: 'op-a' }) }); assert.strictEqual(r.json.ok, true);
  const audit1 = await v('order_events/O1/unassign_op-a');
  await db.ref().update({ 'tasks/O1_pickup/assigned_driver_id': A, 'tasks/O1_pickup/status': 'accepted', 'tasks/O1_delivery/assigned_driver_id': A, 'tasks/O1_delivery/status': 'accepted' });
  r = await call({ body: body({ opId: 'op-a' }) });   // a delayed retry of the SAME press lands after the re-assignment
  assert.deepStrictEqual(await v('order_events/O1/unassign_op-a'), audit1, 'the original audit record is never overwritten (create-only)');
  assert.ok(core.auditCreateOnly({ x: 1 })({ y: 2 }) === undefined && core.auditCreateOnly({ x: 1 })(null).x === 1);
  ok('audit is create-only: a delayed retry of the same opId never overwrites the original event');

  // predictReadyTimeOnNew on the PERSISTED unassign event: its real outputs (order_predictions) stay unchanged, and its cheap
  // prefilter returns before ANY database read (the core would re-confirm, so the read count is the prefilter's observable).
  // Positive control: the order's real `to:'new'` event DOES produce a prediction through the same trigger.
  await seed();
  await db.ref().update({
    'order_events/O1/e_new': { to: 'new', at: 1_760_000_000_000, restaurant_id: 'tb_centro', kitchen_load_ahead: 0 },
    'order_events/O1/unassign_op-p': { action: 'unassign', by: 'x', from_driver: A, at: 1_760_000_100_000 },
  });
  const RefProto = Object.getPrototypeOf(db.ref('x'));
  const orig = { once: RefProto.once, get: RefProto.get, transaction: RefProto.transaction };
  let reads = 0;
  const runCounted = async (eventId) => {
    reads = 0;
    RefProto.once = function (...a) { reads += 1; return orig.once.apply(this, a); };
    RefProto.get = function (...a) { reads += 1; return orig.get.apply(this, a); };
    RefProto.transaction = function (...a) { reads += 1; return orig.transaction.apply(this, a); };
    try {
      const snap = await db.ref(`order_events/O1/${eventId}`).once('value');   // the persisted row, as the platform delivers it
      reads = 0;
      await app.predictReadyTimeOnNew.run({ data: snap, params: { orderId: 'O1', eventId } });
    } finally { Object.assign(RefProto, orig); }
    return reads;
  };
  assert.strictEqual(await runCounted('unassign_op-p'), 0, 'the unassign event is dropped by the prefilter before any read');
  assert.strictEqual(await v('order_predictions/O1'), null, 'no prediction from the unassign event');
  await runCounted('e_new');
  const preds = await v('order_predictions/O1');
  assert.ok(preds && Object.keys(preds).length > 0 && Object.values(preds).every((p) => p.source_event_id === 'e_new'), `positive control: the real 'new' event predicts (${JSON.stringify(preds && Object.keys(preds))})`);
  assert.strictEqual(await runCounted('unassign_op-p'), 0, 'again zero reads after a prediction exists');
  assert.deepStrictEqual(await v('order_predictions/O1'), preds, 'the unassign event leaves the existing prediction unchanged');
  ok('predictReadyTimeOnNew on the PERSISTED unassign event: zero reads (prefilter), order_predictions unchanged; positive control — the real new event predicts');


  // parity: the endpoint's post-state of the tasks == the REAL lifted timeout-path release of an identical order
  assert.ok(/release: releaseToSinAsignar,/.test(INDEX_SRC.slice(INDEX_SRC.indexOf('exports.unassignOrder = onRequest('), INDEX_SRC.indexOf('exports.cancelPaidOrder = onRequest('))), 'the endpoint injects the SAME releaseToSinAsignar');
  await seed();
  const twin = JSON.parse(JSON.stringify({ p: await v('tasks/O1_pickup'), d: await v('tasks/O1_delivery') }).replace(/O1/g, 'O2'));
  await db.ref().update({ 'orders/O2': { order_id: 'O2', status: 'ready', restaurant_id: 'tb_centro', created_at: 1 }, 'tasks/O2_pickup': twin.p, 'tasks/O2_delivery': twin.d });
  r = await call({ body: body({ opId: 'op-par' }) }); assert.strictEqual(r.json.ok, true);
  assert.strictEqual(await releaseToSinAsignar(db, 'O2', A), true);
  assert.strictEqual(JSON.stringify({ p: await v('tasks/O1_pickup'), d: await v('tasks/O1_delivery') }).replace(/O1/g, 'O2'), JSON.stringify({ p: await v('tasks/O2_pickup'), d: await v('tasks/O2_delivery') }));
  ok('parity: the endpoint injects releaseToSinAsignar, and its task post-state is byte-identical to the lifted timeout-path release of a twin order');

  // the REAL dispatch clients (desktop + mobile) under PRODUCTION rules: both unassigned boards see it; the real reassignOrder → reassigned
  const { makeWebSdkLoader } = await import(pathToFileURL(path.join(__dirname, '_web-sdk-loader.mjs')).href);
  const NS = new URL(db.app.options.databaseURL).hostname.split('.')[0];
  const loaders = ['xpizza-dispatch', 'xpizza-dispatch-mobile'].map((site) => makeWebSdkLoader({ project: process.env.GCLOUD_PROJECT, site, uid: DISP, ns: NS }));
  try {
    const [XD, XM] = [await loaders[0].load(), await loaders[1].load()];
    const board = (X) => new Promise((resolve) => { const off = X.subscribeToTasks((t) => { off(); resolve(t); }); });
    await seed();
    r = await call({ body: body({ opId: 'op-b' }) }); assert.strictEqual(r.json.ok, true);
    for (const X of [XD, XM]) {
      const t = await board(X);
      for (const leg of ['O1_pickup', 'O1_delivery']) {
        assert.strictEqual(t[leg].status, 'pending'); assert.strictEqual(t[leg].assigned_driver_id ?? null, null); assert.strictEqual(t[leg].assignment_deadline ?? null, null);
      }
    }
    // a later manual assignment succeeds (the real client batch) and sweepDecision sees the released order as eligible
    const { sweepDecision } = require('../sweep-pending');
    assert.deepStrictEqual(sweepDecision(await v('orders/O1'), await v('tasks'), 10 ** 13), { sweep: true }, 'released → eligible for the sweeper');
    await XD.assignOrderToDriver('O1', B);
    assert.strictEqual((await v('tasks/O1_pickup')).assigned_driver_id, B); assert.strictEqual((await v('tasks/O1_delivery')).assigned_driver_id, B);
    // reassigned: the real reassignOrder moves A's order to B first → a stale unassign is a zero-write no-op
    await seed();
    const rr2 = await XD.reassignOrder('O1', B, A); assert.deepStrictEqual(rr2, { ok: true });
    const pre = await snapAll();
    r = await call({ body: body({ opId: 'op-ra' }) });
    assert.deepStrictEqual([r.status, r.json], [200, { ok: false, reason: 'reassigned' }]);
    assert.strictEqual(await snapAll(), pre, 'zero writes');
    // rules ARE enforced on these clients: the same real reassignOrder from a NON-dispatcher is denied
    const LN = makeWebSdkLoader({ project: process.env.GCLOUD_PROJECT, site: 'xpizza-dispatch', uid: 'u_nobody_000000000000', ns: NS }); loaders.push(LN);
    const XN = await LN.load();
    await seed(); const preN = await snapAll();
    let denied = false;
    try { const rn = await XN.reassignOrder('O1', B, A); denied = rn && rn.ok === false; } catch (e) { denied = /permission|denied/i.test(String(e && e.message)); }
    assert.ok(denied, 'a non-dispatcher client is denied by the production rules');
    assert.strictEqual(await snapAll(), preN, 'and writes nothing');
  } finally { for (const L of loaders) L.cleanup(); }
  ok('real dispatch SDKs (desktop + mobile) under production rules: both boards see the released legs; a later manual assignment lands; sweepDecision eligible; after the real reassignOrder → reassigned, zero writes; a non-dispatcher client is DENIED (rules live)');

  // the pointer transaction RE-RUNS on a racing pointer change and aborts if the pointer now names another order (deterministic:
  // the transaction is issued OFFLINE against the cached O1 pointer; a second connection re-points the driver; reconnect → re-run)
  await seed();
  const app1 = admin.initializeApp({ databaseURL: db.app.options.databaseURL, projectId: process.env.GCLOUD_PROJECT }, 'unassign-race');
  try {
    const db1 = app1.database();
    const seen = [];
    const off = db1.ref(`drivers/${A}`).on('value', () => {});
    await db1.ref(`drivers/${A}`).once('value');
    db1.goOffline();
    const up = core.driverReleaseUpdater('O1');
    const tx = db1.ref(`drivers/${A}`).transaction((cur) => { seen.push(cur && cur.current_task_id); return up(cur); });
    await db.ref(`drivers/${A}/current_task_id`).set('OTHER_pickup');
    db1.goOnline();
    const res = await tx;
    db1.ref(`drivers/${A}`).off('value', off);
    assert.strictEqual(seen[0], 'O1_pickup', `first run on the cached pointer (${seen})`);
    assert.ok(seen.includes('OTHER_pickup'), `re-run with the racing pointer (${seen})`);
    assert.strictEqual(res.committed, false, 'aborted');
    assert.strictEqual((await v(`drivers/${A}`)).current_task_id, 'OTHER_pickup', 'the racing pointer is untouched');
  } finally { await app1.delete(); }
  ok('race: a pointer change racing the U1-b transaction → the transaction re-runs on the new value and aborts (the other order\'s pointer stands)');

  // the pointer transaction forced to throw on the already-released branch → still not_assigned, reason logged
  await seed({ pickupStatus: 'pending', pOwner: null, dOwner: null });
  const thrLogs = [];
  const throwingDb = { ref: (p) => (p.startsWith('drivers/') ? { transaction: async () => { throw new Error('tx boom'); } } : db.ref(p)) };
  const rt = await core.runUnassign({ db: throwingDb, now: () => 1, log: (m) => thrLogs.push(m), release: releaseToSinAsignar },
    { orderId: 'O1', expectedFromDriver: A, opId: 'op-t', actor: 'x', uid: null, byKind: 'recon_secret' });
  assert.deepStrictEqual(rt, { status: 200, body: { ok: false, reason: 'not_assigned' } });
  assert.ok(thrLogs.some((m) => /pointer repair failed O1 u_drvA: tx boom/.test(m)), `logged (${thrLogs})`);
  ok('already-released branch: a throwing pointer transaction still returns not_assigned and logs the reason');

  // E-U4 (documented accepted residual): release → re-assigned to the SAME A → A accepts → THEN step 3b → A's pointer cleared; A still owns both
  await seed();
  const re = await core.runUnassign({ db, now: () => 1, log: () => {}, release: async (dbx, oid, drv) => {
    const okr = await releaseToSinAsignar(dbx, oid, drv);
    await dbx.ref().update({ [`tasks/${oid}_pickup/assigned_driver_id`]: A, [`tasks/${oid}_pickup/status`]: 'accepted', [`tasks/${oid}_delivery/assigned_driver_id`]: A, [`tasks/${oid}_delivery/status`]: 'accepted', [`drivers/${A}/current_task_id`]: `${oid}_pickup`, [`drivers/${A}/status`]: 'assigned' });
    return okr;
  } }, { orderId: 'O1', expectedFromDriver: A, opId: 'op-u4', actor: 'x', uid: null, byKind: 'recon_secret' });
  assert.deepStrictEqual(re, { status: 200, body: { ok: true } });
  assert.strictEqual((await v(`drivers/${A}`)).current_task_id ?? null, null, 'E-U4: A\'s pointer is cleared (the accepted residual)');
  assert.strictEqual((await v('tasks/O1_pickup')).assigned_driver_id, A); assert.strictEqual((await v('tasks/O1_delivery')).assigned_driver_id, A);
  ok('E-U4 documented behaviour: a same-driver re-assign + accept between release and step 3b → A\'s pointer cleared, A still owns both legs');

  // retry: the same opId after success → not_assigned, no second release, audit unchanged
  await seed();
  r = await call({ body: body({ opId: 'op-rt' }) }); assert.strictEqual(r.json.ok, true);
  const a1 = await v('order_events/O1/unassign_op-rt');
  let rel2 = 0;
  const r2 = await core.runUnassign({ db, now: () => 2, log: () => {}, release: async (...x) => { rel2 += 1; return releaseToSinAsignar(...x); } },
    { orderId: 'O1', expectedFromDriver: A, opId: 'op-rt', actor: 'x', uid: null, byKind: 'recon_secret' });
  assert.deepStrictEqual(r2, { status: 200, body: { ok: false, reason: 'not_assigned' } });
  assert.strictEqual(rel2, 0, 'no second release'); assert.deepStrictEqual(await v('order_events/O1/unassign_op-rt'), a1, 'audit unchanged');
  ok('retry of the same opId → not_assigned, no second release, audit unchanged');

  // auth refactor: the wrapper returns byte-identical results to the BASE authorizeDispatcherAction for every credential class
  const { execFileSync } = require('child_process');
  const BASE_SRC = execFileSync('git', ['show', '9947464c:xpizza-functions/index.js'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 << 20 });
  const { getDatabase: gd } = require('firebase-admin/database');
  const authDeps = ['getAuth', 'getDatabase', 'constantTimeEqual', 'process'];
  const mk = (src, names, ret) => new Function(...authDeps, 'require', `${names.map((nm) => liftFn(src, nm)).join('\n')}; return ${ret};`);
  const ctEq = new Function('require', `${liftFn(INDEX_SRC, 'constantTimeEqual')}; return constantTimeEqual;`)(require);
  const baseFn = mk(BASE_SRC, ['authorizeDispatcherAction'], 'authorizeDispatcherAction')(getAuth, gd, ctEq, process, require);
  const newFn = mk(INDEX_SRC, ['authorizeDispatcherActionWithUid', 'authorizeDispatcherAction'], 'authorizeDispatcherAction')(getAuth, gd, ctEq, process, require);
  const reqOf = (h) => ({ get: (k) => (k.toLowerCase() === 'authorization' ? h : undefined) });
  const authStub = getAuth();
  const prevVerify = Object.getPrototypeOf(authStub).verifyIdToken;
  Object.getPrototypeOf(authStub).verifyIdToken = async (t) => {
    if (t === 'tok-disp') return { uid: DISP, email: 'd@example.test' };
    if (t === 'tok-disp-noemail') return { uid: DISP };
    if (t === 'tok-nondispatcher') return { uid: 'u_not_disp' };
    throw new Error('bad');
  };
  await seed();
  for (const h of ['', 'Bearer ', 'Basic x', 'Bearer garbage', 'Bearer tok-nondispatcher', 'Bearer tok-disp', 'Bearer tok-disp-noemail', `Bearer ${process.env.RECON_SECRET}`, `Bearer ${process.env.RECON_SECRET}x`]) {
    const [b, c] = [await baseFn(reqOf(h)), await newFn(reqOf(h))];
    assert.strictEqual(JSON.stringify(c), JSON.stringify(b), `auth equivalence for ${JSON.stringify(h)}`);
  }
  const saved = process.env.RECON_SECRET; delete process.env.RECON_SECRET;
  try { assert.strictEqual(JSON.stringify(await newFn(reqOf('Bearer unassign-recon'))), JSON.stringify(await baseFn(reqOf('Bearer unassign-recon'))), 'secret unset'); }
  finally { process.env.RECON_SECRET = saved; }
  Object.getPrototypeOf(authStub).verifyIdToken = prevVerify;
  ok('auth refactor: authorizeDispatcherAction returns byte-identical results to the base for missing / malformed / bad / non-dispatcher / dispatcher (± email) / RECON_SECRET (± unset)');

  // HTTP + auth
  r = await call({ method: 'GET' }); assert.strictEqual(r.status, 405);
  r = await call({ bearer: null, body: body() }); assert.strictEqual(r.status, 401);
  r = await call({ bearer: 'garbage', body: body() }); assert.strictEqual(r.status, 401);
  r = await call({ bearer: 'tok-nondispatcher', body: body() }); assert.strictEqual(r.status, 403);
  r = await call({ method: 'OPTIONS', bearer: null, headers: { Origin: 'https://dispatch.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.ok(r.status === 204 || r.status === 200, `CORS preflight allowed (${r.status})`);
  ok('HTTP: 405 GET, 401 missing/garbage bearer, 403 non-dispatcher, CORS preflight allowed');

  clearTimeout(watchdog);
  console.log(`unassign: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('unassign: FAIL\n', e); process.exit(1); });
