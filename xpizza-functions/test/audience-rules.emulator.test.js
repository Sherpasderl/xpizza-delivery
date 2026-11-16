'use strict';
/**
 * offer-audience BUILD T11 (PLAN-5f-offer-audience r2 §8 «marker rule denials», r4.1 §4) — behaviourally, on the REAL rules file:
 *   npm run test:audience-rules
 *   customer_seen/{brand}/{h}, customer_seen_m/{brand}/{month_h}, audience_ids_by_day/{day_id}, audience_alerts/... — NO client reads or
 *   writes them (anonymous, a customer incl. the order's own member, a handheld, a dispatcher, kitchen staff, a brand owner), at the node,
 *   a child and the subtree root; and a dispatcher's order write can NEVER change the payout decision orders/{id}/offer_reconcile (create,
 *   edit or delete) while an unrelated field still writes.
 *   RULES_FILE=<path> runs the same cells against another rules file (the RED proof against the base, in the slot).
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'a'.repeat(24), DISP = 'd_' + 'b'.repeat(24), COOK = 'k_' + 'c'.repeat(24), OWN = 'o_' + 'd'.repeat(24);
const H = 'f'.repeat(64);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NODES = [
  ['customer_seen/x_pizza', `customer_seen/x_pizza/${H}`, { m: '2026-11' }],
  ['customer_seen_m/x_pizza', `customer_seen_m/x_pizza/2026-11_${H}`, true],
  ['audience_ids_by_day', 'audience_ids_by_day/2026-11-16_XPZ-1', true],
  ['audience_alerts', 'audience_alerts/mark_skipped/2026-11-16', 1],
];

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      for (const [, leaf, v] of NODES) await db.ref(leaf).set(v);
      await db.ref('orders/XPZ-1').set({ customer_uid: U, restaurant_id: 'x_pizza', status: 'delivered', notes: 'a', offer: { offer_id: 'of_x', audience: 'new' }, offer_reconcile: { funded_by: 'sherpa', reason: 'seen_before', at: 1 } });
      await db.ref('orders/XPZ-2').set({ customer_uid: U, restaurant_id: 'x_pizza', status: 'preparing', notes: 'b', offer: { offer_id: 'of_x', audience: 'new' } });
      await db.ref(`dispatchers/${DISP}`).set(true);
      await db.ref(`restaurants/x_pizza/kitchen_staff/${COOK}`).set(true);
      await db.ref(`brand_members/x_pizza/owners/${OWN}`).set({ granted_at: 1, granted_by: 'x' });
    });
    const who = [['anonymous', env.unauthenticatedContext()], ['a customer (the order\'s own member)', env.authenticatedContext(U, { customer: true })],
      ['a handheld', env.authenticatedContext(U, { handheld: true })], ['a seeded dispatcher', env.authenticatedContext(DISP)],
      ['kitchen staff', env.authenticatedContext(COOK)], ['a brand owner', env.authenticatedContext(OWN)]];
    for (const [name, c] of who) {
      const db = c.database();
      for (const [node, leaf, v] of NODES) {
        await assertFails(db.ref(node).get()); await assertFails(db.ref(leaf).get());
        await assertFails(db.ref(leaf).set(v)); await assertFails(db.ref(node).set(null));
      }
      assert.ok(true, name);
    }
    ok('every client role is denied READ, WRITE and DELETE on customer_seen, customer_seen_m, audience_ids_by_day and audience_alerts');

    const d = env.authenticatedContext(DISP).database();
    await assertSucceeds(d.ref('orders/XPZ-1').update({ notes: 'edited' }));
    await assertFails(d.ref('orders/XPZ-1').update({ 'offer_reconcile/funded_by': 'restaurant' }));
    await assertFails(d.ref('orders/XPZ-1').update({ 'offer_reconcile/reason': 'first' }));
    await assertFails(d.ref('orders/XPZ-1').update({ offer_reconcile: null }));
    await assertFails(d.ref('orders/XPZ-2').update({ offer_reconcile: { funded_by: 'restaurant', reason: 'first', at: 2 } }));
    ok('a dispatcher still edits an order, but never creates, edits or deletes its payout decision (offer_reconcile)');
  } finally { await env.cleanup(); }
  console.log(`\naudience-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`audience-rules.emulator: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
