'use strict';
// H2 attribution helper: verified customer_uid stamping. Guest path must be byte-identical (no-op),
// and the uid can ONLY come from the caller's verified argument — never the request body.
const assert = require('assert');
const { attachCustomerAttribution, attributionUid } = require('./create-order-build');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const ORDER = 'PZX-123';
const meta = { now: 1700000000000, total: 250, orderType: 'delivery', items_text: '1x Pizza', restaurantId: 'x_pizza', items: [{ name: 'Margherita', qty: 1 }] };
const base = () => ({ [`orders/${ORDER}`]: { customer_name: 'A', total: 250, status: 'new' } });

// guest (null uid) → byte-identical, no attribution keys
{
  const u = base(); const before = JSON.stringify(u);
  const out = attachCustomerAttribution(u, ORDER, null, meta);
  assert.equal(JSON.stringify(out), before); ok('guest (null uid) → updates unchanged (byte-identical)');
  assert.ok(!('customer_uid' in out[`orders/${ORDER}`])); ok('guest order record has no customer_uid');
  assert.ok(!Object.keys(out).some((k) => k.startsWith('user_orders/'))); ok('guest writes no user_orders index');
}
// empty-string uid also treated as guest (falsy)
{
  const u = base(); const before = JSON.stringify(u);
  assert.equal(JSON.stringify(attachCustomerAttribution(u, ORDER, '', meta)), before); ok('empty uid → no-op');
}
// verified uid → stamps record + server-only history index
{
  const uid = 'u_' + 'a'.repeat(24);
  const out = attachCustomerAttribution(base(), ORDER, uid, meta);
  assert.equal(out[`orders/${ORDER}`].customer_uid, uid); ok('order record stamped with customer_uid');
  const idx = out[`user_orders/${uid}/${ORDER}`];
  assert.deepStrictEqual(idx, { ts: meta.now, total: 250, order_type: 'delivery', items_text: '1x Pizza', restaurant: 'x_pizza', status: 'new', items: [{ key: 'Margherita', qty: 1 }] });
  ok('user_orders index written {ts,total,order_type,items_text,restaurant,status,items[]}');
}
// status is read from the order record (per-path: new / scheduled) not hardcoded
{
  const uid = 'u_' + 'd'.repeat(24);
  const u = base(); u[`orders/${ORDER}`].status = 'scheduled';
  const out = attachCustomerAttribution(u, ORDER, uid, meta);
  assert.equal(out[`user_orders/${uid}/${ORDER}`].status, 'scheduled'); ok('history status derives from the order record (scheduled)');
}
// normalized items[] drops what the menu does not recognize (never raw client strings)
{
  const uid = 'u_' + 'e'.repeat(24);
  const m = { ...meta, items: [{ name: 'Margherita', qty: 2 }, { name: 'FakePizza', qty: 1 }] };
  const out = attachCustomerAttribution(base(), ORDER, uid, m);
  assert.deepStrictEqual(out[`user_orders/${uid}/${ORDER}`].items, [{ key: 'Margherita', qty: 2 }]); ok('items[] menu-allowlisted (unknown dropped)');
}
// uid is taken ONLY from the argument — the helper has no access to any request body (forgery-proof)
{
  const out = attachCustomerAttribution(base(), ORDER, 'u_verified', { ...meta });
  assert.equal(out[`orders/${ORDER}`].customer_uid, 'u_verified'); ok('customer_uid derives solely from the verified argument');
}
// ── H10 durability: a tombstoned (deleted) uid never re-accrues attribution (attributionUid decision) ──
{
  const dec = { customer: true, uid: 'u_' + 'b'.repeat(24) };
  assert.equal(attributionUid(dec, true), null); ok('tombstoned uid → null (order proceeds as guest)');
  assert.equal(attributionUid(dec, false), dec.uid); ok('non-tombstoned customer uid → attributed');
  assert.equal(attributionUid({ uid: dec.uid }, false), null); ok('non-customer token → null');
  assert.equal(attributionUid({ customer: true }, false), null); ok('customer token without uid → null');
  assert.equal(attributionUid(null, false), null); ok('no decoded token → null');
}
// end-to-end: a tombstoned uid resolves to null → attachCustomerAttribution yields a byte-identical guest order
{
  const dec = { customer: true, uid: 'u_' + 'c'.repeat(24) };
  const guest = attachCustomerAttribution(base(), ORDER, attributionUid(dec, true), meta);
  assert.ok(!('customer_uid' in guest[`orders/${ORDER}`]) && !Object.keys(guest).some((k) => k.startsWith('user_orders/')));
  ok('tombstoned token → guest order (no customer_uid, no user_orders)');
  const active = attachCustomerAttribution(base(), ORDER, attributionUid(dec, false), meta);
  assert.equal(active[`orders/${ORDER}`].customer_uid, dec.uid); ok('active token → order attributed to uid');
}
console.log(`create-order-attribution: OK (${n})`);
