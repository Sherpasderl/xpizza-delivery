/**
 * PLAN-portal-membership r3 §10 — the membership WRITERS and READERS against a REAL RTDB (emulator, Admin SDK).
 * Run: npm run test:membership
 *   1. Null-first on a COLD cache: the writer app has never read brand_members; the cutover backfill (bootstrap_owner into a
 *      truly absent roster) commits, and an owner's grant on an EXISTING roster is never refused as forbidden by a stale null.
 *   2. Real readers after the real writer: getMyRestaurants (exact portal shape), authorizeCatalogEdit (owner caps),
 *      merchantMyLocations (exact H1 array) — the census → backfill → reconcile → compare runbook passes on the prod shape.
 *   3. The platform transfers the brand's ONE owner CONCURRENTLY with an invite acceptance (real transactions) → exactly one
 *      owner; the acceptance either committed first (its grant stands) or found its inviter no longer authorized.
 *   4. Invite: crash after the grant → owner revokes → retry → consumed, NO re-grant.
 *   5. reconcile --apply repairs a malformed member_of ancestor through the REAL SDK (no overlapping paths).
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const R = require('../access/roster');
const I = require('../access/invites');
const A = require('../access/membership-admin-core');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const { getMyRestaurantsCore } = require('../catalog/portal-reads');
const D = require('../merchant/merchant-devices');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const seeder = getDatabase(initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: getDatabase().app.options.databaseURL }, 'membership-seeder'));
const db = getDatabase();   // the app under test: never touched before its first transaction (cold cache)
const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
let tok = 0;
const randomToken = () => `emuTok${String(++tok).padStart(4, '0')}BBBBBBBBBBBBBBBBBBB`;
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

(async () => {
  await seeder.ref().set({
    restaurants: {
      x_pizza: { identity: { name: 'X. Pizza', location_name: 'Centro', prep_default_min: 20 }, owners: { ownerP1: true }, kitchen_staff: { kitchenA1: true } },
      la_musa: { identity: { name: 'La Musa', location_name: 'Musa', prep_default_min: 25 }, owners: { ownerP1: true }, kitchen_staff: { kitchenB1: true } },
    },
    owner_restaurants: { ownerP1: { x_pizza: true, la_musa: true } },
    brands: { x_pizza: legacy('x_pizza'), la_musa: legacy('la_musa') },
    dispatchers: { dispatch01: true },
  });

  // ── 1 + 2. the runbook through the REAL writer on a cold cache, then the REAL readers ──
  const log = []; const run = (op, apply) => A.runMembershipAdmin({ db, op, apply, operator: 'emu', log: (l) => log.push(l), name: 'Marcela Pineda', getUser: async (u) => ({ email: `${u.toLowerCase()}@x.hn`, emailVerified: true }) });
  assert.strictEqual(await run('census'), 0, log.join('\n'));
  assert.strictEqual(await run('backfill', true), 0, `cold-cache backfill: ${log.join('\n')}`);
  assert.ok((await seeder.ref('brand_members/x_pizza/owners/ownerP1').once('value')).exists(), 'the bootstrap committed on the server');
  assert.strictEqual(await run('reconcile'), 0);
  assert.strictEqual(await run('compare'), 0, `compare identical on the prod shape: ${log.join('\n')}`);
  ok('cold cache: census → backfill (bootstrap into an absent roster) → reconcile → compare identical');

  const cold2 = getDatabase(initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: db.app.options.databaseURL }, 'membership-cold2'));
  const g = await R.mutateRoster({ db: cold2 }, 'x_pizza', { kind: 'owner', uid: 'ownerP1' }, { type: 'grant_manager', uid: 'mgrCold01', rids: ['x_pizza'] });
  assert.deepStrictEqual(g, { ok: true, outcome: 'applied' }, 'a stale null never reads as "actor is not an owner"');
  ok('null-first: the owner\'s manager grant on an EXISTING roster from a cold cache commits (never a false forbidden)');

  const req = { method: 'GET', get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer t' : undefined) };
  const dbGet = { ref: (p) => { const r = db.ref(p); return { get: () => r.once('value'), once: (e) => r.once(e) }; } };
  const mine = await getMyRestaurantsCore({ db: dbGet, verifyIdToken: async () => ({ uid: 'ownerP1' }) }, req);
  assert.deepStrictEqual([mine.status, mine.body], [200, { restaurants: [{ rid: 'la_musa', name: 'La Musa' }, { rid: 'x_pizza', name: 'X. Pizza' }] }]);
  const auth = await authorizeCatalogEdit({ db, verifyIdToken: async () => ({ uid: 'ownerP1', email: 'o@x.hn' }) }, req, 'x_pizza');
  assert.deepStrictEqual([auth.ok, auth.role, auth.caps.includes('catalog.fiscal_ack')], [true, 'owner', true]);
  const disp = await authorizeCatalogEdit({ db, verifyIdToken: async () => ({ uid: 'dispatch01' }) }, req, 'x_pizza');
  assert.deepStrictEqual([disp.ok, disp.role, disp.caps], [true, 'dispatcher', ['catalog.edit', 'catalog.publish']]);
  const locs = await D.myLocations({ db, HttpsError }, { uid: 'ownerP1', token: {} }, {});
  assert.deepStrictEqual(locs, [{ rid: 'la_musa', brand_id: 'la_musa', location_name: 'Musa', prep_default_min: 25 }, { rid: 'x_pizza', brand_id: 'x_pizza', location_name: 'Centro', prep_default_min: 20 }]);
  ok('real readers after the real writer: getMyRestaurants / authorizeCatalogEdit / merchantMyLocations');

  // ── 3. the platform transfer racing an invite acceptance (real transactions) ──
  const inv = await I.createInvite({ db, randomToken }, { uid: 'ownerP1', token: {} }, { name: 'Gerente Prueba', brandId: 'x_pizza', rids: ['x_pizza'], email: 'mgrrace01@m.hn' });
  assert.ok(inv.ok, JSON.stringify(inv));
  const [t, acc] = await Promise.all([
    R.mutateRoster({ db: cold2 }, 'x_pizza', { kind: 'cli', operator: 'emu' }, { type: 'transfer_owner', uid: 'ownerNew1', profile: { name: 'Dueña Nueva', email: 'd@x.hn' } }),
    I.acceptInvite({ db }, { uid: 'mgrRace01', token: { email: 'mgrrace01@m.hn', email_verified: true } }, inv.inviteId),
  ]);
  const owners = Object.keys((await seeder.ref('brand_members/x_pizza/owners').once('value')).val() || {});
  assert.deepStrictEqual(owners, ['ownerNew1'], `exactly ONE owner after the transfer (${JSON.stringify([t, acc])})`);
  const granted = (await seeder.ref('brand_members/x_pizza/managers/x_pizza/mgrRace01').once('value')).exists();
  assert.ok((acc.ok && granted) || (!acc.ok && acc.code === 'inviter_not_authorized' && !granted), `consistent: ${JSON.stringify(acc)} granted=${granted}`);
  ok('transfer ∥ invite acceptance → exactly one owner; the acceptance either committed first or found its inviter unauthorized');

  // ── 4. invite crash → revoke → retry (real transactions) ──
  const laOwner = 'ownerP1';   // la_musa's owner since the backfill (untouched by the x_pizza transfer)
  const inv2 = await I.createInvite({ db, randomToken }, { uid: laOwner, token: {} }, { name: 'Gerente Prueba', brandId: 'la_musa', rids: ['la_musa'], email: 'newown001@m.hn' });
  assert.ok(inv2.ok, JSON.stringify(inv2));
  const t0 = Date.now();
  await seeder.ref(`member_invites/${inv2.inviteId}`).update({ state: 'consuming', consuming: { by: 'newOwn001', at: t0 - 60000 } });   // crashed long ago
  await R.mutateRoster({ db }, 'la_musa', { kind: 'owner', uid: laOwner }, { type: 'grant_manager', uid: 'newOwn001', rids: ['la_musa'], inviteId: inv2.inviteId, emailKey: I.emailKey('newown001@m.hn') });   // the grant had committed
  await R.mutateRoster({ db }, 'la_musa', { kind: 'owner', uid: laOwner }, { type: 'revoke_manager', uid: 'newOwn001' });                                            // the owner revokes
  const retry = await I.acceptInvite({ db }, { uid: 'newOwn001', token: { email: 'newown001@m.hn', email_verified: true } }, inv2.inviteId);
  assert.deepStrictEqual(retry, { ok: true, outcome: 'consumed' });
  assert.strictEqual((await seeder.ref('brand_members/la_musa/managers/la_musa/newOwn001').once('value')).exists(), false, '🔴 never re-granted');
  ok('invite crash → owner revokes → retry: consumed, the revoked member is NOT re-granted (real transactions)');

  // ── 5. reconcile repairs a MALFORMED ancestor through the REAL SDK (codex build r1 P2-4): member_of/{uid} is a string while the
  //       roster expects entries under it — one non-overlapping replacement per uid (an ancestor delete + a descendant set in
  //       one update() is rejected by RTDB) ──
  await seeder.ref('member_of/ownerP1').set('malformed');
  log.length = 0;
  assert.strictEqual(await run('reconcile'), 5, 'blocking while malformed');
  assert.strictEqual(await run('reconcile', true), 0, `the real SDK accepts the repair: ${log.join('\n')}`);
  const want = A.expectedIndex((await seeder.ref('brand_members').once('value')).val());
  for (const [p, v] of Object.entries(want)) if (p.startsWith('member_of/ownerP1/')) assert.strictEqual((await seeder.ref(p).once('value')).val(), v, p);
  ok('reconcile --apply repairs a malformed member_of ancestor through the real SDK (non-overlapping replacement)');

  console.log(`membership.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('membership.emulator: FAIL\n', e); process.exit(1); });
