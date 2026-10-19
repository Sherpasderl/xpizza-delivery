/**
 * F2 driver-feed CONTROLLER against the REAL SDK (codex F2b r1). Wires the pure makeDriverFeed controller to a
 * real @firebase/rules-unit-testing database handle under the NARROWED N-human rules and drives the behaviours
 * the node fake-harness can only ASSUME — real Firebase event semantics:
 *   A — a FRESH onValue attach emits the current value even when data is UNCHANGED (the mechanism the reconnect
 *       fix relies on; a flag-reset-and-wait fix would hang because unchanged subscriptions don't re-emit).
 *   B — once('value') on an order POINT path with NO active listener does a SERVER read (not the empty
 *       history-query cache) + the attribution check — the BC1 reconcile primitive.
 *   C — the controller through the real env: happy path READY, then a real revocation (both legs reassigned away)
 *       cancels the per-order listener with PERMISSION_DENIED → the order AND its task legs leave immediately.
 *   D — a real reconnect (goOffline→goOnline, data unchanged) → the controller re-attaches → readiness recovers.
 * The full lifecycle logic (handoff retry/supersession, source-error fail-closed, uid transition, startup) is
 * proven deterministically in ../../xpizza-driver/driver-feed.test.js, whose fake now faithfully models these
 * same SDK semantics.  run: npm run test:f2-driver-feed-lifecycle
 */
require('./_emulator-required')('database');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');

