'use strict';
// R3 P0 — THE RTDB ADAPTER ACCEPTANCE CELLS (PLAN-R3 rev 4.1 §5a): the adapter's callback traces vs the REAL client SDK
// (firebase 11.10.0, Node build) on the same emulator, plus the acknowledged-write / subscription barrier cells.
// The comparison runs in its own namespace (r3cmp) so client security rules do not decide the result.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:r3-p0-adapter
require('../test/_emulator-required')('database', 'firestore');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
require('../index.js');   // the default Admin app, configured exactly as the suites see it
const { createFirebaseHost, appFor } = require('./rtdb-adapter');
const { initializeApp: cInit } = require('firebase/app');
const CDB = require('firebase/database');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (cell, msg) => `🔴 R3-P0:${cell} ${msg}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NS = 'r3cmp';
const URLNS = `https://${NS}.firebaseio.com`;
const [EH, EP] = String(process.env.FIREBASE_DATABASE_EMULATOR_HOST).split(':');

// the three parties: the ADAPTER (a page), the real CLIENT SDK, and a WRITER (a separate Admin connection)
const page = createFirebaseHost({ pageId: 'adapter', options: { databaseURL: URLNS } });
const A = page.modules['firebase-database'];
const adb = A.getDatabase();
const capp = cInit({ projectId: 'demo-xpizza', databaseURL: URLNS }, 'r3-client');
const cdb = CDB.getDatabase(capp);
CDB.connectDatabaseEmulator(cdb, EH, Number(EP));
const writer = appFor('r3-writer-cmp', { databaseURL: URLNS }).database();

// identical subscription on both sides → event logs
function both(path, cons, kinds) {
  const logs = { adapter: [], client: [] };
  const aq = cons.length ? A.query(A.ref(adb, path), ...cons.map(([t, ...a]) => A[t](...a))) : A.ref(adb, path);
  const cq = cons.length ? CDB.query(CDB.ref(cdb, path), ...cons.map(([t, ...a]) => CDB[t](...a))) : CDB.ref(cdb, path);
  const unsubs = [];
  for (const k of kinds) {
    const fn = { value: 'onValue', child_added: 'onChildAdded', child_changed: 'onChildChanged', child_removed: 'onChildRemoved' }[k];
    unsubs.push(A[fn](aq, (s) => logs.adapter.push(k === 'value' ? [k, s.exists() ? JSON.stringify(s.val()) : null] : [k, s.key, JSON.stringify(s.val())])));
    unsubs.push(CDB[fn](cq, (s) => logs.client.push(k === 'value' ? [k, s.exists() ? JSON.stringify(s.val()) : null] : [k, s.key, JSON.stringify(s.val())])));
  }
  return { logs, off: () => unsubs.forEach((u) => u()) };
}
async function settleEq(logs, label, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (logs.adapter.length && JSON.stringify(logs.adapter) === JSON.stringify(logs.client)) { await sleep(150); if (JSON.stringify(logs.adapter) === JSON.stringify(logs.client)) return; } await sleep(30); }
  assert.deepStrictEqual(logs.adapter, logs.client, FAIL(label, 'the adapter\'s callback trace differs from the real client SDK\'s'));
}

