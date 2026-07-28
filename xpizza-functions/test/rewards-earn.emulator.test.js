/**
 * Emulator behavioral suite for the earn engine (rewards-earn.js). Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-earn.emulator.test.js"
 * Asserts balance + lifetime + the deterministic-key ledger + idempotency for earn / welcome / reversal
 * (admin-context db, rules disabled — these are Admin-SDK-only writes). Every mutation is ONE transaction on
 * user_rewards/{uid}/{rid} keyed by a deterministic ledger id (earn_${orderId} / welcome_${ph}_${rid} /
 * reverse_${orderId}); that ledger key is the at-most-once authority AND the reversal-amount source — there
 * is no order-node marker. Also covers the codex-R1 guards: deleted_uids no-recreate + non-negative clamp.
 * Plain-node style.
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
    const lkey = async (u, r, k) => (await db.ref(`user_rewards/${u}/${r}/ledger/${k}`).get()).val();
    const node = async (u) => (await db.ref(`user_rewards/${u}`).get()).val();
    const load = async (o) => (await db.ref(`orders/${o}`).get()).val();

    // 1 — x_pizza delivery, 2 pizzas → 2 punches; idempotent via the earn_${orderId} ledger key
    await db.ref('orders/O1').set({ customer_uid: 'uidA', restaurant_id: 'x_pizza', items: [{ qty: 2 }] });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 100 }), { credited: true, delta: 2 });
    assert.strictEqual(await bal('uidA', 'x_pizza'), 2); assert.strictEqual(await life('uidA', 'x_pizza'), 2);
    assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 1);
    const e1 = await lkey('uidA', 'x_pizza', 'earn_O1'); assert.strictEqual(e1.delta, 2); assert.strictEqual(e1.type, 'earn');
    ok('x_pizza 2 pizzas → +2 punches, deterministic earn_O1 ledger entry {delta:2}');
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 101 })).credited, false);
    assert.strictEqual(await bal('uidA', 'x_pizza'), 2); assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 1); ok('second earn call = NO-OP (same key → balance + ledger unchanged)');

    // 2 — la_musa, subtotal 70000c → floor(70000/3000)=23 → 230 points
    await db.ref('orders/O2').set({ customer_uid: 'uidB', restaurant_id: 'la_musa', subtotal_cents: 70000 });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'O2', order: await load('O2'), now: 200 }), { credited: true, delta: 230 });
    assert.strictEqual(await bal('uidB', 'la_musa'), 230); ok('la_musa 70000c → +230 points (10 pts / 30 L)');

    // 3 — guest (no customer_uid) → NO-OP
    await db.ref('orders/O3').set({ restaurant_id: 'x_pizza', items: [{ qty: 1 }] });
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'O3', order: await load('O3'), now: 300 })).credited, false); ok('guest order → NO-OP (no credit)');

    // 4 — welcome, once per phone_hash per brand
    assert.deepStrictEqual(await creditWelcome(db, { uid: 'uidC', phoneHash: 'phX', restaurantId: 'x_pizza', now: 400 }), { credited: true });
    assert.strictEqual(await bal('uidC', 'x_pizza'), 2); assert.strictEqual(await life('uidC', 'x_pizza'), 2); ok('welcome x_pizza → +2 punches + lifetime');
    assert.strictEqual((await creditWelcome(db, { uid: 'uidC', phoneHash: 'phX', restaurantId: 'x_pizza', now: 401 })).credited, false);
    assert.strictEqual(await bal('uidC', 'x_pizza'), 2); ok('second welcome same phone_hash → NO-OP (tombstoned)');

    // 5 — reversal of the earned O1 (uidA had 2); reads the authoritative earn_O1 entry, writes reverse_O1
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 500 }), { reversed: true });
    assert.strictEqual(await bal('uidA', 'x_pizza'), 0); assert.strictEqual(await life('uidA', 'x_pizza'), 2); ok('reverse earned order → balance -2 (=0), lifetime UNCHANGED (2)');
    assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 2); assert.strictEqual((await lkey('uidA', 'x_pizza', 'reverse_O1')).delta, -2); ok('clawback appended as reverse_O1 (2 ledger entries)');
    assert.strictEqual((await reverseEarnForOrder(db, { orderId: 'O1', order: await load('O1'), now: 501 })).reversed, false);
    assert.strictEqual(await bal('uidA', 'x_pizza'), 0); assert.strictEqual(await ledgerN('uidA', 'x_pizza'), 2); ok('second reverse = NO-OP (same key → no double-debit)');
    // reversing a never-earned order → no-op
    await db.ref('orders/O9').set({ customer_uid: 'uidA', restaurant_id: 'x_pizza', items: [{ qty: 1 }] });
    assert.strictEqual((await reverseEarnForOrder(db, { orderId: 'O9', order: await load('O9'), now: 600 })).reversed, false); ok('reverse a never-earned order → NO-OP');

    // 6 — trigger gate (earnRewardsOnCompletion): 'ready' earns nothing; 'delivered' credits once
    await db.ref('orders/O7').set({ customer_uid: 'uidD', restaurant_id: 'x_pizza', items: [{ qty: 3 }] });
    assert.strictEqual((await onStatus(db, 'O7', 'ready', 700)).credited, false);
    assert.strictEqual(await bal('uidD', 'x_pizza'), null); assert.strictEqual(await lkey('uidD', 'x_pizza', 'earn_O7'), null); ok('status=ready → NO earn (no ledger key, no balance)');
    assert.deepStrictEqual(await onStatus(db, 'O7', 'delivered', 701), { credited: true, delta: 3 });
    assert.strictEqual(await bal('uidD', 'x_pizza'), 3); assert.strictEqual(await ledgerN('uidD', 'x_pizza'), 1); ok('status=delivered → +3 punches, 1 ledger entry');
    assert.strictEqual((await onStatus(db, 'O7', 'completed', 702)).credited, false);
    assert.strictEqual(await bal('uidD', 'x_pizza'), 3); ok('a later terminal write → NO double-credit (earn_O7 at-most-once)');

    // 7 — welcome tombstone survives account deletion (un-farmable across delete + re-login)
    assert.deepStrictEqual(await creditWelcome(db, { uid: 'uidE', phoneHash: 'phZ', restaurantId: 'la_musa', now: 800 }), { credited: true });
    assert.strictEqual(await bal('uidE', 'la_musa'), 100); ok('la_musa welcome → +100 points (first login)');
    await db.ref('user_rewards/uidE').set(null);   // account deletion nulls user_rewards (Task 6) but NOT reward_welcome
    assert.strictEqual((await creditWelcome(db, { uid: 'uidG', phoneHash: 'phZ', restaurantId: 'la_musa', now: 801 })).credited, false);
    assert.strictEqual(await bal('uidG', 'la_musa'), null); ok('re-login same phone after deletion → NO re-credit (tombstone persists)');
    // same phone, DIFFERENT brand → its own welcome (per-brand tombstone)
    assert.deepStrictEqual(await creditWelcome(db, { uid: 'uidG', phoneHash: 'phZ', restaurantId: 'x_pizza', now: 802 }), { credited: true });
    assert.strictEqual(await bal('uidG', 'x_pizza'), 2); ok('same phone, other brand → earns that brand\'s welcome (+2)');

    // 8 — [codex HIGH-1] deleted_uids tombstone → NEVER recreate a purged node (earn / welcome / reverse)
    await db.ref('deleted_uids/uidDel').set(1700000000000);
    await db.ref('orders/OD1').set({ customer_uid: 'uidDel', restaurant_id: 'x_pizza', items: [{ qty: 2 }] });
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'OD1', order: await load('OD1'), now: 900 })).credited, false);
    assert.strictEqual(await node('uidDel'), null); ok('earn on a deleted (tombstoned) uid → NO-OP, node NOT recreated (no zombie ledger)');
    assert.strictEqual((await creditWelcome(db, { uid: 'uidDel', phoneHash: 'phDel', restaurantId: 'x_pizza', now: 901 })).credited, false);
    assert.strictEqual(await node('uidDel'), null); assert.strictEqual((await db.ref('reward_welcome/phDel').get()).val(), null); ok('welcome on a deleted uid → NO-OP, no node + no tombstone written');
    assert.strictEqual((await reverseEarnForOrder(db, { orderId: 'OD1', order: await load('OD1'), now: 902 })).reversed, false);
    assert.strictEqual(await node('uidDel'), null); ok('reverse on a deleted uid → NO-OP, node NOT recreated');

    // 9 — [codex MED-3] reversal clamps balance to >= 0 even when the earned delta exceeds the live balance;
    //     lifetime untouched. (Simulates a partial-spend / drift where balance < the recorded earn.)
    await db.ref('user_rewards/uidClamp/x_pizza').set({ balance: 1, lifetime: 5, ledger: { earn_OX: { type: 'earn', delta: 5, ts: 1, config_version: 1 } } });
    await db.ref('orders/OX').set({ customer_uid: 'uidClamp', restaurant_id: 'x_pizza', items: [{ qty: 5 }] });
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'OX', order: await load('OX'), now: 1000 }), { reversed: true });
    assert.strictEqual(await bal('uidClamp', 'x_pizza'), 0); ok('reversal clamps balance to 0 (1 - 5 → 0, never negative)');
    assert.strictEqual(await life('uidClamp', 'x_pizza'), 5); ok('reversal leaves lifetime untouched (5)');

    // 10 — [codex R2] TOCTOU: a deletion lands BETWEEN the pre-guard read and the post-commit re-check.
    //      Simulated with a db.ref shim whose deleted_uids read is null on call #1 (pre-guard, so the credit
    //      proceeds and the tx recreates the node) and tombstoned on call #2 (post-commit re-check → compensate).
    //      Final state must have NO user_rewards/{uid}. Shared creditNode → covers BOTH earn and welcome.
    const raceDbFor = (uid, tomb) => { let reads = 0;
      const stagedGet = async () => { reads += 1; return { val: () => (reads >= 2 ? tomb : null) }; };
      const shim = { ref: (path) => (path === `deleted_uids/${uid}`) ? { get: stagedGet } : db.ref(path), _reads: () => reads };
      return shim;
    };
    // earn racing a deletion
    await db.ref('orders/ORACE').set({ customer_uid: 'uidRaceE', restaurant_id: 'x_pizza', items: [{ qty: 2 }] });
    const rdE = raceDbFor('uidRaceE', 1700000000000);
    const re = await creditEarnForOrder(rdE, { orderId: 'ORACE', order: await load('ORACE'), now: 1100 });
    assert.strictEqual(re.credited, false); ok('earn racing a deletion → reported NOT credited');
    assert.strictEqual(await node('uidRaceE'), null); assert.strictEqual(rdE._reads(), 2); ok('TOCTOU earn: post-commit re-check purged the recreated zombie node (both reads ran)');
    // welcome racing a deletion (same creditNode compensation)
    const rdW = raceDbFor('uidRaceW', 1700000000000);
    const rw = await creditWelcome(rdW, { uid: 'uidRaceW', phoneHash: 'phRaceW', restaurantId: 'la_musa', now: 1200 });
    assert.strictEqual(rw.credited, false); assert.strictEqual(await node('uidRaceW'), null); ok('TOCTOU welcome: recreated zombie node purged by the post-commit re-check');

    // 11 — [B1 money-gate Part 1] a clawback reclaims ONLY uncommitted balance (balance − reserved), so it
    //      can never drop balance below points held by an in-flight redemption (maintains balance >= reserved).
    await db.ref('user_rewards/uRsv/x_pizza').set({ balance: 8, lifetime: 8, reserved: 8, ledger: { earn_OE: { type: 'earn', delta: 8, order_id: 'OE', ts: 1, config_version: 1 } } });
    await db.ref('orders/OE').set({ customer_uid: 'uRsv', restaurant_id: 'x_pizza', items: [{ qty: 8 }] });
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'OE', order: await load('OE'), now: 1300 }), { reversed: true });
    assert.strictEqual(await bal('uRsv', 'x_pizza'), 8); ok('clawback with balance==reserved → 0 reclaimed (balance stays 8 ≥ reserved 8, no under-collateralization)');
    // partially committed: balance 8, reserved 3, earn 8 → reclaim only the uncommitted 5 → balance 3 (== reserved)
    await db.ref('user_rewards/uRsv2/x_pizza').set({ balance: 8, lifetime: 8, reserved: 3, ledger: { earn_OF: { type: 'earn', delta: 8, order_id: 'OF', ts: 1, config_version: 1 } } });
    await db.ref('orders/OF').set({ customer_uid: 'uRsv2', restaurant_id: 'x_pizza', items: [{ qty: 8 }] });
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'OF', order: await load('OF'), now: 1301 }), { reversed: true });
    assert.strictEqual(await bal('uRsv2', 'x_pizza'), 3); ok('clawback partially-committed → reclaims only uncommitted (5), balance 3 == reserved 3 (invariant held)');

    // ── [Task 9] earn EXCLUDES the redeemed free unit ──
    // x_pizza: 3 pizzas, 1 redeemed-free → earns 2 punches (not 3)
    await db.ref('orders/ORX').set({ customer_uid: 'uidRX', restaurant_id: 'x_pizza', items: [{ qty: 3 }], redemption: { model: 'discount' } });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'ORX', order: await load('ORX'), now: 1400 }), { credited: true, delta: 2 });
    assert.strictEqual(await bal('uidRX', 'x_pizza'), 2); ok('x_pizza redeemed (3 pizzas, 1 freed) → earns 2 punches (not 3)');
    // a wholly-free order (single freed pizza) → 0 earn
    await db.ref('orders/ORX1').set({ customer_uid: 'uidRX1', restaurant_id: 'x_pizza', items: [{ qty: 1 }], redemption: { model: 'discount' } });
    assert.strictEqual((await creditEarnForOrder(db, { orderId: 'ORX1', order: await load('ORX1'), now: 1401 })).credited, false);
    assert.strictEqual(await bal('uidRX1', 'x_pizza'), null); ok('x_pizza single freed pizza → 0 earn (no punch for a wholly-free order)');
    // la_musa: earns on the PAID subtotal only (add_free item is 0-price, absent from subtotal_cents → no adjustment)
    await db.ref('orders/ORL').set({ customer_uid: 'uidRL', restaurant_id: 'la_musa', subtotal_cents: 60000, redemption: { model: 'add_free' } });
    assert.deepStrictEqual(await creditEarnForOrder(db, { orderId: 'ORL', order: await load('ORL'), now: 1402 }), { credited: true, delta: 200 });   // floor(60000/3000)*10
    assert.strictEqual(await bal('uidRL', 'la_musa'), 200); ok('la_musa redeemed → earns on paid subtotal only (add_free item excluded)');
    // the refund reverses the ADJUSTED amount (reads earn_ORX.delta = 2, not the pre-adjustment 3)
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'ORX', order: await load('ORX'), now: 1500 }), { reversed: true });
    assert.strictEqual(await bal('uidRX', 'x_pizza'), 0); ok('refund reverses the ADJUSTED earn (2 → balance 0), not the pre-adjustment 3');
  });

  await env.cleanup();
  console.log(`\nrewards-earn: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
