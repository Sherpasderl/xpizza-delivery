'use strict';
// SDK payment coordinator cells (BRIEF-sdk-payment-coordinator r5). Real coordinator + honest RTDB model + the fake PSP
// behind the real adapter contract. Every money cell asserts the provider calls BY ARGUMENT, the derived figures, the live
// holds and the open obligations. Failure messages start with the cell label. Run: node payments/sdk/coordinator.test.js
const assert = require('assert');
const { makeHonestDb } = require('../../_honest-rtdb-model');
const { makeAdapter } = require('./psp-adapter');
const { makeFakePsp } = require('./fake-adapter');
const R = require('./record');
const C = () => require('./coordinator');

const OID = 'tb_sdk_1';
const TOKEN = 'T-tb-token';
const order = (o = {}) => ({ restaurant_id: 'tb_rest', payment_flow: 'sdk_auth_v1', status: 'pending_payment', created_at: 1000, ...o });
function world({ seed = {}, script = {}, hooks = {}, eligible = () => false, t0 = 100000 } = {}) {
  let t = t0;
  const db = makeHonestDb({ orders: { [OID]: order() }, ...seed }, { now: () => t, ...hooks });
  const fake = makeFakePsp(script);
  const deps = { db, psp: makeAdapter(fake.impl), now: () => t, voidEligible: eligible, release: async () => { deps.released = (deps.released || 0) + 1; } };
  return { db, fake, deps, rec: () => db.getAt(`payment_sdk/${OID}`), ord: () => db.getAt(`orders/${OID}`), tick: (ms) => { t += ms; }, at: () => t };
}
const legs = (rec) => Object.values((rec && rec.legs) || {});
const alerts = (db) => Object.values(db.getAt('dispatcher_alerts') || {});

