/**
 * Emulator suite for the shared redemption intake (rewards-redeem-intake.js) — the money-path wiring cash
 * createOrder (Task 5) and online chargeOnlineOrder (Task 6) both call. Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-redeem-intake.emulator.test.js"
 * Asserts the locked authorization precondition (flag + verified uid), server-computed discount, La Musa
 * free-item 86 gate + items_text append, reserve-at-intake (reserved, not consumed), idempotency, and
 * all-or-nothing rejects. (delivered→consume / cancel→release are wired + tested in Tasks 7/8.)
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { resolveRedemptionForOrder, prepareRedemption, quoteRedemptionCore } = require('../rewards-redeem-intake');
const { reserveRedemption, releaseRedemption, attachAttempt } = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { orderFingerprint } = require('../pixelpay-charge');
const { availKey } = require('../avail-key');

const NOW = 1_700_000_000_000;

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: '{ "rules": { ".read": true, ".write": true } }' } });
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const enable = (on) => db.ref('config/redemption_enabled').set(on);
    const seedPts = (uid, pts, rid = 'x_pizza') => db.ref(`user_rewards/${uid}/${rid}`).set({ balance: pts, lifetime: pts, ledger: { seed: { type: 'earn', delta: pts, ts: NOW } } });
    const resv = async (uid, orderId, rid = 'x_pizza') => (await db.ref(`user_rewards/${uid}/${rid}/reservations/${orderId}`).get()).val();
    const bal = async (uid, rid = 'x_pizza') => (await db.ref(`user_rewards/${uid}/${rid}/balance`).get()).val();
    const rsv = async (uid, rid = 'x_pizza') => (await db.ref(`user_rewards/${uid}/${rid}/reserved`).get()).val() || 0;
    const xpItems = [{ name: 'Margherita', qty: 1 }, { name: 'Anchovies', qty: 1 }];   // 299 + 418 = 717; free Margherita → 418
    const call = (args) => resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'Margherita x1\nAnchovies x1', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, ...args });

    // 1 — flag OFF → non-payable, no reserve (default off: no config key)
    await seedPts('uF', 20);
    let r = await call({ redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OF', customerUid: 'uF' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 409, err: 'rewards_disabled' });
    assert.strictEqual(await rsv('uF'), 0); ok('flag OFF → 409 rewards_disabled, no reserve');

    await enable(true);   // ── flag ON for the rest ──

    // 2 — guest (no verified uid) → 401, no reserve
    r = await call({ redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OG', customerUid: null });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 401, err: 'login_required' }); ok('guest + redeem → 401 login_required (NOT guest fail-open)');

    // 3 — x_pizza valid → discounted priced, RESERVED (not consumed), owns hold, canonical returned
    await seedPts('uX', 20);
    r = await call({ redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OX', customerUid: 'uX' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.priced.total_cents, 41800); assert.strictEqual(r.priced.discount_cents, 29900);
    assert.strictEqual(r.canonical.free_item_key, 'Margherita'); assert.strictEqual(r.ownsHold, true);
    assert.strictEqual(r.itemsText, 'Margherita x1\nAnchovies x1'); ok('A4 (REVISE): x_pizza discount does NOT reconstruct items_text (no append — would break the KDS rail count; comp captured in total_cents/factura/A6/driver)');
    assert.strictEqual((await resv('uX', 'OX')).state, 'reserved'); assert.strictEqual(await rsv('uX'), 8); assert.strictEqual(await bal('uX'), 20); ok('x_pizza valid → discounted total 41800, RESERVED (reserved 8, balance 20 untouched), canonical + ownsHold');

    // 4 — idempotent: same order + same reward → reused, no re-debit
    r = await call({ redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OX', customerUid: 'uX' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.ownsHold, false); assert.strictEqual(await rsv('uX'), 8); ok('idempotent re-intake (same order/reward) → ownsHold false (reused), reserved still 8');

    // 5 — insufficient balance → 409, no reserve
    await seedPts('uP', 5);
    r = await call({ redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OP', customerUid: 'uP' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error, reason: r.body.reason }, { ok: false, status: 409, err: 'redemption_reserve_failed', reason: 'insufficient' });
    assert.strictEqual(await rsv('uP'), 0); ok('insufficient points → 409 redemption_reserve_failed (insufficient), no reserve');

    // 6 — redemption_invalid (wrong tier) → 409, no reserve
    await seedPts('uI', 5000, 'la_musa');
    r = await resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem: { type: 'free_item', level: 1, item_id: 'special_01' }, orderId: 'OI', customerUid: 'uI' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error, reason: r.body.reason }, { ok: false, status: 409, err: 'redemption_invalid', reason: 'ineligible_item' }); ok('ineligible reward (wrong tier) → 409 redemption_invalid');

    // 7 — La Musa free item 86'd → 409 reward_unavailable, no reserve
    await db.ref(`restaurants/la_musa/item_availability/${availKey('soft_01')}`).set({ available: false, updated_at: NOW });
    r = await resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem: { type: 'free_item', level: 1, item_id: 'soft_01', name: 'Coca-Cola' }, orderId: 'OU', customerUid: 'uI' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 409, err: 'reward_unavailable' }); assert.ok(r.body.blocked.length > 0);
    assert.strictEqual(await rsv('uI', 'la_musa'), 0); ok('La Musa 86\'d free item → 409 reward_unavailable, no reserve');

    // 8 — La Musa valid free item → items_text appended (0-price line), no platform factura, reserved
    await db.ref(`restaurants/la_musa/item_availability/${availKey('soft_01')}`).set({ available: true, updated_at: NOW });
    r = await resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem: { type: 'free_item', level: 1, item_id: 'soft_01', name: 'Coca-Cola' }, orderId: 'OL', customerUid: 'uI' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.priced.factura_items, null); assert.strictEqual(r.priced.total_cents, 22300); assert.strictEqual(r.priced.discount_cents, 0);
    assert.ok(/1x Coca-Cola \(Recompensa\)/.test(r.itemsText)); assert.deepStrictEqual(r.priced.free_line, { item_id: 'soft_01', qty: 1, price_cents: 0, added: true });
    assert.strictEqual((await resv('uI', 'OL', 'la_musa')).state, 'reserved'); assert.strictEqual(await rsv('uI', 'la_musa'), 300); ok('La Musa valid → items_text appended (0-price line), factura skipped, total unchanged, reserved 300');

    // 9 — the free-item display NAME is sanitized (money-safe: display only)
    r = await resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem: { type: 'free_item', level: 2, item_id: 'soup_01', name: '<script>x</script>Sopa' }, orderId: 'ON', customerUid: 'uI' });
    assert.strictEqual(r.ok, true); assert.ok(/1x scriptx\/scriptSopa \(Recompensa\)/.test(r.itemsText)); assert.ok(!/[<>]/.test(r.itemsText)); ok('free-item display name sanitized (no <> reach items_text)');

    // ── prepareRedemption (online path): compute/gate/price WITHOUT reserving ──
    // 10 — prepare is a no-op on the hold: valid → ok + priced, but NO reservation is created (reserve is separate)
    await seedPts('uPrep', 20);
    const prep = await prepareRedemption(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: 'uPrep' });
    assert.strictEqual(prep.ok, true); assert.strictEqual(prep.priced.total_cents, 41800); assert.strictEqual(prep.redemption.cost, 8);
    assert.strictEqual(await rsv('uPrep'), 0); assert.strictEqual(await resv('uPrep', 'OPREP'), null); ok('prepareRedemption: computes discounted pricing but does NOT reserve (reserved 0)');
    // flag/uid gates still enforced by prepare
    assert.strictEqual((await prepareRedemption(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: null })).status, 401); ok('prepareRedemption: guest → 401 (gate enforced before reserve)');

    // ── online sequence: prepare → reserve(bound to payment fingerprint) → { release on abandon | attach on claim } ──
    const onlineReserve = async (uid, orderId, canonical, cost, fp) => reserveRedemption(db, { uid, rid: 'x_pizza', orderId, cost, canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW });
    // 11 — abandoned acquire outcome → release frees the owned hold (no orphan)
    await seedPts('uAb', 20);
    const pAb = await prepareRedemption(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: 'uAb' });
    const fpAb = orderFingerprint('OAB', pAb.priced.total_cents, pAb.itemsText, '');
    const rrAb = await onlineReserve('uAb', 'OAB', pAb.canonical, pAb.redemption.cost, fpAb);
    assert.strictEqual(rrAb.action, 'created'); assert.strictEqual(await rsv('uAb'), 8);   // hold owned
    await releaseRedemption(db, { uid: 'uAb', rid: 'x_pizza', orderId: 'OAB', now: NOW });   // simulate a truly-abandoned acquire branch
    assert.strictEqual(await rsv('uAb'), 0); assert.strictEqual((await resv('uAb', 'OAB')).state, 'released'); ok('online abandoned → releaseHoldIfOwned frees the debit (reserved 0, released) — no orphaned hold');
    // 12 — claimed → attach the attempt (state stays reserved, points held until confirm)
    await seedPts('uCl', 20);
    const pCl = await prepareRedemption(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: 'uCl' });
    const fpCl = orderFingerprint('OCL', pCl.priced.total_cents, pCl.itemsText, '');
    await onlineReserve('uCl', 'OCL', pCl.canonical, pCl.redemption.cost, fpCl);
    await attachAttempt(db, { uid: 'uCl', rid: 'x_pizza', orderId: 'OCL', attemptId: 'att_9', hostedExpiresAt: NOW + 900000, now: NOW });
    const recCl = await resv('uCl', 'OCL');
    assert.strictEqual(recCl.state, 'reserved'); assert.strictEqual(recCl.attempt_id, 'att_9'); assert.strictEqual(recCl.hosted_expires_at, NOW + 900000); assert.strictEqual(await rsv('uCl'), 8); ok('online claimed → attachAttempt sets attempt_id + hosted_expires_at, hold stays reserved (8)');
    // 13 — reuse/retry: the payment fingerprint matches → reserve is idempotent 'reused' (NOT ownsHold → never release on preserve)
    const rrReuse = await onlineReserve('uCl', 'OCL', pCl.canonical, pCl.redemption.cost, fpCl);
    assert.strictEqual(rrReuse.action, 'reused'); assert.strictEqual(await rsv('uCl'), 8); ok('online reuse (same order/fingerprint) → reserve reused (no re-debit); a preserve branch never releases');

    // ── [B2 T1] canary allowlist: global flag OFF but an allowlisted uid can redeem ──
    await enable(false);   // global OFF
    const allow = (uid, on) => db.ref(`config/redemption_allowlist/${uid}`).set(on);
    await seedPts('uAL', 20); await allow('uAL', true);
    const rAL = await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OAL', customerUid: 'uAL' });
    assert.strictEqual(rAL.ok, true); assert.strictEqual(await rsv('uAL'), 8); ok('canary: global OFF + allowlisted uid → redemption proceeds (reserved 8)');
    await seedPts('uNA', 20);   // NOT allowlisted
    const rNA = await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, redeem: { type: 'discount_cheapest_pizza' }, orderId: 'ONA', customerUid: 'uNA' });
    assert.deepStrictEqual({ ok: rNA.ok, status: rNA.status, err: rNA.body.error }, { ok: false, status: 409, err: 'rewards_disabled' });
    assert.strictEqual(await rsv('uNA'), 0); ok('canary: global OFF + NON-allowlisted uid → 409 rewards_disabled, no reserve');
    // uid-first reorder: a flag-OFF GUEST now returns login_required (not rewards_disabled) — inert (guests never redeem)
    const rG = await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OG2', customerUid: null });
    assert.deepStrictEqual({ ok: rG.ok, status: rG.status, err: rG.body.error }, { ok: false, status: 401, err: 'login_required' }); ok('uid-first reorder: flag-OFF guest → 401 login_required (inert; guests send no redeem)');

    // ── [B2 T1] quoteRedemptionCore — READ-ONLY preview, NO reserve, same typed errors, quote == applied discount ──
    await enable(true);   // global ON for the quote happy-paths
    await seedPts('uQ', 20);
    const q = await quoteRedemptionCore(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', customerUid: 'uQ' });
    assert.deepStrictEqual({ ok: q.ok, discount_cents: q.discount_cents, total_cents: q.total_cents, name: q.free_item.name }, { ok: true, discount_cents: 29900, total_cents: 41800, name: 'Margherita' });
    assert.strictEqual(await rsv('uQ'), 0); assert.strictEqual(await resv('uQ', 'ANY'), null); ok('quoteRedemptionCore: discounted numbers returned, NO reserve taken (reserved 0, no reservation)');
    // quote == applied: the same cart+redeem through the intake charges the SAME discounted total
    const sub = await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, redeem: { type: 'discount_cheapest_pizza' }, orderId: 'OQ', customerUid: 'uQ' });
    assert.strictEqual(sub.priced.total_cents, q.total_cents); assert.strictEqual(sub.priced.discount_cents, q.discount_cents); ok('quote == applied: quoted total/discount === what the intake charges (given submit reaches redemption)');
    // quote typed errors mirror intake
    await seedPts('uQI', 5);   // insufficient
    assert.deepStrictEqual((await quoteRedemptionCore(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', customerUid: 'uQI' })).body, { error: 'redemption_reserve_failed', reason: 'insufficient' }); ok('quote insufficient → 409 redemption_reserve_failed (mirrors reserve), no reserve');
    assert.deepStrictEqual(await quoteRedemptionCore(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', customerUid: null }), { ok: false, status: 401, body: { error: 'login_required' } }); ok('quote guest → 401 login_required');
    assert.deepStrictEqual(await quoteRedemptionCore(db, { redeem: { type: 'discount_cheapest_pizza' }, items: [{ name: 'NotARealPizza', qty: 1 }], restaurantId: 'x_pizza', customerUid: 'uQ' }), { ok: false, status: 400, body: { error: 'bad_cart' } }); ok('quote malformed cart → 400 bad_cart (never feeds NaN to pricing)');
    // quote flag-OFF non-allowlisted → rewards_disabled
    await enable(false);
    assert.deepStrictEqual((await quoteRedemptionCore(db, { redeem: { type: 'discount_cheapest_pizza' }, items: xpItems, restaurantId: 'x_pizza', customerUid: 'uQ' })).body, { error: 'rewards_disabled' }); ok('quote flag-OFF non-allowlisted → 409 rewards_disabled');
  });

  await env.cleanup();
  console.log(`\nrewards-redeem-intake: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
