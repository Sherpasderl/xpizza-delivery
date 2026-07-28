/**
 * Emulator suite for Phase B1 Task 7 — confirm/completion settle + the consume-recovery sweep. Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-redeem-settle.emulator.test.js"
 * settleRedemptionAtConfirm maps a confirm/webhook disposition (consume | hold | release) onto a REDEEMED
 * order's reservation (no-op for non-redeemed); sweepConsumeRecovery catches holds stuck 'reserved' on an
 * order that already materialized/delivered/completed.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const R = require('../rewards-reserve');

const NOW = 1_700_000_000_000;

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const P = (u) => `user_rewards/${u}/x_pizza`;
    const bal = async (u) => (await db.ref(`${P(u)}/balance`).get()).val();
    const rsv = async (u) => (await db.ref(`${P(u)}/reserved`).get()).val() || 0;
    const st = async (u, o) => (await db.ref(`${P(u)}/reservations/${o}/state`).get()).val();
    const seedPts = (u, pts) => db.ref(P(u)).set({ balance: pts, lifetime: pts, ledger: { seed: { type: 'earn', delta: pts, ts: NOW } } });
    const canon = { restaurant_id: 'x_pizza', model: 'discount', type: 'discount_cheapest_pizza', config_version: 1, cost: 8, discount_cents: 29900, free_item_key: 'Margherita' };
    const reserve = (u, o) => R.reserveRedemption(db, { uid: u, rid: 'x_pizza', orderId: o, cost: 8, canonical: canon, orderFingerprint: 'FP', configVersion: 1, now: NOW });
    const seedOrder = (o, over) => db.ref(`orders/${o}`).set({ customer_uid: over.uid, restaurant_id: 'x_pizza', redemption: canon, ...over });

    // ── consumeEligible (pure predicate) ──
    assert.strictEqual(R.consumeEligible({ status: 'delivered' }), true);
    assert.strictEqual(R.consumeEligible({ status: 'completed' }), true);
    assert.strictEqual(R.consumeEligible({ status: 'new', payment_method: 'online', payment_status: 'confirmed' }), true);
    assert.strictEqual(R.consumeEligible({ status: 'new', payment_method: 'cash' }), false);          // cash not yet delivered → wait
    assert.strictEqual(R.consumeEligible({ status: 'pending_payment', payment_method: 'online', payment_status: 'confirmed' }), false);
    assert.strictEqual(R.consumeEligible({ status: 'scheduled', payment_method: 'online', payment_status: 'confirmed' }), false);
    assert.strictEqual(R.consumeEligible(null), false); ok('consumeEligible: delivered/completed + online-materialized-live → yes; cash-in-progress / pending / scheduled → no');

    // ── settle: consume (online primary / cash at completion) — once, idempotent ──
    await seedPts('uC', 20); await reserve('uC', 'OC'); await seedOrder('OC', { uid: 'uC', status: 'delivered', payment_method: 'cash' });
    const s1 = await R.settleRedemptionAtConfirm(db, { orderId: 'OC', order: (await db.ref('orders/OC').get()).val(), disposition: 'consume', now: NOW });
    assert.strictEqual(s1.action, 'applied'); assert.strictEqual(await bal('uC'), 12); assert.strictEqual(await rsv('uC'), 0); assert.strictEqual(await st('uC', 'OC'), 'consumed'); ok('settle(consume): balance 20→12, reserved 0, state consumed');
    const s2 = await R.settleRedemptionAtConfirm(db, { orderId: 'OC', order: (await db.ref('orders/OC').get()).val(), disposition: 'consume', now: NOW + 1 });
    assert.strictEqual(s2.action, 'noop'); assert.strictEqual(await bal('uC'), 12); ok('settle(consume) re-entry → noop (no double-debit — re-materialize safe)');

    // ── settle: hold (manual_review after capture) — held_paid, NOT released, points still held ──
    await seedPts('uH', 20); await reserve('uH', 'OH'); await seedOrder('OH', { uid: 'uH', status: 'pending_payment', payment_method: 'online', payment_status: 'manual_review' });
    const h = await R.settleRedemptionAtConfirm(db, { orderId: 'OH', order: (await db.ref('orders/OH').get()).val(), disposition: 'hold', now: NOW });
    assert.strictEqual(h.action, 'applied'); assert.strictEqual(await st('uH', 'OH'), 'held_paid'); assert.strictEqual(await rsv('uH'), 8); assert.strictEqual(await bal('uH'), 20); ok('settle(hold): state held_paid, reserved 8 (held, NOT released), balance untouched');

    // ── settle: release (unpaid abandon) — reserved → released ──
    await seedPts('uR', 20); await reserve('uR', 'OR'); await seedOrder('OR', { uid: 'uR', status: 'pending_payment', payment_method: 'online' });
    const rl = await R.settleRedemptionAtConfirm(db, { orderId: 'OR', order: (await db.ref('orders/OR').get()).val(), disposition: 'release', now: NOW });
    assert.strictEqual(rl.action, 'applied'); assert.strictEqual(await st('uR', 'OR'), 'released'); assert.strictEqual(await rsv('uR'), 0); ok('settle(release): reserved → released (points back to available)');

    // ── settle: non-redeemed order → skip (no reservation touched, no throw) ──
    await seedPts('uN', 20);
    const sn = await R.settleRedemptionAtConfirm(db, { orderId: 'ON', order: { customer_uid: 'uN', status: 'delivered' /* NO redemption */ }, disposition: 'consume', now: NOW });
    assert.strictEqual(sn.skipped, true); assert.strictEqual(await rsv('uN'), 0); ok('settle: non-redeemed order → skipped (no-op, no throw)');

    // ── sweepConsumeRecovery: consume a hold stuck 'reserved' on a materialized/completed order; leave others ──
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null);
    await seedPts('uSw', 30);
    await reserve('uSw', 'ODONE'); await seedOrder('ODONE', { uid: 'uSw', status: 'completed', payment_method: 'cash' });   // eligible → recover
    await reserve('uSw', 'OLIVE'); await seedOrder('OLIVE', { uid: 'uSw', status: 'new', payment_method: 'online', payment_status: 'confirmed' }); // eligible (materialized-live)
    await reserve('uSw', 'OWAIT'); await seedOrder('OWAIT', { uid: 'uSw', status: 'preparing', payment_method: 'cash' });   // cash not delivered → NOT eligible
    const sweep = await R.sweepConsumeRecovery(db, { now: NOW });
    assert.deepStrictEqual(sweep.consumed.map((x) => x.orderId).sort(), ['ODONE', 'OLIVE']);
    assert.strictEqual(await st('uSw', 'ODONE'), 'consumed'); assert.strictEqual(await st('uSw', 'OLIVE'), 'consumed'); assert.strictEqual(await st('uSw', 'OWAIT'), 'reserved'); ok('sweepConsumeRecovery: consumes reserved holds on completed + materialized-live orders; leaves cash-in-progress reserved');
    // balance debited by exactly the two recovered holds (8+8), reserved back to just the waiting one (8)
    assert.strictEqual(await bal('uSw'), 30 - 16); assert.strictEqual(await rsv('uSw'), 8); ok('sweepConsumeRecovery: balance debited by the 2 recovered holds only; the waiting hold stays reserved');
    // idempotent — re-run consumes nothing new (no double-debit)
    const sweep2 = await R.sweepConsumeRecovery(db, { now: NOW + 1 });
    assert.strictEqual(sweep2.consumed.length, 0); assert.strictEqual(await bal('uSw'), 14); ok('sweepConsumeRecovery re-run → 0 consumed (idempotent, no double-debit)');

    // ── [T7 R1] the online-expiry RELEASE must NOT release a PAID-but-consume-failed hold (free-redemption race) ──
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null);
    await seedPts('uRace', 20);
    // online hold whose expiry PASSED, but the order materialized PAID+LIVE and the primary consume fail-opened → still reserved
    await R.reserveRedemption(db, { uid: 'uRace', rid: 'x_pizza', orderId: 'ORACE', cost: 8, canonical: canon, orderFingerprint: 'FP', configVersion: 1, now: NOW, hostedExpiresAt: NOW - 1 });
    await seedOrder('ORACE', { uid: 'uRace', status: 'new', payment_method: 'online', payment_status: 'confirmed' });   // realized
    const relRace = await R.sweepStaleReservations(db, { now: NOW });
    assert.ok(!relRace.released.some((x) => x.orderId === 'ORACE'));
    assert.strictEqual(await st('uRace', 'ORACE'), 'reserved'); ok('release sweep: expired hold on a PAID+live order is NOT released (paid ≠ abandoned) — closes the free-redemption race');
    const recRace = await R.sweepConsumeRecovery(db, { now: NOW });
    assert.ok(recRace.consumed.some((x) => x.orderId === 'ORACE'));
    assert.strictEqual(await st('uRace', 'ORACE'), 'consumed'); assert.strictEqual(await bal('uRace'), 12); ok('consume-recovery then realizes the paid-but-consume-failed hold (20→12) — points spent, not freed');
    // a genuinely-abandoned expired online hold (order absent) IS still released
    await seedPts('uAb', 20);
    await R.reserveRedemption(db, { uid: 'uAb', rid: 'x_pizza', orderId: 'OAB2', cost: 8, canonical: canon, orderFingerprint: 'FP', configVersion: 1, now: NOW, hostedExpiresAt: NOW - 1 });   // expired, NO order
    const relAb = await R.sweepStaleReservations(db, { now: NOW });
    assert.ok(relAb.released.some((x) => x.orderId === 'OAB2' && x.kind === 'online_expired'));
    assert.strictEqual(await st('uAb', 'OAB2'), 'released'); ok('release sweep: expired hold on an ABANDONED (absent) order IS still released (genuine abandon)');

    // ── [T8] reverseRedemptionForOrder — the SINGLE-helper reversal cancelOrderCore + resolve-manual invoke ──
    await db.ref('user_rewards').set(null); await db.ref('orders').set(null);
    const revOrder = async (o, disp) => R.reverseRedemptionForOrder(db, { orderId: o, order: (await db.ref(`orders/${o}`).get()).val(), disposition: disp, now: NOW });
    // consumed → refund credits debit_applied back, once (retry no double)
    await seedPts('uRR', 20); await reserve('uRR', 'ORR'); await R.consumeRedemption(db, { uid: 'uRR', rid: 'x_pizza', orderId: 'ORR', now: NOW }); await seedOrder('ORR', { uid: 'uRR', status: 'cancelled' });
    assert.strictEqual(await bal('uRR'), 12);
    assert.strictEqual((await revOrder('ORR', 'refund')).action, 'refunded'); assert.strictEqual(await bal('uRR'), 20); ok('reverse(refund) consumed → balance +cost once (credit debit_applied)');
    assert.strictEqual((await revOrder('ORR', 'refund')).action, 'noop'); assert.strictEqual(await bal('uRR'), 20); ok('reverse(refund) consumed retry → noop (no double-credit)');
    // held_paid → refund releases the hold, NO balance credit
    await seedPts('uHP', 20); await reserve('uHP', 'OHP'); await R.markHeldPaid(db, { uid: 'uHP', rid: 'x_pizza', orderId: 'OHP', now: NOW }); await seedOrder('OHP', { uid: 'uHP', status: 'cancelled' });
    assert.strictEqual((await revOrder('OHP', 'refund')).action, 'released_held'); assert.strictEqual(await bal('uHP'), 20); assert.strictEqual(await rsv('uHP'), 0); ok('reverse(refund) held_paid → hold released, balance UNCHANGED (no double-credit)');
    // held_paid → sale consumes (manual finalize-to-sale)
    await seedPts('uSA', 20); await reserve('uSA', 'OSA'); await R.markHeldPaid(db, { uid: 'uSA', rid: 'x_pizza', orderId: 'OSA', now: NOW }); await seedOrder('OSA', { uid: 'uSA', status: 'new' });
    assert.strictEqual((await revOrder('OSA', 'sale')).action, 'consumed'); assert.strictEqual(await bal('uSA'), 12); ok('reverse(sale) held_paid → consumed (balance −cost once)');
    // reserved-unpaid → refund releases
    await seedPts('uRE', 20); await reserve('uRE', 'ORE'); await seedOrder('ORE', { uid: 'uRE', status: 'cancelled' });
    assert.strictEqual((await revOrder('ORE', 'refund')).action, 'released'); assert.strictEqual(await rsv('uRE'), 0); ok('reverse(refund) reserved-unpaid → released');
    // non-redeemed → skip (no reservation, no throw)
    assert.strictEqual((await R.reverseRedemptionForOrder(db, { orderId: 'ONO', order: { customer_uid: 'x', status: 'cancelled' }, disposition: 'refund', now: NOW })).skipped, true); ok('reverse non-redeemed order → skipped (no-op)');
  });

  await env.cleanup();
  console.log(`\nrewards-redeem-settle: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