let pass = 0; const fails = [];
async function cell(name, fn) { try { await fn(name); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.log(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }

(async () => {
  // ── placement ──
  await cell('SDK-PLACE-APPROVED', async (L) => {
    const w = world();
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'placed', `${L}: placed (got ${JSON.stringify(r)})`);
    assert.deepStrictEqual(w.fake.calls.map((c) => [c.action, c.token, c.amount_cents]), [['authorize', TOKEN, 10000]], `${L}: ONE authorize with the token + the SERVER amount`);
    assert.ok(/^tb_sdk_1:L1:auth:/.test(w.fake.calls[0].op_id), `${L}: the call carries the journaled op_id`);
    const rec = w.rec();
    assert.ok(legs(rec).length === 1 && legs(rec)[0].role === 'committed' && legs(rec)[0].state === 'approved', `${L}: L1 committed + approved`);
    assert.deepStrictEqual([rec.derived.committed_auth_total, rec.derived.captured_total, rec.derived.refund_liability, rec.derived.live_holds], [10000, 0, 0, 1], `${L}: derived`);
    assert.ok(w.ord().payment_placed && w.ord().payment_placed.leg_id === 'L1', `${L}: the go-live decision is recorded on the order`);
    assert.ok(w.db.getAt(`payment_sdk_due/${OID}`) != null, `${L}: enrolled in the due index`);
    assert.strictEqual(w.ord().payment_flow, 'sdk_auth_v1', `${L}: payment_flow preserved`);
  });
  await cell('SDK-PLACE-DECLINED', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'definitive_decline', code: '05' }] } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'declined', `${L}: declined (got ${JSON.stringify(r)})`);
    assert.ok(legs(w.rec())[0].state === 'declined' && !w.rec().lock && !w.ord().payment_placed, `${L}: leg declined, no lock, not placed`);
  });
  await cell('SDK-PLACE-LOST-RESPONSE-LOCKS', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    const r = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.strictEqual(r.outcome, 'unknown', `${L}: unknown (got ${JSON.stringify(r)})`);
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown' && !w.ord().payment_placed, `${L}: locked, leg unknown, NOT placed`);
    const again = await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(again.outcome === 'refused' && w.fake.count('authorize') === 1, `${L}: a second placement is refused — still ONE authorize (got ${JSON.stringify(again)})`);
  });
  await cell('SDK-RECONCILE-NO-UUID-MANUAL', async (L) => {
    const w = world({ script: { authorize: [{ lost: true }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    assert.strictEqual(w.rec().lock.reason, 'manual_reconciliation', `${L}: an unknown auth with NO uuid → manual_reconciliation (got ${JSON.stringify(w.rec().lock)})`);
    assert.ok(w.fake.count('status') === 0 && w.fake.count('authorize') === 1, `${L}: no status (no uuid), no retry`);
  });
  await cell('SDK-RECONCILE-BOUND-STATUS-RESOLVES', async (L) => {
    // approved with a mismatched amount → adapter says unknown WITH a uuid; status (bound, authorized) resolves it
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-77', amount_cents: 9999, effect: (st) => { st['P-77'] = { state: 'authorized', amount_cents: 10000 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    assert.ok(w.rec().lock, `${L}: PREMISE — locked on the mismatched answer`);
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    const l1 = legs(w.rec())[0];
    assert.ok(!w.rec().lock && l1.state === 'approved' && l1.pp_uuid === 'P-77', `${L}: bound evidence resolves the op (got ${JSON.stringify({ lock: w.rec().lock, l1 })})`);
    assert.ok(w.fake.count('authorize') === 1 && w.fake.calls.filter((c) => c.action === 'status').every((c) => c.uuid === 'P-77'), `${L}: one authorize, status by uuid`);
  });
  await cell('SDK-RECONCILE-MISMATCHED-STATUS-KEEPS-LOCK', async (L) => {
    const w = world({ script: { authorize: [{ outcome: 'approved', uuid: 'P-78', amount_cents: 9999, effect: (st) => { st['P-78'] = { state: 'authorized', amount_cents: 9999 }; } }] } });
    await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && legs(w.rec())[0].state === 'unknown', `${L}: evidence with another amount is NOT bound → lock kept (got ${JSON.stringify(w.rec().lock)})`);
  });

  // ── terminal settlement ──
  const placed = async (opts = {}) => { const w = world(opts); await C().placeOriginal(w.deps, { orderId: OID, token: TOKEN, amount_cents: 10000 }); return w; };
  await cell('SDK-TERMINAL-CAPTURES-ONCE-FULL', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const r = await C().settleTerminal(w.deps, { orderId: OID });
    const caps = w.fake.calls.filter((c) => c.action === 'capture');
    assert.deepStrictEqual(caps.map((c) => [c.uuid, c.amount_cents]), [[legs(w.rec())[0].pp_uuid, 10000]], `${L}: ONE capture of L1 at its FULL amount (got ${JSON.stringify(caps)}; ${JSON.stringify(r)})`);
    assert.ok(w.ord().payment_terminal && w.rec().phase === 'frozen' && w.rec().frozen.capture_set.join() === 'L1', `${L}: payment_terminal written, frozen on {L1}`);
    assert.deepStrictEqual([w.rec().derived.captured_total, w.rec().derived.live_holds, Object.keys(w.rec().obligations || {}).length], [10000, 0, 0], `${L}: captured 10000, no live hold, no obligation`);
    assert.ok(R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: financially closed`);
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: idempotent — a second settle captures nothing`);
  });
  await cell('SDK-TERMINAL-COMPLETED-ALSO-SETTLES', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('completed');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: 'completed' (merchant handed) is terminal too`);
  });
  await cell('SDK-TERMINAL-NOT-TERMINAL-NOOP', async (L) => {
    const w = await placed();
    await w.db.ref(`orders/${OID}/status`).set('preparing');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.fake.count('capture') === 0 && !w.ord().payment_terminal && w.rec().phase === 'open', `${L}: a live order is not settled`);
  });
  await cell('SDK-TERMINAL-TRIGGER-SWEEPER-RACE-ONE-CAPTURE', async (L) => {
    let release; const gate = new Promise((r) => { release = r; });
    const w = await placed({ script: { capture: [{ pause: gate }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    const a = C().settleTerminal(w.deps, { orderId: OID });   // the trigger — paused INSIDE the capture call
    await new Promise((r) => setTimeout(r, 20));
    const b = C().settleTerminal(w.deps, { orderId: OID });   // the sweeper, concurrently
    await new Promise((r) => setTimeout(r, 20));
    release(); await Promise.all([a, b]);
    assert.strictEqual(w.fake.count('capture'), 1, `${L}: exactly ONE capture call for L1 (got ${w.fake.count('capture')})`);
    assert.strictEqual(legs(w.rec())[0].state, 'captured', `${L}: captured once`);
  });
  await cell('SDK-LOST-CAPTURE-INCONCLUSIVE-KEEPS-LOCK', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }], status: [{ state: 'inconclusive' }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock, `${L}: PREMISE — the lost capture locks`);
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    await C().settleTerminal(w.deps, { orderId: OID });
    assert.ok(w.rec().lock && w.fake.count('capture') === 1, `${L}: inconclusive status → lock kept, NO second capture (got lock ${JSON.stringify(w.rec().lock)}, captures ${w.fake.count('capture')})`);
    assert.ok(!R.isFinanciallyClosed(w.rec(), w.ord()), `${L}: not closed`);
  });
  await cell('SDK-LOST-CAPTURE-BOUND-STATUS-CAPTURED', async (L) => {
    const w = await placed({ script: { capture: [{ lost: true }] } });
    await w.db.ref(`orders/${OID}/status`).set('delivered');
    await C().settleTerminal(w.deps, { orderId: OID });
    w.tick(3 * 60 * 1000);
    await C().reconcile(w.deps, { orderId: OID });
    assert.ok(!w.rec().lock && legs(w.rec())[0].state === 'captured' && w.fake.count('capture') === 1, `${L}: the PSP did capture → status (bound, captured) resolves it; never a second capture`);
  });

  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nsdk coordinator: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('TEST FAILED:', e && e.stack || e); process.exit(1); });
