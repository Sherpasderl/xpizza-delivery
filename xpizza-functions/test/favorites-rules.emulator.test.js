'use strict';
/**
 * S-C favorites (PLAN §S-C; Codex S-C r1 folded) — the user_favorites RULES, behaviourally (the real rules file on the emulator):
 *   npm run test:favorites-rules
 *   1 the member OWNER sets / reads / updates / deletes its own favorites (single rid and the whole node); an empty / null write
 *     is a DELETE and succeeds (.validate never runs on a delete);
 *   2 a scalar whole-node write (string / number / boolean), direct or via a root multi-path update, is refused;
 *   3 another customer, an unauthenticated client, a REAL seeded dispatcher (staff membership, no customer claim) and a handheld are
 *     denied read, write and delete; nobody reads the user_favorites root;
 *   4 root / parent overwrites and a root multi-path update mixing the owner's own path with a foreign one are refused WHOLE (the
 *     owned half does not land);
 *   5 the owner's still-valid session is denied READ and WRITE under EVERY tombstone kind and the sweep claim (deleted_uids,
 *     user_private.deleted_at, user_profiles.deleting_at);
 *   6 validation: a malformed / too-short rid, a regex-valid rid that is NOT a real restaurant (no restaurants/{rid}/identity), a
 *     non-empty value missing createdAt, a string / future createdAt, an extra field, and a malformed whole-uid replacement ⇒ denied;
 *     the node is bounded by the number of real restaurants.
 * (The purge itself — accountDeleteUpdates nulls user_favorites/{uid} — is proven by deletion-tombstone.test + account-lifecycle.test.)
 */
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const U = 'u_' + 'a'.repeat(24), U2 = 'u_' + 'b'.repeat(24), STAFF = 's_' + 'c'.repeat(24);
const REAL = ['x_pizza', 'la_musa', 'merch_a'];   // seeded restaurants (an identity exists); 'ghost_rid' is regex-valid but not real
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAV = (t = 1) => ({ createdAt: t });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = async (extra = async () => {}) => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('/').set(null);
    for (const rid of REAL) await db.ref(`restaurants/${rid}/identity`).set({ name: rid, active: true });
    await db.ref(`user_profiles/${U}`).set({ phone: '50499990000', phone_hash: 'ph_a', created_at: 1, last_login: 1 });
    await db.ref(`dispatchers/${STAFF}`).set(true);
    await db.ref(`user_favorites/${U}/x_pizza`).set(FAV());
    await db.ref(`user_favorites/${U2}/x_pizza`).set(FAV());
    await extra(db);
  });
  const peek = async (p) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = (await ctx.database().ref(p).once('value')).val(); }); return v; };
  const owner = () => env.authenticatedContext(U, { customer: true }).database();
  try {
    // 1. the member owner
    await seed();
    await assertSucceeds(owner().ref(`user_favorites/${U}/x_pizza`).set(FAV(Date.now())));
    await assertSucceeds(owner().ref(`user_favorites/${U}/la_musa`).set(FAV()));
    await assertSucceeds(owner().ref(`user_favorites/${U}`).get());
    await assertSucceeds(owner().ref(`user_favorites/${U}/x_pizza`).set(null));
    await assertSucceeds(owner().ref(`user_favorites/${U}`).set({ merch_a: FAV(), la_musa: FAV() }));
    await assertSucceeds(owner().ref(`user_favorites/${U}/merch_a`).set({}));          // {} is a delete — allowed
    assert.strictEqual(await peek(`user_favorites/${U}/merch_a`), null, 'the empty write deleted the favorite');
    await assertSucceeds(owner().ref(`user_favorites/${U}`).set(null));                // whole-node delete
    assert.strictEqual(await peek(`user_favorites/${U}`), null);
    ok('the member owner sets / reads / deletes its own favorites (single rid and the whole node); an empty {} and a null write are DELETES and succeed');

    // 2. scalar whole-node writes (Codex r1 #1)
    await seed();
    for (const v of ['arbitrary data', 42, true]) {
      await assertFails(owner().ref(`user_favorites/${U}`).set(v));
      await assertFails(owner().ref().update({ [`user_favorites/${U}`]: v }));
    }
    assert.deepStrictEqual(await peek(`user_favorites/${U}`), { x_pizza: FAV() }, 'the node is unchanged');
    ok('a scalar whole-node write (string / number / boolean) is refused — directly and via a root multi-path update');

    // 3. everyone else (a REAL seeded dispatcher, not just a missing claim)
    for (const [who, mk] of [['another customer', () => env.authenticatedContext(U2, { customer: true }).database()], ['unauthenticated', () => env.unauthenticatedContext().database()],
      ['a seeded dispatcher (staff, no customer claim)', () => env.authenticatedContext(STAFF).database()], ['a dispatcher token carrying customer', () => env.authenticatedContext(STAFF, { customer: true }).database()],
      ['a handheld', () => env.authenticatedContext(U, { customer: true, handheld: true }).database()]]) {
      await seed();
      const db = mk();
      await assertFails(db.ref(`user_favorites/${U}`).get());
      await assertFails(db.ref(`user_favorites/${U}/x_pizza`).get());
      await assertFails(db.ref(`user_favorites/${U}/la_musa`).set(FAV()));
      await assertFails(db.ref(`user_favorites/${U}/x_pizza`).set(null));            // a foreign DELETE
      await assertFails(db.ref(`user_favorites/${U}`).set(null));
      await assertFails(db.ref('user_favorites').get());
      assert.deepStrictEqual(await peek(`user_favorites/${U}`), { x_pizza: FAV() }, `${who}: the owner's favorites are untouched`);
    }
    ok('another customer / unauthenticated / a REAL seeded dispatcher (with and without a customer claim) / a handheld: read, write and DELETE all denied; nobody reads the root');

    // 4. root / parent overwrites + mixed owned+foreign multi-path updates (Codex r1 #4)
    await seed();
    await assertFails(owner().ref('user_favorites').set({ [U]: { la_musa: FAV() } }));
    await assertFails(owner().ref('/').set({ user_favorites: { [U]: { la_musa: FAV() } } }));
    await assertFails(owner().ref().update({ [`user_favorites/${U}/la_musa`]: FAV(), [`user_favorites/${U2}/la_musa`]: FAV() }));
    await assertFails(owner().ref().update({ [`user_favorites/${U}/la_musa`]: FAV(), [`user_favorites/${U2}/x_pizza`]: null }));
    await assertFails(owner().ref('user_favorites').update({ [`${U}/la_musa`]: FAV(), [U2]: null }));
    assert.deepStrictEqual(await peek('user_favorites'), { [U]: { x_pizza: FAV() }, [U2]: { x_pizza: FAV() } }, 'nothing landed — not even the owned half');
    ok('root / parent overwrites and multi-path updates mixing the owner\'s path with a foreign write or DELETE are refused WHOLE (the owned half never lands)');

    // 5. every tombstone kind + the sweep claim — read AND write
    for (const [why, extra] of [
      ['deleted_uids', async (db) => db.ref(`deleted_uids/${U}`).set(5)],
      ['user_private.deleted_at', async (db) => db.ref(`user_private/${U}`).set({ deleted_at: 5 })],
      ['the sweep claim (deleting_at)', async (db) => db.ref(`user_profiles/${U}/deleting_at`).set(5)],
    ]) {
      await seed(extra);
      await assertFails(owner().ref(`user_favorites/${U}/la_musa`).set(FAV()));
      await assertFails(owner().ref(`user_favorites/${U}`).set({ x_pizza: FAV() }));
      await assertFails(owner().ref(`user_favorites/${U}`).get());
      await assertFails(owner().ref(`user_favorites/${U}/x_pizza`).get());
      assert.ok(true, why);
    }
    ok('the owner\'s still-valid session is denied READ and WRITE under deleted_uids, user_private.deleted_at and the sweep claim');

    // 6. validation + the real-restaurant bound (Codex r1 #2 / #3 / #4)
    await seed();
    for (const [why, rid, val] of [['a malformed rid (upper / space)', 'X Pizza', FAV()], ['a one-char rid', 'a', FAV()],
      ['a regex-valid rid that is NOT a real restaurant', 'ghost_rid', FAV()],
      ['a non-empty value missing createdAt', 'la_musa', { note: 'x' }], ['a string createdAt', 'la_musa', { createdAt: 'now' }],
      ['a future createdAt', 'la_musa', { createdAt: Date.now() + 3600e3 }], ['an extra field', 'la_musa', { createdAt: 1, note: 'x' }]]) {
      await assertFails(owner().ref(`user_favorites/${U}/${rid}`).set(val));
      assert.ok(true, why);
    }
    for (const [why, val] of [['a ghost rid in the replacement', { x_pizza: FAV(), ghost_rid: FAV() }], ['a malformed child', { x_pizza: { note: 'x' } }],
      ['an extra field in a child', { x_pizza: { createdAt: 1, extra: 1 } }], ['a scalar child', { x_pizza: 7 }]]) {
      await assertFails(owner().ref(`user_favorites/${U}`).set(val));
      assert.ok(true, why);
    }
    assert.deepStrictEqual(await peek(`user_favorites/${U}`), { x_pizza: FAV() });
    await assertSucceeds(owner().ref(`user_favorites/${U}/merch_a`).set(FAV()));        // a REAL non-house restaurant is allowed
    await assertSucceeds(owner().ref(`user_favorites/${U}`).set(Object.fromEntries(REAL.map((r) => [r, FAV()]))));
    assert.deepStrictEqual(Object.keys(await peek(`user_favorites/${U}`)).sort(), [...REAL].sort());
    await assertFails(owner().ref(`user_favorites/${U}`).set({ ...Object.fromEntries(REAL.map((r) => [r, FAV()])), ghost_rid: FAV() }));
    ok('validation: malformed / too-short / NON-REAL rids, a non-empty value missing createdAt, a string / future createdAt, an extra field and malformed whole-uid replacements are denied; a real rid is allowed and the node holds at most one entry per real restaurant');
  } finally { await env.cleanup(); }
  console.log(`\nfavorites-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { process.stderr.write(`favorites-rules.emulator: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