(async () => {
  await writer.ref().set(null);

  // AD3 + AD1 + AD2: initial delivery, query-window ENTRY / EXIT, deletion
  {
    await writer.ref('orders/pre').set({ status: 'new', n: 1 });
    const s = both('orders', [['orderByChild', 'status'], ['equalTo', 'new']], ['value', 'child_added', 'child_changed', 'child_removed']);
    await settleEq(s.logs, 'AD3');
    const initial = s.logs.adapter.length;
    await writer.ref('orders/a').set({ status: 'new', n: 2 });          // enters the window
    await writer.ref('orders/a/n').set(3);                               // changes inside it
    await writer.ref('orders/a/status').set('preparing');                // EXITS the window
    await writer.ref('orders/pre').remove();                             // deleted
    await settleEq(s.logs, 'AD1');
    const kinds = s.logs.adapter.map((e) => e[0]);
    assert.ok(kinds.includes('child_added') && kinds.includes('child_changed') && kinds.includes('child_removed'), FAIL('AD1', `entry/change/exit all observed (${JSON.stringify(kinds)})`));
    assert.deepStrictEqual(s.logs.adapter[s.logs.adapter.length - 1], ['value', null], FAIL('AD2', 'the window ends empty → onValue(null)'));
    s.off();
    ok(`AD1/AD2/AD3 initial delivery (${initial} events), window entry → change → EXIT, deletion → onValue(null): adapter trace == real client SDK trace (${s.logs.adapter.length} events)`);
  }

  // AD4 unsubscribe stops delivery
  {
    const s = both('u', [], ['value']);
    await writer.ref('u/x').set(1); await settleEq(s.logs, 'AD4');
    const before = { a: s.logs.adapter.length, c: s.logs.client.length };
    s.off();
    await writer.ref('u/x').set(2); await sleep(400);
    assert.deepStrictEqual({ a: s.logs.adapter.length, c: s.logs.client.length }, before, FAIL('AD4', 'a delivery after unsubscribe'));
    ok('AD4 unsubscribe: no delivery after off, on either side');
  }

  // OFF1 (codex r1 P2): off(query, type, callback) stops ONLY that callback on THAT query
  {
    const qA = A.query(A.ref(adb, 'offq'), A.orderByChild('k'), A.equalTo(1));
    const qB = A.ref(adb, 'offq');
    const hits = [0, 0, 0];
    const cb1 = () => { hits[0] += 1; }; const cb2 = () => { hits[1] += 1; }; const cb3 = () => { hits[2] += 1; };
    A.onValue(qA, cb1); A.onValue(qA, cb2); A.onValue(qB, cb3);
    await writer.ref('offq/x').set({ k: 1 }); await page.barrier();
    A.off(qA, 'value', cb1);
    const active = page.subs.filter((x) => x.path === 'offq').map((x) => x.active);
    const before = hits.slice();
    await writer.ref('offq/y').set({ k: 1 }); await page.barrier(); await sleep(150);
    assert.deepStrictEqual(active, [false, true, true], FAIL('OFF1', `off(A, value, cb1) must stop only cb1 on query A (active ${JSON.stringify(active)})`));
    assert.ok(hits[0] === before[0] && hits[1] > before[1] && hits[2] > before[2], FAIL('OFF1', `deliveries after off: ${JSON.stringify({ before, hits })}`));
    A.off(qA); A.off(qB);
    ok('OFF1 off(query A, "value", cb1): only cb1 stops — cb2 on A and cb3 on the unfiltered query keep delivering');
  }

  // AD5 forEach ordering by the query key
  {
    await writer.ref('ord').set({ a: { n: 3 }, b: { n: 1 }, c: { n: 2 } });
    const ak = []; const ck = [];
    // a listener (an unindexed get() is refused by the server; the pages' order queries are listeners)
    await new Promise((res) => A.onValue(A.query(A.ref(adb, 'ord'), A.orderByChild('n')), (snap) => { snap.forEach((c) => { ak.push(c.key); }); res(); }, { onlyOnce: true }));
    await new Promise((res) => CDB.onValue(CDB.query(CDB.ref(cdb, 'ord'), CDB.orderByChild('n')), (snap) => { snap.forEach((c) => { ck.push(c.key); }); res(); }, { onlyOnce: true }));
    assert.deepStrictEqual(ak, ck, FAIL('AD5', `forEach order differs (${ak} vs ${ck})`));
    assert.deepStrictEqual(ak, ['b', 'c', 'a'], FAIL('AD5', 'ordered by n'));
    ok(`AD5 forEach order by the query key: [${ak}] on both sides`);
  }

  // AD6 transaction: commit + abort results
  {
    await writer.ref('tx').set({ c: 1 });
    const ac = await A.runTransaction(A.ref(adb, 'tx/c'), (v) => (v || 0) + 1);
    const cc = await CDB.runTransaction(CDB.ref(cdb, 'tx/c'), (v) => (v || 0) + 1);
    // an ABORT reports the connection's LOCAL value: give both sides the same, current cache (a live listener) first —
    // RTDB semantics, identical in both SDKs; comparing a cold cache against a warm one compares nothing
    const live = []; await Promise.all([
      new Promise((res) => live.push(A.onValue(A.ref(adb, 'tx/c'), (x) => { if (x.val() === 3) res(); }))),
      new Promise((res) => live.push(CDB.onValue(CDB.ref(cdb, 'tx/c'), (x) => { if (x.val() === 3) res(); }))),
    ]);
    const aa = await A.runTransaction(A.ref(adb, 'tx/c'), () => undefined);
    const ca = await CDB.runTransaction(CDB.ref(cdb, 'tx/c'), () => undefined);
    live.forEach((u) => u());
    assert.deepStrictEqual([ac.committed, ac.snapshot.val(), aa.committed, aa.snapshot.val()], [true, 2, false, 3], FAIL('AD6', `adapter results ${JSON.stringify([ac.committed, ac.snapshot.val(), aa.committed, aa.snapshot.val()])}`));
    assert.deepStrictEqual([cc.committed, cc.snapshot.val(), ca.committed, ca.snapshot.val()], [true, 3, false, 3], FAIL('AD6', 'client results'));
    ok('AD6 transaction: commit → {committed:true, snapshot}, abort → {committed:false, current snapshot}; same shape as the client SDK');
  }

  // AD7 serverTimestamp resolution
  {
    await A.set(A.ref(adb, 'ts/a'), { t: A.serverTimestamp() });
    await CDB.set(CDB.ref(cdb, 'ts/c'), { t: CDB.serverTimestamp() });
    const v = (await writer.ref('ts').get()).val();
    assert.ok(Math.abs(v.a.t - Date.now()) < 5000 && Math.abs(v.c.t - Date.now()) < 5000, FAIL('AD7', `serverTimestamp resolved to the server clock (${JSON.stringify(v)})`));
    ok('AD7 serverTimestamp resolves to the server time on both sides');
  }

  // BAR1 the TRAP is real: a same-connection marker passes on its OPTIMISTIC local event before another connection's
  //      write is delivered; the real barrier (acknowledged write + marker from ANOTHER connection, delivered on the
  //      page's connection) never passes early.
  {
    const q = A.query(A.ref(adb, 'bar'), A.orderByChild('k'));
    const seenKeys = new Set();
    const un = A.onChildAdded(q, (s) => seenKeys.add(s.key));
    const naiveRef = page.db.ref('__naive__');
    let naiveEarly = 0; let properEarly = 0; const N = 20;
    for (let i = 0; i < N; i += 1) {
      const k1 = `x${i}`;
      const pending = writer.ref(`bar/${k1}`).set({ k: i });             // in flight, NOT yet acknowledged
      await new Promise((res) => { const h = naiveRef.on('child_added', (s) => { if (s.key === `m${i}`) { naiveRef.off('child_added', h); res(); } }); naiveRef.child(`m${i}`).set(true); });
      if (!seenKeys.has(k1)) naiveEarly += 1;                              // the optimistic local event fired first
      await pending;                                                       // (1) acknowledged
      const k2 = `y${i}`;
      await writer.ref(`bar/${k2}`).set({ k: i });                         // acknowledged write …
      await page.barrier();                                                // … then the barrier
      if (!seenKeys.has(k2)) properEarly += 1;
    }
    un();
    assert.ok(naiveEarly >= 1, FAIL('BAR1', `premise — the naive same-connection marker never passed early (${naiveEarly}/${N}): the trap was not reproduced`));
    assert.strictEqual(properEarly, 0, FAIL('BAR1', `the barrier passed before an acknowledged write was delivered (${properEarly}/${N})`));
    ok(`BAR1 the optimistic-local-event trap reproduced (naive same-connection marker passed early ${naiveEarly}/${N}); the real barrier passed early 0/${N}`);
  }

  // BAR2 the barrier never consults get()
  {
    const g = page.getCalls.length;
    await page.barrier(); await page.barrier();
    assert.strictEqual(page.getCalls.length, g, FAIL('BAR2', 'the barrier issued a get()'));
    ok('BAR2 the barrier issues no get() (a get on a listened query may be served from cache)');
  }

  // BAR4 an UNCHANGED filtered result: the barrier passes; the subscription receives nothing new (settled, no new render)
  {
    let delivered = 0;
    const un = A.onValue(A.query(A.ref(adb, 'win'), A.orderByChild('status'), A.equalTo('new')), () => { delivered += 1; });
    await writer.ref('win/in').set({ status: 'new' });
    await page.barrier();
    const d0 = delivered;
    await writer.ref('win/out').set({ status: 'done' });                 // outside the window
    await page.barrier();
    assert.strictEqual(delivered, d0, FAIL('BAR4', `a write OUTSIDE the filtered window produced a callback (${delivered - d0})`));
    un();
    ok(`BAR4 a write outside the filtered window: the barrier passes, no new callback (settled at ${d0}), nothing waited for a callback that never comes`);
  }

  await page.close();
  console.log(`\nr3-p0-adapter: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-p0-adapter FAILED:', e && e.stack || e); process.exit(1); });
