/**
 * Emulator suite for the shared redemption intake (rewards-redeem-intake.js) — v2. The money-path wiring cash
 * createOrder and online chargeOnlineOrder both call. Run:
 *   firebase emulators:exec --only database --project demo-xpizza "node test/rewards-redeem-intake.emulator.test.js"
 * Asserts the locked authorization precondition (flag + verified uid), the ≥1-paid-item guard, server-computed
 * add-free pricing (total UNCHANGED), the multiset La Musa intake (aggregate reserve + N free lines + items_text),
 * the payment-fingerprint mismatch when the redeemed SET changes, online reserve + acquire-failure release,
 * idempotency, and all-or-nothing rejects.
 */
const assert = require('assert');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { resolveRedemptionForOrder, prepareRedemption, quoteRedemptionCore } = require('../rewards-redeem-intake');
const { reserveRedemption, releaseRedemption, attachAttempt } = require('../rewards-reserve');
const { REDEMPTION_CONFIG_VERSION } = require('../rewards-redeem-config');
const { orderFingerprint } = require('../pixelpay-charge');
const { availKey } = require('../avail-key');

const NOW = 1_700_000_000_000;
const XP = { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };            // free 12" Margherita (L299)

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
    const xpItems = [{ name: 'Margherita', qty: 1 }, { name: 'Anchovies', qty: 1 }];   // 299 + 418 = 717 PAID; free pizza ADDED → total UNCHANGED
    const call = (args) => resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', itemsText: 'Margherita x1 | Anchovies x1', totalLempiras: 717, schedExtra: '', now: NOW, items: xpItems, ...args });

    // 1 — flag OFF → non-payable, no reserve
    await seedPts('uF', 20);
    let r = await call({ redeem: XP, orderId: 'OF', customerUid: 'uF' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 409, err: 'rewards_disabled' });
    assert.strictEqual(await rsv('uF'), 0); ok('flag OFF → 409 rewards_disabled, no reserve');

    await enable(true);   // ── flag ON for the rest ──

    // 2 — guest (no verified uid) → 401, no reserve
    r = await call({ redeem: XP, orderId: 'OG', customerUid: null });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 401, err: 'login_required' }); ok('guest + redeem → 401 login_required (NOT guest fail-open)');

    // 3 — x_pizza valid → ADD-FREE priced (total UNCHANGED), RESERVED (not consumed), owns hold, items_text appended
    await seedPts('uX', 20);
    r = await call({ redeem: XP, orderId: 'OX', customerUid: 'uX' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.priced.total_cents, 71700);   // PAID total UNCHANGED (the free pizza nets to L0)
    assert.strictEqual(r.priced.discount_cents, 0); assert.strictEqual(r.priced.desc_rebaja_cents, 26000);   // A-F: add-free doesn't discount the bill; comped Margherita (L299) → full-value factura line + rebaja (26000 net)
    assert.ok(r.priced.items.length === 2 && !r.priced.items.some((l) => l.redeemed) && r.priced.factura_items.length === 3 && r.priced.factura_items.some((l) => l.redeemed && l.description === 'Margherita'));   // items = paid-only (earn base); factura_items = paid + comped (SAR doc)
    assert.strictEqual(r.canonical.free_item_key, 'Margherita'); assert.strictEqual(r.canonical.model, 'add_free'); assert.strictEqual(r.ownsHold, true);
    assert.ok(/ \| 1x Margherita \(Recompensa\)/.test(r.itemsText)); ok('x_pizza add-free: PAID total UNCHANGED 71700, comped Margherita = full-value factura line + rebaja, free pizza appended to items_text');
    assert.strictEqual((await resv('uX', 'OX')).state, 'reserved'); assert.strictEqual(await rsv('uX'), 8); assert.strictEqual(await bal('uX'), 20); ok('x_pizza valid → RESERVED (reserved 8, balance 20 untouched), canonical + ownsHold');

    // 4 — idempotent: same order + same reward → reused, no re-debit
    r = await call({ redeem: XP, orderId: 'OX', customerUid: 'uX' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.ownsHold, false); assert.strictEqual(await rsv('uX'), 8); ok('idempotent re-intake (same order/reward) → ownsHold false (reused), reserved still 8');

    // 5 — insufficient punches → 409, no reserve
    await seedPts('uP', 5);
    r = await call({ redeem: XP, orderId: 'OP', customerUid: 'uP' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error, reason: r.body.reason }, { ok: false, status: 409, err: 'redemption_reserve_failed', reason: 'insufficient' });
    assert.strictEqual(await rsv('uP'), 0); ok('insufficient punches → 409 redemption_reserve_failed (insufficient), no reserve');

    // 6 — ineligible reward (18" NY pie) → 409 redemption_invalid, no reserve
    r = await call({ redeem: { type: 'free_pizza_choice', item_id: 'Margherita NY' }, orderId: 'OI', customerUid: 'uX' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error, reason: r.body.reason }, { ok: false, status: 409, err: 'redemption_invalid', reason: 'ineligible_item' }); ok('ineligible reward (18" NY pie) → 409 redemption_invalid (ineligible_item)');

    // 7 — La Musa free item 86'd → 409 reward_unavailable, no reserve
    await seedPts('uI', 5000, 'la_musa');
    const laCall = (redeem, orderId, over = {}) => resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem, orderId, customerUid: 'uI', ...over });
    await db.ref(`restaurants/la_musa/item_availability/${availKey('soft_01')}`).set({ available: false, updated_at: NOW });
    r = await laCall({ type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 1, name: 'Coca-Cola' }] }, 'OU');
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 409, err: 'reward_unavailable' }); assert.ok(r.body.blocked.length > 0);
    assert.strictEqual(await rsv('uI', 'la_musa'), 0); ok('La Musa 86\'d free item → 409 reward_unavailable, no reserve');

    // 8 — La Musa valid single → items_text appended (0-price line), no platform factura, aggregate reserve = cost_pts
    await db.ref(`restaurants/la_musa/item_availability/${availKey('soft_01')}`).set({ available: true, updated_at: NOW });
    r = await laCall({ type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 1, name: 'Coca-Cola' }] }, 'OL');
    assert.strictEqual(r.ok, true); assert.strictEqual(r.priced.factura_items, null); assert.strictEqual(r.priced.total_cents, 22300); assert.strictEqual(r.priced.discount_cents, 0);
    assert.ok(/ \| 1x Coca-Cola \(Recompensa\)/.test(r.itemsText)); assert.deepStrictEqual(r.priced.free_lines, [{ item_id: 'soft_01', qty: 1, price_cents: 0, added: true }]);
    assert.strictEqual((await resv('uI', 'OL', 'la_musa')).state, 'reserved'); assert.strictEqual(await rsv('uI', 'la_musa'), 133); ok('La Musa single → items_text appended, factura skipped, total unchanged, reserved = cost_pts 133');

    // 9 — La Musa MULTISET (2 dishes, qty-aware) → aggregate reserve = Σ, N free lines, N items_text appends
    r = await laCall({ type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 2, name: 'Coca-Cola' }, { id: 'dimsum_01', qty: 1, name: 'Wonton' }] }, 'OM');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(await rsv('uI', 'la_musa'), 133 + (133 * 2 + 743));   // OL's 133 still held + OM's Σ = 133×2 + 743 = 1009
    assert.strictEqual((await resv('uI', 'OM', 'la_musa')).cost, 133 * 2 + 743);
    assert.strictEqual(r.priced.free_lines.length, 2);
    assert.ok(/2x Coca-Cola \(Recompensa\)/.test(r.itemsText) && /1x Wonton \(Recompensa\)/.test(r.itemsText)); ok('La Musa MULTISET → ONE aggregate reservation cost Σ=1009, 2 free lines, 2 items_text appends (qty-aware)');

    // 10 — the free-item display NAME is sanitized (money-safe: display only)
    r = await laCall({ type: 'points_ala_carte', items: [{ id: 'soup_01', qty: 1, name: '<script>x</script>Sopa' }] }, 'ON');
    assert.strictEqual(r.ok, true); assert.ok(/1x scriptx\/scriptSopa \(Recompensa\)/.test(r.itemsText)); assert.ok(!/[<>]/.test(r.itemsText)); ok('free-item display name sanitized (no <> reach items_text)');

    // 11 — [§1e-3] the ≥1-PAID-ITEM guard: an empty paid cart → needs_paid_item BEFORE any reserve
    await seedPts('uNP', 20);
    r = await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', items: [], itemsText: '', totalLempiras: 0, schedExtra: '', now: NOW, redeem: XP, orderId: 'ONP', customerUid: 'uNP' });
    assert.deepStrictEqual({ ok: r.ok, status: r.status, err: r.body.error }, { ok: false, status: 409, err: 'needs_paid_item' });
    assert.strictEqual(await rsv('uNP'), 0); assert.strictEqual(await resv('uNP', 'ONP'), null); ok('§1e-3: empty paid cart → 409 needs_paid_item, no reserve (the free item can\'t be the whole order)');
    // a tampered/unknown paid cart → bad_cart (not needs_paid_item)
    assert.strictEqual((await resolveRedemptionForOrder(db, { restaurantId: 'x_pizza', items: [{ name: 'FakePie', qty: 1 }], itemsText: 'x', totalLempiras: 1, schedExtra: '', now: NOW, redeem: XP, orderId: 'OBC', customerUid: 'uNP' })).body.error, 'bad_cart'); ok('§1e-3: tampered/unknown paid cart → 400 bad_cart, no reserve');

    // 12 — prepareRedemption (online path): compute/gate/price WITHOUT reserving
    await seedPts('uPrep', 20);
    const prep = await prepareRedemption(db, { redeem: XP, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: 'uPrep' });
    assert.strictEqual(prep.ok, true); assert.strictEqual(prep.priced.total_cents, 71700); assert.strictEqual(prep.redemption.cost, 8); assert.ok(prep.redemptionFp);
    assert.strictEqual(await rsv('uPrep'), 0); ok('prepareRedemption: computes add-free pricing + redemptionFp but does NOT reserve (reserved 0)');

    // ── online sequence: prepare → reserve(bound to payment fingerprint + set hash) → { release | attach } ──
    const onlineReserve = async (uid, orderId, canonical, cost, fp, rid = 'x_pizza') => reserveRedemption(db, { uid, rid, orderId, cost, canonical, orderFingerprint: fp, configVersion: REDEMPTION_CONFIG_VERSION, now: NOW });
    // 13 — abandoned acquire → release frees the owned hold (no orphan)
    await seedPts('uAb', 20);
    const pAb = await prepareRedemption(db, { redeem: XP, items: xpItems, restaurantId: 'x_pizza', itemsText: 'x', totalLempiras: 717, customerUid: 'uAb' });
    const fpAb = orderFingerprint('OAB', pAb.priced.total_cents, pAb.itemsText, `rf:${pAb.redemptionFp}`);
    assert.strictEqual((await onlineReserve('uAb', 'OAB', pAb.canonical, pAb.redemption.cost, fpAb)).action, 'created'); assert.strictEqual(await rsv('uAb'), 8);
    await releaseRedemption(db, { uid: 'uAb', rid: 'x_pizza', orderId: 'OAB', now: NOW });
    assert.strictEqual(await rsv('uAb'), 0); assert.strictEqual((await resv('uAb', 'OAB')).state, 'released'); ok('online acquire-failure → releaseHoldIfOwned frees the debit (reserved 0, released) — no orphan');

    // 14 — [§1e-2] payment-fingerprint MISMATCH when the redeemed SET changes → reservation_conflict (no silent swap)
    await seedPts('uFp', 5000, 'la_musa');
    const setA = { type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 1, name: 'Coca-Cola' }] };
    const setB = { type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 1, name: 'Coca-Cola' }, { id: 'dimsum_01', qty: 1, name: 'Wonton' }] };
    const laFp = (redeem, orderId) => resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem, orderId, customerUid: 'uFp' });
    assert.strictEqual((await laFp(setA, 'OFP')).ok, true);                                   // reserve order OFP bound to SET A
    const mism = await laFp(setB, 'OFP');                                                     // SAME order, DIFFERENT set → fp changes
    assert.deepStrictEqual({ ok: mism.ok, err: mism.body.error, reason: mism.body.reason }, { ok: false, err: 'redemption_reserve_failed', reason: 'reservation_conflict' }); ok('§1e-2: same order, CHANGED redeemed set → payment-fingerprint mismatch → reservation_conflict (the set is bound, can\'t be swapped)');

    // 15 — canary allowlist: global OFF but an allowlisted uid can redeem
    await enable(false);
    await db.ref('config/redemption_allowlist/uAL').set(true); await seedPts('uAL', 20);
    assert.strictEqual((await call({ redeem: XP, orderId: 'OAL', customerUid: 'uAL' })).ok, true); assert.strictEqual(await rsv('uAL'), 8); ok('canary: global OFF + allowlisted uid → redemption proceeds (reserved 8)');
    await seedPts('uNA', 20);
    assert.strictEqual((await call({ redeem: XP, orderId: 'ONA', customerUid: 'uNA' })).body.error, 'rewards_disabled'); assert.strictEqual(await rsv('uNA'), 0); ok('canary: global OFF + NON-allowlisted uid → 409 rewards_disabled, no reserve');

    // 16 — quoteRedemptionCore v2 — READ-ONLY, NO reserve, returns free_items[] + total_cost + remaining + savings
    await enable(true); await seedPts('uQ', 20);
    const q = await quoteRedemptionCore(db, { redeem: XP, items: xpItems, restaurantId: 'x_pizza', customerUid: 'uQ' });
    assert.strictEqual(q.ok, true); assert.strictEqual(q.total_cents, 71700); assert.strictEqual(q.discount_cents, 0);
    assert.deepStrictEqual(q.free_items, [{ item_id: 'Margherita', qty: 1, name: 'Margherita', price_cents: 29900 }]);
    assert.strictEqual(q.total_cost, 8); assert.strictEqual(q.remaining, 20 - 8); assert.strictEqual(q.savings_cents, 29900);
    assert.strictEqual(await rsv('uQ'), 0); ok('quoteRedemptionCore x_pizza: free_items[] + total_cost 8 + remaining 12 + savings 29900, NO reserve');
    await seedPts('uQL', 5000, 'la_musa');
    const ql = await quoteRedemptionCore(db, { redeem: { type: 'points_ala_carte', items: [{ id: 'soft_01', qty: 2, name: 'Coca-Cola' }] }, items: [{ id: 'dimsum_01', qty: 1 }], restaurantId: 'la_musa', customerUid: 'uQL' });
    assert.strictEqual(ql.total_cost, 266); assert.strictEqual(ql.remaining, 5000 - 266); assert.strictEqual(ql.savings_cents, 8000); assert.strictEqual(ql.free_items[0].qty, 2); ok('quoteRedemptionCore la_musa multiset: total_cost Σ=266, remaining 4734, savings 8000 (2×L40)');
    // quote guest / malformed / flag-off mirror intake
    assert.deepStrictEqual(await quoteRedemptionCore(db, { redeem: XP, items: xpItems, restaurantId: 'x_pizza', customerUid: null }), { ok: false, status: 401, body: { error: 'login_required' } });
    assert.strictEqual((await quoteRedemptionCore(db, { redeem: XP, items: [{ name: 'NotARealPizza', qty: 1 }], restaurantId: 'x_pizza', customerUid: 'uQ' })).body.error, 'bad_cart'); ok('quote: guest → 401 login_required; malformed cart → 400 bad_cart');
  });

  await env.cleanup();
  console.log(`\nrewards-redeem-intake: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
