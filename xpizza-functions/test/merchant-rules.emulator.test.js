/**
 * H1a — handheld RTDB rules (PLAN-H1a r2 C-1, C-3, C-7, T7, BC1). Run: npm run test:merchant-rules
 *
 *   KDS exclusion (dark until A1 sets order_surface): a KITCHEN-member status write is refused ONLY when the order's stored
 *   location is order_surface === 'handheld'. Unchanged: kds/absent surfaces, orders with no restaurant_id (legacy), and
 *   dispatcher-only writers. A dual-role (kitchen + dispatcher) identity's stale write still PASSES (the order-level dispatcher
 *   grant cascades) — the evidence for BC1: A1 must refuse the switch while merchant-gate.dualRoleConflicts() is non-empty.
 *   handhelds / order_surface: server-only (read + write). merchant_requests: server-only writes, dispatcher reads.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const KITCHEN = 'u_kitchen000000000000000';
const DUAL = 'u_dual00000000000000000';
const MGR = 'u_mgr000000000000000000';
const DRIVER = 'u_driver0000000000000000';
const DEVICE = 'hh_tb_norte_abc';

const order = (rid, status = 'new') => ({ order_id: 'x', status, payment_method: 'cash', ...(rid ? { restaurant_id: rid } : {}) });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const seed = async () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().set({
      dispatchers: { [DISP]: { name: 'D' }, [DUAL]: { name: 'DK' } },
      kitchen: { [KITCHEN]: { name: 'K' }, [DUAL]: { name: 'DK' } },
      drivers: { [DRIVER]: { name: 'R' } },
      restaurants: {
        tb_norte: { order_surface: 'handheld', managers: { [MGR]: true }, handhelds: { [DEVICE]: { kind: 'handheld', revoked: false } } },
        tb_centro: { order_surface: 'kds' },
      },
      orders: {
        o_norte: order('tb_norte', 'preparing'),     // a handheld accepted it
        o_centro: order('tb_centro'),
        o_plain: order('tb_sur'),                    // no surface node at all
        o_legacy: order(null),                       // legacy: no restaurant_id
      },
      merchant_requests: { tb_norte: { o_norte: { type: 'reject', state: 'open', op_id: 'op1' } } },
    });
  });
  await seed();
  const as = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const disp = as(DISP), kitchen = as(KITCHEN), dual = as(DUAL), mgr = as(MGR), driver = as(DRIVER);
  const device = as(DEVICE, { handheld: true, rid: 'tb_norte' });
  const cust = as('u_cust000000000000000000', { customer: true });
  const anon = env.unauthenticatedContext().database();
  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };

  // ── KDS exclusion (status) ────────────────────────────────────────────────
  await no('STALE KDS write: kitchen → ready on an order a handheld accepted at a handheld location', kitchen.ref('orders/o_norte/status').set('ready'));
  // BC1 evidence: the order-level dispatcher grant CASCADES over the status rule, so no rule clause can stop a dual-role
  // identity's stale write. That is why A1 must refuse order_surface='handheld' while dualRoleConflicts() is non-empty.
  await ok('dual-role (kitchen+dispatcher) stale write at a handheld location PASSES via the dispatcher grant → BC1 switch refusal required', dual.ref('orders/o_norte/status').set('ready'));
  await ok('dispatcher-only status write at a handheld location: unchanged', disp.ref('orders/o_norte/status').set('ready'));
  await ok('kitchen status write at a kds-surface location: unchanged', kitchen.ref('orders/o_centro/status').set('preparing'));
  await ok('kitchen status write at a location with NO surface node: unchanged', kitchen.ref('orders/o_plain/status').set('preparing'));
  await ok('kitchen status write on a legacy order with no restaurant_id: unchanged', kitchen.ref('orders/o_legacy/status').set('preparing'));
  await ok('dual-role status write at a kds-surface location: unchanged', dual.ref('orders/o_centro/status').set('ready'));

  // ── server-only nodes ─────────────────────────────────────────────────────
  for (const [who, db] of [['dispatcher', disp], ['manager', mgr], ['kitchen', kitchen], ['device', device], ['driver', driver], ['customer', cust], ['anon', anon]]) {
    await no(`${who} CANNOT write restaurants/tb_norte/handhelds/x`, db.ref(`restaurants/tb_norte/handhelds/${DEVICE}/revoked`).set(false));
    await no(`${who} CANNOT write restaurants/tb_norte/order_surface`, db.ref('restaurants/tb_norte/order_surface').set('kds'));
    await no(`${who} CANNOT write merchant_requests`, db.ref('merchant_requests/tb_norte/o_norte/state').set('done'));
    await no(`${who} CANNOT write through a ROOT multi-path update`, db.ref().update({ 'restaurants/tb_norte/order_surface': 'kds', 'merchant_requests/tb_norte/o_norte': null }));
  }
  // handhelds + order_surface are SERVER-ONLY for reads too (restaurants-rules.guard allow-list; clients use callables)
  for (const [who, db] of [['dispatcher', disp], ['manager', mgr], ['kitchen', kitchen], ['device', device], ['driver', driver], ['customer', cust], ['anon', anon]]) {
    await no(`${who} CANNOT read the device registry`, db.ref('restaurants/tb_norte/handhelds').get());
    await no(`${who} CANNOT read order_surface`, db.ref('restaurants/tb_norte/order_surface').get());
  }
  await ok('dispatcher reads merchant_requests', disp.ref('merchant_requests/tb_norte').get());
  for (const [who, db] of [['manager', mgr], ['kitchen', kitchen], ['device', device], ['customer', cust], ['anon', anon]]) await no(`${who} CANNOT read merchant_requests`, db.ref('merchant_requests/tb_norte').get());

  await env.cleanup();
  console.log(`\nmerchant-rules: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant-rules FAILED:', e && e.stack || e); process.exit(1); });
