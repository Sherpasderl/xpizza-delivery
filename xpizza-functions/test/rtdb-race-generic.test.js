'use strict';
// PLAN-rtdb-get-once-race-r3 §4.2 — the GENERIC interleavings, on the real Admin-loaded bundle (test/_rtdb-race-harness.js). These
// exercise the SDK, not our code (no mutants): they pin what the pinned tuple does, so the build's classes (§4.3) and the exit (§8)
// stand on evidence. The server answers in request order, one frame per event turn (harness serve()). Run: node test/rtdb-race-generic.test.js
const assert = require('assert');
const H = require('./_rtdb-race-harness');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const DATA = { orders: { o1: { status: 'paid', n: 1 }, o2: { status: 'new', n: 2 } } };
const at = (p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? null : o[k]), DATA);
const TWICE = /listen\(\) called twice for same path\/queryId/;

// issue `first`, let it go out, issue `second`, serve every frame one per turn; then the residual connection listens, and whether a fresh
// subscription on each of `resub` throws the duplicate-listen assertion
async function interleave(c, first, second, resub) {
  const a = first(c.db); await H.flush(); const b = second(c.db); await H.flush();
  await c.serve(at);
  await Promise.all([a, b]);
  const residual = c.listens();
  const asserts = [];
  for (const r of resub) { try { const p = r(c.db); if (p && p.catch) p.catch(() => {}); await H.flush(); await c.serve(at); } catch (e) { if (TWICE.test(e.message)) asserts.push(r.name || 'resub'); else throw e; } }
  return { residual, asserts };
}
const getAt = (p) => Object.defineProperty((db) => db.ref(p).get(), 'name', { value: `get ${p}` });
const onceAt = (p) => Object.defineProperty((db) => db.ref(p).once('value'), 'name', { value: `once ${p}` });
const filt = Object.defineProperty((db) => db.ref('orders').orderByChild('n').equalTo(1).once('value'), 'name', { value: 'once orders?n=1' });
const txn = Object.defineProperty((db) => db.ref('orders/o1').transaction((cur) => cur), 'name', { value: 'txn orders/o1' });

