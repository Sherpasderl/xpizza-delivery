/**
 * H1a gate G-1 — the ACCEPTANCE check A1 runs BEFORE it sets platform_config/handheld_pairing_enabled (PLAN-H1a r2 C-1/C-3).
 * NOT in the npm / gate chain: it is EXPECTED RED until F2(c) has narrowed /orders, /tasks and /order_timelines and added the
 * C-3 clause to the device read grants. Run under the emulator runner:
 *   node tools/emulator-run.js --only database --project demo-xpizza "node test/merchant-isolation.g1.js"
 *
 * A token with the claims merchantPairDevice mints ({handheld:true, rid}) must be DENIED: /orders, /tasks, /order_timelines,
 * another location's loc_orders, and — once revoked — its own location's loc_orders and order_control. It must be ALLOWED its
 * own loc_orders + order_control while registered and unrevoked. (registerDriverPushToken's refusal of the claim is covered
 * by lib/driver-callable-guard.test.js once the S1b-superset exclusion lands.)
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DEVICE = 'hh_tb_norte_g1';

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref().set({
      restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { [DEVICE]: { kind: 'handheld', revoked: false } } }, tb_centro: { order_surface: 'handheld' } },
      orders: { o1: { restaurant_id: 'tb_norte', status: 'new' } },
      tasks: { o1_delivery: { assigned_driver_id: null } },
      order_timelines: { o1: { new_at: 1 } },
      loc_orders: { tb_norte: { o1: { restaurant_id: 'tb_norte', status: 'new' } }, tb_centro: { o9: { restaurant_id: 'tb_centro', status: 'new' } } },
      order_control: { tb_norte: { current: { paused: false } } },
    });
  });
  const device = env.authenticatedContext(DEVICE, { handheld: true, rid: 'tb_norte' }).database();
  const results = [];
  const check = async (label, pr, expect) => {
    try { await (expect === 'deny' ? assertFails(pr) : assertSucceeds(pr)); results.push(['PASS', label]); }
    catch (_) { results.push(['FAIL', label]); }
  };
  await check('device CANNOT read /orders', device.ref('orders').get(), 'deny');
  await check('device CANNOT read /orders/o1', device.ref('orders/o1').get(), 'deny');
  await check('device CANNOT read /tasks', device.ref('tasks').get(), 'deny');
  await check('device CANNOT read /order_timelines', device.ref('order_timelines').get(), 'deny');
  await check('device CANNOT read another location loc_orders/tb_centro', device.ref('loc_orders/tb_centro').get(), 'deny');
  await check('device reads its own loc_orders/tb_norte', device.ref('loc_orders/tb_norte').get(), 'allow');
  await check('device reads its own order_control/tb_norte', device.ref('order_control/tb_norte').get(), 'allow');
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref(`restaurants/tb_norte/handhelds/${DEVICE}/revoked`).set(true); });
  await check('REVOKED device CANNOT read its own loc_orders/tb_norte (existing ID token)', device.ref('loc_orders/tb_norte').get(), 'deny');
  await check('REVOKED device CANNOT read order_control/tb_norte', device.ref('order_control/tb_norte').get(), 'deny');
  await env.cleanup();
  for (const [r, l] of results) console.log(`  ${r} ${l}`);
  const failed = results.filter(([r]) => r === 'FAIL').length;
  console.log(failed ? `\nG-1 isolation: NOT MET (${failed}/${results.length} failing) — pairing must stay OFF` : `\nG-1 isolation: MET (${results.length}/${results.length})`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('G-1 isolation FAILED to run:', e && e.stack || e); process.exit(2); });
