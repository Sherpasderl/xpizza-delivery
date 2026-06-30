'use strict';

/**
 * (M) Single source of combo validation, shared by the cash golden (create-order-build.test.js)
 * and the emulator e2e (deploy/emulator-e2e.js).
 *
 * COMBOS holds STATIC, audited expected outputs (lifted verbatim from the pre-Phase-0 golden — NOT
 * freshly generated, so it can't be a self-passing oracle) + the additive hub snapshot. The data is
 * hash-guarded (combo-validation.guard.test.js): editing it changes the hash and forces a conscious
 * review. `assertComboOutput` is the one assertion set everything reuses.
 *
 * `input` excludes hubSnap; callers pass `combo.snapshot` as the hubSnap (constant == seeded → OFF≡ON).
 */
const assert = require('assert');

const HUB = { hub_lat: 15.507489753573818, hub_lng: -88.0398486953722, restaurant_name: 'X Pizza', restaurant_phone: '+50497952893' };
const SNAP_KEYS = ['hub_lat', 'hub_lng', 'restaurant_name', 'restaurant_phone'];

const COMBOS = {
  cash_delivery: {
    input: {
      orderId: 'ORD1', orderType: 'delivery', now: 111, trackingToken: 'TOK', total: 350, lat: 15.6, lng: -88.1,
      fields: { customer_name: 'Ana', customer_phone: '+50499999999', items_text: 'Pizza x1', notes: 'ring bell', payment_method: 'cash', address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul' },
      restaurantId: 'x_pizza', priceBreakdown: { total_cents: 35000, subtotal_cents: 30435, tax_cents: 4565 }, facturaPriced: { items: [{ n: 'Pizza', q: 1, c: 35000 }] }, cashTenderedCents: 50000,
    },
    snapshot: HUB,
    pre3b: {
      'orders/ORD1': { order_id: 'ORD1', customer_name: 'Ana', customer_phone: '+50499999999', items_text: 'Pizza x1', total: 350, total_cents: 35000, subtotal_cents: 30435, tax_cents: 4565, notes: 'ring bell', payment_method: 'cash', order_type: 'delivery', status: 'new', tracking_token: 'TOK', created_at: 111, restaurant_id: 'x_pizza', factura_status: 'not_due', cash_tendered_cents: 50000, items: [{ n: 'Pizza', q: 1, c: 35000 }], lat: 15.6, lng: -88.1, address_detected: 'Calle 1, Col Centro, SPS', address_details: 'casa azul', maps_link: 'https://www.google.com/maps?q=15.6,-88.1', pickup_task_id: 'ORD1_pickup', delivery_task_id: 'ORD1_delivery' },
      'tasks/ORD1_pickup': { order_id: 'ORD1', type: 'pickup', status: 'pending', assigned_driver_id: null, linked_task_id: 'ORD1_delivery', depends_on_task_id: null, destination_lat: 15.507489753573818, destination_lng: -88.0398486953722, destination_address: 'X Pizza', recipient_name: 'X Pizza', recipient_phone: '+50497952893', notes: 'Pizza x1', created_at: 111 },
      'tasks/ORD1_delivery': { order_id: 'ORD1', type: 'delivery', status: 'pending', assigned_driver_id: null, linked_task_id: 'ORD1_pickup', depends_on_task_id: 'ORD1_pickup', destination_lat: 15.6, destination_lng: -88.1, destination_address: 'Calle 1, Col Centro, SPS', address_details: 'casa azul', recipient_name: 'Ana', recipient_phone: '+50499999999', payment_method: 'cash', total: 350, notes: 'Pizza x1', created_at: 111 },
      'order_tracking/TOK': { order_id: 'ORD1', order_type: 'delivery', restaurant_id: 'x_pizza', customer_name: 'Ana', items_text: 'Pizza x1', total: 350, address_short: 'Calle 1', status: 'new', created_at: 111 },
    },
  },
  cash_pickup: {
    input: {
      orderId: 'ORD2', orderType: 'pickup', now: 222, trackingToken: 'TOK2', total: 200,
      fields: { customer_name: 'Ben', customer_phone: '+50488888888', items_text: 'Calzone x2', notes: '', payment_method: 'cash', pickup_time: 'standard' },
      restaurantId: 'x_pizza', priceBreakdown: { total_cents: 20000, subtotal_cents: 17391, tax_cents: 2609 }, facturaPriced: { items: [{ n: 'Calzone', q: 2, c: 20000 }] }, cashTenderedCents: 20000,
    },
    snapshot: HUB,
    pre3b: {
      'orders/ORD2': { order_id: 'ORD2', customer_name: 'Ben', customer_phone: '+50488888888', items_text: 'Calzone x2', total: 200, total_cents: 20000, subtotal_cents: 17391, tax_cents: 2609, notes: '', payment_method: 'cash', order_type: 'pickup', status: 'new', tracking_token: 'TOK2', created_at: 222, restaurant_id: 'x_pizza', factura_status: 'not_due', cash_tendered_cents: 20000, items: [{ n: 'Calzone', q: 2, c: 20000 }], pickup_time: 'standard' },
      'order_tracking/TOK2': { order_id: 'ORD2', order_type: 'pickup', restaurant_id: 'x_pizza', customer_name: 'Ben', items_text: 'Calzone x2', total: 200, address_short: 'Recoger en X. Pizza', status: 'new', created_at: 222 },
    },
  },
};

// RTDB drops null-valued keys on write, so a read-back lacks them while a pure builder/fixture keeps
// them. Normalize to RTDB write semantics (null === absent). Shared by the e2e value compare and the
// shape anchor so both agree on null handling.
function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) { if (val !== null) out[k] = stripNulls(val); }
    return out;
  }
  return v;
}

