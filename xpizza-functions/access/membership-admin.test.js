'use strict';
// PLAN-portal-membership r3 §7 / §10 — the one-time cutover, over a PROD-SHAPED fixture (one human owner of two legacy
// single-location brands, zero managers, one kitchen staff each, a dispatcher) and every off-shape the census must refuse.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const C = require('./membership-admin-core');

const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const prod = () => ({
  restaurants: {
    x_pizza: { identity: { name: 'X. Pizza' }, owners: { ownerP1: true }, kitchen_staff: { kitchenA1: true } },
    la_musa: { identity: { name: 'La Musa' }, owners: { ownerP1: true }, kitchen_staff: { kitchenB1: true } },
  },
  owner_restaurants: { ownerP1: { x_pizza: true, la_musa: true } },
  brands: { x_pizza: legacy('x_pizza'), la_musa: legacy('la_musa') },
  dispatchers: { dispatch01: true },
});
const run = async (db, op, apply = false) => { const logs = []; const code = await C.runMembershipAdmin({ db, op, apply, operator: 'op', now: () => 5, log: (l) => logs.push(l) }); return { code, logs }; };

test('census: the prod shape is clean and yields exactly the verified owners', async () => {
  const c = await C.census(createFakeDb(prod()));
  assert.strictEqual(c.ok, true, JSON.stringify(c.findings));
  assert.deepStrictEqual(c.owners, [{ uid: 'ownerP1', rid: 'la_musa' }, { uid: 'ownerP1', rid: 'x_pizza' }]);
  assert.deepStrictEqual(c.dispatchers, ['dispatch01']);
});

test('census REFUSES every off-shape (a reverse-only entry never becomes an owner)', async () => {
  const cases = [
    ['reverse_only_owner', (w) => { w.owner_restaurants.ghost001 = { x_pizza: true }; }],
    ['forward_only_owner', (w) => { w.restaurants.x_pizza.owners.fwdOnly01 = true; }],
    ['not_validated_legacy_singleton', (w) => { w.brands.x_pizza.activation.state = 'on'; }],
    ['not_validated_legacy_singleton', (w) => { delete w.brands.la_musa; }],
    ['not_validated_legacy_singleton', (w) => { w.restaurants.x_pizza.identity.brand_id = 'other_b'; }],
    ['legacy_manager_present', (w) => { w.restaurants.la_musa.managers = { mgr00001: true }; }],
    ['brand_member_manager_present', (w) => { w.brand_members = { x_pizza: { managers: { x_pizza: { mgr00002: { granted_at: 1 } } } } }; }],
    ['unexpected_new_owner', (w) => { w.brand_members = { x_pizza: { owners: { stranger1: { granted_at: 1 } } } }; }],
    ['bad_uid', (w) => { w.restaurants.x_pizza.owners['u_bad'] = true; w.owner_restaurants.u_bad = { x_pizza: true }; }],
  ];
  for (const [code, mut] of cases) {
    const w = prod(); mut(w);
    const c = await C.census(createFakeDb(w));
    assert.strictEqual(c.ok, false, `${code} must refuse`);
    assert.ok(c.findings.some((f) => f.code === code), `${code} reported: ${JSON.stringify(c.findings)}`);
    assert.ok(!c.owners.some((o) => o.uid === 'ghost001'), 'a reverse-only entry is never an owner');
    assert.strictEqual((await run(createFakeDb(w), 'census')).code, 3, 'the CLI exits non-zero');
    assert.strictEqual((await run(createFakeDb(w), 'backfill', true)).code, 3, 'and backfill refuses on an unclean census');
  }
});

test('runbook: compare refuses BEFORE the backfill; backfill (idempotent) → reconcile clean → compare identical', async () => {
  const db = createFakeDb(prod());
  const before = await run(db, 'compare');
  assert.strictEqual(before.code, 6, 'the new readers see nothing yet — a difference, so the cutover cannot proceed');
  assert.strictEqual((await run(db, 'backfill')).code, 0, 'dry run');
  assert.strictEqual(db.get('brand_members'), null, 'a dry run writes nothing');
  assert.strictEqual((await run(db, 'backfill', true)).code, 0);
  assert.deepStrictEqual(Object.keys(db.get('brand_members')).sort(), ['la_musa', 'x_pizza']);
  assert.deepStrictEqual(db.get('member_of/ownerP1'), { brands: { x_pizza: 'owner', la_musa: 'owner' } });
  assert.strictEqual(db.get('restaurants/x_pizza/owners/ownerP1'), true, 'legacy nodes untouched (the rollback source)');
  assert.strictEqual((await run(db, 'backfill', true)).code, 0, 'idempotent re-run');
  assert.strictEqual((await run(db, 'reconcile')).code, 0, 'the index matches the rosters');
  const after = await run(db, 'compare');
  assert.strictEqual(after.code, 0, `compare must be identical: ${after.logs.join('\n')}`);
});

test('compare DETECTS an injected difference (new-source-only, no legacy fallback masks it)', async () => {
  const db = createFakeDb(prod());
  await run(db, 'backfill', true);
  db.put('brand_members/la_musa/owners/ownerP1', null);   // the new grant missing for one brand
  const r = await run(db, 'compare');
  assert.strictEqual(r.code, 6);
  assert.ok(/getMyRestaurants|catalog\.fiscal_ack/.test(r.logs.join('\n')), 'the diff names the operation');
});

test('reconcile: missing / stale / malformed reported; --apply repairs the INDEX only (never a grant)', async () => {
  const db = createFakeDb(prod());
  await run(db, 'backfill', true);
  db.put('member_of/ownerP1/brands/la_musa', null);             // missing
  db.put('member_of/staleUid1', { brands: { x_pizza: 'owner' } });   // stale (no forward grant)
  db.put('member_of/junkUid01', 'nonsense');                    // malformed
  const r = await C.reconcile(db);
  assert.deepStrictEqual([r.ok, r.missing, r.stale, r.malformed], [false, ['member_of/ownerP1/brands/la_musa'], ['member_of/staleUid1/brands/x_pizza'], ['member_of/junkUid01']]);
  assert.strictEqual((await run(db, 'reconcile')).code, 5, 'blocking until clean');
  const rosterBefore = JSON.stringify(db.get('brand_members'));
  assert.strictEqual((await run(db, 'reconcile', true)).code, 0, 'repaired, then re-verified');
  assert.strictEqual(JSON.stringify(db.get('brand_members')), rosterBefore, 'grants untouched');
  assert.strictEqual(db.get('member_of/staleUid1/brands/x_pizza'), null, 'the stale entry is removed (RTDB prunes the empty parent)');
});
