/**
 * PLAN-portal-membership r3 §10 — the membership WRITERS and READERS against a REAL RTDB (emulator, Admin SDK).
 * Run: npm run test:membership
 *   1. Null-first on a COLD cache: the writer app has never read brand_members; the cutover backfill (bootstrap_owner into a
 *      truly absent roster) commits, and an owner's grant on an EXISTING roster is never refused as forbidden by a stale null.
 *   2. Real readers after the real writer: getMyRestaurants (exact portal shape), authorizeCatalogEdit (owner caps),
 *      merchantMyLocations (exact H1 array) — the census → backfill → reconcile → compare runbook passes on the prod shape.
 *   3. Two owners revoke each other CONCURRENTLY (real transactions) → exactly one owner remains.
 *   4. Invite: accept → granted; crash after the grant → owner revokes → retry → consumed, NO re-grant.
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
  const log = []; const run = (op, apply) => A.runMembershipAdmin({ db, op, apply, operator: 'emu', log: (l) => log.push(l) });
  assert.strictEqual(await run('census'), 0, log.join('\n'));
  assert.strictEqual(await run('backfill', true), 0, `cold-cache backfill: ${log.join('\n')}`);
  assert.ok((await seeder.ref('brand_members/x_pizza/owners/ownerP1').once('value')).exists(), 'the bootstrap committed on the server');
  assert.strictEqual(await run('reconcile'), 0);
  assert.strictEqual(await run('compare'), 0, `compare identical on the prod shape: ${log.join('\n')}`);
  ok('cold cache: census → backfill (bootstrap into an absent roster) → reconcile → compare identical');

  const cold2 = getDatabase(initializeApp({ projectId: process.env.GCLOUD_PROJECT, databaseURL: db.app.options.databaseURL }, 'membership-cold2'));
  const g = await R.mutateRoster({ db: cold2 }, 'x_pizza', { kind: 'owner', uid: 'ownerP1' }, { type: 'grant_owner', uid: 'coOwner01' });
  assert.deepStrictEqual(g, { ok: true, outcome: 'applied' }, 'a stale null never reads as "actor is not an owner"');
  ok('null-first: an owner grant on an EXISTING roster from a cold cache commits (never a false forbidden)');

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

  // ── 3. concurrent mutual revokes (real transactions): exactly one owner remains ──
  const [a, b] = await Promise.all([
    R.mutateRoster({ db }, 'x_pizza', { kind: 'owner', uid: 'ownerP1' }, { type: 'revoke_owner', uid: 'coOwner01' }),
    R.mutateRoster({ db: cold2 }, 'x_pizza', { kind: 'owner', uid: 'coOwner01' }, { type: 'revoke_owner', uid: 'ownerP1' }),
  ]);
  const left = Object.keys((await seeder.ref('brand_members/x_pizza/owners').once('value')).val() || {});
  assert.strictEqual(left.length, 1, `exactly one owner remains (${JSON.stringify([a, b, left])})`);
  assert.strictEqual([a, b].filter((r) => r.ok && r.outcome === 'applied').length, 1, 'exactly one revoke applied');
  ok('two owners revoking each other concurrently → exactly one owner remains (the roster transaction serializes)');

  // ── 4. invite crash → revoke → retry (real transactions) ──
  const laOwner = 'ownerP1';   // la_musa's owner since the backfill (untouched by the x_pizza revokes)
  const inv2 = await I.createInvite({ db, randomToken }, { uid: laOwner, token: {} }, { kind: 'owner', brandId: 'la_musa' });
  assert.ok(inv2.ok, JSON.stringify(inv2));
  const t0 = Date.now();
  await seeder.ref(`member_invites/${inv2.inviteId}`).update({ state: 'consuming', consuming: { by: 'newOwn001', at: t0 - 60000 } });   // crashed long ago
  await R.mutateRoster({ db }, 'la_musa', { kind: 'owner', uid: laOwner }, { type: 'grant_owner', uid: 'newOwn001', inviteId: inv2.inviteId });   // the grant had committed
  await R.mutateRoster({ db }, 'la_musa', { kind: 'owner', uid: laOwner }, { type: 'revoke_owner', uid: 'newOwn001' });                         // the owner revokes
  const retry = await I.acceptInvite({ db }, { uid: 'newOwn001', token: {} }, inv2.inviteId);
  assert.deepStrictEqual(retry, { ok: true, outcome: 'consumed' });
  assert.strictEqual((await seeder.ref('brand_members/la_musa/owners/newOwn001').once('value')).exists(), false, '🔴 never re-granted');
  ok('invite crash → owner revokes → retry: consumed, the revoked member is NOT re-granted (real transactions)');

  console.log(`membership.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('membership.emulator: FAIL\n', e); process.exit(1); });
