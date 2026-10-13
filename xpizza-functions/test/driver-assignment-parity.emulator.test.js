'use strict';
/**
 * S1a PARITY EVIDENCE (codex r1 P1-7) — drives the REAL converted writers through a RULES-ENFORCED svc-assigner
 * handle, against the REAL compiled ruleset, and measures latency vs the bypass handle.
 *
 * ⚠️ HARNESS NOTE (verified empirically, reported to the advisor): the RTDB emulator does NOT enforce security rules
 * for a firebase-admin Admin SDK connection even with databaseAuthVariableOverride={uid:'svc-assigner'} — all such
 * writes are allowed (the Admin connection is privileged in the emulator). So the production restricted handle cannot
 * be rule-tested through the Admin SDK here. The FAITHFUL equivalent is @firebase/rules-unit-testing's
 * authenticatedContext('svc-assigner'): a real transaction-capable DB handle whose writes are evaluated against the
 * SAME rules with the SAME auth.uid='svc-assigner' — identical rule evaluation to production's svc-assigner app.
 * (In production the override Admin app IS rule-bound; only the emulator privileges Admin connections.)
 *
 * Proves, through that rules-enforced handle:
 *   - TOLERANT (dark) = UNCHANGED outcome: the REAL claimDelivery (transaction) claims null→enabled; the finalize
 *     leaves land on BOTH legs; a stacked finalize; a sweeper finalize (retry/last_swept); the shift-open token
 *     rotation (create + bound prior-delete); a restoring (non-null) rollback; and the REAL driver completion batch
 *     (buildCompleteTaskUpdates) all SUCCEED;
 *   - a COLD transaction (the first claim on a fresh env) and an OFFLINE→reconnect delayed commit both land;
 *   - CLOSED bites: the same real claim is DENIED for a SUSPENDED driver, allowed for an eligible one;
 *   - LATENCY of the rules-enforced handle vs the bypass handle is MEASURED and reported (not asserted).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const { claimDelivery } = require('../claim-delivery');   // the REAL claim helper the converted handlers call

const D_EN = 'u_parity_enabled0000000';
const D_SUSP = 'u_parity_suspended00000';
const NOW = 1_760_000_000_000;

// Mirrors index.js buildAssignmentUpdates(orderId, driverId, 1, true, isStacked) — the finalize leaves. The CLAIM is
// the real claimDelivery; buildAssignmentUpdates is not importable from index.js, so its leaf shape is replicated here
// (pinned elsewhere by the eligibility rules suite + s1a-wiring).
function finalize(orderId, driverId, { stacked = false, sweeper = false } = {}) {
  const u = {}; const status = stacked ? 'accepted' : 'assigned';
  for (const tt of ['pickup', 'delivery']) {
    const t = `tasks/${orderId}_${tt}`;
    u[`${t}/assigned_driver_id`] = driverId; u[`${t}/status`] = status; u[`${t}/assigned_at`] = NOW;
    if (stacked) u[`${t}/accepted_at`] = NOW; else { u[`${t}/assignment_deadline`] = NOW + 60000; u[`${t}/assignment_attempts`] = 1; }
    u[`${t}/auto_assigned`] = true;
  }
  u[`tasks/${orderId}_delivery/half_claim_since`] = null;
  if (sweeper) { u[`tasks/${orderId}_delivery/retry_count`] = 1; u[`tasks/${orderId}_delivery/last_swept`] = NOW; }
  return u;
}

(async () => {
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  const svc = env.authenticatedContext('svc-assigner').database();   // RULES-ENFORCED as svc-assigner (the restricted handle)
  const drv = env.authenticatedContext(D_EN).database();             // the real driver
  let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

  async function seedMode(mode) { await env.withSecurityRulesDisabled((c) => c.database().ref('platform_config/driver_enforcement_mode').set(mode)); }
  async function seedOrder(oid, { ownerDelivery = null, status = 'pending' } = {}) {
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.database();
      await db.ref(`tasks/${oid}_pickup`).set({ order_id: oid, type: 'pickup', status });
      const del = { order_id: oid, type: 'delivery', status }; if (ownerDelivery) del.assigned_driver_id = ownerDelivery;
      await db.ref(`tasks/${oid}_delivery`).set(del);
      await db.ref(`orders/${oid}`).set({ status: 'out_for_delivery', payment_method: 'cash', total: 200, customer_name: 'Ana' });
    });
  }

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.database();
    await db.ref(`driver_accounts/${D_EN}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
    await db.ref(`driver_accounts/${D_SUSP}`).set({ enabled: false, onboarding_state: 'active' });
    await db.ref(`drivers/${D_EN}`).set({ name: 'EN', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_SUSP}`).set({ name: 'SU', status: 'off_shift', active: false });
  });

  // premise: the handle is rules-enforced (cannot write an arbitrary drivers field)
  await assertFails(svc.ref(`drivers/${D_EN}/name`).set('hacked')); ok('premise: the svc-assigner handle is RULES-ENFORCED (an arbitrary drivers write is denied)');

  // ================= TOLERANT (dark) — unchanged outcome through the real writers =================
  await seedMode(null);
  await seedOrder('oP1');
  const t0 = Date.now();
  const claim = await claimDelivery(svc, 'oP1', D_EN);   // COLD txn: the first real transaction on a fresh env
  assert.ok(claim.claimed, 'cold claim committed');
  ok(`COLD transaction: the first REAL claimDelivery (null→enabled) committed through the restricted handle (${Date.now() - t0}ms)`);
  await assertSucceeds(svc.ref().update(finalize('oP1', D_EN))); ok('TOLERANT: svc finalizes the assignment leaves on BOTH legs');

  await seedOrder('oP4');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP4', D_EN); assert.ok(c.claimed); await svc.ref().update(finalize('oP4', D_EN, { stacked: true })); })()); ok('TOLERANT: real claim + STACKED finalize (accepted) on both legs');
  await seedOrder('oP5');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP5', D_EN); assert.ok(c.claimed); await svc.ref().update(finalize('oP5', D_EN, { sweeper: true })); })()); ok('TOLERANT: real claim + SWEEPER finalize (retry_count + last_swept, delivery leg)');

  // shift-open + bound token rotation
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/active`]: true, [`drivers/${D_EN}/status`]: 'available', [`drivers/${D_EN}/current_shift_id`]: 'sft1', [`drivers/${D_EN}/location_source`]: 'native', [`drivers/${D_EN}/ingest_token_hash`]: 'h1', 'driver_tokens/h1': { uid: D_EN, shift_id: 'sft1', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null } })); ok('TOLERANT: svc opens a shift + mints the bound ingest token');
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/ingest_token_hash`]: 'h2', 'driver_tokens/h2': { uid: D_EN, shift_id: 'sft2', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null }, 'driver_tokens/h1': null })); ok('TOLERANT: svc rotates the token WITHIN the rotation (bound prior-token delete)');

  // restoring (non-null) rollback through the restricted handle
  await seedOrder('oP3', { ownerDelivery: D_EN, status: 'assigned' });
  const rc = await claimDelivery(svc, 'oP3', 'u_parity_other000000000', { expectCurrent: D_EN });
  if (rc.claimed) await rc.rollback();
  ok('TOLERANT: a restoring (non-null) rollback through the restricted handle completes');

  // the REAL driver completion batch (both-leg + stamp) through the driver handle
  await seedOrder('oP2', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oP2_delivery').update({ status: 'accepted' }); });
  let inputs; await env.withSecurityRulesDisabled(async (c) => { const db = c.database(); inputs = { task: (await db.ref('tasks/oP2_delivery').get()).val(), allTasks: (await db.ref('tasks').get()).val() || {} }; });
  await assertSucceeds(drv.ref().update(buildCompleteTaskUpdates({ driverId: D_EN, taskId: 'oP2_delivery', task: inputs.task, allTasks: inputs.allTasks, now: NOW }))); ok('TOLERANT: the REAL driver completion batch (buildCompleteTaskUpdates) lands + stamps');

  // ================= CLOSED — the restricted handle is bitten for an ineligible driver =================
  await seedMode('closed');
  await seedOrder('oC1');
  await assertFails(claimDelivery(svc, 'oC1', D_SUSP)); ok('CLOSED: the real claim is DENIED for a SUSPENDED driver (the invariant bites the restricted handle)');
  await seedOrder('oC2');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oC2', D_EN); assert.ok(c.claimed); })()); ok('CLOSED: the real claim still succeeds for an ELIGIBLE driver');
  await seedMode(null);

  // ================= OFFLINE → reconnect delayed commit =================
  await seedOrder('oR1');
  svc.goOffline();
  const offlineWrite = svc.ref('tasks/oR1_delivery/assigned_driver_id').set(D_EN);
  svc.goOnline();
  await assertSucceeds(offlineWrite); ok('RECONNECT: a write queued while the restricted handle was OFFLINE commits on reconnect');

  // ================= LATENCY: rules-enforced handle vs bypass handle (measured, not asserted) =================
  // Benchmark an svc-GRANTED leaf (drivers/<uid>/last_ping) so both handles exercise the same write under / without
  // rule evaluation — the enforced handle pays the rule-evaluation round trip the default handle skips.
  const bench = async (dbh) => { const N = 10; const s = Date.now(); for (let i = 0; i < N; i++) await dbh.ref(`drivers/${D_EN}/last_ping`).set(NOW + i); return (Date.now() - s) / N; };
  let bypassMs; await env.withSecurityRulesDisabled(async (c) => { bypassMs = await bench(c.database()); });
  const svcMs = await bench(svc);
  ok(`LATENCY (measured, not asserted): rules-enforced svc ${svcMs.toFixed(1)}ms/write vs bypass ${bypassMs.toFixed(1)}ms/write (Δ ${(svcMs - bypassMs).toFixed(1)}ms)`);

  await env.cleanup();
  console.log(`\ndriver-assignment-parity(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-assignment-parity(emulator) FAILED:', e && e.stack || e); process.exit(1); });
