/**
 * ORCHESTRATION O1a T6 (PLAN-multi-location-orchestration r3.1 §2, §4; advisor ruling "every identity write bumps version") —
 * behavioural suite against the RTDB emulator:
 *   N  server-only: brand_ops, branch_op_ids, rid_reservations, brand_branch_names, route_pins, restaurants/{rid}/draft —
 *      no client role (dispatcher, kitchen, driver, handheld, customer, anon) reads or writes any of them
 *   H  identity hours (same-day, 7 named days, {open[,start,end]}), address, active_changed_at validators — every cell carries a
 *      valid version + 1, so the validator under test is what decides
 *   W  the branch-store WRITERS round-trip through REAL RTDB transactions (Admin SDK, incl. its cached-null first pass): draft →
 *      materialize → staged; activateBrand; the fenced projection publish; a version-only resync bump
 *   npm run test:branches-rules
 */
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const S = require('../branches/branch-store');
const B = require('../brands/brand-store');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'disp-uid'; const KIT = 'kit-uid'; const DRV = 'drv-uid';
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const IDENT = { name: 'Loc', hub_lat: 15.5, hub_lng: -88.0, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 5, hours: H7, active: true, version: 1 };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const NOW = 1_800_000_000_000;

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-branches-rules', database: { rules: RULES } });
  const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));
  const raw = async (p) => { let v; await admin(async (db) => { v = (await db.ref(p).once('value')).val(); }); return v; };
  await admin(async (db) => {
    await db.ref(`dispatchers/${DISP}`).set(true);
    await db.ref(`kitchen/${KIT}`).set(true);
    await db.ref(`drivers/${DRV}`).set({ name: 'Drv', status: 'available' });
    await db.ref('restaurants/leg_x/identity').set(IDENT);
    await db.ref('restaurants/tb_c/draft').set({ brand_id: 'tb_brand', location_name: 'C', phone: '+50499990000', hours: H7, prep_default_min: 20, op_id: 'o' });
    // brand_ops/tb_n: a brand the W section never uses (a probe value there would be a malformed lock → that brand fails closed)
    for (const k of ['brand_ops/tb_n', 'branch_op_ids/tb_brand/o', 'rid_reservations/tb_c', 'brand_branch_names/tb_brand/c', 'route_pins/k1']) await db.ref(k).set({ x: 1 });
  });
  const roles = [
    ['dispatcher', env.authenticatedContext(DISP).database()], ['kitchen', env.authenticatedContext(KIT).database()],
    ['driver', env.authenticatedContext(DRV).database()], ['handheld', env.authenticatedContext('hh', { handheld: true, rid: 'tb_c' }).database()],
    ['customer', env.authenticatedContext('cu', { customer: true }).database()], ['anon', env.unauthenticatedContext().database()],
  ];
  const disp = roles[0][1];
  let n = 0;
  const ok = async (l, p) => { await assertSucceeds(p); console.log(`  ✓ ${++n} ${l}`); };
  const no = async (l, p) => { await assertFails(p); console.log(`  ✓ ${++n} ${l}`); };
  const pass = (l) => console.log(`  ✓ ${++n} ${l}`);

  // ── N: server-only nodes ──
  const NODES = ['brand_ops/tb_n', 'branch_op_ids/tb_brand/o', 'rid_reservations/tb_c', 'brand_branch_names/tb_brand/c', 'route_pins/k1', 'restaurants/tb_c/draft'];
  for (const [who, db] of roles) {
    for (const p of NODES) {
      await no(`N: ${who} cannot read ${p}`, db.ref(p).get());
      await no(`N: ${who} cannot write ${p}`, db.ref(p).set({ y: 2 }));
    }
    await no(`N: ${who} cannot delete a draft`, db.ref('restaurants/tb_c/draft').remove());
  }
  for (const p of NODES) assert.ok(await raw(p), `${p} intact`);
  pass('N: every server-only node is intact after the whole matrix');

  // ── H: identity validators (each with a valid version + 1; leg_x starts at 1) ──
  let v = 1;
  const at = (fields) => disp.ref('restaurants/leg_x/identity').update({ ...fields, version: v + 1 });
  const yes = async (l, fields) => { await ok(l, at(fields)); v += 1; };
  await yes('H1: a full 7-day same-day schedule', { hours: H7 });
  await no('H2: an unknown day key', at({ hours: { ...H7, xyz: DAY } }));
  await no('H3: a closed day carrying times', at({ hours: { ...H7, mon: { open: false, start: '10:00', end: '11:00' } } }));
  await no('H4: an open day without times', at({ hours: { ...H7, tue: { open: true } } }));
  await no('H5: start == end', at({ hours: { ...H7, tue: { open: true, start: '11:00', end: '11:00' } } }));
  await no('H6: overnight (end before start)', at({ hours: { ...H7, tue: { open: true, start: '22:00', end: '02:00' } } }));
  await no("H7: '24:00' is not a time", at({ hours: { ...H7, tue: { open: true, start: '11:00', end: '24:00' } } }));
  await no('H8: an extra key on a day', at({ hours: { ...H7, tue: { ...DAY, note: 'x' } } }));
  await no('H9: open not boolean', at({ hours: { ...H7, tue: { open: 'yes', start: '11:00', end: '22:00' } } }));
  await yes('H10: address_line + address_reference', { address_line: 'Blvd 1', address_reference: 'frente al parque' });
  await no("H11: address_line ''", at({ address_line: '' }));
  await no('H12: address_line 121 chars', at({ address_line: 'a'.repeat(121) }));
  await no('H13: address_reference 121 chars', at({ address_reference: 'a'.repeat(121) }));
  await yes('H14: active_changed_at number', { active_changed_at: NOW });
  await no('H15: active_changed_at string', at({ active_changed_at: 'now' }));
  await no('H16: hub_lat 91', at({ hub_lat: 91 }));
  await no('H17: hub_lng -181', at({ hub_lng: -181 }));
  await no('H18: a write WITHOUT the version bump', disp.ref('restaurants/leg_x/identity/address_line').set('Otra'));
  assert.strictEqual(await raw('restaurants/leg_x/identity/version'), v); pass(`H: leg_x at version ${v} — exactly one bump per allowed write, none for a denied one`);

  // ── W: the writers over REAL RTDB transactions (Admin) ──
  let out;
  await admin(async (db) => {
    await db.ref('brands/tb_brand').set({ name: 'Third', active: true, locations: { tb_norte: 'member' }, activation: { state: 'off', since: 1 } });
    await db.ref('restaurants/tb_norte/identity').set({ ...IDENT, brand_id: 'tb_brand', location_name: 'Norte', zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20, active: false, active_changed_at: 1, version: 3 });
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const input = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20 };
    out = { draft: await S.createDraft(db, { input, opId: 'w1', callerUid: 'own', now: NOW }) };
    out.again = await S.createDraft(db, { input, opId: 'w1', callerUid: 'own', now: NOW + 1 });
    out.mat = await S.materializeBranch(db, { rid: 'tb_brand_centro', location: { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' }, now: NOW, callId: 'c1' });
    out.not = await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_brand_centro'], now: NOW, readers: { teamCount: async () => 1 } });
    await db.ref('restaurants/tb_brand_centro/handhelds/h1').set({ revoked: false, last_seen: 5 });
    await db.ref('menus/tb_brand').set({ v: 1 });
    out.act = await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_brand_centro'], now: NOW, readers: { teamCount: async () => 1 } });
    out.pub = await B.publishBrandProjection(db, 'tb_brand', { now: NOW });
    out.bump = await S.bumpIdentityVersion(db, { rid: 'tb_norte', expectedVersion: 3 });
    out.pub2 = await B.publishBrandProjection(db, 'tb_brand', { now: NOW });
  });
  assert.deepStrictEqual([out.draft, out.again], [{ ok: true, rid: 'tb_brand_centro' }, { ok: true, rid: 'tb_brand_centro' }]);
  assert.deepStrictEqual(out.mat, { ok: true, rid: 'tb_brand_centro', state: 'staged' });
  assert.deepStrictEqual(out.not, { ok: false, error: 'not_ready', unmet: { tb_brand_centro: ['no_handheld_online', 'menu_not_published'] } });
  assert.deepStrictEqual(out.act, { ok: true, opened: ['tb_brand_centro'] });
  assert.deepStrictEqual(await raw('brands/tb_brand/activation/state'), 'on');
  assert.deepStrictEqual(await raw('brands/tb_brand/locations'), { tb_norte: 'member', tb_brand_centro: 'member' });
  assert.deepStrictEqual([await raw('restaurants/tb_brand_centro/identity/active'), await raw('restaurants/tb_brand_centro/identity/version')], [true, 2]);
  assert.strictEqual(await raw('restaurants/tb_brand_centro/draft'), null);
  assert.deepStrictEqual(out.pub.source, { gen: 2, versions: { tb_brand_centro: 2, tb_norte: 3 } });
  assert.deepStrictEqual([out.bump, out.pub2.source], [{ ok: true, version: 4 }, { gen: 2, versions: { tb_brand_centro: 2, tb_norte: 4 } }]);
  pass('W: createDraft (idempotent) → materialize → staged; activateBrand readiness then off→on + staged→member + identity active (version +1); fenced publish at gen 2; version-only resync republishes — all over REAL RTDB transactions');

  await env.cleanup();
  console.log(`\nbranches-rules: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('branches-rules FAILED:', e); process.exit(1); });
