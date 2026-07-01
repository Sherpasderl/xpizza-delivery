/**
 * Behavioral suite for the /restaurants RTDB rules (Phase 0, Steps 1 + 2).
 *
 * Run against the Firebase RTDB emulator:
 *   npm run test:rules
 *     = firebase emulators:exec --only database "node test/restaurants-rules.emulator.test.js"
 *
 * Section A (Step 1): access control — identity authed-read + dispatcher-write; factura_config and
 *   all ancestor/sibling/root paths locked; identity wrapper auto-covers new fields.
 * Section B (Step 2): .validate — completeness (hasChildren) + per-field types + monotonic version;
 *   distinguishes whole-node replacement vs child update; pins the parent-.validate recheck on a
 *   child write to an incomplete node.
 *
 * Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'),
  'utf8'
);

const DISP = 'disp-uid'; // a dispatcher
const DRV = 'drv-uid'; // authenticated, NOT a dispatcher

// A complete, valid identity payload (matches the .validate contract).
const VALID_HOURS = {
  sun: { open: true, start: '12:00', end: '19:45' }, mon: { open: true, start: '12:00', end: '19:45' },
  tue: { open: true, start: '12:00', end: '19:45' }, wed: { open: true, start: '12:00', end: '19:45' },
  thu: { open: true, start: '12:00', end: '20:45' }, fri: { open: true, start: '12:00', end: '20:45' },
  sat: { open: true, start: '12:00', end: '20:45' },
};
const VALID = {
  name: 'X Pizza', hub_lat: 15.5, hub_lng: -88.0, phone: '+50400000000',
  whatsapp_instance: 'i1', whatsapp_enabled: true, delivery_radius_km: 7,
  hours: VALID_HOURS, active: true, version: 1,
};
const without = (k) => { const c = { ...VALID }; delete c[k]; return c; };
const withField = (k, v) => ({ ...VALID, [k]: v });

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza-rules',
    database: { rules: RULES }, // emulator host/port auto-detected from emulators:exec env
  });

  // Seed /dispatchers/{DISP} (rules disabled) so the dispatcher-write rule can pass.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('dispatchers/' + DISP).set(true);
  });
  // Seed complete / incomplete identity nodes (rules disabled) for the child-write cases.
  const seedRaw = (rid, val) =>
    env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`restaurants/${rid}/identity`).set(val));
  await seedRaw('cnode', VALID); // complete node, for child-update tests
  await seedRaw('inode', { name: 'X' }); // INCOMPLETE node, for the parent-recheck test

  const dispDb = env.authenticatedContext(DISP).database();
  const drvDb = env.authenticatedContext(DRV).database();
  const anonDb = env.unauthenticatedContext().database();

  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);
  const upd = (db, p, v) => db.ref(p).update(v);

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

  // ── Section A — access control (Step 1) ───────────────────────────────────
  await ok('A: driver reads identity/name', get(drvDb, 'restaurants/x_pizza/identity/name'));
  await no('A: authed reads factura_config', get(drvDb, 'restaurants/x_pizza/factura_config'));
  await no('A: driver writes identity (auth)', set(drvDb, 'restaurants/awrite/identity', VALID));
  await ok('A: dispatcher writes complete identity', set(dispDb, 'restaurants/awrite/identity', VALID));
  await no('A: dispatcher writes factura_config', set(dispDb, 'restaurants/awrite/factura_config', { cai: 'X' }));
  await no('A: unauth reads identity/name', get(anonDb, 'restaurants/x_pizza/identity/name'));
  await no('A: authed reads $rid parent', get(drvDb, 'restaurants/x_pizza'));
  await no('A: authed reads arbitrary sibling', get(drvDb, 'restaurants/x_pizza/anything_else'));
  await ok('A: driver reads new identity field (wrapper auto-covers)', get(drvDb, 'restaurants/cnode/identity/brand_new'));
  await no('A: dispatcher update touches factura_config', upd(dispDb, 'restaurants/awrite', { 'factura_config/cai': 'X' }));
  await no('A: dispatcher parent write (denied structurally)', set(dispDb, 'restaurants/awrite', { identity: VALID }));
  await no('A: authed reads /restaurants root', get(drvDb, 'restaurants'));
  await no('A: unauth reads /restaurants root', get(anonDb, 'restaurants'));

  // ── Section B — .validate (Step 2) ─────────────────────────────────────────
  // Whole-node replacement: completeness (hasChildren) + per-field types.
  await ok('B: whole-node set complete identity', set(dispDb, 'restaurants/wok/identity', VALID));
  await no('B: whole-node missing version', set(dispDb, 'restaurants/wbad/identity', without('version')));
  await no('B: whole-node missing delivery_radius_km', set(dispDb, 'restaurants/wbad/identity', without('delivery_radius_km')));
  await no('B: whole-node hub_lat string', set(dispDb, 'restaurants/wbad/identity', withField('hub_lat', 'x')));
  await no('B: whole-node active string', set(dispDb, 'restaurants/wbad/identity', withField('active', 'yes')));
  await no('B: whole-node version string', set(dispDb, 'restaurants/wbad/identity', withField('version', '1')));
  await no('B: whole-node whatsapp_enabled string', set(dispDb, 'restaurants/wbad/identity', withField('whatsapp_enabled', 'true')));
  await no('B: whole-node delivery_radius_km string', set(dispDb, 'restaurants/wbad/identity', withField('delivery_radius_km', '7')));

  // Child update on a COMPLETE node (cnode seeded with VALID, version 1).
  await ok('B: child update active=false (complete node)', set(dispDb, 'restaurants/cnode/identity/active', false));
  await ok('B: child update hub_lat=number (complete node)', set(dispDb, 'restaurants/cnode/identity/hub_lat', 99));
  await ok('B: child update version 1->2 (increasing)', set(dispDb, 'restaurants/cnode/identity/version', 2));
  await no('B: child update version 2->1 (decreasing)', set(dispDb, 'restaurants/cnode/identity/version', 1));
  // phone has no type validator this step — number write is permitted (documents the rule surface).
  await ok('B: child update phone=number (no validator)', set(dispDb, 'restaurants/cnode/identity/phone', 123));

  // Parent-recheck: a single child write onto an INCOMPLETE node. If the parent .validate
  // re-evaluates the merged node (Firebase docs say it does), hasChildren fails -> deny.
  await no('B: child write on incomplete node (parent recheck -> deny)', set(dispDb, 'restaurants/inode/identity/active', true));

  // ── D: driver-write regression (#6) — the new current_hub_task_id .validate (S1) is dispatcher-only.
  //    Confirm it does NOT break the driver client's own per-field writes (GPS/status), that a driver
  //    CANNOT write current_hub_task_id (the client only READS it — server/dispatcher owns it), and that
  //    the intended dispatcher writer is allowed. Node seeded with 'name' (the parent .validate). ──
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`drivers/${DRV}`).set({ name: 'Hermez' }));
  await ok('D: driver writes own lat/lng (GPS) — unaffected by the new .validate', upd(drvDb, `drivers/${DRV}`, { lat: 15.5, lng: -88.0 }));
  await ok('D: driver writes own status', set(drvDb, `drivers/${DRV}/status`, 'available'));
  await no('D: driver writes current_hub_task_id (dispatcher-only -> deny)', set(drvDb, `drivers/${DRV}/current_hub_task_id`, `${DRV}_pickup`));
  await ok('D: dispatcher writes current_hub_task_id (intended writer)', set(dispDb, `drivers/${DRV}/current_hub_task_id`, `${DRV}_pickup`));

  await env.cleanup();
  console.log(`restaurants-rules.emulator: OK (${n} assertions)`);
})().catch((e) => {
  console.error('restaurants-rules.emulator: FAIL\n', e);
  process.exit(1);
});
