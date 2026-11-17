'use strict';
// OWNER 2026-11-16: an APP pickup is CARD ONLY (pickup-card-only.js). Through the REAL order seam both handlers call first
// (tip.js orderRefusal / refuse — createOrder index.js:800, chargeOnlineOrder :1546), with bodies shaped as the REAL capp builds them
// (customer-app/capp-checkout.js orderBody / quoteBody). The handler path (zero writes) is the s2tip emulator's PCO block.
// Run: node pickup-card-only.test.js
const assert = require('assert');
const path = require('path');
const TIP = require('./tip');
const { pickupCardOnlyRefusal } = require('./pickup-card-only');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const cell = (label, fn) => { try { fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); };

// the REAL capp body builders (pure; the checkout module is a UMD that exports under node)
const CK = require(path.join(__dirname, '..', 'customer-app', 'capp-checkout.js'));
const CTX = { restaurantId: 'x_pizza', items: [{ name: 'Margherita', qty: 1, price: 0 }], itemsText: '1x Margherita', orderId: 'xpz_t1' };
const flow = (mode, pay) => ({ mode, pay, name: 'Ana', phone: '99990000', notes: '', rtn: false, details: '', pin: { lat: 14.1, lng: -87.2, confirmed: true } });
const capp = (mode, pay) => CK.orderBody(flow(mode, pay), CTX);
const FORM = (b) => { const f = { ...b }; delete f.entry_mode; return f; };

cell('PCO-PREMISE: the real capp order body is app-marked, carries order_type + payment_method; its quote body carries NO payment method', () => {
  const b = capp('pickup', 'cash');
  assert.deepStrictEqual([b.entry_mode, b.order_type, b.payment_method], ['app', 'pickup', 'cash']);
  const q = CK.quoteBody(flow('pickup', 'online'), CTX);
  assert.ok(!('payment_method' in q) && !('order_type' in q), 'the quote is payment-agnostic (no gate possible there)');
});

cell('PCO-APP-CASH: an app pickup paid in cash (or card_delivery, or no method) ⇒ 400 pickup_card_only', () => {
  for (const pm of ['cash', 'card_delivery', '', undefined, 'bitcoin']) {
    const b = { ...capp('pickup', 'cash'), payment_method: pm };
    assert.deepStrictEqual(TIP.orderRefusal(b), { status: 400, error: 'pickup_card_only' }, `🔴 PCO-APP-CASH: method ${JSON.stringify(pm)}`);
  }
});

cell('PCO-APP-ONLINE: an app pickup paid online is not refused', () => {
  assert.strictEqual(TIP.orderRefusal(capp('pickup', 'online')), null, '🔴 PCO-APP-ONLINE');
});

cell('PCO-APP-DELIVERY-CASH: an app DELIVERY paid in cash is unchanged', () => {
  assert.strictEqual(TIP.orderRefusal(capp('delivery', 'cash')), null, '🔴 PCO-APP-DELIVERY-CASH');
});

cell('PCO-FORMS-PICKUP-CASH: a FORM pickup (no app marker, or entry_mode direct) paid in cash is unchanged', () => {
  assert.strictEqual(TIP.orderRefusal(FORM(capp('pickup', 'cash'))), null, '🔴 PCO-FORMS-PICKUP-CASH: no marker');
  assert.strictEqual(TIP.orderRefusal({ ...capp('pickup', 'cash'), entry_mode: 'direct' }), null, '🔴 PCO-FORMS-PICKUP-CASH: direct');
});

cell('PCO-PRECEDENCE: an app pickup with cash AND a tip answers pickup_card_only (one clear reason), not a tip code', () => {
  assert.deepStrictEqual(TIP.orderRefusal({ ...capp('pickup', 'cash'), tip_cents: 2000 }), { status: 400, error: 'pickup_card_only' }, '🔴 PCO-PRECEDENCE');
});

cell('PCO-SEAM: TIP.refuse — the handlers\' one-line seam — answers 400 { error: pickup_card_only } and stops the handler', () => {
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } };
  assert.strictEqual(TIP.refuse(res, capp('pickup', 'cash')), true, '🔴 PCO-SEAM: refused');
  assert.deepStrictEqual([res.code, res.body], [400, { error: 'pickup_card_only' }], '🔴 PCO-SEAM: the answer');
  const res2 = { status() { throw new Error('must not answer'); } };
  assert.strictEqual(TIP.refuse(res2, capp('pickup', 'online')), false, 'PCO-SEAM: online proceeds');
});

cell('PCO-QUOTE: a quote-shaped body (mode, no order_type, no method) is never refused by this rule', () => {
  assert.strictEqual(pickupCardOnlyRefusal(CK.quoteBody(flow('pickup', 'cash'), CTX)), null, '🔴 PCO-QUOTE');
  for (const v of [null, undefined, 'x', 7]) assert.strictEqual(pickupCardOnlyRefusal(v), null, 'non-object bodies pass through to the handlers\' own validation');
});
console.log(`pickup-card-only: OK (${n})`);
