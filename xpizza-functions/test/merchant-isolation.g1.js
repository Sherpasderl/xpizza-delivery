/**
 * H1a gate G-1 — the ACCEPTANCE check A1 runs BEFORE it sets platform_config/handheld_pairing_enabled (PLAN-H1a r2 C-1/C-3).
 * NOT in the npm / gate chain: it is EXPECTED RED until F2(c) has narrowed /orders, /tasks and /order_timelines and added the
 * C-3 clause to the device read grants. Run under the emulator runner:
 *   node tools/emulator-run.js --only database --project demo-xpizza "node test/merchant-isolation.g1.js"
 *
 * Amendment A-2 (advisor 2026-10-17): the feed is a QUERY on /orders (loc_orders shelved). A token with the claims
 * merchantPairDevice mints ({handheld:true, rid}) must be ALLOWED only its own-rid query
 * orders.orderByChild('restaurant_id').equalTo(rid) (+ its order_control) while registered and unrevoked, and DENIED: /orders
 * unqueried, /orders/{oid} directly, another rid's query, a query on another child, /tasks, /order_timelines, and — once
 * revoked — its own-rid query and order_control. A-2 C1/C2: it also proves the device clause itself (kind ≠ handheld, an
 * unregistered uid, a claim-rid mismatch, wrong orderBy → denied) and downloads-5f's Q0 (the device token is denied every
 * broad read found on main: /orders, /tasks, /order_timelines, /drivers, /dispatchers, /kitchen, /config,
 * restaurants/$rid/identity). Q0 is a HARD prerequisite: pairing stays OFF until every line here passes. (registerDriverPushToken's refusal of the claim is covered
 * by lib/driver-callable-guard.test.js once the S1b-superset exclusion lands.)
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DEVICE = 'hh_tb_norte_g1';
const NOTHH = 'hh_tb_norte_human';   // a registry row whose kind is NOT 'handheld'
const MISMATCH = 'hh_tb_norte_mm';    // registered under tb_norte, but its token claims rid tb_centro

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref().set({
      restaurants: { tb_norte: { order_surface: 'handheld', identity: { location_name: 'Norte' }, handhelds: { [DEVICE]: { kind: 'handheld', revoked: false }, [NOTHH]: { kind: 'human', revoked: false }, [MISMATCH]: { kind: 'handheld', revoked: false } } }, tb_centro: { order_surface: 'handheld' } },
      drivers: { d1: { status: 'available' } }, dispatchers: { disp1: true }, kitchen: { k1: true }, config: { auto_assign_enabled: true },
      orders: { o1: { restaurant_id: 'tb_norte', status: 'new' }, o9: { restaurant_id: 'tb_centro', status: 'new' } },
      tasks: { o1_delivery: { assigned_driver_id: null } },
      order_timelines: { o1: { new_at: 1 } },
      order_control: { tb_norte: { current: { paused: false } } },
    });
  });
  const device = env.authenticatedContext(DEVICE, { handheld: true, rid: 'tb_norte' }).database();
  const results = [];
  const check = async (label, pr, expect) => {
    try { await (expect === 'deny' ? assertFails(pr) : assertSucceeds(pr)); results.push(['PASS', label]); }
    catch (_) { results.push(['FAIL', label]); }
  };
  const own = () => device.ref('orders').orderByChild('restaurant_id').equalTo('tb_norte').get();
  await check('device CANNOT read /orders unqueried', device.ref('orders').get(), 'deny');
  await check('device CANNOT read /orders/o1', device.ref('orders/o1').get(), 'deny');
  await check('device CANNOT read /tasks', device.ref('tasks').get(), 'deny');
  await check('device CANNOT read /order_timelines', device.ref('order_timelines').get(), 'deny');
  await check('device CANNOT query another location (equalTo tb_centro)', device.ref('orders').orderByChild('restaurant_id').equalTo('tb_centro').get(), 'deny');
  await check('device CANNOT query /orders by another child (status)', device.ref('orders').orderByChild('status').equalTo('new').get(), 'deny');
  await check('device runs its OWN-rid query orders by restaurant_id == tb_norte', own(), 'allow');
  await check('device CANNOT query /orders orderByKey', device.ref('orders').orderByKey().get(), 'deny');
  // A-2 C2 — the device clause itself
  const q = (db) => db.ref('orders').orderByChild('restaurant_id').equalTo('tb_norte').get();
  await check('kind ≠ handheld (registry row kind "human") CANNOT run the query', q(env.authenticatedContext(NOTHH, { handheld: true, rid: 'tb_norte' }).database()), 'deny');
  await check('UNREGISTERED uid with handheld claims CANNOT run the query', q(env.authenticatedContext('hh_ghost', { handheld: true, rid: 'tb_norte' }).database()), 'deny');
  await check('claim-rid MISMATCH (token rid tb_centro, registered tb_norte) CANNOT query tb_norte', q(env.authenticatedContext(MISMATCH, { handheld: true, rid: 'tb_centro' }).database()), 'deny');
  // A-2 C1 — Q0: every broad read found on main is denied to a device token
  for (const p of ['drivers', 'dispatchers', 'kitchen', 'config', 'restaurants/tb_norte/identity']) await check(`device CANNOT read /${p} (Q0)`, device.ref(p).get(), 'deny');
  await check('device reads its own order_control/tb_norte', device.ref('order_control/tb_norte').get(), 'allow');
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref(`restaurants/tb_norte/handhelds/${DEVICE}/revoked`).set(true); });
  await check('REVOKED device CANNOT run its own-rid query (existing ID token)', own(), 'deny');
  await check('REVOKED device CANNOT read order_control/tb_norte', device.ref('order_control/tb_norte').get(), 'deny');
  await env.cleanup();
  for (const [r, l] of results) console.log(`  ${r} ${l}`);
  const failed = results.filter(([r]) => r === 'FAIL').length;
  console.log(failed ? `\nG-1 isolation: NOT MET (${failed}/${results.length} failing) — pairing must stay OFF` : `\nG-1 isolation: MET (${results.length}/${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('G-1 isolation FAILED to run:', e && e.stack || e); process.exit(2); });
