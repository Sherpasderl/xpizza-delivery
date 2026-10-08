/**
 * D4-c4 "Pausar pedidos" — the order_control RTDB rules (PLAN-D4c4 rev 13 §1/§0.9). Run: npm run test:order-control-rules
 *
 *   READ: ONLY global dispatchers — at the restaurant node, its `current`, its `events`, and the PARENT `order_control`
 *         (dispatch enumerates restaurants from the parent, §0.9). Kitchen staff, drivers, customers, a plain signed-in
 *         user and anonymous are denied at every level.
 *   WRITE: nobody — not even a dispatcher — at the leaf, the node, `events`, the parent, or through a ROOT multi-path
 *          update. The only writer is the owner CLI (Admin SDK).
 *   And the dispatcher can read the banner's restaurant name (restaurants/{rid}/identity/name).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const KITCHEN = 'u_kitchen000000000000000';
const DRIVER = 'u_driver0000000000000000';
const PLAIN = 'u_plain00000000000000000';
const NODE = { current: { paused: true, until: 1900000000000, since: 1, by: 'Ana', principal: 'a@x', reason: 'r', version: 1, op_id: 'op1' }, events: { op1: { from: { paused: false }, to: { paused: true }, at: 1, by: 'Ana', principal: 'a@x', reason: 'r', version: 1 } } };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`kitchen/${KITCHEN}`).set({ name: 'K' });
    await db.ref(`restaurants/x_pizza/kitchen_staff/${KITCHEN}`).set(true);
    await db.ref(`drivers/${DRIVER}`).set({ name: 'R' });
    await db.ref('order_control/x_pizza').set(NODE);
    await db.ref('order_control/r3_synthetic').set(NODE);
    await db.ref('restaurants/x_pizza/identity/name').set('X. Pizza');
  });
  const disp = env.authenticatedContext(DISP).database();
  const others = {
    kitchen: env.authenticatedContext(KITCHEN).database(),
    driver: env.authenticatedContext(DRIVER).database(),
    customer: env.authenticatedContext('u_cust000000000000000000', { customer: true }).database(),
    plain: env.authenticatedContext(PLAIN).database(),
    anon: env.unauthenticatedContext().database(),
  };
  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const READS = ['order_control', 'order_control/x_pizza', 'order_control/x_pizza/current', 'order_control/x_pizza/current/paused', 'order_control/x_pizza/events', 'order_control/r3_synthetic'];

  for (const p of READS) await ok(`dispatcher reads ${p}`, disp.ref(p).get());
  await ok('dispatcher reads the banner name restaurants/x_pizza/identity/name', disp.ref('restaurants/x_pizza/identity/name').get());
  for (const [who, db] of Object.entries(others)) for (const p of READS) await no(`${who} CANNOT read ${p}`, db.ref(p).get());

  const WRITES = [
    ['order_control/x_pizza/current/paused', false], ['order_control/x_pizza/current', { paused: false }], ['order_control/x_pizza', null],
    ['order_control/x_pizza/events/op2', { x: 1 }], ['order_control', null], ['order_control/new_rid/current', { paused: true }],
  ];
  for (const [who, db] of [['dispatcher', disp], ...Object.entries(others)]) {
    for (const [p, v] of WRITES) await no(`${who} CANNOT write ${p}`, db.ref(p).set(v));
    await no(`${who} CANNOT update order_control/x_pizza/current`, db.ref('order_control/x_pizza/current').update({ paused: false }));
    await no(`${who} CANNOT write through a ROOT multi-path update`, db.ref().update({ 'order_control/x_pizza/current/paused': false }));
  }
  await env.withSecurityRulesDisabled(async (ctx) => {
    const v = (await ctx.database().ref('order_control/x_pizza').get()).val();
    require('assert').deepStrictEqual(v, NODE, 'the node changed');   // deep (RTDB returns keys sorted)
  });
  console.log(`  ok ${++n} the node is byte-identical after every attempted write`);

  await env.cleanup();
  console.log(`\norder-control-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('order-control-rules(emulator) FAILED:', e && e.stack || e); process.exit(1); });
