'use strict';

/**
 * Golden tests for buildMaterializeUpdates snapshot-or-fallback (#4) + no-metadata-leak (#2).
 * Pure builder, dep-free. Proves: snapshot used when present; RESTAURANT fallback for pre-3b
 * orders; x_pizza snapshot == constant -> byte-identical; reader metadata never reaches tasks.
 */
const assert = require('assert');
const { buildMaterializeUpdates } = require('./materialize');

const FALLBACK = { lat: 15.507489753573818, lng: -88.0398486953722, name: 'X Pizza', phone: '+50497952893' };
const baseOrder = (extra) => ({
  order_type: 'delivery', payment_method: 'online', customer_name: 'A', customer_phone: '1',
  items_text: 'x', total: 100, lat: 15.6, lng: -88.1, address_detected: 'Somewhere, City', ...extra,
});
let n = 0;
const ok = (label) => console.log(`  ✓ ${++n} ${label}`);

// 1) Order WITH snapshot -> pickup task uses the snapshot, not the fallback.
{
  const order = baseOrder({ hub_lat: 15.50414, hub_lng: -88.03848, restaurant_name: 'La Musa', restaurant_phone: '+50493736607' });
  const pickup = buildMaterializeUpdates({ orderId: 'o1', order, trackingToken: 't', now: 1, restaurant: FALLBACK })['tasks/o1_pickup'];
  assert.equal(pickup.destination_lat, 15.50414);
  assert.equal(pickup.destination_lng, -88.03848);
  assert.equal(pickup.destination_address, 'La Musa');
  assert.equal(pickup.recipient_name, 'La Musa');
  assert.equal(pickup.recipient_phone, '+50493736607');
  ok('snapshot present -> pickup uses snapshot');
}

// 2) Order WITHOUT snapshot (pre-3b) -> pickup task falls back to RESTAURANT.
{
  const pickup = buildMaterializeUpdates({ orderId: 'o2', order: baseOrder({}), trackingToken: 't', now: 1, restaurant: FALLBACK })['tasks/o2_pickup'];
  assert.equal(pickup.destination_lat, FALLBACK.lat);
  assert.equal(pickup.destination_address, FALLBACK.name);
  assert.equal(pickup.recipient_phone, FALLBACK.phone);
  ok('snapshot absent -> pickup falls back to RESTAURANT');
}

// 3) Byte-identical: x_pizza snapshot == fallback constant -> identical pickup task either way.
{
  const withSnap = baseOrder({ hub_lat: FALLBACK.lat, hub_lng: FALLBACK.lng, restaurant_name: FALLBACK.name, restaurant_phone: FALLBACK.phone });
  const a = buildMaterializeUpdates({ orderId: 'o3', order: withSnap, trackingToken: 't', now: 1, restaurant: FALLBACK })['tasks/o3_pickup'];
  const b = buildMaterializeUpdates({ orderId: 'o3', order: baseOrder({}), trackingToken: 't', now: 1, restaurant: FALLBACK })['tasks/o3_pickup'];
  assert.deepEqual(a, b);
  ok('x_pizza snapshot == constant -> byte-identical pickup task');
}

// 4) No metadata leak: reader metadata on the order never reaches tasks/tracking.
{
  const order = baseOrder({ hub_lat: 15.5, hub_lng: -88.0, restaurant_name: 'X Pizza', restaurant_phone: '+504',
    _source: 'fresh', _fetched_at: 123 });
  const u = buildMaterializeUpdates({ orderId: 'o4', order, trackingToken: 't', now: 1, restaurant: FALLBACK });
  const blob = JSON.stringify({ pickup: u['tasks/o4_pickup'], delivery: u['tasks/o4_delivery'], tracking: u['order_tracking/t'] });
  for (const leak of ['_source', '_fetched_at']) assert(!blob.includes(leak), `metadata ${leak} leaked into materialize output`);
  ok('no reader-metadata leak into tasks/tracking');
}

// 5) D2: order_tracking carries restaurant_id from the order (legacy-normalized).
{
  const lm = buildMaterializeUpdates({ orderId: 'o5', order: baseOrder({ restaurant_id: 'la_musa' }), trackingToken: 't5', now: 1, restaurant: FALLBACK })['order_tracking/t5'];
  assert.equal(lm.restaurant_id, 'la_musa');
  const legacy = buildMaterializeUpdates({ orderId: 'o6', order: baseOrder({}), trackingToken: 't6', now: 1, restaurant: FALLBACK })['order_tracking/t6'];
  assert.equal(legacy.restaurant_id, 'x_pizza');
  ok('order_tracking restaurant_id stamped from order (la_musa / legacy→x_pizza)');
}

// 6) A1: a scheduled FREE order (fully-comped redemption) carries free_order onto the released delivery task
//    (its task is built HERE, not at create). Non-free release omits the field → byte-identical.
{
  const free = buildMaterializeUpdates({ orderId: 'o7', order: baseOrder({ free_order: true, payment_method: 'cash', total: 0 }), trackingToken: 't7', now: 1, restaurant: FALLBACK })['tasks/o7_delivery'];
  assert.equal(free.free_order, true); ok('scheduled free order → free_order:true on the released delivery task');
  const paid = buildMaterializeUpdates({ orderId: 'o8', order: baseOrder({}), trackingToken: 't8', now: 1, restaurant: FALLBACK })['tasks/o8_delivery'];
  assert.equal('free_order' in paid, false); ok('non-free release omits free_order (byte-identical)');
}

// 7) Track A: a PROFILED materialized order stamps order_tracking.has_profile:true (tracker hides the guest
//    claim card); a guest order OMITS it → order_tracking byte-identical.
{
  const prof = buildMaterializeUpdates({ orderId: 'o9', order: baseOrder({ customer_uid: 'uZ' }), trackingToken: 't9', now: 1, restaurant: FALLBACK })['order_tracking/t9'];
  assert.equal(prof.has_profile, true); ok('profiled order → order_tracking.has_profile:true (tracker hides guest claim card)');
  const guest = buildMaterializeUpdates({ orderId: 'o10', order: baseOrder({}), trackingToken: 't10', now: 1, restaurant: FALLBACK })['order_tracking/t10'];
  assert.equal('has_profile' in guest, false); ok('guest order → order_tracking omits has_profile (byte-identical)');
}

console.log(`materialize-snapshot: OK (${n} cases)`);
