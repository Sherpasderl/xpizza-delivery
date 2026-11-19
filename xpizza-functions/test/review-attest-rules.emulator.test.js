'use strict';
/**
 * «Marcar como revisado» (Codex #217 P2-1) — behaviourally, on the REAL rules file: npm run test:review-attest-rules
 * A dispatcher (the only client with an order write) can NEVER create, change or delete the attestation (manual_review_closed/*) or its
 * episode stamp (manual_review_since) — by a leaf write, an update or a whole-order replace — while an unrelated field still writes.
 * Every other client role is denied the order write outright. RULES_FILE=<path> runs the same cells against another rules file (the RED
 * proof against the base, in the slot).
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(process.env.RULES_FILE || path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'd_' + 'b'.repeat(24), U = 'u_' + 'a'.repeat(24);
const CLOSED = { outcome: 'refunded_in_pixelpay', amount_cents: 29900, note: 'anulado', by: 'disp@tb', at: 5, episode: 4, audited: true };
const ORDER = { restaurant_id: 'x_pizza', status: 'cancelled', payment_status: 'manual_review', notes: 'a', manual_review_since: 4, manual_review_closed: CLOSED };
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  try {
    const seed = async () => env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref('/').set(null);
      await db.ref('orders/RVA-1').set(ORDER);
      await db.ref('orders/RVA-2').set({ ...ORDER, manual_review_closed: null, manual_review_since: null });
      await db.ref(`dispatchers/${DISP}`).set(true);
    });
    await seed();
    const d = env.authenticatedContext(DISP).database();
    await assertSucceeds(d.ref('orders/RVA-1').update({ notes: 'edited' }));
    ok('premise: a dispatcher can still edit an unrelated order field');
    for (const k of Object.keys(CLOSED)) {
      await assertFails(d.ref('orders/RVA-1').update({ [`manual_review_closed/${k}`]: k === 'audited' ? false : 'x' }));   // change
      await assertFails(d.ref(`orders/RVA-1/manual_review_closed/${k}`).set(null));                                        // delete
      await assertFails(d.ref('orders/RVA-2').update({ [`manual_review_closed/${k}`]: CLOSED[k] }));                       // create (forge)
    }
    await assertFails(d.ref('orders/RVA-1/manual_review_closed').set(null));
    await assertFails(d.ref('orders/RVA-2/manual_review_closed').set(CLOSED));
    await assertFails(d.ref('orders/RVA-1').update({ manual_review_since: 9 }));
    await assertFails(d.ref('orders/RVA-1/manual_review_since').set(null));
    await assertFails(d.ref('orders/RVA-2').update({ manual_review_since: 4 }));
    await assertFails(d.ref('orders/RVA-2').set({ ...ORDER }));                                                             // whole-order replace with a forged closure
    ok('🔴 RAR-DISPATCHER: a dispatcher can never create, change or delete any attestation leaf or the episode stamp (leaf, node, update, whole order)');
    for (const c of [env.unauthenticatedContext(), env.authenticatedContext(U, { customer: true }), env.authenticatedContext(U, { handheld: true }), env.authenticatedContext(U)]) {
      await assertFails(c.database().ref('orders/RVA-2/manual_review_closed').set(CLOSED));
      await assertFails(c.database().ref('orders/RVA-1/manual_review_closed').set(null));
    }
    ok('every other client role is denied outright');
    console.log(`review-attest-rules(emulator): OK (${n})`);
  } finally { await env.cleanup(); }
})().catch((e) => { console.error(e); process.exit(1); });
