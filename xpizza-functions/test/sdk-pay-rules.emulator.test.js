/**
 * SDK card-order rules, per client role, against the REAL rules file (BRIEF-sdk-payment-coordinator r5 §3, §4a, D1).
 * Run under the emulator runner: npm run test:sdk-pay-rules
 */
'use strict';
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const KITCHEN = 'u_kitchen000000000000000';
const DRIVER = 'u_driver0000000000000000';
const DEVICE = 'hh_tb_norte_abc';
const SDK = { payment_flow: 'sdk_auth_v1', payment_total_cents: 10000, payment_placed: { leg_id: 'L1', at: 1 }, payment_commit: { revision: 1, pid: 'p1' }, sdk_live_pending: '{"delivery":{}}' };
const live = () => ({ order_id: 'x', restaurant_id: 'tb_norte', status: 'preparing', ...SDK });
const done = () => ({ ...live(), status: 'delivered', payment_terminal: { revision: 1, at: 2 } });
const legacy = () => ({ order_id: 'x', restaurant_id: 'tb_norte', status: 'delivered', payment_method: 'cash' });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref().set({
      dispatchers: { [DISP]: { name: 'D' } }, kitchen: { [KITCHEN]: { name: 'K' } }, drivers: { [DRIVER]: { name: 'R' } },
      restaurants: { tb_norte: { order_surface: 'kds' } },
      tasks: { o_live_delivery: { assigned_driver_id: DRIVER, status: 'assigned' } },
      orders: { o_live: live(), o_done: done(), o_legacy: legacy(), o_legacy2: { ...legacy(), status: 'preparing' }, o_fresh: { order_id: 'x', restaurant_id: 'tb_norte', status: 'preparing', payment_flow: 'sdk_auth_v1', payment_total_cents: 10000 } },
      payment_sdk: { o_live: { version: 1 } }, payment_sdk_due: { o_live: 1 },
    });
  });
  await seed();
  const as = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const disp = as(DISP); const kitchen = as(KITCHEN); const driver = as(DRIVER);
  const device = as(DEVICE, { handheld: true, rid: 'tb_norte' }); const cust = as('u_cust000000000000000000', { customer: true });
  const anon = env.unauthenticatedContext().database();
  let n = 0;
  const ok = async (label, pr) => { await seed(); await assertSucceeds(pr()); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await seed(); await assertFails(pr()); console.log(`  ok ${++n} ${label}`); };
  const roles = { dispatcher: disp, kitchen, driver, device, customer: cust, anon };

  // D1: the record and the due index are server-only for every client
  for (const [r, db] of Object.entries(roles)) for (const node of ['payment_sdk/o_live', 'payment_sdk_due/o_live']) {
    await no(`SPRE-SERVER-ONLY ${r} reads ${node}`, () => db.ref(node).once('value'));
    await no(`SPRE-SERVER-ONLY ${r} writes ${node}`, () => db.ref(node).set({ x: 1 }));
  }
  // §3: no client creates / changes / removes a decision field — leaf, delete, extra child, whole-order, multipath, order delete
  for (const [r, db] of Object.entries(roles)) {
    await no(`SPRE-FIELD ${r} changes payment_flow`, () => db.ref('orders/o_live/payment_flow').set('legacy'));
    await no(`SPRE-FIELD ${r} removes payment_flow`, () => db.ref('orders/o_live/payment_flow').remove());
    await no(`SPRE-FIELD ${r} changes payment_commit/revision`, () => db.ref('orders/o_live/payment_commit/revision').set(9));
    await no(`SPRE-FIELD ${r} adds payment_commit/evil`, () => db.ref('orders/o_live/payment_commit/evil').set(1));
    await no(`SPRE-FIELD ${r} creates payment_cancel`, () => db.ref('orders/o_live/payment_cancel').set({ kind: 'cancel', at: 1 }));
    await no(`SPRE-FIELD ${r} creates payment_terminal`, () => db.ref('orders/o_live/payment_terminal').set({ revision: 1, at: 1 }));
    await no(`SPRE-FIELD ${r} creates payment_flow on a LEGACY order`, () => db.ref('orders/o_legacy2/payment_flow').set('sdk_auth_v1'));
  }
  // Codex r1 #1: scalar forgery of every decision object — created as a scalar, an existing object replaced by a scalar,
  // and a whole-order write carrying a scalar marker
  for (const [r, db] of Object.entries(roles)) for (const f of ['payment_placed', 'payment_commit', 'payment_terminal', 'payment_cancel']) {
    await no(`SPRE-SCALAR ${r} creates ${f} = true`, () => db.ref(`orders/o_fresh/${f}`).set(true));
    await no(`SPRE-SCALAR ${r} creates ${f} = 1`, () => db.ref(`orders/o_fresh/${f}`).set(1));
  }
  // Codex r3 A: the go-live pending list is server-only — never created, changed or removed by a client
  for (const [r, db] of Object.entries(roles)) {
    await no(`SPRE-LIVE-PENDING ${r} creates sdk_live_pending`, () => db.ref('orders/o_fresh/sdk_live_pending').set('{"pickup":{}}'));
    await no(`SPRE-LIVE-PENDING ${r} changes sdk_live_pending`, () => db.ref('orders/o_live/sdk_live_pending').set('{}'));
    await no(`SPRE-LIVE-PENDING ${r} removes sdk_live_pending`, () => db.ref('orders/o_live/sdk_live_pending').remove());
  }
  await no('SPRE-LIVE-PENDING dispatcher whole-order write adds sdk_live_pending', () => disp.ref('orders/o_fresh').set({ order_id: 'x', restaurant_id: 'tb_norte', status: 'preparing', payment_flow: 'sdk_auth_v1', payment_total_cents: 10000, sdk_live_pending: '{}' }));
  await no('SPRE-SCALAR dispatcher replaces payment_placed with a scalar', () => disp.ref('orders/o_live/payment_placed').set(true));
  await no('SPRE-SCALAR dispatcher whole-order write adds payment_terminal = true', () => disp.ref('orders/o_fresh').set({ order_id: 'x', restaurant_id: 'tb_norte', status: 'preparing', payment_flow: 'sdk_auth_v1', payment_total_cents: 10000, payment_terminal: true }));
  await no('SPRE-SCALAR dispatcher multipath adds payment_cancel = true', () => disp.ref().update({ 'orders/o_fresh/payment_cancel': true, 'orders/o_fresh/notes': 'x' }));
  await ok('SPRE-SCALAR PREMISE dispatcher edits the fresh SDK order otherwise', () => disp.ref('orders/o_fresh/notes').set('x'));
  const { payment_flow, ...stripped } = live();
  await no('SPRE-WHOLE dispatcher replaces the order WITHOUT payment_flow', () => disp.ref('orders/o_live').set(stripped));
  await no('SPRE-WHOLE dispatcher replaces the order with another payment_commit', () => disp.ref('orders/o_live').set({ ...live(), payment_commit: { revision: 2, pid: 'pX' } }));
  await ok('SPRE-WHOLE dispatcher replaces the order PRESERVING every server field (legit edit)', () => disp.ref('orders/o_live').set({ ...live(), notes: 'sin cebolla' }));
  await no('SPRE-MULTIPATH dispatcher strips payment_flow by a root update', () => disp.ref().update({ 'orders/o_live/payment_flow': null, 'orders/o_live/notes': 'x' }));
  await ok('SPRE-MULTIPATH dispatcher edits another field by a root update', () => disp.ref().update({ 'orders/o_live/notes': 'x' }));
  await no('SPRE-DELETE dispatcher deletes an SDK order', () => disp.ref('orders/o_live').remove());
  await ok('SPRE-DELETE dispatcher deletes a LEGACY order (unchanged rules)', () => disp.ref('orders/o_legacy').remove());
  // §4a: a delivered / completed SDK order cannot be moved back by a client — leaf, whole-order, multipath, status delete
  for (const [r, db] of Object.entries({ dispatcher: disp, kitchen })) await no(`SPRE-REVERSAL ${r} moves a delivered SDK order back to preparing`, () => db.ref('orders/o_done/status').set('preparing'));
  await no('SPRE-REVERSAL dispatcher whole-order write back to preparing', () => disp.ref('orders/o_done').set({ ...done(), status: 'preparing' }));
  await no('SPRE-REVERSAL dispatcher multipath back to preparing', () => disp.ref().update({ 'orders/o_done/status': 'preparing' }));
  await no('SPRE-REVERSAL dispatcher deletes the status of a delivered SDK order', () => disp.ref('orders/o_done/status').remove());
  await ok('SPRE-LEGACY a dispatcher may still move a LEGACY delivered order back (unchanged rules)', () => disp.ref('orders/o_legacy/status').set('preparing'));
  // delivery is NEVER blocked by payments
  await ok('SPRE-DELIVERY the assigned driver marks a live SDK order delivered', () => driver.ref('orders/o_live/status').set('delivered'));
  await ok('SPRE-DELIVERY a dispatcher marks a live SDK order completed', () => disp.ref('orders/o_live/status').set('completed'));
  await ok('SPRE-DELIVERY kitchen moves a live SDK order forward (ready)', () => kitchen.ref('orders/o_live/status').set('ready'));
  console.log(`\nsdk-pay-rules (emulator): OK (${n})`);
  await env.cleanup();
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e && e.message); process.exit(1); });
