/**
 * Emulator suite for claimOrder — retro-credit a guest order's loyalty earn on profile-claim (MONEY-PATH).
 * Run: firebase emulators:exec --only database --project demo-xpizza "node test/claim-order.emulator.test.js"
 * Proves the money-safety of the atomic bind + idempotent credit: double-claim (same/different uid) → single
 * credit; phone-mismatch / token-mismatch / cancelled / tombstoned / path-injection → 403; bind-only then
 * completion → one credit; cancel-after-claim → reversed.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { claimOrderCore } = require('../claim-order');
const { creditEarnForOrder, reverseEarnForOrder } = require('../rewards-earn');
const { phoneHash } = require('../otp-lib');

const NOW = 1_700_000_000_000;

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const bal = async (u) => (await db.ref(`user_rewards/${u}/x_pizza/balance`).get()).val() || 0;
    const boundUid = async (o) => (await db.ref(`orders/${o}/customer_uid`).get()).val() || null;
    const PHONE = '+50499990000';
    // A verified profile whose phone_hash matches the order's phone.
    const seedProfile = (uid, phone = PHONE) => db.ref(`user_profiles/${uid}`).set({ phone_hash: phoneHash(phone), created_at: NOW });
    const seedOrder = (o, extra = {}) => db.ref(`orders/${o}`).set({
      order_id: o, customer_phone: PHONE, restaurant_id: 'x_pizza', order_type: 'delivery', total: 897,
      subtotal_cents: 78000, items: [{ name: 'Margherita', qty: 3 }], items_text: '3x Margherita', status: 'delivered',
      tracking_token: 'Trk' + o, ...extra,
    });
    const seedTrk = (tok, o) => db.ref(`order_tracking/${tok}`).set({ order_id: o, restaurant_id: 'x_pizza' });
    const reset = async () => { await db.ref('user_rewards').set(null); await db.ref('user_orders').set(null); await db.ref('orders').set(null); await db.ref('order_tracking').set(null); await db.ref('user_profiles').set(null); await db.ref('deleted_uids').set(null); };

    // 1 — tokenless valid claim of a terminal order → binds + credits (3 pizzas → 3 punches)
    await reset(); await seedProfile('u1'); await seedOrder('O1');
    let r = await claimOrderCore(db, { uid: 'u1', orderId: 'O1', token: null, now: NOW });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.credited, true); assert.strictEqual(r.body.delta, 3); assert.strictEqual(r.body.unit, 'punch');
    assert.strictEqual(await bal('u1'), 3); assert.strictEqual(await boundUid('O1'), 'u1');
    assert.ok((await db.ref('user_orders/u1/O1').get()).exists()); ok('tokenless terminal claim → binds + credits 3, balance 3, user_orders written');

    // 2 — double-claim SAME uid (idempotent replay) → still 3, not 6
    r = await claimOrderCore(db, { uid: 'u1', orderId: 'O1', token: null, now: NOW });
    assert.strictEqual(r.status, 200); assert.strictEqual(await bal('u1'), 3); ok('double-claim same uid → idempotent (balance still 3, no double grant)');

    // 3 — double-claim DIFFERENT uid → 403 (order already bound to u1), no credit for u2
    await seedProfile('u2');
    r = await claimOrderCore(db, { uid: 'u2', orderId: 'O1', token: null, now: NOW });
    assert.strictEqual(r.status, 403); assert.strictEqual(await bal('u2'), 0); assert.strictEqual(await boundUid('O1'), 'u1'); ok('double-claim different uid → 403 (bound by another), no second credit');

    // 4 — token path: valid token↔order bind → binds + credits
    await reset(); await seedProfile('u4'); await seedOrder('O4'); await seedTrk('Tok4abcd', 'O4');
    r = await claimOrderCore(db, { uid: 'u4', orderId: 'O4', token: 'Tok4abcd', now: NOW });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.credited, true); assert.strictEqual(await bal('u4'), 3); ok('token path (valid bind) → binds + credits');

    // 5 — token bound to a DIFFERENT order → 403
    await seedTrk('TokX9999', 'OTHER');
    r = await claimOrderCore(db, { uid: 'u4', orderId: 'O4', token: 'TokX9999', now: NOW });
    assert.strictEqual(r.status, 403); ok('token↔order mismatch → 403');

    // 6 — phone-mismatch → 403 (profile phone ≠ order phone)
    await reset(); await seedProfile('u6', '+50488887777'); await seedOrder('O6');   // order phone is PHONE, profile hash differs
    r = await claimOrderCore(db, { uid: 'u6', orderId: 'O6', token: null, now: NOW });
    assert.strictEqual(r.status, 403); assert.strictEqual(await boundUid('O6'), null); assert.strictEqual(await bal('u6'), 0); ok('phone-mismatch → 403, no bind, no credit');

    // 7 — path-injection order_id / token → 403
    await reset(); await seedProfile('u7');
    assert.strictEqual((await claimOrderCore(db, { uid: 'u7', orderId: 'bad/../evil', token: null, now: NOW })).status, 403);
    assert.strictEqual((await claimOrderCore(db, { uid: 'u7', orderId: 'O7', token: 'bad/../tok', now: NOW })).status, 403); ok('path-injection order_id / token → 403');

    // 8 — cancelled order → 403 (no bind)
    await reset(); await seedProfile('u8'); await seedOrder('O8', { status: 'cancelled' });
    r = await claimOrderCore(db, { uid: 'u8', orderId: 'O8', token: null, now: NOW });
    assert.strictEqual(r.status, 403); assert.strictEqual(await boundUid('O8'), null); ok('cancelled order → 403, no bind');
    // cancel-in-progress (resolving_action:cancel + cancel_claim_id) → 403
    await seedOrder('O8b', { status: 'new', resolving_action: 'cancel', cancel_claim_id: 'c1' });
    assert.strictEqual((await claimOrderCore(db, { uid: 'u8', orderId: 'O8b', token: null, now: NOW })).status, 403); ok('cancel-in-progress (resolving_action+cancel_claim_id) → 403');

    // 9 — tombstoned uid → 403 (no bind)
    await reset(); await seedProfile('u9'); await seedOrder('O9'); await db.ref('deleted_uids/u9').set({ ts: NOW });
    r = await claimOrderCore(db, { uid: 'u9', orderId: 'O9', token: null, now: NOW });
    assert.strictEqual(r.status, 403); assert.strictEqual(await boundUid('O9'), null); ok('tombstoned uid → 403, no bind');

    // 10 — no profile / no phone_hash → 403
    await reset(); await seedOrder('O10');
    r = await claimOrderCore(db, { uid: 'uNoProf', orderId: 'O10', token: null, now: NOW });
    assert.strictEqual(r.status, 403); ok('no profile / no phone_hash → 403');

    // 11 — bind-only (non-terminal) then completion → credits ONCE (not twice with claimOrder)
    await reset(); await seedProfile('u11'); await seedOrder('O11', { status: 'new' });
    r = await claimOrderCore(db, { uid: 'u11', orderId: 'O11', token: null, now: NOW });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.credited, false); assert.strictEqual(r.body.delta, 0);
    assert.strictEqual(await boundUid('O11'), 'u11'); assert.strictEqual(await bal('u11'), 0); ok('bind-only (non-terminal) → binds, NOT yet credited (balance 0)');
    // completion fires earnRewardsOnCompletion == creditEarnForOrder on the now-bound order → credits once
    const committed = (await db.ref('orders/O11').get()).val();
    await creditEarnForOrder(db, { orderId: 'O11', order: { ...committed, status: 'delivered' }, now: NOW });
    assert.strictEqual(await bal('u11'), 3);
    await creditEarnForOrder(db, { orderId: 'O11', order: { ...committed, status: 'delivered' }, now: NOW });   // replay
    assert.strictEqual(await bal('u11'), 3); ok('completion credits once (idempotent on earn_${orderId}); replay no-ops');

    // 12 — cancel-after-claim → reverseEarnForOrder reverses the credited delta (3 → 0)
    await reset(); await seedProfile('u12'); await seedOrder('O12');
    await claimOrderCore(db, { uid: 'u12', orderId: 'O12', token: null, now: NOW });
    assert.strictEqual(await bal('u12'), 3);
    const o12 = (await db.ref('orders/O12').get()).val();
    await reverseEarnForOrder(db, { orderId: 'O12', order: o12, now: NOW });
    assert.strictEqual(await bal('u12'), 0); ok('cancel-after-claim → reverseEarnForOrder reverses (balance 3 → 0)');
  });

  await env.cleanup();
  console.log(`\nclaim-order: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
