'use strict';
// lib/rtdb-gate (PLAN-rtdb-get-once-race r9): the gate's own contract, on the real Admin-loaded bundle (test/_rtdb-race-harness.js).
//   RG-GATE-UNIT — gets never wait (even with a listener queued), get+get never wait, a child get never blocks an ancestor listener, a
//   parent get blocks a descendant listener, the mark holds through a REJECTED get, admission is atomic (no get slips between the
//   wake and the registration), FIFO forward admission, no leak after 10k cycles. RG-BURST-5 — a listener queued behind 5 back-to-back
//   gets registers once the last settles (the measured wait is printed). Run: node test/rtdb-gate.test.js
const assert = require('assert');
const H = require('./_rtdb-race-harness');
const G = require('../lib/rtdb-gate');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const DATA = { orders: { o1: { n: 1 }, o2: { n: 2 } } };
const at = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? null : o[k]), DATA);
const sentKinds = (c, from) => c.sent().slice(from).filter((m) => m.a === 'g' || m.a === 'q').map((m) => `${m.a}:${m.b.p}`);

(async () => {
  await cell('RG-GATE-UNIT gets never wait: a gated get goes out NOW even while a gated get and a queued listener exist on its path', async (L) => {
    const c = H.client('u1'); const from = c.sent().length;
    const g1 = G.gatedGet(c.db.ref('orders/o1')); const l = G.afterGets(c.db.ref('orders/o1'), () => c.db.ref('orders/o1').once('value'));
    const g2 = G.gatedGet(c.db.ref('orders/o1')); await H.flush();
    assert.deepStrictEqual(sentKinds(c, from), ['g:/orders/o1', 'g:/orders/o1'], `${L}: both gets sent, the listener held`);
    await c.serve(at); await Promise.all([g1, g2, l]);
    assert.deepStrictEqual(c.listens(), [], `${L}: clean`); assert.strictEqual(G.gateState().waiters, 0, L); await c.close();
  });
  await cell('RG-GATE-UNIT ancestor rule: a parent get blocks a descendant listener; a child get never blocks an ancestor listener', async (L) => {
    const c = H.client('u2'); let from = c.sent().length;
    const g = G.gatedGet(c.db.ref('orders')); const l = G.afterGets(c.db.ref('orders/o1'), () => c.db.ref('orders/o1').once('value')); await H.flush();
    assert.deepStrictEqual(sentKinds(c, from), ['g:/orders'], `${L}: the descendant listener waits for the parent get`);
    await c.serve(at); await Promise.all([g, l]);
    from = c.sent().length;
    const g2 = G.gatedGet(c.db.ref('orders/o1')); const l2 = G.afterGets(c.db.ref('orders'), () => c.db.ref('orders').once('value')); await H.flush();
    assert.deepStrictEqual(sentKinds(c, from), ['g:/orders/o1', 'q:/orders'], `${L}: the ancestor listener does not wait`);
    await c.serve(at); await Promise.all([g2, l2]); assert.deepStrictEqual(c.listens(), [], L); await c.close();
  });
  await cell('RG-GATE-UNIT the mark holds through a REJECTED get; the queued listener registers after the rejection', async (L) => {
    const c = H.client('u3'); const g = G.gatedGet(c.db.ref('orders/o1')); g.catch(() => {});
    const l = G.afterGets(c.db.ref('orders/o1'), () => c.db.ref('orders/o1').once('value')); await H.flush();
    const [gm] = c.pending('g'); assert.strictEqual(c.pending('q').length, 0, `${L}: listener held`);
    c.reply(gm, 'permission_denied', 'permission_denied'); await H.flush(); await assert.rejects(g, L);
    await c.serve(at); assert.strictEqual((await l).val().n, 1, `${L}: the listener ran after the rejection`); await c.close();
  });
  await cell('RG-GATE-UNIT atomic admission: a get issued in the same turn as the wake cannot slip ahead of the admitted listener', async (L) => {
    const c = H.client('u4'); const g = G.gatedGet(c.db.ref('orders/o1'));
    const l = G.afterGets(c.db.ref('orders/o1'), () => c.db.ref('orders/o1').once('value'));
    // the moment g settles, the continuation issues another gated get — the listener must already be registered (q before the 2nd g)
    const from = c.sent().length; let g2;
    g.then(() => { g2 = G.gatedGet(c.db.ref('orders/o1')); });
    await H.flush(); await c.serve(at); await l; await g2; await c.serve(at);
    const k = sentKinds(c, from); assert.ok(k.indexOf('q:/orders/o1') >= 0 && k.indexOf('q:/orders/o1') < k.lastIndexOf('g:/orders/o1'), `${L}: ${k.join(' ')}`);
    assert.deepStrictEqual(c.listens(), [], `${L}: clean`); await c.close();
  });
  await cell('RG-GATE-UNIT FIFO forward admission, and no leak after 10k mark / admit cycles', async (L) => {
    const c = H.client('u5'); const g = G.gatedGet(c.db.ref('orders/o2')); const order = [];
    const ls = [1, 2, 3].map((i) => G.afterGets(c.db.ref('orders/o2'), () => { order.push(i); return c.db.ref('orders/o2').once('value'); }));
    await H.flush(); await c.serve(at); await Promise.all([g, ...ls]); assert.deepStrictEqual(order, [1, 2, 3], L);
    for (let i = 0; i < 10000; i++) { const fake = { toString: () => 'r/orders/x', root: { toString: () => 'r' }, get: () => Promise.resolve(i) }; G.gatedGet(fake); }
    await new Promise((r) => setImmediate(r)); const s = G.gateState(); assert.deepStrictEqual([s.pending_gets, s.waiters], [0, 0], `${L}: ${JSON.stringify(s)}`); await c.close();
  });
  await cell('RG-BURST-5: a listener queued behind 5 back-to-back gated gets registers once the last settles (measured)', async (L) => {
    const c = H.client('b5'); const gs = []; gs.push(G.gatedGet(c.db.ref('orders/o1')));
    const t0 = Date.now(); let tReg = null;
    const l = G.afterGets(c.db.ref('orders/o1'), () => { tReg = Date.now(); return c.db.ref('orders/o1').once('value'); });
    for (let i = 0; i < 4; i++) gs.push(G.gatedGet(c.db.ref('orders/o1')));
    await H.flush(); assert.strictEqual(tReg, null, `${L}: held while gets are in flight`);
    await c.serve(at); await Promise.all([...gs, l]);
    assert.ok(tReg !== null, `${L}: registered`); assert.deepStrictEqual(c.listens(), [], `${L}: clean`);
    console.log(`    RG-BURST-5 wait ${tReg - t0} ms (5 gets, harness turns)`); await c.close();
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`rtdb-gate: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
