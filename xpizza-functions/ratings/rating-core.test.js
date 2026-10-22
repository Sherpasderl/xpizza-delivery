'use strict';
// S5 ratings writer — pure core. Run: node ratings/rating-core.test.js
const assert = require('assert');
const R = require('./rating-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1792700000000, DAY = 86400000;

// ── the request: one generic refusal for every malformed shape ──
assert.deepStrictEqual(R.parseRequest({ tracking_token: 'AbCd2345efgh', thumb: 'up' }), { ok: true, token: 'AbCd2345efgh', thumb: 'up' });
for (const bad of [null, {}, { tracking_token: 'AbCd2345efgh' }, { tracking_token: 'AbCd2345efgh', thumb: 'meh' }, { tracking_token: 'short', thumb: 'up' },
  { tracking_token: 'has/slash1234', thumb: 'up' }, { tracking_token: '../orders/x123', thumb: 'down' }, { tracking_token: 12345678, thumb: 'up' }, { tracking_token: 'A'.repeat(65), thumb: 'up' }]) {
  assert.deepStrictEqual(R.parseRequest(bad), { ok: false }, `refused: ${JSON.stringify(bad)}`);
}
ok('request: a tracker token (alphanumeric, 8–64) + thumb up|down; every other shape (path chars, wrong thumb, missing) → the same generic refusal');

// ── eligibility: fulfilled (delivered / completed pickup) within 7 days ──
assert.strictEqual(R.eligibility({ status: 'delivered', delivered_at: NOW - DAY }, NOW), null);
assert.strictEqual(R.eligibility({ status: 'completed', completed_at: NOW - 6.9 * DAY }, NOW), null, 'a picked-up pickup counts');
assert.strictEqual(R.eligibility({ status: 'delivered', delivered_at: NOW - 7 * DAY }, NOW), null, 'exactly 7 days → still open');
assert.strictEqual(R.eligibility({ status: 'delivered', delivered_at: NOW - 7 * DAY - 1 }, NOW), 'rating_closed');
assert.strictEqual(R.eligibility({ status: 'delivered' }, NOW), 'rating_closed', 'no fulfilment time → closed (never open-ended)');
for (const st of ['new', 'preparing', 'ready', 'out_for_delivery', 'cancelled', 'scheduled', undefined]) assert.strictEqual(R.eligibility({ status: st, delivered_at: NOW }, NOW), 'not_fulfilled', `${st} → not_fulfilled`);
assert.strictEqual(R.eligibility(null, NOW), 'not_fulfilled');
ok('eligibility: delivered / completed, within 7 days of fulfilment (inclusive); not yet fulfilled / cancelled / no time / older → refused');

// ── the record: NO customer identity ──
assert.deepStrictEqual(R.ratingRecord('down', 'x_pizza', NOW), { thumb: 'down', rated_at: NOW, restaurant_id: 'x_pizza' });
assert.deepStrictEqual(Object.keys(R.ratingRecord('up', 'x_pizza', NOW)).sort(), ['rated_at', 'restaurant_id', 'thumb'], 'only thumb / time / restaurant — no uid, phone, name or token');
ok('record: { thumb, rated_at, restaurant_id } — nothing that identifies the customer');

// ── the ≥ 20 gate ──
assert.strictEqual(R.likedPct({ thumbs_up: 19, ratings_n: 19 }), null, '19 ratings → hidden');
assert.strictEqual(R.likedPct({ thumbs_up: 15, ratings_n: 20 }), 75, '20 ratings → shown');
assert.strictEqual(R.likedPct({ thumbs_up: 2, ratings_n: 3 }), null);
assert.strictEqual(R.likedPct({ thumbs_up: 1, ratings_n: 30 }), 3);
for (const bad of [{ thumbs_up: 21, ratings_n: 20 }, { thumbs_up: -1, ratings_n: 20 }, { thumbs_up: 1.5, ratings_n: 20 }, {}, { thumbs_up: 10, ratings_n: '20' }]) assert.strictEqual(R.likedPct(bad), null, `malformed ${JSON.stringify(bad)} → hidden`);
assert.strictEqual(R.MIN_RATINGS, 20);
ok('gate: «% liked» is null (hidden) below 20 ratings, the rounded % from 20; malformed counts → hidden');

console.log(`\nrating-core: ${n} passed`);