// The one assertion set: existing fields byte-identical (strip the additive snapshot), snapshot
// correct, tasks/tracking exact, no reader-metadata leak, and no unexpected update paths.
function assertComboOutput(updates, combo) {
  const orderKey = `orders/${combo.input.orderId}`;
  const order = updates[orderKey];
  assert.ok(order, `${orderKey} missing from output`);
  const stripped = { ...order };
  const snap = {};
  for (const k of SNAP_KEYS) { snap[k] = stripped[k]; delete stripped[k]; }
  assert.deepStrictEqual(stripped, combo.pre3b[orderKey], 'order: existing fields drifted or a non-snapshot field was added');
  assert.deepStrictEqual(snap, combo.snapshot, 'order: hub snapshot wrong');
  for (const [k, v] of Object.entries(combo.pre3b)) {
    if (k === orderKey) continue;
    assert.deepStrictEqual(updates[k], v, `${k}: drifted from anchored expected`);
  }
  assert.ok(!/_source|_fetched_at/.test(JSON.stringify(updates)), 'reader metadata (_source/_fetched_at) leaked into output');
  assert.deepStrictEqual(Object.keys(updates).sort(), Object.keys(combo.pre3b).sort(), 'unexpected or missing update paths');
}

// Independent structural anchor for LIVE writes (B emulator e2e): assert the write has the AUDITED
// COMBOS key-structure (paths + per-record field-key-sets) + the constant snapshot + no metadata
// leak — substituting only the dynamic order_id/tracking_token. Proves deployed == AUDITED SHAPE
// WITHOUT routing through buildCreateOrderUpdates (so it can't drift-together with the builder).
// Scenario values (pricing/coords/names) are inputs, not anchored here — pricing correctness is
// covered by computeServerTotal + unit tests.
function assertComboShape(updates, combo, { orderId, trackingToken }) {
  const subPath = (p) => p.replace(combo.input.orderId, orderId).replace(combo.input.trackingToken, trackingToken);
  assert.deepStrictEqual(Object.keys(updates).sort(), Object.keys(combo.pre3b).map(subPath).sort(),
    'live write: unexpected/missing paths vs audited COMBOS');
  for (const [comboKey, comboRec] of Object.entries(combo.pre3b)) {
    const live = updates[subPath(comboKey)];
    assert.ok(live, `missing ${subPath(comboKey)}`);
    const isOrder = comboKey.startsWith('orders/');
    // RTDB drops null-valued keys on write, so the live read-back lacks them — mirror that in the
    // expected key-set (the audited shape keeps e.g. assigned_driver_id:null) before comparing.
    const normKeys = Object.keys(stripNulls(comboRec));
    const expectKeys = (isOrder ? [...normKeys, ...SNAP_KEYS] : normKeys).sort();
    assert.deepStrictEqual(Object.keys(live).sort(), expectKeys, `${subPath(comboKey)}: field-key-set drift vs audited shape`);
    if (isOrder) {
      const snap = {};
      for (const k of SNAP_KEYS) snap[k] = live[k];
      assert.deepStrictEqual(snap, combo.snapshot, `${subPath(comboKey)}: snapshot != HUB constant`);
    }
  }
  assert.ok(!/_source|_fetched_at/.test(JSON.stringify(updates)), 'reader metadata leaked into live write');
}

// Canonical hash of the EXPECTED-OUTPUT truth (inputs + pre3b + snapshot), guarded by the test.
function combosHash() {
  return require('crypto').createHash('sha256').update(JSON.stringify(COMBOS)).digest('hex');
}

module.exports = { HUB, COMBOS, SNAP_KEYS, stripNulls, assertComboOutput, assertComboShape, combosHash };
