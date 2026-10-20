'use strict';
// TRACKER FIXES T2 — the REAL rules on the emulator: every client identity is DENIED read and write on the three server-only
// tracker nodes (codex build review: unauthenticated, driver, dispatcher, kitchen staff, handheld device, customer, svc-assigner).
// Run: npm run test:tracker-rules
require('./_emulator-required')('database');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-tracker-rules', database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().update({
      'dispatchers/u_disp': { name: 'D' }, 'kitchen/u_kit': true, 'restaurants/tb_centro/kitchen_staff/u_kit': true,
      'drivers/u_drv': { name: 'R', active: true },
      'tracker_seq/o1': 3, 'tracker_claims/u_drv/o1': { seq: 3, gone: false, at: 1 }, 'tracker_claims_owner/o1': { seq: 3, uid: 'u_drv', gone: false, at: 1 },
    });
  });
  const ids = [
    ['unauthenticated', env.unauthenticatedContext()],
    ['driver', env.authenticatedContext('u_drv')],
    ['dispatcher', env.authenticatedContext('u_disp')],
    ['kitchen staff', env.authenticatedContext('u_kit')],
    ['handheld device', env.authenticatedContext('u_hh', { handheld: true, rid: 'tb_centro' })],
    ['customer', env.authenticatedContext('u_cust', { customer: true })],
    ['svc-assigner', env.authenticatedContext('svc-assigner')],
  ];
  let n = 0;
  for (const [label, ctx] of ids) {
    const db = ctx.database();
    for (const p of ['tracker_seq/o1', 'tracker_seq', 'tracker_claims/u_drv/o1', 'tracker_claims/u_drv', 'tracker_claims_owner/o1']) {
      await assertFails(db.ref(p).once('value')); n += 1;
      await assertFails(db.ref(p).set({ seq: 99, gone: false, at: 1 })); n += 1;
    }
    console.log(`  ✓ ${label}: read + write DENIED on all three tracker nodes`);
  }
  await env.cleanup();
  console.log(`tracker-rules.emulator: OK (${n} denials across ${ids.length} identities)`);
  process.exit(0);
})().catch((e) => { console.error('tracker-rules.emulator: FAIL', e); process.exit(1); });
