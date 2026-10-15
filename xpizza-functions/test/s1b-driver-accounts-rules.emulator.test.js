/**
 * S1b — /driver_accounts RTDB rules (PLAN-S1b-BUILD §3 + the finding-1 "pending cannot work" proof against the
 * REAL S1a eligibility rules). Run via the emulator (see package.json test:s1b-rules).
 *
 * Covers:
 *   • Collection read (finding 9): a dispatcher reads the /driver_accounts COLLECTION; a driver is denied the
 *     collection but reads its OWN node; a driver is denied another's node; a customer is denied.
 *   • Server-only: every client write to /driver_accounts is denied (Admin-SDK only) — dispatcher and driver alike.
 *   • Pending-cannot-work (finding 1) in CLOSED mode, driven by the svc-assigner identity (the real writer): a
 *     pending (enabled:false) account is rejected at a new-shift transition AND at a task ownership claim on BOTH
 *     legs; once approved (enabled:true) the same transitions succeed; a suspended (enabled:false) account is
 *     likewise blocked; and in tolerant mode a MISSING account is still allowed (legacy).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const DRIVER = 'u_driver0000000000000000';
const DRIVER2 = 'u_driver2000000000000000';
const SVC = 'svc-assigner';

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-s1b', database: { rules: RULES } });
  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };

  const disp = env.authenticatedContext(DISP).database();
  const driver = env.authenticatedContext(DRIVER).database();
  const customer = env.authenticatedContext('u_cust000000000000000000', { customer: true }).database();
  const svc = env.authenticatedContext(SVC, { svc_assigner: true }).database();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`driver_accounts/${DRIVER}`).set({ enabled: false, onboarding_state: 'pending', email: 'p@c.hn', version: 0 });
    await db.ref(`driver_accounts/${DRIVER2}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
  });

  // ============ COLLECTION READ (finding 9) ============
  await ok('dispatcher reads the /driver_accounts COLLECTION', disp.ref('driver_accounts').get());
  await ok('dispatcher reads any driver node', disp.ref(`driver_accounts/${DRIVER}`).get());
  await ok('a driver reads its OWN node', driver.ref(`driver_accounts/${DRIVER}`).get());
  await no('a driver CANNOT read the /driver_accounts COLLECTION', driver.ref('driver_accounts').get());
  await no('a driver CANNOT read ANOTHER driver\'s node', driver.ref(`driver_accounts/${DRIVER2}`).get());
  await no('a customer CANNOT read the collection', customer.ref('driver_accounts').get());
  await no('a customer CANNOT read a node', customer.ref(`driver_accounts/${DRIVER}`).get());

  // ============ SERVER-ONLY WRITES (.write:false — Admin only) ============
  await no('a dispatcher CANNOT write /driver_accounts (server-only)', disp.ref(`driver_accounts/${DRIVER}/enabled`).set(true));
  await no('a dispatcher CANNOT create a /driver_accounts node', disp.ref('driver_accounts/u_new').set({ enabled: true }));
  await no('a driver CANNOT write its own /driver_accounts node', driver.ref(`driver_accounts/${DRIVER}/onboarding_state`).set('active'));

  // ============ PENDING-CANNOT-WORK (finding 1) vs the REAL S1a eligibility rules ============
  // Set CLOSED enforcement, then drive the svc-assigner writer (the real ownership/shift writer identity).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('platform_config/driver_enforcement_mode').set('closed');
    await db.ref(`drivers/${DRIVER}`).set({ name: 'R1', active: false });
    await db.ref('tasks/o1_delivery').set({ order_id: 'o1', type: 'delivery', status: 'pending' });
    await db.ref('tasks/o1_pickup').set({ order_id: 'o1', type: 'pickup', status: 'pending' });
  });

  // new-shift transition (active:false→true + a shift id) — svc-assigner leaf writes under the $driver_id .validate E(uid)
  const openShift = () => svc.ref().update({ [`drivers/${DRIVER}/active`]: true, [`drivers/${DRIVER}/current_shift_id`]: 's1' });
  const claim = (leg) => svc.ref().update({ [`tasks/o1_${leg}/assigned_driver_id`]: DRIVER, [`tasks/o1_${leg}/status`]: 'assigned' });

  await no('closed mode: a PENDING (enabled:false) driver is rejected at a new-shift transition', openShift());
  await no('closed mode: a PENDING driver is rejected at a DELIVERY-leg ownership claim', claim('delivery'));
  await no('closed mode: a PENDING driver is rejected at a PICKUP-leg ownership claim', claim('pickup'));

  // approve → enabled:true, then the SAME writes succeed
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref(`driver_accounts/${DRIVER}`).update({ enabled: true, onboarding_state: 'active', approved_at: 1 }));
  await ok('closed mode: once APPROVED (enabled:true) the new-shift transition succeeds', openShift());
  await ok('closed mode: once APPROVED the delivery-leg claim succeeds', claim('delivery'));
  await ok('closed mode: once APPROVED the pickup-leg claim succeeds', claim('pickup'));

  // suspended (enabled:false again) is blocked like pending
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref(`driver_accounts/${DRIVER}`).update({ enabled: false, suspended_at: 2 });
    await db.ref(`drivers/${DRIVER}`).update({ active: false, current_shift_id: null });
    await db.ref('tasks/o2_delivery').set({ order_id: 'o2', type: 'delivery', status: 'pending' });
  });
  await no('closed mode: a SUSPENDED (enabled:false) driver is rejected at a new-shift transition', openShift());
  await no('closed mode: a SUSPENDED driver is rejected at an ownership claim',
    svc.ref().update({ 'tasks/o2_delivery/assigned_driver_id': DRIVER, 'tasks/o2_delivery/status': 'assigned' }));

  // tolerant mode: a MISSING account is still legacy-allowed (no account for DRIVER_LEGACY)
  const LEGACY = 'u_legacy0000000000000000';
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('platform_config/driver_enforcement_mode').set(null); // tolerant
    await db.ref(`drivers/${LEGACY}`).set({ name: 'Legacy', active: false });
  });
  const svcLegacy = svc; // same svc identity
  await ok('tolerant mode: a MISSING account (legacy) is still allowed to open a shift',
    svcLegacy.ref().update({ [`drivers/${LEGACY}/active`]: true, [`drivers/${LEGACY}/current_shift_id`]: 'sL' }));

  await env.cleanup();
  console.log(`\ns1b-driver-accounts-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('s1b-driver-accounts-rules(emulator) FAILED:', e && e.stack || e); process.exit(1); });
