'use strict';

/**
 * Golden tests for the extracted cash-intake builder (create-order-build.js). The acceptance
 * criterion for X. Pizza's primary path: existing order/task/tracking fields BYTE-IDENTICAL to
 * the pre-3b output, and the ONLY additions are the 4 allowlisted hub-snapshot fields (no
 * reader-metadata leak). Strategy: strip the 4 snapshot keys from the built order record and
 * assert the remainder deep-equals the hand-authored pre-3b record.
 */
const assert = require('assert');
const { buildCreateOrderUpdates } = require('./create-order-build');

const HUB = { hub_lat: 15.507489753573818, hub_lng: -88.0398486953722, restaurant_name: 'X Pizza', restaurant_phone: '+50497952893' };
let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);
const stripSnap = (o) => { const { hub_lat, hub_lng, restaurant_name, restaurant_phone, ...rest } = o; return { rest, snap: { hub_lat, hub_lng, restaurant_name, restaurant_phone } }; };
const noLeak = (u) => assert(!/_source|_fetched_at/.test(JSON.stringify(u)), 'reader metadata leaked');

// ── Combo 1: CASH DELIVERY ────────────────────────────────────────────────
{
  const fields = { customer_name: 'Ana', customer_phone: '+50499999999', items_text: 'Pizza x1',
    notes: 'ring bell', payment_method: 'cash', address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul' };
  const u = buildCreateOrderUpdates({
    orderId: 'ORD1', orderType: 'delivery', now: 111, trackingToken: 'TOK', total: 350, lat: 15.6, lng: -88.1,
    fields, hubSnap: HUB, restaurantId: 'x_pizza',
    priceBreakdown: { total_cents: 35000, subtotal_cents: 30435, tax_cents: 4565 },
    facturaPriced: { items: [{ n: 'Pizza', q: 1, c: 35000 }] }, cashTenderedCents: 50000,
  });

  const PRE3B = {
    order_id: 'ORD1', customer_name: 'Ana', customer_phone: '+50499999999', items_text: 'Pizza x1',
    total: 350, total_cents: 35000, subtotal_cents: 30435, tax_cents: 4565, notes: 'ring bell',
    payment_method: 'cash', order_type: 'delivery', status: 'new', tracking_token: 'TOK', created_at: 111,
    restaurant_id: 'x_pizza', factura_status: 'not_due', cash_tendered_cents: 50000, items: [{ n: 'Pizza', q: 1, c: 35000 }],
    lat: 15.6, lng: -88.1, address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul',
    maps_link: 'https://www.google.com/maps?q=15.6,-88.1', pickup_task_id: 'ORD1_pickup', delivery_task_id: 'ORD1_delivery',
  };
  const { rest, snap } = stripSnap(u['orders/ORD1']);
  assert.deepEqual(rest, PRE3B);                  // existing fields byte-identical + only additions are the snapshot
  assert.deepEqual(snap, HUB);                    // snapshot correct
  // pickup task from snapshot; delivery task from customer
  assert.deepEqual(u['tasks/ORD1_pickup'], {
    order_id: 'ORD1', type: 'pickup', status: 'pending', assigned_driver_id: null,
    linked_task_id: 'ORD1_delivery', depends_on_task_id: null,
    destination_lat: HUB.hub_lat, destination_lng: HUB.hub_lng, destination_address: 'X Pizza',
    recipient_name: 'X Pizza', recipient_phone: '+50497952893', notes: 'Pizza x1', created_at: 111,
  });
  assert.equal(u['tasks/ORD1_delivery'].destination_lat, 15.6);
  assert.equal(u['tasks/ORD1_delivery'].recipient_name, 'Ana');
  assert.equal(u['order_tracking/TOK'].address_short, 'Calle 1');
  assert.equal(u['order_tracking/TOK'].status, 'new');
  noLeak(u);
  ok('cash delivery: order byte-identical + snapshot-only addition; tasks + tracking correct');
}

// ── Combo 2: CASH PICKUP ──────────────────────────────────────────────────
{
  const fields = { customer_name: 'Ben', customer_phone: '+50488888888', items_text: 'Calzone x2',
    notes: '', payment_method: 'cash', pickup_time: 'standard' };
  const u = buildCreateOrderUpdates({
    orderId: 'ORD2', orderType: 'pickup', now: 222, trackingToken: 'TOK2', total: 200,
    fields, hubSnap: HUB, restaurantId: 'x_pizza',
    priceBreakdown: { total_cents: 20000, subtotal_cents: 17391, tax_cents: 2609 },
    facturaPriced: { items: [{ n: 'Calzone', q: 2, c: 20000 }] }, cashTenderedCents: 20000,
  });

  const PRE3B = {
    order_id: 'ORD2', customer_name: 'Ben', customer_phone: '+50488888888', items_text: 'Calzone x2',
    total: 200, total_cents: 20000, subtotal_cents: 17391, tax_cents: 2609, notes: '',
    payment_method: 'cash', order_type: 'pickup', status: 'new', tracking_token: 'TOK2', created_at: 222,
    restaurant_id: 'x_pizza', factura_status: 'not_due', cash_tendered_cents: 20000,
    items: [{ n: 'Calzone', q: 2, c: 20000 }], pickup_time: 'standard',
  };
  const { rest, snap } = stripSnap(u['orders/ORD2']);
  assert.deepEqual(rest, PRE3B);
  assert.deepEqual(snap, HUB);
  assert.equal(u['tasks/ORD2_pickup'], undefined);   // pickup orders create no driver tasks
  assert.equal(u['tasks/ORD2_delivery'], undefined);
  assert.equal(u['order_tracking/TOK2'].address_short, 'Recoger en X. Pizza');
  noLeak(u);
  ok('cash pickup: order byte-identical + snapshot-only; no tasks; pickup tracking copy');
}

console.log(`create-order-build: OK (${n} cases)`);
