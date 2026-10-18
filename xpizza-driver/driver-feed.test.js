// Pure driver-feed controller tests — run: `node driver-feed.test.js` (no framework, repo idiom).
// Exercises the REAL makeDriverFeed controller; fakes exist ONLY at the injected Firebase boundary (the env
// primitives). Covers the F2 plan §10 + the explicitly-required cases (i)-(iv): membership/value authority
// (BC2), ongoing readiness, reconnect (BC3), revocation vs read-error, session teardown, BC1 handoff.
import assert from 'node:assert/strict';
import { makeDriverFeed, READY, LOADING } from './driver-feed.js';

let passed = 0;
async function t(name, fn) { try { await fn(); } catch (e) { console.error(`✗ ${name}`); throw e; } passed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { await tick(); await tick(); };   // drain the BC1 Promise.resolve().then(getHistoryOnce) chain

// Faithful STATUS-ONLY live filter (mirrors xpizza-delivery.js NON_LIVE_ORDER_STATUSES; NO restaurant filter).
const NON_LIVE = new Set(['pending_payment', 'scheduled', 'releasing']);
function filterLiveOrders(m) { const out = {}; for (const id in (m || {})) { const o = m[id]; if (o && NON_LIVE.has(o.status)) continue; out[id] = o; } return out; }

function harness() {
  const H = {
    taskCb: null, orders: new Map(), hist: { primary: null, legacy: null },
    reconnectCb: null, driverCb: null, historyOnce: { primary: {}, legacy: {} },
    attachCount: new Map(), out: { orders: null, tasks: null, readiness: [], driver: [] },
  };
  H.env = {
    filterLiveOrders,
    subscribeOwnTasks(cb) { H.taskCb = cb; return () => { H.taskCb = null; }; },
    subscribeOrder(oid, cb, onRevoked) {
      H.attachCount.set(oid, (H.attachCount.get(oid) || 0) + 1);
      H.orders.set(oid, { cb, onRevoked });
      return () => { H.orders.delete(oid); };
    },
    subscribeHistory(which, cb, onError) { H.hist[which] = { cb, onError }; return () => { H.hist[which] = null; }; },
    getHistoryOnce() { return Promise.resolve(H.historyOnce); },
    onReconnect(cb) { H.reconnectCb = cb; return () => { H.reconnectCb = null; }; },
    subscribeOwnDriver(cb) { H.driverCb = cb; return () => { H.driverCb = null; }; },
    emit: {
      onOrders(o) { H.out.orders = o; }, onTasks(tk) { H.out.tasks = tk; },
      onReadiness(r) { H.out.readiness.push(r); }, onDriver(d) { H.out.driver.push(d); },
    },
  };
  H.taskSnap = (m) => H.taskCb && H.taskCb(m);
  H.orderSnap = (oid, v) => { const r = H.orders.get(oid); if (r) r.cb(v); };
  H.revoke = (oid) => { const r = H.orders.get(oid); if (r) r.onRevoked(); };
  H.histSnap = (which, m) => { const r = H.hist[which]; if (r) r.cb(m); };
  H.histErr = (which) => { const r = H.hist[which]; if (r) r.onError(); };
  H.reconnect = () => H.reconnectCb && H.reconnectCb();
  H.driverSnap = (d) => H.driverCb && H.driverCb(d);
  return H;
}

const pickup = (oid, drv = 'me') => ({ order_id: oid, type: 'pickup', assigned_driver_id: drv, status: 'accepted' });
const delivery = (oid, drv = 'me') => ({ order_id: oid, type: 'delivery', assigned_driver_id: drv, status: 'accepted' });
const tasksFor = (...oids) => { const m = {}; for (const oid of oids) { m[`${oid}_pickup`] = pickup(oid); m[`${oid}_delivery`] = delivery(oid); } return m; };
const ord = (extra = {}) => ({ status: 'out_for_delivery', total: 100, ...extra });

function bringReady(H, oids, histP = {}, histL = {}) {
  H.taskSnap(tasksFor(...oids));
  for (const oid of oids) H.orderSnap(oid, ord({ tag: `${oid}-v1` }));
  H.histSnap('primary', histP);
  H.histSnap('legacy', histL);
}

const SUITE_DEADLINE = setTimeout(() => { console.error('✗ driver-feed suite hung'); process.exit(1); }, 5000);

(async () => {
  // ---- 1. initial loading → ready; allOrders carries the point value ----
  await t('loading until tasks + both histories + every order listener emit; then ready', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    assert.equal(feed.readiness(), LOADING);
    H.taskSnap(tasksFor('O1'));
    assert.equal(feed.readiness(), LOADING, 'order listener not emitted yet');
    H.orderSnap('O1', ord({ tag: 'p' }));
    assert.equal(feed.readiness(), LOADING, 'histories not emitted yet');
    H.histSnap('primary', {}); assert.equal(feed.readiness(), LOADING);
    H.histSnap('legacy', {});
    assert.equal(feed.readiness(), READY);
    assert.deepEqual(Object.keys(feed.getOrders()), ['O1']);
    assert.equal(feed.getOrders().O1.tag, 'p');
  });

  // ---- 2. BC2 value authority: point listener's latest wins over a (stale) legacy history child ----
  await t('BC2: newer point value then a stale-legacy emission → published value stays the point value', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    H.orderSnap('O1', ord({ tag: 'point-v2' }));                 // fresh point value
    H.histSnap('legacy', { O1: ord({ tag: 'stale-legacy' }) }); // a later legacy-query emission for the SAME node
    assert.equal(feed.getOrders().O1.tag, 'point-v2', 'point authority holds over the legacy child');
  });

  // ---- presence invariant: a non-live status is filtered out even with membership ----
  await t('presence invariant: a pending_payment value is never published despite membership', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    H.taskSnap(tasksFor('O1')); H.histSnap('primary', {}); H.histSnap('legacy', {});
    H.orderSnap('O1', ord({ status: 'pending_payment' }));
    assert.deepEqual(Object.keys(feed.getOrders()), []);
    assert.equal(feed.readiness(), READY, 'its listener emitted — readiness is not held by a filtered order');
  });

  // ---- 3. assignment add & remove ----
  await t('assignment add attaches a listener (loading until it emits); removal with live history detaches, no handoff', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    // add O2
    H.taskSnap(tasksFor('O1', 'O2'));
    assert.equal(feed.readiness(), LOADING, 'new O2 listener has not emitted');
    H.orderSnap('O2', ord({ tag: 'o2' }));
    assert.equal(feed.readiness(), READY);
    assert.deepEqual(Object.keys(feed.getOrders()).sort(), ['O1', 'O2']);
    // O2 now also lives in history; remove its task → detach, stays via history, NO handoff
    H.histSnap('primary', { O2: ord({ tag: 'o2-hist' }) });
    H.taskSnap(tasksFor('O1'));
    assert.equal(feed.hasPendingHandoff(), false, 'history present → no BC1 handoff');
    assert.ok(feed.getOrders().O2, 'O2 stays via history membership');
    assert.equal(H.orders.has('O2'), false, 'O2 point listener detached');
  });

  // ---- 4. BC1 handoff: delivery then task deletion; one fresh reconcile keeps it; cash never undercounts ----
  await t('BC1: last-membership task removal → pending handoff; reconcile finds it → kept via history', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    H.orderSnap('O1', ord({ tag: 'delivered', status: 'delivered' }));
    H.historyOnce = { primary: { O1: ord({ tag: 'delivered-hist', status: 'delivered' }) }, legacy: {} };
    H.taskSnap({});                         // both legs deleted on delivery; no live history yet
    assert.equal(feed.hasPendingHandoff(), true, 'finalization blocked until the reconcile resolves');
    await flush();
    assert.equal(feed.hasPendingHandoff(), false);
    assert.ok(feed.getOrders().O1, 'kept via the fresh reconcile → cuadre cannot undercount');
  });
  await t('BC1: reconcile finds NEITHER → the order is genuinely removed', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    H.historyOnce = { primary: {}, legacy: {} };
    H.taskSnap({});
    assert.equal(feed.hasPendingHandoff(), true);
    await flush();
    assert.equal(feed.hasPendingHandoff(), false);
    assert.equal(feed.getOrders().O1, undefined, 'removed — no source references it');
  });

  // ---- 5. reconnect (BC3): readiness→loading until all re-emit; no duplicate listeners ----
  await t('BC3 reconnect: readiness drops to loading, re-emits restore ready, no duplicate listeners', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    assert.equal(feed.readiness(), READY);
    H.reconnect();
    assert.equal(feed.readiness(), LOADING, 'reconnect resets readiness');
    assert.equal(H.attachCount.get('O1'), 1, 'no duplicate order listener added on reconnect');
    // re-emit everything post-reconnect
    H.taskSnap(tasksFor('O1')); H.orderSnap('O1', ord()); H.histSnap('primary', {}); H.histSnap('legacy', {});
    assert.equal(feed.readiness(), READY);
    assert.equal(H.attachCount.get('O1'), 1);
  });

  // ---- 6. revocation vs read-error (§10 iii) ----
  await t('revocation: per-order PERMISSION_DENIED removes the oid, readiness NOT held; other orders keep updating', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1', 'O2']);
    assert.equal(feed.readiness(), READY);
    H.revoke('O1');
    assert.equal(feed.getOrders().O1, undefined, 'revoked order removed');
    assert.ok(feed.getOrders().O2, 'the still-granted order remains');
    assert.equal(feed.readiness(), READY, 'revocation does not hold readiness');
    // a stale task snapshot still listing O1 must NOT re-attach a listener (no retry loop)
    H.taskSnap(tasksFor('O1', 'O2'));
    assert.equal(H.attachCount.get('O1'), 1, 'revoked oid not re-attached while still task-referenced');
    // once the task feed drops O1, a genuinely-new future assignment may re-attach
    H.taskSnap(tasksFor('O2'));
    H.taskSnap(tasksFor('O1', 'O2'));
    assert.equal(H.attachCount.get('O1'), 2, 'cleared from the revoked set after the task feed dropped it');
  });
  await t('read-error: a history source cancel holds readiness loading (distinct from revocation); re-emit restores', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    assert.equal(feed.readiness(), READY);
    H.histErr('primary');
    assert.equal(feed.readiness(), LOADING, 'source-level error holds loading, no stale publish');
    H.histSnap('primary', {});
    assert.equal(feed.readiness(), READY);
  });

  // ---- 7. session teardown (logout/login → §10 iv): old-session callbacks rejected; fresh reset ----
  await t('session teardown: a late callback from the disposed session is rejected; restart is fresh loading', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    bringReady(H, ['O1']);
    const staleOrderCb = H.orders.get('O1').cb;
    feed.dispose();
    staleOrderCb(ord({ tag: 'ZOMBIE' }));                 // late callback from the old generation
    assert.equal(Object.keys(feed.getOrders()).length, 0, 'disposed feed holds no orders; zombie rejected');
    feed.start();
    assert.equal(feed.readiness(), LOADING, 'auth change → readiness returns only after the new session emits');
    assert.equal(H.attachCount.get('O1'), 1, 'no listener re-attached until the new session re-subscribes tasks');
  });

  // ---- 8. overlapping-source removal (§10 i) ----
  await t('(i) overlapping sources: an oid supplied by task AND history stays when one source releases it', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    H.taskSnap(tasksFor('O1')); H.orderSnap('O1', ord({ tag: 'point' }));
    H.histSnap('primary', { O1: ord({ tag: 'hist' }) }); H.histSnap('legacy', {});
    assert.ok(feed.getOrders().O1);
    H.taskSnap({});                                        // task source released; history still supplies it
    assert.equal(feed.hasPendingHandoff(), false);
    assert.equal(feed.getOrders().O1.tag, 'hist', 'stays via history; value falls back to the history child');
    H.histSnap('primary', {});                            // last source released
    assert.equal(feed.getOrders().O1, undefined, 'now genuinely gone');
  });

  // ---- 9. delayed history init (§10 ii) ----
  await t('(ii) delayed history: task-present order published via point; readiness loading until histories arrive', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    H.taskSnap(tasksFor('O1')); H.orderSnap('O1', ord({ tag: 'p' }));
    assert.ok(feed.getOrders().O1, 'published from the point listener');
    assert.equal(feed.readiness(), LOADING, 'histories have not initialized — never ready, so cuadre never undercounts');
    H.histSnap('primary', {}); H.histSnap('legacy', {});
    assert.equal(feed.readiness(), READY);
  });

  // ---- own driver record (§8) ----
  await t('own driver record is surfaced and reset on dispose', async () => {
    const H = harness(); const feed = makeDriverFeed(H.env); feed.start();
    H.driverSnap({ active: true, status: 'available' });
    assert.equal(feed.getDriver().status, 'available');
    assert.equal(H.out.driver.at(-1).active, true);
    feed.dispose();
    assert.equal(feed.getDriver(), null);
  });

  clearTimeout(SUITE_DEADLINE);
  console.log(`✓ driver-feed: ${passed} passed`);
})().catch((e) => { clearTimeout(SUITE_DEADLINE); console.error(e); process.exit(1); });
