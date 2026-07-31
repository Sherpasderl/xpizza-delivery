/**
 * Emulator test for [A — refund/cancel ledger ATOMICITY]: the durable ledger-repair retry.
 * Run: firebase emulators:exec --only database --project demo-xpizza "node test/reward-ledger-repair.emulator.test.js"
 *
 * When a cancel commits but the earn-clawback / redemption-reversal FAILS, cancelOrderCore journals a
 * `reward_ledger_repair/${orderId}` record (never swallows). retryRewardLedgerRepair (run on the 5-min
 * sweepStalePending) re-runs BOTH reversals — idempotent (order_id-keyed), so it heals the divergence WITHOUT
 * double-reversing, then clears the record. This proves: heals a diverged ledger, no double-reverse on retry,
 * order-gone is cleaned up, and the `ok` failure-discriminator on reverseEarnForOrder.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { retryRewardLedgerRepair } = require('../cancel-order-core');
const { reverseEarnForOrder } = require('../rewards-earn');

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const bal = async (u, r) => (await db.ref(`user_rewards/${u}/${r}/balance`).get()).val();
    const lkey = async (u, r, k) => (await db.ref(`user_rewards/${u}/${r}/ledger/${k}`).get()).val();
    const resvState = async (u, r, o) => (await db.ref(`user_rewards/${u}/${r}/reservations/${o}/state`).get()).val();
    const repair = async (o) => (await db.ref(`reward_ledger_repair/${o}`).get()).val();
    const alerts = []; const alert = async (kind, detail) => { alerts.push({ kind, detail }); };
    const deps = { db, alert };

    // ── Seed a cancelled, redeemed+earned X. Pizza order whose reversals "failed" during cancel (repair journaled).
    //    balance 3 = the earn (reserved 0, so the clawback can reclaim it); reservation CONSUMED (8 debited).
    await db.ref('orders/ORD').set({ customer_uid: 'u1', restaurant_id: 'x_pizza', status: 'cancelled',
      redemption: { model: 'add_free', free_item_key: 'Margherita' } });
    await db.ref('user_rewards/u1/x_pizza').set({ balance: 3, lifetime: 3, reserved: 0,
      ledger: { earn_ORD: { type: 'earn', delta: 3, order_id: 'ORD', ts: 1, config_version: 2 } },
      reservations: { ORD: { state: 'consumed', cost: 8, debit_applied: 8, seq: 1, updated_at: 1 } } });
    await db.ref('reward_ledger_repair/ORD').set({ order_id: 'ORD', disposition: 'refund',
      earn_failed: true, redemption_failed: true, reason: 'cancel', first_failed_at: 1, attempts: 0 });

    // 1 — retry HEALS: earn clawed back (3→0) AND redemption refunded (consumed→refunded, +8 debit_applied),
    //     the repair record cleared, no alert. Net balance = 0 (earn reversed) + 8 (redemption refund) = 8.
    let r = await retryRewardLedgerRepair(deps, { now: 1000 });
    assert.deepStrictEqual(r, { healed: 1, pending: 0 });
    assert.strictEqual((await lkey('u1', 'x_pizza', 'reverse_ORD')).delta, -3); ok('retry: earn clawed back (reverse_ORD delta -3)');
    assert.strictEqual(await resvState('u1', 'x_pizza', 'ORD'), 'refunded'); ok('retry: redemption reversed (reservation consumed → refunded)');
    assert.strictEqual(await bal('u1', 'x_pizza'), 8); ok('retry: net balance 8 (earn -3 then redemption refund +8), never mints');
    assert.strictEqual(await repair('ORD'), null); ok('retry: repair record CLEARED once the ledger is consistent');
    assert.strictEqual(alerts.length, 0); ok('retry: a clean heal raises NO alert');

    // 2 — idempotency: the record is gone → a second sweep is a no-op; the ledger never double-reverses.
    r = await retryRewardLedgerRepair(deps, { now: 1100 });
    assert.deepStrictEqual(r, { healed: 0, pending: 0 });
    assert.strictEqual(await bal('u1', 'x_pizza'), 8); assert.strictEqual((await lkey('u1', 'x_pizza', 'reverse_ORD')).delta, -3); ok('retry idempotent: no repair record → no re-reversal (balance still 8)');

    // 3 — [A revise] a PURGED order must NOT orphan a diverged ledger: an ENRICHED record (uid/rid/has_redemption)
    //     heals INDEPENDENTLY of the order node. Seed the divergence with NO orders/PURGED present.
    await db.ref('user_rewards/u3/x_pizza').set({ balance: 3, lifetime: 3, reserved: 0,
      ledger: { earn_PURGED: { type: 'earn', delta: 3, order_id: 'PURGED', ts: 1, config_version: 2 } },
      reservations: { PURGED: { state: 'consumed', cost: 8, debit_applied: 8, seq: 1, updated_at: 1 } } });
    await db.ref('reward_ledger_repair/PURGED').set({ order_id: 'PURGED', disposition: 'refund',
      uid: 'u3', rid: 'x_pizza', has_redemption: true, earn_failed: true, redemption_failed: true, attempts: 0 });
    r = await retryRewardLedgerRepair(deps, { now: 1200 });
    assert.strictEqual((await lkey('u3', 'x_pizza', 'reverse_PURGED')).delta, -3);
    assert.strictEqual(await resvState('u3', 'x_pizza', 'PURGED'), 'refunded');
    assert.strictEqual(await bal('u3', 'x_pizza'), 8); assert.strictEqual(await repair('PURGED'), null); ok('retry: a PURGED order with an enriched record still HEALS from stored coords (never silently orphaned)');

    // 3b — a legacy (pre-enrich) record with NO uid AND a purged order → CANNOT heal → orphan ALERT + record KEPT
    //      (never silently dropped: the divergence stays visible to a human, not lost).
    await db.ref('reward_ledger_repair/LEGACY').set({ order_id: 'LEGACY', disposition: 'refund', attempts: 0 });
    r = await retryRewardLedgerRepair(deps, { now: 1250 });
    assert.notStrictEqual(await repair('LEGACY'), null); ok('retry: legacy record + purged order → KEPT, not silently removed');
    assert.ok(alerts.some((a) => a.kind === 'reward_reversal_orphaned' && a.detail && a.detail.orderId === 'LEGACY')); ok('retry: unhealable orphan → reward_reversal_orphaned alert (visible, never lost)');

    // 4 — reverseEarnForOrder ok-discriminator: a legit no-op (never-earned order) is ok:true (nothing to repair).
    await db.ref('orders/ONE').set({ customer_uid: 'u1', restaurant_id: 'x_pizza', items: [{ qty: 1 }] });
    assert.deepStrictEqual(await reverseEarnForOrder(db, { orderId: 'ONE', order: (await db.ref('orders/ONE').get()).val(), now: 1300 }), { reversed: false, ok: true }); ok('reverseEarnForOrder: never-earned → { reversed:false, ok:true } (no-op, not a failure)');
  });

  await env.cleanup();
  console.log(`\nreward-ledger-repair: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
