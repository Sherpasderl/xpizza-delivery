/**
 * PLATFORM F1 (PLAN-F1 r2 §3) — behavioural suite for the multi-location rules, against the RTDB emulator:
 *   B  /brands server-only            P  /public closed except read-only /public/brands
 *   I  identity branch fields + brand_id Admin-only (no client create / change / remove; no delete of a branded identity)
 *   R  order restaurant_id / brand_id immutability — incl. the REAL client batches (driver delivery completion via the imported
 *      builder, the driver pickup + stacked-pickup batch, the dispatch root multi-path order write)
 *   S  the brand store's writes round-trip through real RTDB (empty objects dropped)
 *   npm run test:brands-rules
 */
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const S = require('../brands/brand-store');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'disp-uid'; const KIT = 'kit-uid'; const DRV = 'drv-uid';
const HOURS = { sun: { open: true, start: '12:00', end: '19:45' } };
const IDENT = { name: 'Loc', hub_lat: 15.5, hub_lng: -88.0, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 5, hours: HOURS, active: true, version: 1 };
const BRANDED = { ...IDENT, brand_id: 'tb_brand' };
const order = (id, ids) => ({ order_id: id, status: 'ready', payment_method: 'cash', pickup_task_id: `${id}_pickup`, delivery_task_id: `${id}_delivery`, ...ids });
const BOTH = { restaurant_id: 'tb_centro', brand_id: 'tb_brand' };
const task = (oid, type, status) => ({ order_id: oid, type, status, assigned_driver_id: DRV, linked_task_id: type === 'pickup' ? `${oid}_delivery` : null, created_at: 1 });

