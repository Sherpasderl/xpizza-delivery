'use strict';
// Task 0 (H2 card attribution): buildMaterializeUpdates carries a logged-in customer's attribution onto a
// materialized CARD order via FIELD-LEVEL paths only — NEVER a whole-object orders/{id} key (which would
// throw / strand a PAID order). Guest online orders materialize byte-identically. The token→customer_uid
// decision is attributionUid (covered in create-order-attribution.test.js); this covers the shared builder.
const assert = require('assert');
const { buildMaterializeUpdates } = require('./materialize');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

const REST = { lat: 15.5, lng: -88.0, name: 'X. Pizza', phone: '+50400000000' };
const NOW = 1700000000000;
const TOK = 'trk_abc';
const ORDER = 'PZX-9001';
const base = (extra) => ({
  order_id: ORDER, order_type: 'pickup', payment_method: 'online',
  customer_name: 'Ana', customer_phone: '50499998888', items_text: '1x Pizza', total: 250,
  restaurant_id: 'x_pizza', ...extra,
});
const call = (order) => buildMaterializeUpdates({
  orderId: ORDER, order, trackingToken: TOK, now: NOW, restaurant: REST, paymentMethod: 'online', paymentReference: 'ref1',
});

// (c) pending WITH customer_uid → the two field-level attribution paths, no throw
{
  const uid = 'u_' + 'a'.repeat(24);
  const u = call(base({ customer_uid: uid }));
  assert.equal(u[`orders/${ORDER}/customer_uid`], uid); ok('(c) orders/{id}/customer_uid field path emitted');
  assert.deepStrictEqual(u[`user_orders/${uid}/${ORDER}`], { ts: NOW, total: 250, order_type: 'pickup', items_text: '1x Pizza' });
  ok('(c) user_orders index {ts,total,order_type,items_text} emitted');
}
// (d) guest (no customer_uid) → NO attribution paths (byte-identical to today)
{
  const u = call(base());
  assert.ok(!(`orders/${ORDER}/customer_uid` in u)); ok('(d) guest online order → no customer_uid path');
  assert.ok(!Object.keys(u).some((k) => k.startsWith('user_orders/'))); ok('(d) guest online order → no user_orders index');
}
// (e) REGRESSION GUARD — attribution present must NOT introduce a whole-object orders/{id} key
{
  const uid = 'u_' + 'b'.repeat(24);
  const u = call(base({ customer_uid: uid, order_type: 'delivery', lat: 15.6, lng: -88.1, address_detected: 'Col X', address_details: 'casa' }));
  assert.ok(!(`orders/${ORDER}` in u), 'no whole-object orders/{id} key may exist'); ok('(e) NO whole-object orders/{id} key (paid order never stranded)');
  const wholeNodeKeys = Object.keys(u).filter((k) => k === `orders/${ORDER}`);
  assert.equal(wholeNodeKeys.length, 0); ok('(e) every order write is a field-level patch path (orders/{id}/<field>)');
  assert.equal(u[`orders/${ORDER}/customer_uid`], uid); ok('(e) delivery card order still attributes');
}
// guest byte-identical: attribution adds EXACTLY the 2 paths, nothing else changes
{
  const uid = 'u_' + 'c'.repeat(24);
  const guest = call(base());
  const authed = call(base({ customer_uid: uid }));
  const delta = Object.keys(authed).filter((k) => !(k in guest));
  assert.deepStrictEqual(delta.sort(), [`orders/${ORDER}/customer_uid`, `user_orders/${uid}/${ORDER}`].sort());
  ok('attribution delta vs guest = exactly the 2 attribution paths');
  for (const k of Object.keys(guest)) assert.deepStrictEqual(authed[k], guest[k]);
  ok('all non-attribution materialize paths byte-identical to guest');
}
console.log(`materialize-attribution: OK (${n})`);
