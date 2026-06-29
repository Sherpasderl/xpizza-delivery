'use strict';

/**
 * (B) Emulator end-to-end — the byte-identical proof. RUNS IN A JAVA/EMULATOR ENV ONLY:
 *   firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emulator-e2e.js"
 *   env: GCLOUD_PROJECT, MAKE_SECRET, CREATEORDER_URL
 *
 * INCREMENT 1 — cash_delivery end-to-end: POST createOrder (in-zone) to the running function, read
 * back the actual writes, and assert they are byte-identical to buildCreateOrderUpdates (the
 * golden-anchored oracle) fed the SAME server-generated now/tracking_token. Because the builder is
 * hash-guarded against the audited COMBOS, function == builder == anchored truth.
 *
 * Cash needs no PixelPay; WhatsApp is disabled (config flag) so the FUNCTION'S process makes no
 * external call. The zero-egress guard below governs THIS process (allow emulator localhost only).
 * (Next increments: online-charge-pending ABSENCE, La Musa routing, fail-closed; online-materialized
 * byte-identical is already covered by materialize-snapshot.test.js + confirm-active-recheck.test.js.)
 */

// ── Zero-egress guard for THIS process (allow the local emulator transport only) ─────────────────
const ALLOW = /(^|\b)(127\.0\.0\.1|localhost|::1|0\.0\.0\.0)\b/;
(function denyEgress() {
  const net = require('net');
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (opts, ...rest) {
    const host = typeof opts === 'object' ? (opts.host || opts.path) : rest[0];
    if (!ALLOW.test(String(host))) throw new Error(`ZERO-EGRESS: blocked external connect to ${host}`);
    return orig.call(this, opts, ...rest);
  };
})();

const assert = require('assert');
const admin = require('firebase-admin');
const { emuDatabaseURL } = require('./emu-ns');
const { buildCreateOrderUpdates } = require('../create-order-build');
const { HUB } = require('./combo-validation');

// In-zone cash delivery (coords ~0.1km from the hub so it passes the zone-check and WRITES).
const INPUT = {
  order_id: 'E2E_CASH_DELIVERY',
  order_type: 'delivery',
  customer_name: 'Ana', customer_phone: '+50499999999',
  items_text: 'Margherita x1', items: [{ name: 'Margherita', qty: 1 }],
  notes: 'ring bell', payment_method: 'cash',
  lat: 15.5080, lng: -88.0400,
  address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul',
  cash_tendered: 500,
};

(async () => {
  const PID = process.env.GCLOUD_PROJECT || 'demo-xpizza';
  admin.initializeApp({ projectId: PID, databaseURL: emuDatabaseURL() });
  const db = admin.database();

  // Disable WhatsApp so createOrder's post-write send makes no external call.
  await db.ref('config/whatsapp_enabled').set(false);

  // Drive the real deployed handler.
  const res = await fetch(process.env.CREATEORDER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MAKE_SECRET}` },
    body: JSON.stringify(INPUT),
  });
  const body = await res.json().catch(() => ({}));
  assert.equal(res.status, 200, `createOrder returned ${res.status}: ${JSON.stringify(body)}`);
  const trackingToken = body.tracking_token;
  assert.ok(trackingToken, 'no tracking_token in createOrder response');

  // Read back the actual writes.
  const id = INPUT.order_id;
  const order = (await db.ref(`orders/${id}`).once('value')).val();
  assert.ok(order, 'order not written');
  const actual = {
    [`orders/${id}`]: order,
    [`tasks/${id}_pickup`]: (await db.ref(`tasks/${id}_pickup`).once('value')).val(),
    [`tasks/${id}_delivery`]: (await db.ref(`tasks/${id}_delivery`).once('value')).val(),
    [`order_tracking/${trackingToken}`]: (await db.ref(`order_tracking/${trackingToken}`).once('value')).val(),
  };

  // Oracle: the golden-anchored builder, fed the SAME server-generated now/token + read-back pricing
  // (3b changed structure/snapshot, not pricing — pricing flows through; structure is what we prove).
  const expected = buildCreateOrderUpdates({
    orderId: id, orderType: 'delivery', now: order.created_at, trackingToken, total: order.total,
    lat: INPUT.lat, lng: INPUT.lng,
    fields: {
      customer_name: INPUT.customer_name, customer_phone: INPUT.customer_phone, items_text: INPUT.items_text,
      notes: INPUT.notes, payment_method: 'cash', address_detected: INPUT.address_detected, address_details: INPUT.address_details,
    },
    restaurantId: 'x_pizza',
    priceBreakdown: { total_cents: order.total_cents, subtotal_cents: order.subtotal_cents, tax_cents: order.tax_cents },
    facturaPriced: { items: order.items }, cashTenderedCents: order.cash_tendered_cents,
    hubSnap: HUB,
  });

  assert.deepStrictEqual(actual, expected);
  console.log(`emulator-e2e [cash_delivery]: deployed createOrder == builder (byte-identical), snapshot ${order.restaurant_name}/${order.hub_lat} ✓`);
  process.exit(0);
})().catch((e) => { console.error('emulator-e2e: FAIL —', e.message); process.exit(1); });
