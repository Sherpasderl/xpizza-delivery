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
const ev = (orderId, after, before = null) => ({ data: { before: { val: () => before }, after: { val: () => after } }, params: { orderId } });
const order = (o = {}) => ({ status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', tracking_token: 'TOK-' + (o.id || 'x'), ...o });
const dn = async (id) => (await db.ref(`orders/${id}/display_number`).once('value')).val();
const trackDn = async (tok) => (await db.ref(`order_tracking/${tok}/display_number`).once('value')).val();
const counter = async (rid) => (await db.ref(`counters/order_display_seq/${rid}/${DAY}`).once('value')).val();
const seed = (id, o) => db.ref(`orders/${id}`).set(order({ id, ...o }));
const reset = () => db.ref('/').set(null);

let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const inRange = (x) => Number.isInteger(x) && x >= 100 && x <= 999;   // NON-SEQUENTIAL 3-digit label

(async () => {
  // 1. live/Sale order → a 3-digit number on BOTH /orders and order_tracking; counter node records it
  await reset();
  await seed('A', {});
  await app.allocateDisplayNumberOnSale.run(ev('A', order({ id: 'A' })));
  const nA = await dn('A');
  assert.ok(inRange(nA), '/orders/A/display_number is a 3-digit number');
  assert.strictEqual(await trackDn('TOK-A'), nA, 'order_tracking/TOK-A mirrors the same number');
  assert.deepStrictEqual(await counter('x_pizza'), { last: nA, by_order: { A: nA } }, 'counter records A → nA');
  ok('live/Sale order → a 3-digit number on /orders AND order_tracking; counter correct');

  // 2. second order → a DIFFERENT 3-digit number (non-sequential, unique within the day — NOT #2)
  await seed('B', {});
  await app.allocateDisplayNumberOnSale.run(ev('B', order({ id: 'B' })));
  const nB = await dn('B');
  assert.ok(inRange(nB), 'second order → a 3-digit number');
  assert.notStrictEqual(nB, nA, 'second order gets a DIFFERENT number (unique within the day)');
  assert.deepStrictEqual((await counter('x_pizza')).by_order, { A: nA, B: nB });
  ok('second order → a different 3-digit number (non-sequential, unique, no volume signal)');

  // 3. IDEMPOTENT re-fire of A → still nA, counter unchanged (no re-burn/duplicate)
  await app.allocateDisplayNumberOnSale.run(ev('A', order({ id: 'A' })));
  assert.strictEqual(await dn('A'), nA, 'A still nA');
  assert.deepStrictEqual((await counter('x_pizza')).by_order, { A: nA, B: nB }, 'by_order unchanged (no re-burn)');
  ok('idempotent re-fire of A → same number, by_order unchanged (no re-burn/duplicate)');

  // 4. CONCURRENCY: two handlers for one fresh order → exactly one number
  await seed('C', {});
  await Promise.all([
    app.allocateDisplayNumberOnSale.run(ev('C', order({ id: 'C' }))),
    app.allocateDisplayNumberOnSale.run(ev('C', order({ id: 'C' }))),
  ]);
  const nC = await dn('C');
  assert.ok(inRange(nC), 'C got a 3-digit number');
  const byO = (await counter('x_pizza')).by_order;
  assert.strictEqual(byO.C, nC, 'C has exactly one recorded number');
  assert.strictEqual(Object.keys(byO).length, 3, 'exactly A,B,C recorded (no double-burn)');
  ok('concurrency: two handlers for one order → one number (no double-burn)');

  // 5. per-restaurant: la_musa gets its OWN number from an independent node (brand-agnostic obscuring)
  await seed('L', { restaurant_id: 'la_musa', tracking_token: 'TOK-L' });
  await app.allocateDisplayNumberOnSale.run(ev('L', order({ id: 'L', restaurant_id: 'la_musa', tracking_token: 'TOK-L' })));
  const nL = await dn('L');
  assert.ok(inRange(nL), 'la_musa → its own 3-digit number');
  assert.deepStrictEqual(await counter('la_musa'), { last: nL, by_order: { L: nL } });
  ok('per-restaurant counter: la_musa gets its own 3-digit number, independent of x_pizza');

  // 6. NOT eligible → no number, no counter burn
  await reset();
  await seed('P', { status: 'pending_payment', payment_method: 'online' });
  await app.allocateDisplayNumberOnSale.run(ev('P', order({ id: 'P', status: 'pending_payment', payment_method: 'online' })));
  assert.strictEqual(await dn('P'), null, 'pending_payment → no number');
  assert.strictEqual(await counter('x_pizza'), null, 'no counter node created for an ineligible order');
  ok('ineligible (pending_payment) → no number, no counter burn');

  // 7. F1 — an order ALREADY live ('new'→'new', unstamped) on a NON-transition write → NOT numbered, no burn
  await reset();
  await seed('PRE', {});
  await app.allocateDisplayNumberOnSale.run(ev('PRE', order({ id: 'PRE' }), order({ id: 'PRE' })));  // before.status also 'new'
  assert.strictEqual(await dn('PRE'), null, 'pre-existing live order → NOT numbered on a non-transition write');
  assert.strictEqual(await counter('x_pizza'), null, 'no counter burn (would have made the real first order #2)');
  ok('F1: already-live order on a non-transition write → no number, no burn (deploy-day mis-numbering fixed)');

  // 8. F2 + F3 — allocate anchored to the order's LIVE day; a later stamp-fail heals to the SAME number (cross-midnight-safe)
  await reset();
  const liveTs = Date.UTC(2026, 6, 16, 6, 0);   // fixed live timestamp → a specific Tegucigalpa day-node
  const liveDay = hnDateISO(liveTs);
  await db.ref('orders/H').set(order({ id: 'H', created_at: liveTs }));
  await app.allocateDisplayNumberOnSale.run(ev('H', order({ id: 'H', created_at: liveTs }), null));  // transition → allocate
  const n = await dn('H');
  assert.ok(inRange(n), 'H allocated a 3-digit number');
  const liveNode = async () => (await db.ref(`counters/order_display_seq/x_pizza/${liveDay}`).once('value')).val();
  assert.strictEqual((await liveNode()).by_order.H, n, 'reservation lives in the LIVE-day node (F2: day from created_at, not trigger time)');
  // simulate a stamp-fail (the /orders stamp never landed) THEN a later non-transition write (status → preparing)
  await db.ref('orders/H/display_number').remove();
  await app.allocateDisplayNumberOnSale.run(
    ev('H', order({ id: 'H', created_at: liveTs, status: 'preparing' }), order({ id: 'H', created_at: liveTs, status: 'new' })));
  assert.strictEqual(await dn('H'), n, 'HEAL re-stamped the SAME number (F3) from the live-day node (cross-midnight-safe, F2)');
  assert.strictEqual((await liveNode()).last, n, 'no NEW number minted on the heal (last unchanged — no duplicate)');
  ok('F2+F3: allocate on the live-day node; a later stamp-fail heals to the SAME number, no duplicate/next-day burn');

  console.log(`\nAll ${pass} display-number emulator assertions passed.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
