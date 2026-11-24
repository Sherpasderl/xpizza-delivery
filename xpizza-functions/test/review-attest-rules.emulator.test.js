'use strict';
/**
 * «Marcar como revisado» (structural rebuild, owner GO 11-19) — behaviourally, on the REAL rules file: npm run test:review-attest-rules
 *   manual_review_closures/{order}/{episode}: NO client reads or writes it (every role, the node, a child, the root).
 *   manual_review_episodes/{order}: a dispatcher may READ it (Central sends it back); NO client writes it; every other role is denied the read.
 * RULES_FILE=<path> runs the same cells against another rules file (the RED proof against the base, in the slot).
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'd_' + 'b'.repeat(24), U = 'u_' + 'a'.repeat(24);
const REC = { outcome: 'refunded_in_pixelpay', amount_cents: 29900, note: 'anulado', by: 'disp@tb', at: 5 };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      await db.ref('manual_review_episodes/RVA-1').set(4);
      await db.ref('manual_review_closures/RVA-1/4').set(REC);
      await db.ref(`dispatchers/${DISP}`).set(true);
    });
    const d = env.authenticatedContext(DISP).database();
    await assertSucceeds(d.ref('manual_review_episodes/RVA-1').get());
    ok('a dispatcher can READ an order\'s current episode');
    await assertFails(d.ref('manual_review_episodes/RVA-1').set(9));
    await assertFails(d.ref('manual_review_episodes/RVA-1').set(null));
    await assertFails(d.ref('manual_review_episodes/RVA-2').set(4));
    await assertFails(d.ref('manual_review_episodes').get());
    for (const p of ['manual_review_closures', 'manual_review_closures/RVA-1', 'manual_review_closures/RVA-1/4', 'manual_review_closures/RVA-1/4/by']) {
      await assertFails(d.ref(p).get()); await assertFails(d.ref(p).set(null));
    }
    await assertFails(d.ref('manual_review_closures/RVA-1/9').set(REC));
    ok('🔴 RAR-DISPATCHER: a dispatcher can never write an episode, nor read or write any closure (node, child, root)');
    for (const c of [env.unauthenticatedContext(), env.authenticatedContext(U, { customer: true }), env.authenticatedContext(U, { handheld: true }), env.authenticatedContext(U)]) {
      const db = c.database();
      await assertFails(db.ref('manual_review_episodes/RVA-1').get()); await assertFails(db.ref('manual_review_episodes/RVA-1').set(9));
      await assertFails(db.ref('manual_review_closures/RVA-1/4').get()); await assertFails(db.ref('manual_review_closures/RVA-1/9').set(REC));
    }
    ok('every other client role is denied the episode read and every write');
    assert.ok(n === 3);
    console.log(`review-attest-rules(emulator): OK (${n})`);
  } finally { await env.cleanup(); }
})().catch((e) => { console.error(e); process.exit(1); });
