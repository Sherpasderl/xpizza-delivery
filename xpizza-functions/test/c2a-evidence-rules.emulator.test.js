'use strict';
/**
 * 1D D4-c2a — Firestore rules for restaurants/{rid}/identity_evidence (PLAN-D4c2a rev 9 §7): an EXPLICIT client deny for
 * read and write, for an unauthenticated client, a signed-in client and a signed-in "owner" alike. Only the server
 * (Admin SDK, which bypasses rules) writes evidence. Run: npm run test:c2a-evidence-rules
 * The existing catalog surface is re-asserted beside it (public read of the restaurant profile / menu_items) so the new
 * match block is shown not to have changed what was already open.
 */
require('./_emulator-required')('firestore');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, getDocs, collection, deleteDoc, updateDoc } = require('firebase/firestore');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const hostPort = process.env.FIRESTORE_EMULATOR_HOST;
  const i = hostPort.lastIndexOf(':');
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', firestore: { rules: RULES, host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) } });
  try {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'restaurants/x_pizza'), { name: 'X. Pizza' });
      await setDoc(doc(db, 'restaurants/x_pizza/menu_items/m1'), { key: 'Margherita' });
      await setDoc(doc(db, 'restaurants/x_pizza/identity_evidence/abc__g1'), { v: 1, vid: 'abc', generation: 1 });
    });
    const clients = { anonymous: env.unauthenticatedContext(), signed_in: env.authenticatedContext('u1'), owner_claim: env.authenticatedContext('u2', { role: 'owner', restaurantId: 'x_pizza' }) };
    for (const [who, ctx] of Object.entries(clients)) {
      const db = ctx.firestore();
      const ref = doc(db, 'restaurants/x_pizza/identity_evidence/abc__g1');
      await assertFails(getDoc(ref));
      await assertFails(getDocs(collection(db, 'restaurants/x_pizza/identity_evidence')));
      await assertFails(setDoc(doc(db, 'restaurants/x_pizza/identity_evidence/new__g2'), { v: 1 }));
      await assertFails(updateDoc(ref, { v: 2 }));
      await assertFails(deleteDoc(ref));
      // unchanged surface beside it
      await assertSucceeds(getDoc(doc(db, 'restaurants/x_pizza')));
      await assertSucceeds(getDocs(collection(db, 'restaurants/x_pizza/menu_items')));
      await assertFails(setDoc(doc(db, 'restaurants/x_pizza/menu_items/m2'), { key: 'x' }));
      ok(`${who}: identity_evidence get / list / create / update / delete are ALL denied; the public profile and menu_items reads still succeed and menu writes are still denied`);
    }
    console.log(`c2a-evidence-rules: OK (${n})`);
  } finally { await env.cleanup(); }
  process.exit(0);
})().catch((e) => { console.error('c2a-evidence-rules FAILED:', e); process.exit(1); });
