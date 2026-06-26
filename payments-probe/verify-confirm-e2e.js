/**
 * Stage-4 sub-stage 2 — LIVE end-to-end confirm against the real sandbox.
 * SDK 3DS-less AUTH → real confirmOnlinePayment (real pixelpay-client capture +
 * verify + materialize) over an in-memory RTDB → asserts the order materializes.
 * Proves the whole capture→confirm→materialize path with a REAL sandbox capture.
 *   PIXELPAY_MODE=sandbox node verify-confirm-e2e.js
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const PixelPay = require('@pixelpay/sdk-core');
const { confirmOnlinePayment } = require('../xpizza-functions/pixelpay-confirm');
const { buildMaterializeUpdates } = require('../xpizza-functions/materialize');
const client = require('../xpizza-functions/pixelpay-client');
const { Settings, Card, Order, Billing } = PixelPay.Models;
const { AuthTransaction } = PixelPay.Requests;
const { Transaction } = PixelPay.Services;

const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };

function makeDb(initial = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let n = root; for (const k of p.split('/')) { if (n == null) return null; n = n[k]; } return n === undefined ? null : n; };
  const setAt = (p, val) => { const a = p.split('/'); let n = root; for (let i = 0; i < a.length - 1; i++) { if (n[a[i]] == null || typeof n[a[i]] !== 'object') n[a[i]] = {}; n = n[a[i]]; } const l = a[a.length - 1]; if (val === null) delete n[l]; else n[l] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } setAt(p, Object.assign({}, getAt(p) || {}, clone(patch))); }
  });
  return { ref, getAt };
}

async function authHold(pixelpayOrderId, amount) {
  const s = new Settings(); s.setupSandbox(); const tx = new Transaction(s);
  const c = new Card(); c.number = '4111111111111111'; c.cvv2 = '300'; c.expire_month = 12; c.expire_year = 2027; c.cardholder = 'Test User';
  const o = new Order(); o.id = pixelpayOrderId; o.currency = 'HNL'; o.amount = amount; o.tax_amount = 0; o.customer_name = 'Ana Lopez'; o.customer_email = 'cliente.prueba@gmail.com';
  const b = new Billing(); b.address = 'Col. Test 123'; b.country = 'HN'; b.state = 'HN-CR'; b.city = 'San Pedro Sula'; b.zip = '21101'; b.phone = '50497952893';
  const a = new AuthTransaction(); a.setCard(c); a.setBilling(b); a.setOrder(o);
  const r = await tx.doAuth(a);
  return r.data && r.data.payment_uuid;
}

(async () => {
  const orderId = 'PZX-E2E-' + Date.now();
  const attemptId = 'A';
  const pixelpayOrderId = `${orderId}-${attemptId}`;

  console.log('AUTH (amount=1) for', pixelpayOrderId);
  const payment_uuid = await authHold(pixelpayOrderId, 1);
  console.log('payment_uuid:', payment_uuid);
  assert.ok(payment_uuid, 'auth must return a payment_uuid');

  // Pending order: total_cents=100 → amountLempiras = 1 (matches the auth amount).
  const db = makeDb({
    orders: { [orderId]: { order_id: orderId, customer_name: 'Ana', customer_phone: '50488887777', items_text: 'Margherita x1', total: 1, total_cents: 100, payment_method: 'online', payment_status: 'pending', order_type: 'delivery', status: 'pending_payment', active_attempt_id: attemptId, lat: 15.51, lng: -88.03, address_detected: 'Calle 1, SPS', address_details: 'casa azul' } },
    payment_attempts: { [attemptId]: { order_id: orderId, status: 'active', total_cents: 100, pixelpay_order_id: pixelpayOrderId } }
  });

  const deps = { db, client, restaurant: RESTAURANT, buildMaterializeUpdates, alert: (k, d) => console.log('ALERT', k, JSON.stringify(d)) };
  const r = await confirmOnlinePayment(deps, { orderId, paymentUuid: payment_uuid, now: Date.now(), trackingToken: 'TOKE2E' });

  console.log('\nconfirm outcome:', r.outcome);
  const o = db.getAt(`orders/${orderId}`);
  const att = db.getAt(`payment_attempts/${attemptId}`);
  console.log('order.status:', o.status, '| payment_status:', o.payment_status, '| materialized_at:', !!o.materialized_at, '| ref:', o.payment_reference);
  console.log('attempt.status:', att.status, '| amount_cents:', att.amount_cents);
  console.log('delivery task created:', !!db.getAt(`tasks/${orderId}_delivery`));
  console.log('tracking created:', !!db.getAt('order_tracking/TOKE2E'));

  assert.strictEqual(r.outcome, 'confirmed');
  assert.strictEqual(o.status, 'new');
  assert.strictEqual(o.payment_status, 'confirmed');
  assert.ok(o.materialized_at);
  assert.strictEqual(att.status, 'captured');
  assert.ok(db.getAt(`tasks/${orderId}_delivery`));

  // Idempotency: a 2nd confirm must not re-capture (capture would 412) and stays confirmed.
  const r2 = await confirmOnlinePayment(deps, { orderId, paymentUuid: payment_uuid, now: Date.now(), trackingToken: 'TOKE2E2' });
  console.log('\n2nd confirm outcome:', r2.outcome, '(expect already_confirmed)');
  assert.strictEqual(r2.outcome, 'already_confirmed');

  console.log('\n✅ LIVE E2E PASS — real sandbox capture → verified → materialized; idempotent.');
})().catch((e) => { console.error('E2E FAILED:', e && e.stack || e); process.exit(1); });
