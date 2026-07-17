'use strict';
/**
 * OWNER-RUN emulator test — allocateDisplayNumberOnSale (order-display-number Core).
 *
 *   firebase emulators:exec --only database --project demo-xpizza \
 *     "node test/display-number.emulator.test.js"
 *
 * The counter LOGIC is unit-tested in order-display-number.test.js. This proves the TRIGGER wiring against the
 * real RTDB emulator (via .run()): allocation stamps display_number on BOTH /orders and order_tracking, the
 * one-transaction counter is idempotent (retry → same #, no re-burn) and concurrency-safe (two handlers → one #),
 * per-restaurant counters are independent, and an ineligible order burns no number.
 */
const assert = require('assert');
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const app = require('../index.js');
const { getDatabase } = require('firebase-admin/database');
const { hnDateISO } = require('../factura/build-record');
const db = getDatabase();

const DAY = hnDateISO(Date.now());
const ev = (orderId, after) => ({ data: { before: { val: () => null }, after: { val: () => after } }, params: { orderId } });
const order = (o = {}) => ({ status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', tracking_token: 'TOK-' + (o.id || 'x'), ...o });
const dn = async (id) => (await db.ref(`orders/${id}/display_number`).once('value')).val();
const trackDn = async (tok) => (await db.ref(`order_tracking/${tok}/display_number`).once('value')).val();
const counter = async (rid) => (await db.ref(`counters/order_display_seq/${rid}/${DAY}`).once('value')).val();
const seed = (id, o) => db.ref(`orders/${id}`).set(order({ id, ...o }));
const reset = () => db.ref('/').set(null);

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

(async () => {
  // 1. live/Sale order → #1 on BOTH /orders and order_tracking; counter node correct
  await reset();
  await seed('A', {});
  await app.allocateDisplayNumberOnSale.run(ev('A', order({ id: 'A' })));
  assert.strictEqual(await dn('A'), 1, '/orders/A/display_number #1');
  assert.strictEqual(await trackDn('TOK-A'), 1, 'order_tracking/TOK-A/display_number #1');
  assert.deepStrictEqual(await counter('x_pizza'), { last: 1, by_order: { A: 1 } }, 'counter { last:1, by_order:{A:1} }');
  ok('live/Sale order → #1 on /orders AND order_tracking; counter correct');

  // 2. second order → #2
  await seed('B', {});
  await app.allocateDisplayNumberOnSale.run(ev('B', order({ id: 'B' })));
  assert.strictEqual(await dn('B'), 2, 'second order → #2');
  assert.deepStrictEqual((await counter('x_pizza')).by_order, { A: 1, B: 2 });
  ok('second order → #2 (per-day sequence advances)');

  // 3. IDEMPOTENT re-fire of A → still #1, counter.last unchanged (no re-burn/gap)
  await app.allocateDisplayNumberOnSale.run(ev('A', order({ id: 'A' })));
  assert.strictEqual(await dn('A'), 1, 'A still #1');
  assert.strictEqual((await counter('x_pizza')).last, 2, 'counter.last unchanged (no re-burn)');
  ok('idempotent re-fire of A → same #1, last still 2 (no re-burn/gap)');

  // 4. CONCURRENCY: two handlers for one fresh order → exactly one number, counter +1
  await seed('C', {});
  await Promise.all([
    app.allocateDisplayNumberOnSale.run(ev('C', order({ id: 'C' }))),
    app.allocateDisplayNumberOnSale.run(ev('C', order({ id: 'C' }))),
  ]);
  assert.strictEqual(await dn('C'), 3, 'C got a single number (#3)');
  assert.strictEqual((await counter('x_pizza')).last, 3, 'counter advanced by exactly 1 (no double-burn)');
  ok('concurrency: two handlers for one order → one #, counter +1 (no double-burn/gap)');

  // 5. per-restaurant: la_musa has its OWN #1 (independent of x_pizza's sequence)
  await seed('L', { restaurant_id: 'la_musa', tracking_token: 'TOK-L' });
  await app.allocateDisplayNumberOnSale.run(ev('L', order({ id: 'L', restaurant_id: 'la_musa', tracking_token: 'TOK-L' })));
  assert.strictEqual(await dn('L'), 1, 'la_musa → its own #1');
  assert.deepStrictEqual(await counter('la_musa'), { last: 1, by_order: { L: 1 } });
  ok('per-restaurant counter: la_musa gets a clean #1, independent of x_pizza');

  // 6. NOT eligible → no number, no counter burn
  await reset();
  await seed('P', { status: 'pending_payment', payment_method: 'online' });
  await app.allocateDisplayNumberOnSale.run(ev('P', order({ id: 'P', status: 'pending_payment', payment_method: 'online' })));
  assert.strictEqual(await dn('P'), null, 'pending_payment → no number');
  assert.strictEqual(await counter('x_pizza'), null, 'no counter node created for an ineligible order');
  ok('ineligible (pending_payment) → no number, no counter burn');

  console.log(`\nAll ${pass} display-number emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
