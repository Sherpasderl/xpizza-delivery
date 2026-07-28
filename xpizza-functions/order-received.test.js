'use strict';

// Unit test for the order-received decision core (order-received.js). Proves: online+new+phone → send;
// cash/card+new → skip (createOrder already sent, no double-send); online at a non-'new' status → skip;
// missing phone → skip; null order → false (guard). Run: node order-received.test.js
const assert = require('assert');
const { shouldSendOrderReceived } = require('./order-received');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const online = { payment_method: 'online', customer_phone: '50499998888' };

assert.strictEqual(shouldSendOrderReceived(online, 'new'), true); ok('online + new + phone → SEND');
assert.strictEqual(shouldSendOrderReceived({ payment_method: 'cash', customer_phone: '50499998888' }, 'new'), false); ok('cash + new → skip (createOrder already sent inline)');
assert.strictEqual(shouldSendOrderReceived({ payment_method: 'card_delivery', customer_phone: '50499998888' }, 'new'), false); ok('card_delivery + new → skip');
assert.strictEqual(shouldSendOrderReceived(online, 'preparing'), false); ok('online + preparing → skip (no re-notify)');
assert.strictEqual(shouldSendOrderReceived(online, 'ready'), false); ok('online + ready → skip');
assert.strictEqual(shouldSendOrderReceived(online, 'out_for_delivery'), false); ok('online + out_for_delivery → skip (delivery logic handles it)');
assert.strictEqual(shouldSendOrderReceived(online, 'cancelled'), false); ok('online + cancelled → skip');
assert.strictEqual(shouldSendOrderReceived({ payment_method: 'online' }, 'new'), false); ok('online + new, NO phone → skip');
assert.strictEqual(shouldSendOrderReceived(null, 'new'), false); ok('null order → false (guard before order.*)');
assert.strictEqual(shouldSendOrderReceived(undefined, 'new'), false); ok('undefined order → false');

console.log(`\norder-received: ${n} assertions passed`);
