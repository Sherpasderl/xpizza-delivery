'use strict';
// PLAN-manual-factura r3 §6 + Codex #252-1 — under the REAL database rules, no client write can create or touch an order in the manual
// factura key space (`manual_…`), including the separately-granted child-only /status write; the same writes on an ordinary id pass
// (the controls prove each writer really holds the grant). Run: npm run test:manual-factura-rules
//   (RULES_FILE=<path> runs it against another rules file: the base must FAIL — the RED proof.)
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_mfdisp0000000000000000';
const KITCHEN = 'u_mfkitchen0000000000000';
const MAN = 'manual_mf_aaaaaaaaaaaaaaaa', ORD = 'mf_rules_order_1';
const order = (id) => ({ orderId: id, restaurant_id: 'x_pizza', status: 'preparing', customer_name: 'T', total: 115 });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-mfrules', database: { rules: RULES } });
  let n = 0;
  const ok = async (label, pr) => { try { await assertSucceeds(pr); } catch (e) { throw new Error(`FAILED (control): ${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  const no = async (cell, label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`🔴 ${cell}: ${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  const seed = () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('/').set(null);
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`kitchen/${KITCHEN}`).set({ name: 'K' });
    await db.ref(`restaurants/x_pizza/kitchen_staff/${KITCHEN}`).set(true);
    await db.ref(`orders/${ORD}`).set(order(ORD));
    await db.ref(`orders/${MAN}`).set(order(MAN));   // a stray manual_ node (only the server could ever have put it there)
  });
  const disp = env.authenticatedContext(DISP).database();
  const kitchen = env.authenticatedContext(KITCHEN).database();
  await seed();
  await ok('control: a dispatcher writes an ordinary order', disp.ref('orders/mf_rules_order_2').set(order('mf_rules_order_2')));
  await no('MFR-CREATE', 'a dispatcher CANNOT create a manual_ order', disp.ref('orders/manual_mf_bbbbbbbbbbbbbbbb').set(order('manual_mf_bbbbbbbbbbbbbbbb')));
  await ok('control: a dispatcher writes an ordinary order\'s /status', disp.ref(`orders/${ORD}/status`).set('ready'));
  await no('MFR-STATUS', 'a dispatcher CANNOT write a manual_ order\'s /status (child-only write)', disp.ref(`orders/${MAN}/status`).set('cancelled'));
  await ok('control: kitchen staff write an ordinary order\'s /status', kitchen.ref(`orders/${ORD}/status`).set('preparing'));
  await no('MFR-STATUS', 'kitchen staff CANNOT write a manual_ order\'s /status (the separately-granted child)', kitchen.ref(`orders/${MAN}/status`).set('cancelled'));
  await no('MFR-STATUS', 'a multi-path update touching a manual_ order\'s /status is refused', disp.ref('orders').update({ [`${MAN}/status`]: 'cancelled' }));
  await env.cleanup();
  console.log(`manual-factura-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
