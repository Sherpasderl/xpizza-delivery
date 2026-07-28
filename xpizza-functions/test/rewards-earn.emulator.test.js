/**
 * Emulator behavioral suite for the earn engine (rewards-earn.js). Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-earn.emulator.test.js"
 * Asserts balance + lifetime + ledger + idempotency markers for earn / welcome / reversal (admin-context
 * db, rules disabled — these are Admin-SDK-only writes). Plain-node style.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { creditEarnForOrder, creditWelcome, reverseEarnForOrder } = require('../rewards-earn');
const { shouldEarnOnStatus } = require('../rewards-core');

// Mirrors the earnRewardsOnCompletion trigger body: gate on the status, then credit the loaded order.
const onStatus = async (db, orderId, after, now) => {
  if (!shouldEarnOnStatus(after)) return { credited: false, delta: 0 };
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  return creditEarnForOrder(db, { orderId, order, now });
};

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const bal = async (u, r) => (await db.ref(`user_rewards/${u}/${r}/balance`).get()).val();
    const life = async (u, r) => (await db.ref(`user_rewards/${u}/${r}/lifetime`).get()).val();
    const ledgerN = async (u, r) => { const s = await db.ref(`user_rewards/${u}/${r}/ledger`).get(); return s.exists() ? Object.keys(s.val()).length : 0; };
    const marker = async (o, k) => (await db.ref(`orders/${o}/${k}`).get()).val();
    const load = async (o) => (await db.ref(`orders/${o}`).get()).val();

    // 1 — x_pizza delivery, 2 pizzas → 2 punches; idempotent
    await db.ref('orders/O1').set({ customer_uid: 'uidA', restaurant_id: 'x_pizza', items: [{ qty: 2 }] });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 100 }), { credited: true, delta: 2 });
    assert.strictEqual(await bal('uidA', 'x_pizza'), 2); assert.strictEqual(await life('uidA', 'x_pizza'), 2);
    assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 1);
    const m1 = await marker('O1', 'rewards_earned_at'); assert.strictEqual(m1.delta, 2); ok('x_pizza 2 pizzas → +2 punches, marker {delta:2}, 1 ledger entry');
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 101 })).credited, false);
    assert.strictEqual(await bal('uidA', 'x_pizza'), 2); assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 1); ok('second earn call = NO-OP (balance + ledger unchanged)');

    // 2 — la_musa, subtotal 70000c → 280 points
    await db.ref('orders/O2').set({ customer_uid: 'uidB', restaurant_id: 'la_musa', subtotal_cents: 70000 });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'O2', order: await load('O2'), now: 200 }), { credited: true, delta: 280 });
    assert.strictEqual(await bal('uidB', 'la_musa'), 280); ok('la_musa 70000c → +280 points');

    // 3 — guest (no customer_uid) → NO-OP, no user_rewards node
    await db.ref('orders/O3').set({ restaurant_id: 'x_pizza', items: [{ qty: 1 }] });
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'O3', order: await load('O3'), now: 300 })).credited, false);
    assert.strictEqual((await marker('O3', 'rewards_earned_at')), null); ok('guest order → NO-OP (no marker, no credit)');

    // 4 — welcome, once per phone_hash per brand
    assert.deepStrictEqual(await creditWelcome(db, { uid: 'uidC', phoneHash: 'phX', restaurantId: 'x_pizza', now: 400 }), { credited: true });
    assert.strictEqual(await bal('uidC', 'x_pizza'), 2); assert.strictEqual(await life('uidC', 'x_pizza'), 2); ok('welcome x_pizza → +2 punches + lifetime');
    assert.strictEqual((await creditWelcome(db, { uid: 'uidC', phoneHash: 'phX', restaurantId: 'x_pizza', now: 401 })).credited, false);
    assert.strictEqual(await bal('uidC', 'x_pizza'), 2); ok('second welcome same phone_hash → NO-OP (tombstoned)');

    // 5 — reversal of the earned O1 (uidA had 2)
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 500 }), { reversed: true });
    assert.strictEqual(await bal('uidA', 'x_pizza'), 0); assert.strictEqual(await life('uidA', 'x_pizza'), 2); ok('reverse earned order → balance -2 (=0), lifetime UNCHANGED (2), clawback ledger');
    assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 2); ok('clawback appended (2 ledger entries)');
    assert.strictEqual((await reverseEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 501 })).reversed, false);
    assert.strictEqual(await bal('uidA', 'x_pizza'), 0); ok('second reverse = NO-OP (no double-debit)');
    // reversing a never-earned order → no-op
    await db.ref('orders/O9').set({ customer_uid: 'uidA', restaurant_id: 'x_pizza', items: [{ qty: 1 }] });
    assert.strictEqual((await reverseEarnForOrder(db, { orderId: 'O9', order: await load('O9'), now: 600 })).reversed, false); ok('reverse a never-earned order → NO-OP');

    // 6 — trigger gate (earnRewardsOnCompletion): 'ready' earns nothing; 'delivered' credits once
    await db.ref('orders/O7').set({ customer_uid: 'uidD', restaurant_id: 'x_pizza', items: [{ qty: 3 }] });
    assert.strictEqual((await onStatus(db, 'O7', 'ready', 700)).credited, false);
    assert.strictEqual(await bal('uidD', 'x_pizza'), null); assert.strictEqual((await marker('O7', 'rewards_earned_at')), null); ok('status=ready → NO earn (no marker, no balance)');
    assert.deepStrictEqual(await onStatus(db, 'O7', 'delivered', 701), { credited: true, delta: 3 });
    assert.strictEqual(await bal('uidD', 'x_pizza'), 3); assert.strictEqual(await ledgerN('uidD', 'x_pizza'), 1); ok('status=delivered → +3 punches, 1 ledger entry');
    assert.strictEqual((await onStatus(db, 'O7', 'completed', 702)).credited, false);
    assert.strictEqual(await bal('uidD', 'x_pizza'), 3); ok('a later terminal write → NO double-credit (marker at-most-once)');
  });

  await env.cleanup();
  console.log(`\nrewards-earn: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
