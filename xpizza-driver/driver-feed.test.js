// Pure driver-feed controller tests — run: `node driver-feed.test.js` (no framework, repo idiom).
// The fake env is FAITHFUL to real Firebase SDK semantics (codex F2b r1): a listener emits the current value on
// ATTACH and only re-emits on a value CHANGE — it does NOT re-fire an unchanged subscription on reconnect, so a
// fix that merely reset flags and waited would hang here. reconcileOrderOnce is a controllable server read.
import assert from 'node:assert/strict';
import { makeDriverFeed, READY, LOADING } from './driver-feed.js';

let passed = 0;
async function t(name, fn) { try { await fn(); } catch (e) { console.error(`✗ ${name}`); throw e; } passed++; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { await tick(); await tick(); };

const NON_LIVE = new Set(['pending_payment', 'scheduled', 'releasing']);
function filterLiveOrders(m) { const o = {}; for (const id in (m || {})) { const v = m[id]; if (v && NON_LIVE.has(v.status)) continue; o[id] = v; } return o; }

function harness() {
  const H = {
    tasks: undefined, taskL: new Set(),
    orders: new Map(), orderL: new Map(),           // oid -> value ; oid -> Set of {cb,onRevoked,onError}
    hist: { primary: undefined, legacy: undefined }, histL: { primary: new Set(), legacy: new Set() },
    driver: undefined, driverL: new Set(),
    reconnectCbs: new Set(),
    reconcileImpl: null,                            // (oid) => Promise<{value,keep}>
    attachCount: new Map(),
    out: { orders: null, tasks: null, readiness: [], driver: [] },
  };
  const emitTo = (set, ...a) => { for (const l of [...set]) try { l.cb(...a); } catch (_) {} };
  H.env = {
    filterLiveOrders,
    subscribeOwnTasks(cb, onError) { const l = { cb, onError }; H.taskL.add(l); if (H.tasks !== undefined) cb(H.tasks); return () => H.taskL.delete(l); },
    subscribeOrder(oid, cb, onRevoked, onError) {
      H.attachCount.set(oid, (H.attachCount.get(oid) || 0) + 1);
      const l = { cb, onRevoked, onError };
      if (!H.orderL.has(oid)) H.orderL.set(oid, new Set());
      H.orderL.get(oid).add(l);
      if (H.orders.has(oid)) cb(H.orders.get(oid));          // emit current value on ATTACH (faithful)
      return () => { const s = H.orderL.get(oid); if (s) s.delete(l); };
    },
    subscribeHistory(which, cb, onError) { const l = { cb, onError }; H.histL[which].add(l); if (H.hist[which] !== undefined) cb(H.hist[which]); return () => H.histL[which].delete(l); },
    reconcileOrderOnce(oid) { return H.reconcileImpl ? H.reconcileImpl(oid) : Promise.resolve({ value: null, keep: false }); },
    subscribeOwnDriver(cb, onError) { const l = { cb, onError }; H.driverL.add(l); if (H.driver !== undefined) cb(H.driver); return () => H.driverL.delete(l); },
    onReconnect(cb) { const l = { cb }; H.reconnectCbs.add(l); return () => H.reconnectCbs.delete(l); },
    emit: {
      onOrders(o) { H.out.orders = o; }, onTasks(tk) { H.out.tasks = tk; },
      onReadiness(r) { H.out.readiness.push(r); }, onDriver(d) { H.out.driver.push(d); },
    },
  };
  // drivers (set value + emit to current listeners, like a server push)
  H.setTasks = (m) => { H.tasks = m; emitTo(H.taskL, m); };
  H.taskError = () => { for (const l of [...H.taskL]) try { l.onError && l.onError(new Error('permission_denied')); } catch (_) {} };
  H.setOrder = (oid, v) => { H.orders.set(oid, v); const s = H.orderL.get(oid); if (s) for (const l of [...s]) try { l.cb(v); } catch (_) {} };
  // A PERMISSION_DENIED cancel is DEAD at the SDK level — fire onRevoked AND remove the listener (faithful: no
  // further callbacks reach a cancelled subscription), independent of whether the controller unsubscribes.
  H.revoke = (oid) => { const s = H.orderL.get(oid); if (s) for (const l of [...s]) { try { l.onRevoked && l.onRevoked(); } catch (_) {} s.delete(l); } };
  H.orderError = (oid) => { const s = H.orderL.get(oid); if (s) for (const l of [...s]) try { l.onError && l.onError(new Error('disconnected')); } catch (_) {} };
  H.setHist = (which, m) => { H.hist[which] = m; emitTo(H.histL[which], m); };
  H.histError = (which) => { for (const l of [...H.histL[which]]) try { l.onError && l.onError(new Error('x')); } catch (_) {} };
  H.setDriver = (d) => { H.driver = d; emitTo(H.driverL, d); };
  H.driverError = () => { for (const l of [...H.driverL]) try { l.onError && l.onError(new Error('x')); } catch (_) {} };
  H.reconnect = () => { for (const l of [...H.reconnectCbs]) try { l.cb(); } catch (_) {} };
  return H;
}

const pickup = (oid, drv = 'me') => ({ order_id: oid, type: 'pickup', assigned_driver_id: drv, status: 'accepted' });
const delivery = (oid, drv = 'me') => ({ order_id: oid, type: 'delivery', assigned_driver_id: drv, status: 'accepted' });
const tasksFor = (...oids) => { const m = {}; for (const oid of oids) { m[`${oid}_pickup`] = pickup(oid); m[`${oid}_delivery`] = delivery(oid); } return m; };
const ord = (extra = {}) => ({ status: 'out_for_delivery', total: 100, ...extra });

// bring a feed to READY with the given task oids (emits tasks, each order's point value, both empty histories)
function bringReady(H, oids) {
  for (const oid of oids) H.orders.set(oid, ord({ tag: `${oid}` }));   // so the point listener emits on attach
  H.setTasks(tasksFor(...oids));
  H.setHist('primary', {}); H.setHist('legacy', {});
}

const DEADLINE = setTimeout(() => { console.error('✗ driver-feed suite hung'); process.exit(1); }, 5000);

(async () => {
  // ---- core ----
  await t('loading until tasks + both histories + every order listener emit; then ready', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    assert.equal(f.readiness(), LOADING);
    H.orders.set('O1', ord({ tag: 'p' })); H.setTasks(tasksFor('O1'));   // task + its point value on attach
    assert.equal(f.readiness(), LOADING, 'histories not emitted');
    H.setHist('primary', {}); assert.equal(f.readiness(), LOADING);
    H.setHist('legacy', {});
    assert.equal(f.readiness(), READY);
    assert.deepEqual(Object.keys(f.getOrders()), ['O1']);
    assert.equal(f.getOrders().O1.tag, 'p');
  });
  await t('BC2 value authority: point value wins over a stale legacy history child', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setOrder('O1', ord({ tag: 'point-v2' }));
    H.setHist('legacy', { O1: ord({ tag: 'stale-legacy' }) });
    assert.equal(f.getOrders().O1.tag, 'point-v2');
  });
  await t('presence invariant: a pending_payment value is never published', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    H.orders.set('O1', ord({ status: 'pending_payment' })); H.setTasks(tasksFor('O1'));
    H.setHist('primary', {}); H.setHist('legacy', {});
    assert.deepEqual(Object.keys(f.getOrders()), []);
    assert.equal(f.readiness(), READY);
  });

  // ---- #1 reconnect must RE-ATTACH (unchanged subscriptions don't re-emit) ----
  await t('#1 reconnect: re-attaches sources (unchanged data) → readiness recovers, not stuck loading', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    assert.equal(f.readiness(), READY);
    const before = H.attachCount.get('O1');
    H.reconnect();                                   // NO data changes — a flag-reset-and-wait fix would hang here
    assert.equal(f.readiness(), READY, 'reconnect re-attached and the fresh emissions restored readiness');
    assert.equal(H.attachCount.get('O1'), before + 1, 'the order listener was re-attached (fresh emission)');
    assert.ok(f.getOrders().O1, 'order still published after reconnect');
  });

  // ---- #2 server-fresh reconcile (no cached-empty undercount) ----
  await t('#2 BC1 handoff reconciles via a SERVER read: attributed delivered order stays counted', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setOrder('O1', ord({ status: 'delivered', delivered_by_driver_uid: 'me', tag: 'delivered' }));
    let reconciled = null;
    H.reconcileImpl = (oid) => { reconciled = oid; return Promise.resolve({ value: ord({ status: 'delivered', delivered_by_driver_uid: 'me', tag: 'server' }), keep: true }); };
    H.setTasks({});                                   // both legs deleted; NO live history yet
    assert.equal(f.hasPendingHandoff(), true);
    await flush();
    assert.equal(reconciled, 'O1', 'did a per-oid server reconcile');
    assert.equal(f.hasPendingHandoff(), false);
    assert.ok(f.getOrders().O1, 'kept via the server-fresh reconcile — no undercount');
    assert.equal(f.getOrders().O1.tag, 'server');
  });
  await t('#2b reconcile says not-mine → removed', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.reconcileImpl = () => Promise.resolve({ value: ord({ status: 'delivered', delivered_by_driver_uid: 'other' }), keep: false });
    H.setTasks({}); await flush();
    assert.equal(f.getOrders().O1, undefined);
    assert.equal(f.hasPendingHandoff(), false);
  });

  // ---- #3 rejected handoff recovers ----
  await t('#3 rejected handoff stays pending (fail closed) and RECOVERS on retry', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setOrder('O1', ord({ status: 'delivered', delivered_by_driver_uid: 'me' }));
    let calls = 0;
    H.reconcileImpl = () => { calls++; return calls === 1 ? Promise.reject(new Error('net')) : Promise.resolve({ value: ord({ status: 'delivered', delivered_by_driver_uid: 'me', tag: 'retry' }), keep: true }); };
    H.setTasks({}); await flush();
    assert.equal(f.hasPendingHandoff(), true, 'reject keeps it pending (finalize blocked)');
    assert.ok(f.getOrders().O1, 'still published (fail closed)');
    H.reconnect(); await flush();                     // retry on reconnect
    assert.equal(calls, 2, 'retried');
    assert.equal(f.hasPendingHandoff(), false, 'recovered');
    assert.ok(f.getOrders().O1);
  });

  // ---- #4 late result cannot resurrect a removed order ----
  await t('#4 a live history removal supersedes a pending reconcile — stale result does not resurrect', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    let resolveRec;
    H.reconcileImpl = () => new Promise((r) => { resolveRec = () => r({ value: ord({ tag: 'STALE' }), keep: true }); });
    H.setTasks({});                                   // handoff begins (reconcile pending)
    assert.equal(f.hasPendingHandoff(), true);
    await tick();                                      // let the reconcile microtask start (resolveRec is now set)
    assert.ok(resolveRec, 'reconcile started');
    H.setHist('primary', { O1: ord({ tag: 'hist' }) });  // live history adds it → supersedes the handoff
    assert.equal(f.hasPendingHandoff(), false);
    H.setHist('primary', {});                          // then history removes it
    assert.equal(f.getOrders().O1, undefined, 'gone');
    resolveRec(); await flush();                       // the STALE reconcile resolves last
    assert.equal(f.getOrders().O1, undefined, 'NOT resurrected by the stale reconcile');
  });

  // ---- #5 revocation removes everything published ----
  await t('#5 revocation removes the order AND its task legs (no stale card), readiness not held', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1', 'O2']);
    assert.equal(f.readiness(), READY);
    H.revoke('O1');
    assert.equal(f.getOrders().O1, undefined, 'revoked order removed from allOrders');
    assert.equal(f.getOwnTasks().O1_pickup, undefined, 'revoked order task legs removed from published ownTasks');
    assert.equal(f.getOwnTasks().O1_delivery, undefined);
    assert.ok(f.getOwnTasks().O2_pickup, 'the other order keeps its legs');
    assert.ok(f.getOrders().O2);
    assert.equal(f.readiness(), READY, 'revocation does not hold readiness');
  });
  await t('#5b revocation also drops a history-membership contribution for the oid', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    H.orders.set('O1', ord()); H.setTasks(tasksFor('O1'));
    H.setHist('primary', { O1: ord({ tag: 'hist' }) }); H.setHist('legacy', {});
    assert.ok(f.getOrders().O1);
    H.revoke('O1');
    assert.equal(f.getOrders().O1, undefined, 'not kept alive by history after revocation');
  });

  // ---- #6 source errors fail closed ----
  await t('#6 task-query error → readiness loading, task-only order dropped, history order survives', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setHist('primary', { O9: ord({ tag: 'h' }) });   // O9 lives only in history
    assert.equal(f.readiness(), READY);
    H.taskError();
    assert.equal(f.readiness(), LOADING, 'fail closed');
    assert.equal(f.getOrders().O1, undefined, 'task-only order dropped');
    assert.ok(f.getOrders().O9, 'history order survives');
    H.setTasks(tasksFor('O1')); H.setOrder('O1', ord());   // recovery
    assert.equal(f.readiness(), READY);
  });
  await t('#6b history error → readiness loading and that history map cleared', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setHist('legacy', { O8: ord() });
    assert.ok(f.getOrders().O8);
    H.histError('legacy');
    assert.equal(f.readiness(), LOADING);
    assert.equal(f.getOrders().O8, undefined, 'stale legacy contribution dropped');
  });
  await t('#6c point error (non-permission) → readiness loading, recovers on reconnect re-attach', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.orderError('O1');
    assert.equal(f.readiness(), LOADING);
    H.reconnect();                                     // re-attach → fresh emit clears errored
    assert.equal(f.readiness(), READY);
  });
  await t('#6d own-driver error → onDriver(null)', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    H.setDriver({ active: true });
    assert.ok(f.getDriver());
    H.driverError();
    assert.equal(f.getDriver(), null);
    assert.equal(H.out.driver.at(-1), null);
  });

  // ---- #7 uid transition: dispose clears everything; restart is fresh loading ----
  await t('#7 dispose clears all state; a late old-session callback is rejected; restart is loading', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    f.dispose();
    assert.equal(Object.keys(f.getOrders()).length, 0);
    assert.equal(f.getDriver(), null);
    // new user (uid change): fresh server state, nothing emitted yet
    H.tasks = undefined; H.hist = { primary: undefined, legacy: undefined }; H.orders.clear(); H.driver = undefined;
    f.start();
    assert.equal(f.readiness(), LOADING, 'new session loading until the new user emits');
    assert.equal(f.getOrders().O1, undefined, 'no old-session order leaked');
    H.setTasks({}); H.setHist('primary', {}); H.setHist('legacy', {});
    assert.equal(f.readiness(), READY, 'ready once the new user source set emits');
  });

  // ---- r2: session-generation guard (codex r2: removing every gen guard previously SURVIVED). The TASK
  // callback has no rec-identity check, so only isLive(gen) protects it — fire a stale gen-1 task callback into
  // a live gen-2 session and assert it cannot pollute it. ----
  await t('r2 gen-guard: a stale DISPOSED-session task callback cannot pollute the next session', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    const genOneTaskCb = [...H.taskL][0].cb;   // the controller's gen-1 task wrapper
    bringReady(H, ['O1']);
    f.dispose();
    H.orders.clear(); H.tasks = undefined; H.hist = { primary: undefined, legacy: undefined };
    f.start();                                  // gen 2
    H.setTasks(tasksFor('O2')); H.setOrder('O2', ord()); H.setHist('primary', {}); H.setHist('legacy', {});
    assert.equal(f.readiness(), READY);
    genOneTaskCb(tasksFor('O1'));               // STALE gen-1 task callback — must be rejected by isLive(gen)
    assert.equal(H.out.tasks && H.out.tasks.O1_pickup, undefined, 'stale gen-1 tasks must not enter session 2');
    assert.equal(f.getOrders().O1, undefined, 'and no gen-1 order leaks in');
    assert.deepEqual(Object.keys(f.getOrders()), ['O2'], 'session 2 unchanged');
  });

  // ---- r2#1: an OLDER reconcile must not consume a NEWER handoff of the same oid (per-attempt epoch) ----
  await t('r2#1: older reconcile (keep:false) resolving LAST cannot drop a re-handed-off delivered order', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setOrder('O1', ord({ status: 'delivered' }));
    let resolveA, resolveB; let call = 0;
    H.reconcileImpl = () => (call++ === 0)
      ? new Promise((r) => { resolveA = () => r({ value: null, keep: false }); })                      // attempt A: not mine
      : new Promise((r) => { resolveB = () => r({ value: ord({ status: 'delivered' }), keep: true }); }); // attempt B: mine
    H.setTasks({});                 // remove O1 → handoff A (epoch 1)
    await flush();
    H.orders.set('O1', ord({ status: 'delivered' }));
    H.setTasks(tasksFor('O1'));     // re-add → supersedes A (epoch bumped), re-attaches
    H.setTasks({});                 // remove again → handoff B (epoch 3)
    await flush();
    resolveA();                     // older A resolves LAST, keep:false — must be IGNORED (stale epoch)
    await flush();
    resolveB();                     // newer B resolves, keep:true
    await flush();
    assert.ok(f.getOrders().O1, 'delivered order stays counted — A ignored, B applied');
    assert.equal(f.hasPendingHandoff(), false);
  });

  // ---- r2#2: revocation suppression must persist across an unrelated task update that RETAINS the legs ----
  await t('r2#2: revocation stays suppressed when an unrelated task update retains the revoked legs', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1', 'O2']);
    H.revoke('O1');
    assert.equal(f.getOrders().O1, undefined);
    const attachBefore = H.attachCount.get('O1');
    const m = tasksFor('O1', 'O2'); m.O2_pickup = { ...m.O2_pickup, status: 'in_progress' };   // change O2, keep O1's legs
    H.setTasks(m);
    assert.equal(f.getOrders().O1, undefined, 'O1 still suppressed (raw legs retained → revocation persists)');
    assert.equal(H.out.tasks && H.out.tasks.O1_pickup, undefined, 'O1 legs still excluded from the published card');
    assert.equal(H.attachCount.get('O1'), attachBefore, 'O1 listener NOT re-attached');
  });

  // ---- r2#3: an errored point must drop its value authority to independent history ----
  await t('r2#3: errored point drops value authority → history value is published', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    bringReady(H, ['O1']);
    H.setOrder('O1', ord({ total: 100 }));
    H.setHist('primary', { O1: ord({ total: 300 }) });     // independent history membership + value
    assert.equal(f.getOrders().O1.total, 100, 'healthy point wins');
    H.orderError('O1');                                    // non-permission point error
    assert.equal(f.readiness(), LOADING, 'readiness fails closed');
    assert.equal(f.getOrders().O1.total, 300, 'errored point drops its value → history 300 published, not stale 100');
  });

  // ---- #8 startup does not publish synthetic empty tasks ----
  await t('#8 start() does NOT emit onTasks before a real task snapshot', async () => {
    const H = harness(); const f = makeDriverFeed(H.env); f.start();
    assert.equal(H.out.tasks, null, 'no synthetic empty onTasks at startup');
    assert.deepEqual(H.out.readiness, [LOADING], 'readiness still emits LOADING');
    H.setTasks(tasksFor('O1'));
    assert.ok(H.out.tasks && H.out.tasks.O1_pickup, 'onTasks emitted only after the real snapshot');
  });

  clearTimeout(DEADLINE);
  console.log(`✓ driver-feed: ${passed} passed`);
})().catch((e) => { clearTimeout(DEADLINE); console.error(e); process.exit(1); });
