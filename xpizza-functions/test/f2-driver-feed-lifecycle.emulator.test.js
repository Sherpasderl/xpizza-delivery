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
    reconcileOrderOnce(oid) { return db.ref('orders/' + oid).get().then((s) => { const v = s.val(); return { value: v, keep: !!(v && (v.delivered_by_driver_uid === uid || v.delivered_by_uid === uid)) }; }).catch((e) => { if (isPermissionDenied(e)) return { value: null, keep: false }; throw e; }); },   // get() = production; server-fresh with no active listener (never the cache). A rules-DENY (not mine, no task) = authoritative keep:false; only a transient error rejects.
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

  // ── B: the BC1 reconcile reads SERVER-fresh, never the stale cache. Plus the attribution decision. ──
  //   DETERMINISTIC (asserted below): while OFFLINE with the server moved to 999, get() returns the populated
  //   cache's stale 150 — proof the cache is both populated and stale. ONLINE, get() returns 999, never the
  //   stale 150 — the property BC1 depends on.
  //   DOCUMENTED LIMITATION (codex r4 #B): we cannot assert that the online get() bypassed the cache via its OWN
  //   server round-trip. Holding the cache populated requires an ACTIVE listener, and an active listener ONLINE
  //   keeps that cache server-synced — so by the time get() runs, 999 may already be IN the cache from the
  //   listener's resync rather than from get()'s own fetch. The two are indistinguishable here: @firebase/
  //   rules-unit-testing drives the RTDB websocket protocol and exposes NO request-count or transport hook to
  //   count round-trips, and the only way to force a cache miss (detach the sole listener) evicts the cache
  //   (codex r3 #1), destroying the stale-cache precondition. A deterministic "populated-stale cache + online
  //   get bypasses it" is therefore not constructible against a real client. What IS proven — online get()
  //   never serves the stale 150 — is the behaviour BC1 relies on; the controller-level freshness is covered
  //   additionally by driver-feed.test.js (the reconcile reads through env, which the node harness fakes).
  {
    await wipe(); await admin(SEED());                             // O2: delivered, total 150, delivered_by_driver_uid=UID
    const db = testEnv.authenticatedContext(UID).database();
    const r = db.ref('orders/O2');
    // Keep a listener ACTIVE so the SDK cache for this path stays POPULATED (codex r3 #1: detaching the ONLY
    // listener evicts the cache, making a later get() hit the server trivially — not a real stale-cache race).
    let lastSeen = null;
    const keepAlive = r.on('value', (s) => { lastSeen = s.val() && s.val().total; });
    await new Promise((res) => { const check = () => (lastSeen === 150 ? res() : setTimeout(check, 20)); check(); });  // cache populated @150
    db.goOffline();                                                // freeze the client → the populated cache stays 150 and cannot refresh
    await admin({ 'orders/O2/total': 999 });                       // server now 999 on a separate connection → the client's POPULATED cache is now STALE
    const stale = await r.get();                                   // offline get() → the stale CACHED value (proves the cache is populated AND stale)
    ck(stale.val() && stale.val().total === 150, `B: offline get() should return the stale populated cache 150 (${stale.val() && stale.val().total})`);
    db.goOnline();
    await sleep(400);                                              // reconnect
    const fresh = await r.get();                                   // online get() → SERVER-fresh 999, bypassing the still-populated cache
    ck(fresh.val() && fresh.val().total === 999, `B: online get() must be server-fresh 999, not the populated-but-stale cache (${fresh.val() && fresh.val().total})`);
    r.off('value', keepAlive);
    const env = makeEnv(db, UID, {});
    const rec = await env.reconcileOrderOnce('O2');
    ck(rec.keep === true && rec.value && rec.value.total === 999, `B: reconcileOrderOnce not fresh+attributed (${JSON.stringify(rec)})`);
    await admin({ 'orders/O9': { order_id: 'O9', status: 'delivered', total: 50, payment_method: 'cash', delivered_by_driver_uid: 'u-other' } });
    const rec9 = await env.reconcileOrderOnce('O9');
    ck(rec9.keep === false, `B: a non-attributed order must be keep:false (${JSON.stringify(rec9)})`);
  }

  // ── C: controller through the real env — READY, then revocation tears the order + its tasks down ──
  {
    await wipe(); await admin(SEED());
    const db = testEnv.authenticatedContext(UID).database();
    const out = { orders: {}, tasks: {} };
    const events = [];                 // codex r4 #C: record the CAUSE (PERMISSION_DENIED cancel) vs the EFFECT (removal)
    let watch = false, snap = null, resolveT;
    const tornDown = new Promise((r) => { resolveT = r; });
    let feed;
    const emit = {
      onOrders: (o) => {
        out.orders = o;
        // Capture the FIRST emission that drops O1 — the teardown publish — SYNCHRONOUSLY in that callback, not
        // after a fixed delay (codex r3 #2).
        if (watch && o && o.O1 === undefined && snap === null) { events.push('removal'); snap = { orders: o, tasks: feed.getOwnTasks() }; resolveT(); }
      },
      onTasks: (t) => { out.tasks = t; }, onReadiness: () => {}, onDriver: () => {},
    };
    const base = makeEnv(db, UID, emit);
    // Wrap subscribeOrder so the PERMISSION_DENIED cancel is RECORDED (synchronously, before onRevoked runs) — this
    // lets us assert the cancel is the CAUSE of the teardown (codex r4 #C), not merely that O1 eventually vanished.
    const env = Object.assign({}, base, {
      subscribeOrder(oid, cb, onRevoked, onError) {
        return base.subscribeOrder(oid, cb, () => { if (watch) events.push('cancel:' + oid); onRevoked(); }, onError);
      },
    });
    feed = makeDriverFeed(env);
    feed.start();
    await sleep(800);
    ck(feed.readiness() === 'ready', `C: not ready after start (${feed.readiness()})`);
    ck(!!out.orders.O1 && !!feed.getOwnTasks().O1_pickup, 'C: O1 not published before revoke');
    watch = true;
    // reassign both legs away → the per-order onValue(orders/O1) is cancelled PERMISSION_DENIED → onRevoked tears it down
    await admin({ 'tasks/O1_pickup/assigned_driver_id': 'u-d2', 'tasks/O1_delivery/assigned_driver_id': 'u-d2' });
    await Promise.race([tornDown, sleep(3000).then(() => { throw new Error('C: teardown never emitted on the cancel callback'); })]);
    // Immediate teardown (r3): O1 + BOTH its task legs are gone in that single teardown emission — no stale card.
    ck(snap && snap.orders.O1 === undefined, 'C: revoked O1 not removed from allOrders on the cancel callback');
    ck(snap && snap.tasks.O1_pickup === undefined && snap.tasks.O1_delivery === undefined, 'C: revoked O1 legs not stripped from ownTasks on the cancel callback');
    // The CANCEL is the CAUSE (codex r4 #C): the PERMISSION_DENIED cancel fired, and its onRevoked executed — proven
    // because O1 is now in revokedOids, which ONLY the revocation path sets (a plain task-query drop never does).
    ck(events.indexOf('cancel:O1') !== -1, `C: the PERMISSION_DENIED cancel never fired (events=${events.join(',')})`);
    ck(feed._state().revokedOids.has('O1'), 'C: O1 not in revokedOids → the PERMISSION_DENIED cancel path did not drive the teardown');
    feed.dispose();
  }

  // ── D: a real reconnect (goOffline→goOnline, data UNCHANGED) → the controller re-attaches → readiness
  //       transitions ready → LOADING → ready (asserts the LOADING transition, not merely eventual readiness). ──
  {
    await wipe(); await admin(SEED());
    const db = testEnv.authenticatedContext(UID).database();
    const rh = [];
    const emit = { onOrders: () => {}, onTasks: () => {}, onReadiness: (r) => { rh.push(r); }, onDriver: () => {} };
    const feed = makeDriverFeed(makeEnv(db, UID, emit));
    feed.start();
    await sleep(800);
    ck(feed.readiness() === 'ready', `D: not ready before reconnect (${feed.readiness()})`);
    const mark = rh.length;
    db.goOffline(); await sleep(400);
    db.goOnline(); await sleep(1500);        // NO data changes across the reconnect
    ck(feed.readiness() === 'ready', `D: readiness did not recover — controller did not re-attach (${feed.readiness()})`);
    ck(rh.slice(mark).includes('loading'), `D: no LOADING transition on reconnect (re-attach not exercised): [${rh.slice(mark)}]`);
    ck(!!feed.getOrders().O1, 'D: O1 lost after reconnect');
    feed.dispose();
  }

  // ── E: a UID transition — a feed for a NEW driver must not carry the previous driver's shift (the controller
  //       half of fix #7; the host-side dispose-before-new-user + driver-record cash gate are in index.html). ──
  {
    await wipe(); await admin(SEED());        // O1 belongs to UID (u-d1)
    await admin({ 'drivers/u-d2': { active: true, status: 'available' } });
    const feed1 = makeDriverFeed(makeEnv(testEnv.authenticatedContext(UID).database(), UID, { onOrders: () => {}, onTasks: () => {}, onReadiness: () => {}, onDriver: () => {} }));
    feed1.start(); await sleep(800);
    ck(!!feed1.getOrders().O1, 'E: u-d1 feed should see O1');
    feed1.dispose();                          // auth transition → dispose the prior session
    const feed2 = makeDriverFeed(makeEnv(testEnv.authenticatedContext('u-d2').database(), 'u-d2', { onOrders: () => {}, onTasks: () => {}, onReadiness: () => {}, onDriver: () => {} }));
    feed2.start(); await sleep(800);
    ck(feed2.getOrders().O1 === undefined, `E: new driver u-d2 must NOT see u-d1's order (${JSON.stringify(feed2.getOrders())})`);
    ck(feed2.readiness() === 'ready', `E: u-d2 feed not ready (${feed2.readiness()})`);
    feed2.dispose();
  }

  await testEnv.cleanup();
  if (fails.length) { console.error('f2-driver-feed-lifecycle FAILURES:\n' + fails.map((f) => '  ✗ ' + f).join('\n')); process.exit(1); }
  // Emit one recognised cell marker per case (count-marks.js tallies ✓ → ##CELLS); reached only when every case passed.
  [
    'A: a fresh onValue attach emits the current value even when UNCHANGED',
    'B: the BC1 reconcile reads SERVER-fresh, never the stale populated cache',
    'C: the PERMISSION_DENIED cancel DROVE the immediate revocation teardown (O1 in revokedOids)',
    'D: a real reconnect (goOffline→goOnline, data unchanged) re-attaches → readiness recovers',
    'E: uid isolation — a new driver never sees the prior driver’s order',
  ].forEach((l, i) => console.log(`  ✓ ${i + 1} ${l}`));
  console.log('f2-driver-feed-lifecycle(emulator): OK (A fresh-attach, B get() server-fresh vs stale cache, C revocation teardown, D reconnect loading→ready, E uid isolation)');
})().catch((e) => { console.error(e); process.exit(1); });
