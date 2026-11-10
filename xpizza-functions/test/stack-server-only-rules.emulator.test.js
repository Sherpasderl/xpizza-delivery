'use strict';
/**
 * 3a stack (S-A(d), S-B, S-F, convergence §1) — the NEW server-only RTDB nodes, behaviourally on the REAL rules file:
 *   npm run test:stack-server-only-rules
 *   rating_index/{rid}, stats_buckets/{rid}/{day}, stats_agg/{rid}, support_tickets/{id}, support_ticket_counts/{orderId},
 *   restaurants/{rid}/platform_config — NO client reads or writes them: anonymous, a customer (incl. the order's own member), a
 *   handheld, a seeded dispatcher, a kitchen staff member and a brand owner are all denied, at the node, at a child and at the root of
 *   each subtree; public_stats/{rid} stays PUBLIC-READ and client-unwritable (the S-B publication).
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'a'.repeat(24), DISP = 'd_' + 'b'.repeat(24), COOK = 'k_' + 'c'.repeat(24), OWN = 'o_' + 'd'.repeat(24);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NODES = [
  ['rating_index/x_pizza', 'rating_index/x_pizza/0000000000001-XPZ-1', 'XPZ-1'],
  ['stats_buckets/x_pizza', 'stats_buckets/x_pizza/2027-03-09', { v: 1, orders: 1 }],
  ['stats_agg/x_pizza', 'stats_agg/x_pizza/watermark', '2027-03-09'],
  ['support_tickets', 'support_tickets/t1', { order_id: 'XPZ-1', reason: 'late' }],
  ['support_ticket_counts/XPZ-1', 'support_ticket_counts/XPZ-1/committed/t1', true],
  ['restaurants/x_pizza/platform_config', 'restaurants/x_pizza/platform_config/source_version', 1],
];

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      for (const [, leaf, v] of NODES) await db.ref(leaf).set(v);
      await db.ref('orders/XPZ-1').set({ customer_uid: U, restaurant_id: 'x_pizza', status: 'delivered' });
      await db.ref(`dispatchers/${DISP}`).set(true);
      await db.ref(`restaurants/x_pizza/kitchen_staff/${COOK}`).set(true);
      await db.ref(`brand_members/x_pizza/owners/${OWN}`).set({ granted_at: 1, granted_by: 'x' });
      await db.ref('public_stats/x_pizza').set({ v: 1, rating_count: 12, rating_avg: 4.6 });
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
    ok('every client role (anonymous, a customer incl. the order\'s own member, a handheld, a dispatcher, kitchen staff, a brand owner) is denied READ, WRITE and DELETE on rating_index, stats_buckets, stats_agg, support_tickets, support_ticket_counts and restaurants/{rid}/platform_config');
    for (const [name, c] of who) {
      await assertSucceeds(c.database().ref('public_stats/x_pizza').get());
      await assertFails(c.database().ref('public_stats/x_pizza').set({ v: 1, rating_count: 999 }));
      assert.ok(true, name);
    }
    ok('public_stats/{rid} (the S-B publication) is PUBLIC-READ and NO client writes it');
  } finally { await env.cleanup(); }
  console.log(`\nstack-server-only-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`stack-server-only-rules.emulator: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
