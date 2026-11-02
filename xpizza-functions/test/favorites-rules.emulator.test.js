'use strict';
/**
 * S-C favorites (PLAN §S-C) — the user_favorites RULES, behaviourally (the real rules file on the emulator):  npm run test:favorites-rules
 *   1 the member OWNER sets / reads / updates / deletes its own favorites (single rid and the whole node);
 *   2 another customer, an unauthenticated client, a staff account (no customer claim) and a handheld are denied, read and write;
 *   3 the owner's still-valid session is denied under EVERY tombstone kind and the sweep claim (deleted_uids, user_private.deleted_at,
 *     user_profiles.deleting_at) — no favorite outlives or races a deletion;
 *   4 validation: a malformed rid, a missing / non-number / future createdAt, an extra field ⇒ denied.
 * (The purge itself — accountDeleteUpdates nulls user_favorites/{uid} — is proven by deletion-tombstone.test + account-lifecycle.test.)
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'a'.repeat(24), U2 = 'u_' + 'b'.repeat(24);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAV = (t = 1) => ({ createdAt: t });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = async (extra = async () => {}) => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('/').set(null);
    await db.ref(`user_profiles/${U}`).set({ phone: '50499990000', phone_hash: 'ph_a', created_at: 1, last_login: 1 });
    await db.ref(`user_favorites/${U2}/x_pizza`).set(FAV());
    await extra(db);
  });
  const owner = () => env.authenticatedContext(U, { customer: true }).database();
  try {
    // 1. the member owner
    await seed();
    await assertSucceeds(owner().ref(`user_favorites/${U}/x_pizza`).set(FAV(Date.now())));
    await assertSucceeds(owner().ref(`user_favorites/${U}/la_musa`).set(FAV()));
    await assertSucceeds(owner().ref(`user_favorites/${U}`).get());
    await assertSucceeds(owner().ref(`user_favorites/${U}/x_pizza`).set(null));
    await assertSucceeds(owner().ref(`user_favorites/${U}`).set({ merch_a: FAV(), merch_b: FAV() }));
    ok('the member owner sets / reads / deletes its own favorites (single rid and the whole node)');

    // 2. everyone else
    for (const [who, db] of [['another customer', env.authenticatedContext(U2, { customer: true }).database()], ['unauthenticated', env.unauthenticatedContext().database()],
      ['a staff account (no customer claim)', env.authenticatedContext(U).database()], ['a handheld', env.authenticatedContext(U, { customer: true, handheld: true }).database()]]) {
      await assertFails(db.ref(`user_favorites/${U}`).get());
      await assertFails(db.ref(`user_favorites/${U}/x_pizza`).set(FAV()));
      if (who !== 'another customer') await assertFails(db.ref(`user_favorites/${U2}`).get());
      assert.ok(true, who);
    }
    await assertFails(env.authenticatedContext(U, { customer: true }).database().ref('user_favorites').get());
    ok('another customer / unauthenticated / staff (no customer claim) / a handheld are denied read + write; nobody reads the root');

    // 3. every tombstone kind + the sweep claim
    for (const [why, extra] of [
      ['deleted_uids', async (db) => db.ref(`deleted_uids/${U}`).set(5)],
      ['user_private.deleted_at', async (db) => db.ref(`user_private/${U}`).set({ deleted_at: 5 })],
      ['the sweep claim (deleting_at)', async (db) => db.ref(`user_profiles/${U}/deleting_at`).set(5)],
    ]) {
      await seed(extra);
      await assertFails(owner().ref(`user_favorites/${U}/x_pizza`).set(FAV()));
      await assertFails(owner().ref(`user_favorites/${U}`).set({ x_pizza: FAV() }));
      assert.ok(true, why);
    }
    ok('the owner\'s still-valid session is denied under deleted_uids, user_private.deleted_at and the sweep claim');

    // 4. validation
    await seed();
    for (const [why, rid, val] of [['a malformed rid (upper / space)', 'X Pizza', FAV()], ['a one-char rid', 'a', FAV()], ['a missing createdAt', 'x_pizza', {}],
      ['a string createdAt', 'x_pizza', { createdAt: 'now' }], ['a future createdAt', 'x_pizza', { createdAt: Date.now() + 3600e3 }], ['an extra field', 'x_pizza', { createdAt: 1, note: 'x' }]]) {
      await assertFails(owner().ref(`user_favorites/${U}/${rid}`).set(val));
      assert.ok(true, why);
    }
    ok('validation: a malformed / too-short rid, a missing / string / future createdAt and an extra field are denied');
  } finally { await env.cleanup(); }
  console.log(`\nfavorites-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`favorites-rules.emulator: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
