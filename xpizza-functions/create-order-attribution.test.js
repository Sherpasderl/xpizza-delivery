'use strict';
// H2 attribution helper: verified customer_uid stamping. Guest path must be byte-identical (no-op),
// and the uid can ONLY come from the caller's verified argument — never the request body.
const assert = require('assert');
const { attachCustomerAttribution } = require('./create-order-build');
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const ORDER = 'PZX-123';
const meta = { now: 1700000000000, total: 250, orderType: 'delivery', items_text: '1x Pizza' };
const base = () => ({ [`orders/${ORDER}`]: { customer_name: 'A', total: 250 } });

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
  assert.deepStrictEqual(idx, { ts: meta.now, total: 250, order_type: 'delivery', items_text: '1x Pizza' });
  ok('user_orders index written {ts,total,order_type,items_text}');
}
// uid is taken ONLY from the argument — the helper has no access to any request body (forgery-proof)
{
  const out = attachCustomerAttribution(base(), ORDER, 'u_verified', { ...meta });
  assert.equal(out[`orders/${ORDER}`].customer_uid, 'u_verified'); ok('customer_uid derives solely from the verified argument');
}
console.log(`create-order-attribution: OK (${n})`);