(async () => {
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-brands-rules', database: { rules: RULES } });
  const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));
  // withSecurityRulesDisabled resolves to void, so the value is captured, not returned
  const raw = async (p) => { let v; await admin(async (db) => { v = (await db.ref(p).once('value')).val(); }); return v; };
  await admin(async (db) => {
    await db.ref(`dispatchers/${DISP}`).set(true);
    await db.ref(`kitchen/${KIT}`).set(true);
    await db.ref(`drivers/${DRV}`).set({ name: 'Drv', status: 'at_restaurant' });
    await db.ref('brands/tb_brand').set({ name: 'Third', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 1 } });
    await db.ref('public/brands/tb_brand').set({ name: 'Third' });
    await db.ref('public/other').set({ x: 1 });
    await db.ref('restaurants/tb_centro/identity').set(BRANDED);
    await db.ref('restaurants/leg_x/identity').set(IDENT);
    // O1a T6: a LEGACY brand's own (enriched) branch — the one branded identity a client may still edit (version + 1)
    await db.ref('brands/leg_b').set({ name: 'Leg', active: true, locations: { leg_b: 'member' }, activation: { state: 'legacy', since: 1 } });
    await db.ref('restaurants/leg_b/identity').set({ ...IDENT, brand_id: 'leg_b' });
    await db.ref('orders/O1').set(order('O1', BOTH));
    await db.ref('orders/O2').set(order('O2', {}));
    await db.ref('orders/O3').set(order('O3', BOTH));
    await db.ref('orders/O4').set(order('O4', { restaurant_id: 'tb_centro' }));
    for (const o of ['O1', 'O3', 'O4']) {
      await db.ref(`tasks/${o}_pickup`).set(task(o, 'pickup', 'accepted'));
      await db.ref(`tasks/${o}_delivery`).set(task(o, 'delivery', 'accepted'));
    }
  });
  const disp = env.authenticatedContext(DISP).database();
  const kit = env.authenticatedContext(KIT).database();
  const drv = env.authenticatedContext(DRV).database();
  const anon = env.unauthenticatedContext().database();
  const cust = env.authenticatedContext('cust-uid', { customer: true }).database();
  let n = 0;
  const ok = async (l, p) => { await assertSucceeds(p); console.log(`  ✓ ${++n} ${l}`); };
  const no = async (l, p) => { await assertFails(p); console.log(`  ✓ ${++n} ${l}`); };
  const pass = (l) => console.log(`  ✓ ${++n} ${l}`);

  // ── B: /brands is server-only ──
  for (const [who, db] of [['anon', anon], ['customer', cust], ['driver', drv], ['kitchen', kit], ['dispatcher', disp]]) {
    await no(`B: ${who} cannot read /brands/tb_brand`, db.ref('brands/tb_brand').get());
    await no(`B: ${who} cannot write /brands/tb_brand`, db.ref('brands/tb_brand/active').set(false));
  }
  await no('B: dispatcher cannot read the /brands root', disp.ref('brands').get());

  // ── P: /public/brands public read, no client write; the rest of /public closed ──
  await ok('P1: anon reads /public/brands/tb_brand', anon.ref('public/brands/tb_brand').get());
  await ok('P2: anon reads /public/brands', anon.ref('public/brands').get());
  await no('P3: dispatcher cannot write /public/brands/tb_brand', disp.ref('public/brands/tb_brand/name').set('X'));
  await no('P4: anon cannot read /public/other', anon.ref('public/other').get());
  await no('P5: anon cannot read the /public root', anon.ref('public').get());

  // ── I: identity branch fields; brand_id is Admin-only ──
  const idp = (rid) => `restaurants/${rid}/identity`;
  await ok('I1: dispatcher whole-identity write, legacy (no branch fields)', disp.ref(idp('leg_x')).set({ ...IDENT, version: 2 }));
  await ok('I2: branch fields on unbranded leg_x (location_name, zone, prep_default_min) + version + 1', disp.ref(idp('leg_x')).update({ location_name: 'Centro', zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20, version: 3 }));
  // every denial below carries a VALID version + 1 (leg_x is at 3), so the validator under test is what denies it
  const at = (rid, fields, v) => disp.ref(idp(rid)).update({ ...fields, version: v });
  await no('I3: zone polygon', at('leg_x', { zone: { type: 'polygon', radius_km: 5 } }, 4));
  await no('I4: zone radius 0', at('leg_x', { zone: { type: 'circle', radius_km: 0 } }, 4));
  await no('I5: zone radius 51', at('leg_x', { zone: { type: 'circle', radius_km: 51 } }, 4));
  await no('I6: zone extra key', at('leg_x', { zone: { type: 'circle', radius_km: 5, pts: 1 } }, 4));
  await no('I7: prep 4', at('leg_x', { prep_default_min: 4 }, 4));
  await no('I7b: prep 20.5', at('leg_x', { prep_default_min: 20.5 }, 4));
  await no("I8: location_name ''", at('leg_x', { location_name: '' }, 4));
  await no('I9: client CREATES brand_id on unbranded leg_x', at('leg_x', { brand_id: 'tb_brand' }, 4));
  // brand_id immutability on the one branded identity a client may edit (a LEGACY brand's own branch, version 1)
  await no('I10: client CHANGES brand_id (legacy-brand branch)', at('leg_b', { brand_id: 'other_b' }, 2));
  await no('I11: client DELETES brand_id (legacy-brand branch)', at('leg_b', { brand_id: null }, 2));
  await ok('I12: whole-identity replacement, version + 1, SAME brand_id (legacy-brand branch)', disp.ref(idp('leg_b')).set({ ...IDENT, brand_id: 'leg_b', version: 2 }));
  await no('I13: whole-identity replacement WITHOUT brand_id', disp.ref(idp('leg_b')).set({ ...IDENT, version: 3 }));
  await no('I14: whole-identity replacement with a DIFFERENT brand_id', disp.ref(idp('leg_b')).set({ ...IDENT, brand_id: 'other_b', version: 3 }));
  await no('I15: client DELETES the whole branded identity', disp.ref(idp('leg_b')).remove());
  await no('I17: client CREATES a whole identity carrying brand_id', disp.ref(idp('new_rid')).set(BRANDED));
  await ok('I18: unrelated child update (active) + version + 1 on the legacy-brand branch', at('leg_b', { active: false }, 3));
  // O1a T6: a branch of a NON-legacy brand is Sherpa-admin only — even a well-formed, version + 1, same-brand write is refused
  await no('I19: dispatcher whole-identity replacement of a NON-legacy branch (version + 1, same brand_id)', disp.ref(idp('tb_centro')).set({ ...BRANDED, version: 2 }));
  await no('I20: dispatcher child update (active) + version + 1 on a NON-legacy branch', at('tb_centro', { active: false }, 2));
  await no('I21: dispatcher pin move on a NON-legacy branch (Sherpa-admin only)', at('tb_centro', { hub_lat: 15.6 }, 2));
  // O1a T6 (advisor ruling): EVERY non-admin identity write bumps version by EXACTLY 1
  await no('I22: an UNBUMPED dispatcher write is DENIED (leg_x active, version unchanged)', disp.ref(`${idp('leg_x')}/active`).set(false));
  await no('I23: a +2 version jump is DENIED', at('leg_x', { active: false }, 5));
  await ok('I24: the same edit with version + 1 is allowed', at('leg_x', { active: false }, 4));
  assert.strictEqual(await raw(`${idp('tb_centro')}/brand_id`), 'tb_brand'); assert.strictEqual(await raw(`${idp('leg_b')}/brand_id`), 'leg_b');
  pass('I: tb_centro and leg_b keep their brand_id after every denied attempt');
  await ok('I16: client deletes an UNBRANDED identity (today\'s behaviour)', disp.ref(idp('leg_x')).remove());

  // ── R: order location immutability ──
  await no('R1: child write changing restaurant_id', disp.ref('orders/O1/restaurant_id').set('tb_norte'));
  await no('R2: child write changing brand_id', disp.ref('orders/O1/brand_id').set('other_b'));
  await no('R3: child DELETE of restaurant_id', disp.ref('orders/O1/restaurant_id').remove());
  await no('R4: child DELETE of brand_id', disp.ref('orders/O1/brand_id').remove());
  await ok('R5: whole-order overwrite keeping both ids', disp.ref('orders/O1').set({ ...order('O1', BOTH), notes: 'n' }));
  const { restaurant_id: _r, ...noRid } = order('O1', BOTH);
  const { brand_id: _b, ...noBid } = order('O1', BOTH);
  await no('R6: whole-order overwrite dropping restaurant_id', disp.ref('orders/O1').set(noRid));
  await no('R7: whole-order overwrite dropping brand_id', disp.ref('orders/O1').set(noBid));
  // the createOrderWithTasks shape (xpizza-dispatch/xpizza-delivery.js:1134): one ROOT multi-path update, order + both tasks
  const batch = (o, ord) => ({ [`orders/${o}`]: ord, [`tasks/${o}_pickup`]: task(o, 'pickup', 'pending'), [`tasks/${o}_delivery`]: task(o, 'delivery', 'pending') });
  await ok('R8: root multi-path update, ids preserved', disp.ref().update(batch('O1', order('O1', BOTH))));
  await admin((db) => db.ref('tasks/O1_pickup').set(task('O1', 'pickup', 'accepted')));
  await admin((db) => db.ref('tasks/O1_delivery').set(task('O1', 'delivery', 'accepted')));
  const tasksBefore = JSON.stringify([await raw('tasks/O1_pickup'), await raw('tasks/O1_delivery')]);
  await no('R9: root multi-path update dropping restaurant_id', disp.ref().update(batch('O1', noRid)));
  assert.strictEqual(JSON.stringify([await raw('tasks/O1_pickup'), await raw('tasks/O1_delivery')]), tasksBefore); pass('R9: both tasks unchanged (atomic)');
  await no('R9b: root multi-path update dropping brand_id', disp.ref().update(batch('O1', noBid)));
  assert.strictEqual(JSON.stringify([await raw('tasks/O1_pickup'), await raw('tasks/O1_delivery')]), tasksBefore); pass('R9b: both tasks unchanged (atomic)');
  await ok('R10: root multi-path update creating NEW order O9 with ids', disp.ref().update(batch('O9', order('O9', BOTH))));
  // the driver pickup + stacked-pickup batch (literal keys of xpizza-driver/xpizza-delivery.js:969–999), current O1 + stacked O3
  await ok('R13: driver pickup + stacked-pickup batch on O1 + O3 (ids present)', drv.ref().update({
    'tasks/O1_pickup/status': 'completed', 'tasks/O1_pickup/completed_at': 2, 'tasks/O1_delivery/status': 'accepted', 'tasks/O1_delivery/accepted_at': 2,
    [`drivers/${DRV}/current_task_id`]: 'O1_delivery', [`drivers/${DRV}/status`]: 'en_route_delivery',
    'orders/O1/status': 'out_for_delivery', 'orders/O1/picked_up_at': 2,
    'tasks/O3_pickup/status': 'completed', 'tasks/O3_pickup/completed_at': 2, 'tasks/O3_delivery/status': 'accepted',
    'orders/O3/status': 'out_for_delivery', 'orders/O3/picked_up_at': 2,
  }));
  // the REAL delivery-completion batch (status + delivered_at + delivered_by_driver_uid + task + driver keys)
  const complete = async (o) => {
    const allTasks = await raw('tasks');
    return buildCompleteTaskUpdates({ driverId: DRV, taskId: `${o}_delivery`, task: allTasks[`${o}_delivery`], allTasks, now: 3 });
  };
  await ok('R11: real delivery completion on O4 (restaurant_id only)', drv.ref().update(await complete('O4')));
  await ok('R12: real delivery completion on O1 (both ids)', drv.ref().update(await complete('O1')));
  assert.deepStrictEqual([await raw('orders/O1/restaurant_id'), await raw('orders/O1/brand_id'), await raw('orders/O1/delivered_by_driver_uid')], ['tb_centro', 'tb_brand', DRV]);
  pass('R12: ids intact, attribution stamped');
  await ok('R14: kitchen status write on O1', kit.ref('orders/O1/status').set('delivered'));
  await ok('R14b: dispatcher update({status}) on O1', disp.ref('orders/O1').update({ status: 'delivered' }));
  await ok('R15: legacy O2 (no ids) sets restaurant_id once', disp.ref('orders/O2/restaurant_id').set('leg_x'));
  await no('R16: …then changes it', disp.ref('orders/O2/restaurant_id').set('leg_y'));
  await ok('R17: dispatcher whole-order DELETE (O3)', disp.ref('orders/O3').remove());

  // ── S: the store's writes round-trip through REAL RTDB (empty objects dropped) ──
  await admin(async (db) => {
    const br = { ...IDENT, brand_id: 'tb_brand', location_name: 'Centro', zone: { type: 'circle', radius_km: 5 }, prep_default_min: 20 };
    for (const [label, brand, ident] of [
      ['all-retired brand', { name: 'Third', active: true, locations: { tb_centro: 'retired' }, activation: { state: 'on', since: 1 } }, br],
      // same public path as the case above: gaining a member moves projection_gen (the fence: same gen + different members = incomparable)
      ['member with empty hours', { name: 'Third', active: true, locations: { tb_centro: 'member' }, activation: { state: 'on', since: 1 }, projection_gen: 1 }, { ...br, hours: {} }],
    ]) {
      const plan = S.planPublish({ brandId: 'tb_brand', brand, identities: { tb_centro: ident }, current: null });
      assert.strictEqual(plan.ok, true, JSON.stringify(plan.errors));
      assert.deepStrictEqual(await S.applyPublish(db, plan), { ok: true }, label);
      const again = S.planPublish({ brandId: 'tb_brand', brand, identities: { tb_centro: ident }, current: await S.readNode(db, S.publicPath('tb_brand')) });
      assert.strictEqual(again.changed, false, `${label}: re-plan after the round-trip reports unchanged`);
      pass(`S1: ${label} — applyPublish reads back equal; re-plan unchanged`);
    }
    await db.ref('restaurants/seed_a/identity').set({ ...IDENT, name: 'Seed A' });
    const plan = S.planSeedLegacy({ rid: 'seed_a', identity: await S.readNode(db, 'restaurants/seed_a/identity'), existing: await S.readNode(db, 'brands/seed_a'), nowMs: 7 });
    assert.deepStrictEqual(await S.applySeedLegacy(db, plan), { ok: true });
    const re = S.planSeedLegacy({ rid: 'seed_a', identity: await S.readNode(db, 'restaurants/seed_a/identity'), existing: await S.readNode(db, 'brands/seed_a'), nowMs: 8 });
    assert.deepStrictEqual(re, { ok: true, noop: true });
    pass('S2: applySeedLegacy creates via a real transaction and reads back; the re-plan is a no-op');
  });

  await env.cleanup();
  console.log(`brands-rules.emulator: OK (${n} assertions)`);
  process.exit(0);
})().catch((e) => { console.error('brands-rules.emulator: FAIL\n', e); process.exit(1); });