(async () => {
  await cell('RG-SHA: the harness compiled the exact Admin-required standalone artifact (the §8 pin)', (L) => {
    assert.strictEqual(H.SHA256, '3c3e93d04d6ba9750ffb4a6834310f4485fbea739f389db49be531ba2ea2197d', L);
    assert.ok(/@firebase\/database-compat\/dist\/index\.standalone\.js$/.test(H.FILE), `${L}: ${H.FILE}`);
  });
  await cell('RG-1: same-path get pending, then once ⇒ an ORPHANED connection listen, and a fresh subscription asserts «listen() called twice»', async (L) => {
    const c = H.client('rg1');
    const r = await interleave(c, getAt('orders/o1'), onceAt('orders/o1'), [onceAt('orders/o1')]);
    assert.deepStrictEqual(r.residual, [['/orders/o1', 'default']], `${L}: the orphan`);
    assert.deepStrictEqual(r.asserts, ['once orders/o1'], `${L}: the assertion`);
    await c.close();
  });
  await cell('RG-1-ORDER: the same pair with the once FIRST is clean (the hazard needs the get issued first)', async (L) => {
    const c = H.client('rg1o');
    const r = await interleave(c, onceAt('orders/o1'), getAt('orders/o1'), [onceAt('orders/o1')]);
    assert.deepStrictEqual(r, { residual: [], asserts: [] }, L);
    await c.close();
  });
  await cell('RG-PC: parent get pending, then a child once ⇒ the orphan at the child; resubscribing the child asserts', async (L) => {
    const c = H.client('rgpc');
    const r = await interleave(c, getAt('orders'), onceAt('orders/o1'), [onceAt('orders/o1')]);
    assert.deepStrictEqual(r.residual, [['/orders/o1', 'default']], `${L}: the orphan`);
    assert.deepStrictEqual(r.asserts, ['once orders/o1'], L);
    await c.close();
  });
  await cell('RG-ANC (the §2.3 gate): child get pending, then an ANCESTOR once ⇒ clean, both orders', async (L) => {
    for (const [x, y] of [[getAt('orders/o1'), onceAt('orders')], [onceAt('orders'), getAt('orders/o1')]]) {
      const c = H.client('rganc');
      assert.deepStrictEqual(await interleave(c, x, y, [onceAt('orders'), onceAt('orders/o1')]), { residual: [], asserts: [] }, `${L}: ${x.name} → ${y.name}`);
      await c.close();
    }
  });
  await cell('RG-FILT: parent get pending, then a filtered query under it ⇒ the orphan (filtered queryId); resubscribing it asserts', async (L) => {
    const c = H.client('rgfilt');
    const r = await interleave(c, getAt('orders'), filt, [filt]);
    assert.strictEqual(r.residual.length, 1, `${L}: one orphan`); assert.strictEqual(r.residual[0][0], '/orders', L);
    assert.deepStrictEqual(r.asserts, ['once orders?n=1'], L);
    await c.close();
  });
  await cell('RG-TXN: get pending + a transaction on the same path (its persistent internal listener) ⇒ clean, both orders', async (L) => {
    for (const [x, y] of [[getAt('orders/o1'), txn], [txn, getAt('orders/o1')]]) {
      const c = H.client('rgtxn');
      assert.deepStrictEqual(await interleave(c, x, y, [onceAt('orders/o1')]), { residual: [], asserts: [] }, `${L}: ${x.name} → ${y.name}`);
      await c.close();
    }
  });
  await cell('RG-ON: get pending + a persistent on(\'value\') later removed by off() (casCursor\'s shape) ⇒ clean after off, both orders', async (L) => {
    for (const order of ['get-first', 'on-first']) {
      const c = H.client('rgon'); const ref = c.db.ref('orders/o1'); const cb = () => {};
      let g; if (order === 'get-first') { g = ref.get(); await H.flush(); ref.on('value', cb); } else { ref.on('value', cb); await H.flush(); g = ref.get(); }
      await H.flush(); await c.serve(at); await g;
      assert.deepStrictEqual(c.listens(), [['/orders/o1', 'default']], `${L}: ${order}: the on's own listen while it is on`);
      ref.off('value', cb); await H.flush(); await c.serve(at);
      const r = await interleave(c, onceAt('orders/o2'), onceAt('orders/o1'), [onceAt('orders/o1')]);
      assert.deepStrictEqual(r, { residual: [], asserts: [] }, `${L}: ${order}: nothing left after off`);
      await c.close();
    }
  });
  await cell('RG-ONCE: the once-only counterparts (same path, parent + child, filtered) leave EMPTY bookkeeping, 20/20', async (L) => {
    for (let i = 0; i < 20; i++) {
      for (const [x, y] of [[onceAt('orders/o1'), onceAt('orders/o1')], [onceAt('orders'), onceAt('orders/o1')], [onceAt('orders'), filt]]) {
        const c = H.client('rgonce');
        assert.deepStrictEqual(await interleave(c, x, y, [y]), { residual: [], asserts: [] }, `${L}: run ${i} ${x.name} → ${y.name}`);
        await c.close();
      }
    }
  });
  await cell('RG-OWNED (lib/rtdb-once onceWithin): beside a same-path once, both orders ⇒ the same value, EMPTY bookkeeping, no assertion', async (L) => {
    const RO = require('../lib/rtdb-once');
    const owned = Object.defineProperty((db) => RO.onceWithin(db.ref('orders/o1'), 60000), 'name', { value: 'onceWithin orders/o1' });
    for (const [x, y] of [[owned, onceAt('orders/o1')], [onceAt('orders/o1'), owned]]) {
      const c = H.client('rgowned');
      const a = x(c.db); await H.flush(); const b = y(c.db); await H.flush(); await c.serve(at);
      const [sa, sb] = await Promise.all([a, b]);
      assert.deepStrictEqual([sa.val(), sb.val()], [DATA.orders.o1, DATA.orders.o1], `${L}: ${x.name} → ${y.name}: the value`);
      assert.deepStrictEqual(await interleave(c, onceAt('orders/o2'), onceAt('orders/o1'), [onceAt('orders/o1')]), { residual: [], asserts: [] }, `${L}: ${x.name} → ${y.name}`);
      await c.close();
    }
  });
  await cell('RG-OWNED-DETACH: no value within the deadline ⇒ its listener is detached (only its own), the promise never settles, a late value changes nothing', async (L) => {
    const RO = require('../lib/rtdb-once');
    const c = H.client('rgdetach'); const ref = c.db.ref('orders/o1');
    let settled = false; RO.onceWithin(ref, 30).then(() => { settled = true; }, () => { settled = true; });
    const keep = () => {}; c.db.ref('orders/o2').on('value', keep);   // an unrelated listener stays
    await H.flush(); assert.deepStrictEqual(c.listens().map(([p]) => p).sort(), ['/orders/o1', '/orders/o2'], `${L}: premise, both listening`);
    await new Promise((r) => setTimeout(r, 60)); await H.flush();
    assert.deepStrictEqual(c.listens().map(([p]) => p), ['/orders/o2'], `${L}: only the owned callback was detached`);
    await c.serve(at); await H.flush();
    assert.strictEqual(settled, false, `${L}: never settles (the caller's race answered)`);
    c.db.ref('orders/o2').off('value', keep); await c.close();
  });
  await cell('RG-BURST: delivering every frame in ONE synchronous burst hides RG-1 (why the cells serve one frame per turn)', async (L) => {
    const c = H.client('rgburst');
    const g = c.db.ref('orders/o1').get(); await H.flush(); const o = c.db.ref('orders/o1').once('value'); await H.flush();
    const [gm] = c.pending('g'); const [qm] = c.pending('q');
    c.reply(gm, at('/orders/o1')); c.push('/orders/o1', at('/orders/o1')); c.reply(qm, {});   // same turn
    await Promise.all([g, o]); await H.flush(); await c.serve(at);
    assert.deepStrictEqual(c.listens(), [], `${L}: no orphan when the listen's data beats get()'s continuation`);
    await c.close();
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`rtdb-race-generic: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