const REF = path.join(__dirname, '..', '..', 'xpizza-reference');
const RULES = fs.readFileSync(path.join(REF, 'f2-narrow', 'N-human.rules.json'), 'utf8');   // broad-grants-ABSENT
const UID = 'u-d1';
const isPermissionDenied = (e) => /permission.?denied/i.test(String((e && (e.code || e.message)) || ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE = (s) => ['pending_payment', 'scheduled', 'releasing'].includes(s) ? false : true;

// The live env, built from a compat db — mirrors xpizza-delivery.js createLiveDriverFeed on the node SDK.
function makeEnv(db, uid, emit) {
  return {
    emit,
    filterLiveOrders(m) { const o = {}; for (const k in (m || {})) { const v = m[k]; if (v && !LIVE(v.status)) continue; o[k] = v; } return o; },
    subscribeOwnTasks(cb, onError) { const q = db.ref('tasks').orderByChild('assigned_driver_id').equalTo(uid); const h = q.on('value', (s) => cb(s.val() || {}), (e) => onError && onError(e)); return () => q.off('value', h); },
    subscribeOrder(oid, cb, onRevoked, onError) { const r = db.ref('orders/' + oid); const h = r.on('value', (s) => cb(s.val()), (e) => { if (isPermissionDenied(e)) onRevoked(); else onError && onError(e); }); return () => r.off('value', h); },
    subscribeHistory(which, cb, onError) { const field = which === 'primary' ? 'delivered_by_driver_uid' : 'delivered_by_uid'; const q = db.ref('orders').orderByChild(field).equalTo(uid); const h = q.on('value', (s) => cb(s.val() || {}), (e) => onError && onError(e)); return () => q.off('value', h); },
    reconcileOrderOnce(oid) { return db.ref('orders/' + oid).once('value').then((s) => { const v = s.val(); return { value: v, keep: !!(v && (v.delivered_by_driver_uid === uid || v.delivered_by_uid === uid)) }; }); },
    subscribeOwnDriver(cb, onError) { const r = db.ref('drivers/' + uid); const h = r.on('value', (s) => cb(s.val()), (e) => onError && onError(e)); return () => r.off('value', h); },
    onReconnect(cb) { let was = null; const r = db.ref('.info/connected'); const h = r.on('value', (s) => { const c = s.val() === true; if (was === false && c) cb(); was = c; }); return () => r.off('value', h); },
  };
}

(async () => {
  const fails = [];
  const { makeDriverFeed } = await import('../../xpizza-driver/driver-feed.js');
  const testEnv = await initializeTestEnvironment({ projectId: 'demo-f2-feed', database: { rules: RULES } });
  const admin = (u) => testEnv.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(u));
  const wipe = () => testEnv.withSecurityRulesDisabled((ctx) => ctx.database().ref().set(null));
  const ck = (c, m) => { if (!c) fails.push(m); };

  const SEED = () => ({
    'tasks/O1_pickup': { order_id: 'O1', type: 'pickup', assigned_driver_id: UID, status: 'accepted' },
    'tasks/O1_delivery': { order_id: 'O1', type: 'delivery', assigned_driver_id: UID, status: 'accepted' },
    'orders/O1': { order_id: 'O1', status: 'out_for_delivery', total: 300, payment_method: 'cash' },
    'orders/O2': { order_id: 'O2', status: 'delivered', total: 150, payment_method: 'cash', delivered_by_driver_uid: UID },
    'drivers/u-d1': { active: true, status: 'available' },
  });

  // ── A: a fresh onValue attach emits the current value even when UNCHANGED ──
  {
    await wipe(); await admin(SEED());
    const db = testEnv.authenticatedContext(UID).database();
    let a = 0, b = 0;
    const r = db.ref('orders/O1');
    await new Promise((res) => { const h = r.on('value', (s) => { if (s.val()) { a++; r.off('value', h); res(); } }); });
    ck(a === 1, `A: first attach did not emit (${a})`);
    await new Promise((res) => { const h = r.on('value', (s) => { if (s.val()) { b++; r.off('value', h); res(); } }); });   // re-attach, data UNCHANGED
    ck(b === 1, `A: re-attach of an unchanged subscription did not emit a fresh value (${b})`);
  }

  // ── B: once() on a point path with no active listener → server read + attribution ──
  {
    const db = testEnv.authenticatedContext(UID).database();
    const s = await db.ref('orders/O2').once('value');
    const v = s.val();
    ck(!!v && v.delivered_by_driver_uid === UID, `B: server read of a delivered+attributed order failed (${JSON.stringify(v)})`);
  }

  // ── C: controller through the real env — READY, then revocation tears the order + its tasks down ──
  {
    await wipe(); await admin(SEED());
    const db = testEnv.authenticatedContext(UID).database();
    const out = { orders: {}, tasks: {}, readiness: null };
    const emit = { onOrders: (o) => { out.orders = o; }, onTasks: (t) => { out.tasks = t; }, onReadiness: (r) => { out.readiness = r; }, onDriver: () => {} };
    const feed = makeDriverFeed(makeEnv(db, UID, emit));
    feed.start();
    await sleep(800);
    ck(feed.readiness() === 'ready', `C: not ready after start (${feed.readiness()})`);
    ck(!!out.orders.O1, 'C: O1 not published');
    ck(!!feed.getOwnTasks().O1_pickup, 'C: O1 task legs not published');
    // reassign both legs away → the per-order listener is cancelled PERMISSION_DENIED + the task query drops them
    await admin({ 'tasks/O1_pickup/assigned_driver_id': 'u-d2', 'tasks/O1_delivery/assigned_driver_id': 'u-d2' });
    await sleep(1200);
    ck(feed.getOrders().O1 === undefined, `C: revoked O1 still in allOrders (${JSON.stringify(feed.getOrders().O1)})`);
    ck(feed.getOwnTasks().O1_pickup === undefined, 'C: revoked O1 task legs still published (stale card)');
    feed.dispose();
  }

  // ── D: a real reconnect (goOffline→goOnline, data unchanged) → the controller re-attaches → readiness recovers ──
  {
    await wipe(); await admin(SEED());
    const db = testEnv.authenticatedContext(UID).database();
    const emit = { onOrders: () => {}, onTasks: () => {}, onReadiness: () => {}, onDriver: () => {} };
    const feed = makeDriverFeed(makeEnv(db, UID, emit));
    feed.start();
    await sleep(800);
    ck(feed.readiness() === 'ready', `D: not ready before reconnect (${feed.readiness()})`);
    db.goOffline();
    await sleep(400);
    db.goOnline();                           // NO data changes across the reconnect
    await sleep(1500);
    ck(feed.readiness() === 'ready', `D: readiness did not recover after reconnect — controller did not re-attach (${feed.readiness()})`);
    ck(!!feed.getOrders().O1, 'D: O1 lost after reconnect');
    feed.dispose();
  }

  await testEnv.cleanup();
  if (fails.length) { console.error('f2-driver-feed-lifecycle FAILURES:\n' + fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
  console.log('f2-driver-feed-lifecycle(emulator): OK (A fresh-attach, B server-reconcile, C revocation teardown, D reconnect recovery)');
})().catch((e) => { console.error(e); process.exit(1); });
