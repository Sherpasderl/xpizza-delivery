'use strict';

/**
 * (B) Emulator end-to-end — the byte-identical proof. RUNS IN A JAVA/EMULATOR ENV ONLY, one mode
 * per `emulators:exec` so each scenario gets a COLD getIdentity cache (the 30s warm cache would
 * otherwise mask a seed-state change within a session):
 *   firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emulator-e2e.js <mode>"
 *   modes: cash | reject <expectedStatus> | pending     env: GCLOUD_PROJECT, MAKE_SECRET, CREATEORDER_URL
 *
 * - cash    (seed active): drive createOrder for cash_delivery + cash_pickup, assert byte-identical to
 *           buildCreateOrderUpdates (golden-anchored oracle), null-normalized for RTDB write semantics.
 * - reject N (seed inactive→400 / missing|invalid→503): POST a valid in-zone cash order, assert the
 *           handler short-circuits with status N and writes NOTHING (no external call on these paths).
 * - pending (seed active): in-process — acquireHostedAttempt writes the pending order but NO tasks /
 *           NO tracking (those come only at materialize). No PixelPay (createHostedCharge is called
 *           AFTER, in chargeOnlineOrder) → no egress.
 *
 * NO-EGRESS is by construction: cash has WhatsApp config-gated off + no PixelPay; reject paths
 * short-circuit before any write/send; pending uses only the CAS write. (The earlier in-process
 * socket guard was removed — wrong process, and it broke the e2e's own admin connection.)
 * Online-materialized byte-identical is covered by materialize-snapshot.test.js + confirm-active-recheck.test.js.
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { emuDatabaseURL } = require('./emu-ns');
const { buildCreateOrderUpdates } = require('../create-order-build');
const { HUB, COMBOS, assertComboShape, stripNulls } = require('./combo-validation');
const { acquireHostedAttempt } = require('../pixelpay-hosted-charge');
const { orderFingerprint } = require('../pixelpay-charge');

const COMMON = { customer_name: 'Ana', customer_phone: '+50499999999', items_text: 'Margherita x1', items: [{ name: 'Margherita', qty: 1 }], notes: 'ring bell', payment_method: 'cash', cash_tendered: 500 };
const CASH_DELIVERY = { ...COMMON, order_id: 'E2E_CASH_DELIVERY', order_type: 'delivery', lat: 15.5080, lng: -88.0400, address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul' };
const CASH_PICKUP = { ...COMMON, notes: '', order_id: 'E2E_CASH_PICKUP', order_type: 'pickup', pickup_time: 'standard' };

const post = (input) => fetch(process.env.CREATEORDER_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MAKE_SECRET}` },
  body: JSON.stringify(input),
});

async function driveByteIdentical(db, input, comboKey) {
  const label = comboKey;
  const res = await post(input);
  const body = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `${label}: createOrder ${res.status}: ${JSON.stringify(body)}`);
  const token = body.tracking_token;
  const id = input.order_id;
  const order = (await db.ref(`orders/${id}`).once('value')).val();
  assert.ok(order, `${label}: order not written`);

  const actual = { [`orders/${id}`]: order, [`order_tracking/${token}`]: (await db.ref(`order_tracking/${token}`).once('value')).val() };
  if (input.order_type === 'delivery') {
    actual[`tasks/${id}_pickup`] = (await db.ref(`tasks/${id}_pickup`).once('value')).val();
    actual[`tasks/${id}_delivery`] = (await db.ref(`tasks/${id}_delivery`).once('value')).val();
  }

  const expected = stripNulls(buildCreateOrderUpdates({
    orderId: id, orderType: input.order_type, now: order.created_at, trackingToken: token, total: order.total,
    lat: input.lat, lng: input.lng,
    fields: { customer_name: input.customer_name, customer_phone: input.customer_phone, items_text: input.items_text, notes: input.notes, payment_method: 'cash', address_detected: input.address_detected, address_details: input.address_details, pickup_time: input.pickup_time },
    restaurantId: 'x_pizza',
    priceBreakdown: { total_cents: order.total_cents, subtotal_cents: order.subtotal_cents, tax_cents: order.tax_cents },
    facturaPriced: { items: order.items }, cashTenderedCents: order.cash_tendered_cents, hubSnap: HUB,
  }));

  // (a) value-level integration vs the builder (pricing is PASS-THROUGH here — pricing correctness
  //     is covered by computeServerTotal + unit tests; this proves structure/snapshot/layout).
  assert.deepStrictEqual(actual, expected);
  // (b) INDEPENDENT anchor: the live write matches the AUDITED COMBOS shape (key-structure +
  //     snapshot + no-leak), so deployed and builder cannot drift together undetected (#5).
  assertComboShape(actual, COMBOS[comboKey], { orderId: input.order_id, trackingToken: token });
  console.log(`  ✓ ${label}: deployed createOrder == builder (value) AND == audited COMBOS shape; pricing pass-through`);
}

async function main() {
  const PID = process.env.GCLOUD_PROJECT || 'demo-xpizza';
  admin.initializeApp({ projectId: PID, databaseURL: emuDatabaseURL() });
  const db = admin.database();
  const mode = process.argv[2];

  if (mode === 'cash') {
    await db.ref('config/whatsapp_enabled').set(false); // function makes no external send
    await driveByteIdentical(db, CASH_DELIVERY, 'cash_delivery');
    await driveByteIdentical(db, CASH_PICKUP, 'cash_pickup');
  } else if (mode === 'reject') {
    const expected = Number(process.argv[3]);
    const before = (await db.ref('rate_limits').once('value')).val();
    const res = await post({ ...CASH_DELIVERY, order_id: 'E2E_REJECT' });
    assert.equal(res.status, expected, `reject: expected ${expected}, got ${res.status}`);
    for (const p of ['orders/E2E_REJECT', 'tasks/E2E_REJECT_pickup', 'tasks/E2E_REJECT_delivery']) {
      assert.ok(!(await db.ref(p).once('value')).exists(), `reject: ${p} written despite ${expected}`);
    }
    const after = (await db.ref('rate_limits').once('value')).val();
    assert.deepStrictEqual(after, before, 'reject: rate_limits changed (rejection must precede rate limiting)');
    // order_tracking is token-keyed and only written inside the post-rejection updates block, so its
    // absence follows from orders/E2E_REJECT being absent (the handler returns before that block).
    console.log(`  ✓ reject: ${expected}; no order/task write; rate_limits unchanged (short-circuit before write & rate-limit)`);
  } else if (mode === 'pending') {
    const id = 'E2E_PENDING';
    const pending = { order_id: id, customer_name: 'X', customer_phone: '+504', items_text: 'Margherita x1', total: 299, total_cents: 29900, subtotal_cents: 26000, tax_cents: 3900, notes: '', payment_method: 'online', payment_status: 'pending', order_type: 'delivery', status: 'pending_payment', created_at: Date.now(), restaurant_id: 'x_pizza', factura_status: 'not_due', cash_tendered_cents: 0, items: [{ name: 'Margherita', qty: 1, c: 29900 }], lat: 15.508, lng: -88.04 };
    const acq = await acquireHostedAttempt(db, id, pending, orderFingerprint(id, 29900, 'Margherita x1'), Date.now());
    assert.equal(acq.outcome, 'claimed', `pending: acquireHostedAttempt outcome ${acq.outcome}`);
    const order = (await db.ref(`orders/${id}`).once('value')).val();
    assert.equal(order.status, 'pending_payment', 'pending: order not pending_payment');
    assert.ok(!order.tracking_token, 'pending: order has a tracking_token');
    assert.ok(!(await db.ref(`tasks/${id}_pickup`).once('value')).exists(), 'pending: created a pickup task');
    assert.ok(!(await db.ref(`tasks/${id}_delivery`).once('value')).exists(), 'pending: created a delivery task');
    console.log('  ✓ pending-absence (HELPER-LEVEL CAS invariant — acquireHostedAttempt, NOT the chargeOnlineOrder HTTP route): pending order, NO tasks / NO tracking');
  } else {
    throw new Error(`unknown mode "${mode}" — use: cash | reject <status> | pending`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('emulator-e2e: FAIL —', e.message); process.exit(1); });
