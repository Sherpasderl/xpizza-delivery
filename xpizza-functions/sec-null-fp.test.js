'use strict';
// SECURITY (NOTE-security-null-fp-tracking-token, advisor Option A 2026-11-12): a cash re-submit of an EXISTING live order whose
// content fingerprint cannot be recomputed (a `redeem` the server cannot price — a guest, an unknown reward) must NOT be classified
// as the same order: legacy format, a stored payment_fingerprint + a null incoming one → 409 order_exists `cart_unverifiable` (the
// canonical format's answer), never the idempotent 200 that hands back the stored order's tracking token. Every value comes from
// the REAL writers: the catalog fixture tables (test/d4b-legacy-fixtures), the REAL prepareRedemption, the REAL fingerprint and the
// REAL order builder. Run: node sec-null-fp.test.js
const assert = require('assert');
const F = require('./test/d4b-legacy-fixtures');
const { classifyExistingOrder, computeIncomingFingerprint } = require('./createorder-classify');
const { prepareRedemption } = require('./rewards-redeem-intake');
const { buildCreateOrderUpdates } = require('./create-order-build');
const { orderFingerprint } = require('./pixelpay-charge');
const { orderBreakdownCents } = require('./order-money');
const { isStatusChangeClosedToAutomation } = require('./manual-resolve');
const OE = require('./order-exists');
const SCHED = require('./scheduled-orders');
const { computeServerTotal } = require('./menu-pricing');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
// redemption is on (the global flag) — the read prepareRedemption makes; nothing else is read
const db = { ref: (p) => ({ get: async () => ({ val: () => (p === 'config/redemption_enabled' ? true : null), exists: () => p === 'config/redemption_enabled' }) }) };
const deps = (rid) => ({ orderBreakdownCents, prepareRedemption, orderFingerprint, schedFingerprintExtra: SCHED.fingerprintExtra, db, tables: F.tablesFor(rid) });
const D = { isPaymentStatusClosed: isStatusChangeClosedToAutomation };
// the stored order, built by the REAL builder over the REAL fingerprint of the victim's request
async function storedOrder(rid, ctx) {
  const fp = await computeIncomingFingerprint(ctx, deps(rid));
  assert.ok(typeof fp === 'string' && fp.length > 0, `premise: the victim's request fingerprints (${rid})`);
  const built = buildCreateOrderUpdates({ orderId: ctx.orderId, orderType: 'pickup', now: 1, trackingToken: 'victim-tracking-token', total: ctx.total, lat: 0, lng: 0,
    fields: { customer_name: 'Víctima', customer_phone: '+50412345678', items_text: ctx.itemsText, notes: '—', payment_method: 'cash', pickup_time: 'standard' },
    hubSnap: { hub_lat: 0, hub_lng: 0, restaurant_name: 'R', restaurant_phone: 'p' }, restaurantId: rid, priceBreakdown: orderBreakdownCents(ctx.total, rid),
    facturaPriced: { items: null, factura_items: null }, cashTenderedCents: 0, freeOrder: false, rewardStamp: {}, paymentFingerprint: fp });
  const rec = built[`orders/${ctx.orderId}`];
  assert.strictEqual(rec.payment_fingerprint, fp, 'premise: the builder stores the fingerprint');
  return rec;
}
const ctxFor = (rid, over = {}) => { const items = F.cartsFor(rid).plain; const total = computeServerTotal(items, rid, F.tablesFor(rid)).total;
  return { orderId: 'SEC-1', restaurantId: rid, total, itemsText: `1x victim cart ${rid}`, items, redeem: null, customerUid: null, scheduledForRaw: NaN, orderType: 'pickup', tipCents: 0, ...over }; };

(async () => {
  for (const rid of F.RIDS) {
    await cell(`SEC-NULL-FP ${rid}`, async (L) => {
      const victim = await storedOrder(rid, ctxFor(rid));
      // the attacker: same order id, same restaurant, cash, as a GUEST, with a `redeem` the server cannot price
      const fp = await computeIncomingFingerprint(ctxFor(rid, { redeem: F.redeemFor(rid), itemsText: 'anything' }), deps(rid));
      assert.strictEqual(fp, null, `${L}: premise — a guest's redemption cannot be priced (the real prepareRedemption refuses)`);
      const cls = classifyExistingOrder(victim, { paymentMethod: 'cash', restaurantMatches: true, incomingTip: 0 }, fp, D);
      assert.deepStrictEqual(cls, { action: '409', reason: 'cart_unverifiable' }, `${L}: never the idempotent 200 that returns the stored tracking token`);
      const oe = OE.decideCashExistingRefusal(cls.reason, victim);
      assert.deepStrictEqual([oe, OE.orderExistsBody(oe.reason, 'SEC-1')], [{ legacy: false, reason: 'cart_unverifiable' },
        { error: 'order_exists', reason: 'cart_unverifiable', detail: OE.orderExistsBody('cart_unverifiable', 'SEC-1').detail, order_id: 'SEC-1' }], `${L}: the existing recovery answer, no token`);
    });
    await cell(`SEC-LEGIT-RETRY ${rid}`, async (L) => {
      const ctx = ctxFor(rid); const victim = await storedOrder(rid, ctx);
      const fp = await computeIncomingFingerprint(ctx, deps(rid));
      assert.deepStrictEqual(classifyExistingOrder(victim, { paymentMethod: 'cash', restaurantMatches: true, incomingTip: 0 }, fp, D), { action: '200' }, `${L}: the genuine retry is still idempotent`);
    });
    await cell(`SEC-LEGIT-REWARD-RETRY ${rid}`, async (L) => {
      const ctx = ctxFor(rid, { redeem: F.redeemFor(rid), customerUid: F.UID });
      const fp0 = await computeIncomingFingerprint(ctx, deps(rid));
      assert.ok(fp0, `${L}: premise — the member's reward is priced`);
      const order = await storedOrder(rid, ctx);
      const fp = await computeIncomingFingerprint(ctx, deps(rid));
      assert.deepStrictEqual(classifyExistingOrder(order, { paymentMethod: 'cash', restaurantMatches: true, incomingTip: 0 }, fp, D), { action: '200' }, `${L}: a member's reward retry is still idempotent`);
    });
  }
  await cell('SEC-NO-STORED-FP (pre-F1 legacy order)', async (L) => {
    assert.deepStrictEqual(classifyExistingOrder({ restaurant_id: 'x_pizza', payment_method: 'cash', status: 'new', payment_status: 'pending' }, { paymentMethod: 'cash', restaurantMatches: true }, null, D), { action: '200' }, `${L}: an order without a stored fingerprint keeps today's path`);
  });
  if (fails.length) { console.log(`sec-null-fp FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
  console.log(`sec-null-fp: OK (${n})`);
})();
