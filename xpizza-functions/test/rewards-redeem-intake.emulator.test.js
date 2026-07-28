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
const { resolveRedemptionForOrder } = require('../rewards-redeem-intake');
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
    assert.strictEqual((await resv('uI', 'OL', 'la_musa')).state, 'reserved'); assert.strictEqual(await rsv('uI', 'la_musa'), 500); ok('La Musa valid → items_text appended (0-price line), factura skipped, total unchanged, reserved 500');

    // 9 — the free-item display NAME is sanitized (money-safe: display only)
    r = await resolveRedemptionForOrder(db, { restaurantId: 'la_musa', items: [{ id: 'dimsum_01', qty: 1 }], itemsText: 'dimsum x1', totalLempiras: 223, schedExtra: '', now: NOW, redeem: { type: 'free_item', level: 2, item_id: 'soup_01', name: '<script>x</script>Sopa' }, orderId: 'ON', customerUid: 'uI' });
    assert.strictEqual(r.ok, true); assert.ok(/1x scriptx\/scriptSopa \(Recompensa\)/.test(r.itemsText)); assert.ok(!/[<>]/.test(r.itemsText)); ok('free-item display name sanitized (no <> reach items_text)');
  });

  await env.cleanup();
  console.log(`\nrewards-redeem-intake: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
