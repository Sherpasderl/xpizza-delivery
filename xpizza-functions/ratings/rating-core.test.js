'use strict';
// S5 ratings writer — pure core (r1 redesign: the signed-in customer who placed the order; status-only eligibility).
// Run: node ratings/rating-core.test.js
const assert = require('assert');
const R = require('./rating-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1792700000000;

// ── the request ──
assert.deepStrictEqual(R.parseRequest({ order_id: 'XP-1_a', thumb: 'up' }), { ok: true, orderId: 'XP-1_a', thumb: 'up' });
for (const bad of [null, {}, { order_id: 'XP-1' }, { order_id: 'XP-1', thumb: 'meh' }, { order_id: '', thumb: 'up' }, { order_id: '../x', thumb: 'up' },
  { order_id: 'a/b', thumb: 'down' }, { order_id: 12, thumb: 'up' }, { order_id: 'A'.repeat(65), thumb: 'up' }, { tracking_token: 'AbCd2345efgh', thumb: 'up' }]) {
  assert.deepStrictEqual(R.parseRequest(bad), { ok: false }, `refused: ${JSON.stringify(bad)}`);
}
ok('request: { order_id (path-safe, ≤ 64), thumb up|down }; anything else (incl. a tracking token) → refused');

// ── eligibility: the order's OWN customer, status only ──
const own = (o) => ({ customer_uid: 'u1', status: 'delivered', ...o });
assert.strictEqual(R.eligibility(own(), 'u1'), null);
assert.strictEqual(R.eligibility(own({ status: 'completed' }), 'u1'), null, 'a pickup completed by the KDS counts');
assert.strictEqual(R.eligibility(own({ status: 'completed', delivered_at: undefined, completed_at: undefined }), 'u1'), null, 'no timestamp needed');
for (const [o, uid, label] of [[own(), 'u2', 'another customer'], [own({ customer_uid: undefined }), 'u1', 'a guest order'], [null, 'u1', 'no order'], [own(), null, 'no uid'], [own(), '', 'empty uid']]) {
  assert.strictEqual(R.eligibility(o, uid), 'not_allowed', `${label} → the generic not_allowed`);
}
for (const st of ['new', 'preparing', 'ready', 'out_for_delivery', 'cancelled', 'scheduled', undefined]) assert.strictEqual(R.eligibility(own({ status: st }), 'u1'), 'not_fulfilled', `own order, ${st} → not_fulfilled`);
assert.strictEqual(R.eligibility({ customer_uid: 'u2', status: 'new' }, 'u1'), 'not_allowed', 'someone else\'s unfulfilled order → generic (never reveals its status)');
ok('eligibility: only the order\'s customer_uid; delivered / completed by status alone; another customer / guest order / unknown → generic not_allowed (checked BEFORE status)');

// ── the record: NO customer identity ──
assert.deepStrictEqual(R.ratingRecord('down', 'x_pizza', NOW), { thumb: 'down', rated_at: NOW, restaurant_id: 'x_pizza' });
ok('record: { thumb, rated_at, restaurant_id } — nothing that identifies the customer');

// ── the ≥ 20 gate ──
assert.strictEqual(R.likedPct({ thumbs_up: 19, ratings_n: 19 }), null, '19 ratings → hidden');
assert.strictEqual(R.likedPct({ thumbs_up: 15, ratings_n: 20 }), 75, '20 ratings → shown');
assert.strictEqual(R.likedPct({ thumbs_up: 1, ratings_n: 30 }), 3);
for (const bad of [{ thumbs_up: 21, ratings_n: 20 }, { thumbs_up: -1, ratings_n: 20 }, { thumbs_up: 1.5, ratings_n: 20 }, {}, { thumbs_up: 10, ratings_n: '20' }]) assert.strictEqual(R.likedPct(bad), null, `malformed ${JSON.stringify(bad)} → hidden`);
ok('gate: «% liked» is null (hidden) below 20 ratings, the rounded % from 20; malformed counts → hidden');

console.log(`\nrating-core: ${n} passed`);
