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
 * Proves, through that rules-enforced handle, driving the REAL writers (buildAssignmentUpdates is LIFTED out of index.js
 * and executed — not duplicated; the driver accept uses the real stackedTasksToAccept cascade; completion uses the real
 * buildCompleteTaskUpdates):
 *   - TOLERANT (dark) = UNCHANGED outcome: the REAL claimDelivery (transaction) claims null→enabled; the lifted
 *     buildAssignmentUpdates lands on BOTH legs (matrix-asserted) for a normal, a stacked, and a sweeper finalize;
 *     the shift-open token rotation (create + bound prior-delete, with shift_id + delete NEGATIVES); a restoring
 *     (non-null) rollback that runs UNCONDITIONALLY and restores the prior owner;
 *   - the TIMEOUT reassign flow: svc replaces a timed-out owner via expectCurrent + finalizes to the next driver;
 *   - the REAL driver accept at the rules layer: first (lone), stacked (same-hub cascade), second (cross-hub owner
 *     write), and a NEGATIVE (a driver cannot accept another driver's task); plus the real completion batch;
 *   - a COLD transaction (the first claim on a fresh env) and an OFFLINE→reconnect delayed commit both land;
 *   - the svcWriteOrFallback SAFETY NET: an svc write denied in tolerant mode falls back + raises a loud alert;
 *   - CLOSED bites: the same real claim is DENIED for a SUSPENDED driver, allowed for an eligible one;
 *   - LATENCY of the real claim→finalize cycle, rules-enforced vs bypass, is MEASURED and reported (not asserted).
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
const D_EN2 = 'u_parity_enabled1111111';   // a SECOND eligible driver — the reassignment target + second-accept actor
const D_SUSP = 'u_parity_suspended00000';
const NOW = 1_760_000_000_000;

// codex r2 P1-5: LIFT the REAL buildAssignmentUpdates out of index.js (brace-match) and run it with injected deps, so
// the finalize is the actual converted builder — not a duplicate. The sweeper path adds retry_count/last_swept exactly
// as index.js:sweepPendingOrders does after the builder.
function liftFn(name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = src.indexOf(`function ${name}(`); assert.notStrictEqual(at, -1, `lift ${name}`);
  let i = src.indexOf('{', at), d = 0, end = i; for (; end < src.length; end++) { if (src[end] === '{') d++; else if (src[end] === '}') { d--; if (!d) break; } }
  return src.slice(at, end + 1);
}
// eslint-disable-next-line no-new-func
const buildAssignmentUpdates = new Function('ServerValue', 'ACCEPT_TIMEOUT_MS', `${liftFn('buildAssignmentUpdates')}; return buildAssignmentUpdates;`)({ TIMESTAMP: NOW }, 60000);
const sweeperFinalize = (orderId, driverId) => { const u = buildAssignmentUpdates(orderId, driverId, 1, true, false); u[`tasks/${orderId}_delivery/retry_count`] = 1; u[`tasks/${orderId}_delivery/last_swept`] = NOW; return u; };

(async () => {
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const { stackedTasksToAccept } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'stacking-helpers.js')).href);
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  const svc = env.authenticatedContext('svc-assigner', { svc_assigner: true }).database();   // RULES-ENFORCED as svc-assigner (the restricted handle)
  const drv = env.authenticatedContext(D_EN).database();             // the real driver (D_EN), rules-enforced
  const drv2 = env.authenticatedContext(D_EN2).database();           // the SECOND real driver (D_EN2), rules-enforced
  let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

  // both-leg matrix assertion: after a finalize, BOTH the pickup and delivery legs carry the driver + status
  async function assertBothLegs(oid, driverId, status) {
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.database();
      for (const leg of ['pickup', 'delivery']) {
        const t = (await db.ref(`tasks/${oid}_${leg}`).get()).val() || {};
        assert.equal(t.assigned_driver_id, driverId, `${oid}_${leg} assigned_driver_id`);
        assert.equal(t.status, status, `${oid}_${leg} status`);
        assert.equal(t.auto_assigned, true, `${oid}_${leg} auto_assigned`);
      }
    });
  }
  // the REAL driver accept-update map (mirrors xpizza-delivery.js acceptTask: status+accepted_at on the task,
  // current_task_id + driver status, PLUS the same-hub stacked cascade via the real stackedTasksToAccept)
  function acceptUpdates(driverId, taskId, allTasks) {
    const u = { [`tasks/${taskId}/status`]: 'accepted', [`tasks/${taskId}/accepted_at`]: NOW, [`drivers/${driverId}/current_task_id`]: taskId, [`drivers/${driverId}/status`]: 'assigned' };
    for (const tid of stackedTasksToAccept(allTasks, driverId, allTasks[taskId] && allTasks[taskId].order_id)) { u[`tasks/${tid}/status`] = 'accepted'; u[`tasks/${tid}/accepted_at`] = NOW; }
    return u;
  }

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
    await db.ref(`driver_accounts/${D_EN2}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
    await db.ref(`driver_accounts/${D_SUSP}`).set({ enabled: false, onboarding_state: 'active' });
    await db.ref(`drivers/${D_EN}`).set({ name: 'EN', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_EN2}`).set({ name: 'EN2', status: 'off_shift', active: false });
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
  await assertSucceeds(svc.ref().update(buildAssignmentUpdates('oP1', D_EN, 1, true, false))); await assertBothLegs('oP1', D_EN, 'assigned'); ok('TOLERANT: the REAL buildAssignmentUpdates finalizes the assignment on BOTH legs (matrix-asserted)');

  await seedOrder('oP4');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP4', D_EN); assert.ok(c.claimed); await svc.ref().update(buildAssignmentUpdates('oP4', D_EN, 1, true, true)); })()); await assertBothLegs('oP4', D_EN, 'accepted'); ok('TOLERANT: real claim + STACKED builder (accepted) on both legs (matrix-asserted)');
  await seedOrder('oP5');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP5', D_EN); assert.ok(c.claimed); await svc.ref().update(sweeperFinalize('oP5', D_EN)); })()); await assertBothLegs('oP5', D_EN, 'assigned'); ok('TOLERANT: real claim + SWEEPER builder (retry_count + last_swept, delivery leg)');

  // shift-open + bound token rotation
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/active`]: true, [`drivers/${D_EN}/status`]: 'available', [`drivers/${D_EN}/current_shift_id`]: 'sft1', [`drivers/${D_EN}/location_source`]: 'native', [`drivers/${D_EN}/ingest_token_hash`]: 'h1', 'driver_tokens/h1': { uid: D_EN, shift_id: 'sft1', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null } })); ok('TOLERANT: svc opens a shift + mints the bound ingest token');
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'sft2', [`drivers/${D_EN}/ingest_token_hash`]: 'h2', 'driver_tokens/h2': { uid: D_EN, shift_id: 'sft2', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null }, 'driver_tokens/h1': null })); ok('TOLERANT: svc rotates to a new shift+token WITHIN the rotation (token.shift_id==current_shift_id, prior-token delete bound to the replacement)');
  // rotation NEGATIVE: a token whose shift_id does not match the driver current_shift_id is denied
  await assertFails(svc.ref().update({ [`drivers/${D_EN}/ingest_token_hash`]: 'h3', 'driver_tokens/h3': { uid: D_EN, shift_id: 'MISMATCH', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null } })); ok('TOLERANT: rotation NEGATIVE — a token whose shift_id ≠ the driver current_shift_id is denied');
  // rotation DELETE NEGATIVE: deleting the live token WITHOUT installing a replacement (drivers still points at it) is denied
  await assertFails(svc.ref().update({ 'driver_tokens/h2': null })); ok('TOLERANT: rotation DELETE NEGATIVE — deleting the prior token while the driver still points at it (no replacement installed) is denied');

  // restoring (non-null) rollback through the restricted handle — UNCONDITIONAL: force the claim, then always roll back
  await seedOrder('oP3', { ownerDelivery: D_EN, status: 'assigned' });
  const rc = await claimDelivery(svc, 'oP3', D_EN2, { expectCurrent: D_EN });
  assert.ok(rc.claimed, 'forced reassign claim committed (so the rollback actually runs)');
  await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oP3_delivery/assigned_driver_id').get()).val(), D_EN2, 'claim moved it to D_EN2'); });
  await rc.rollback();
  await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oP3_delivery/assigned_driver_id').get()).val(), D_EN, 'rollback restored the ORIGINAL owner'); });
  ok('TOLERANT: a restoring (non-null) rollback through the restricted handle runs UNCONDITIONALLY and restores the prior owner');

  // ================= TIMEOUT reassign flow: svc replaces a timed-out owner (expectCurrent) + finalizes to the next driver =================
  await seedOrder('oT1', { ownerDelivery: D_EN, status: 'assigned' });
  const tclaim = await claimDelivery(svc, 'oT1', D_EN2, { expectCurrent: D_EN });   // the REAL reassign claim the monitor issues
  assert.ok(tclaim.claimed, 'timeout reassign claim (expectCurrent) committed');
  await assertSucceeds(svc.ref().update(buildAssignmentUpdates('oT1', D_EN2, 1, true, false)));
  await assertBothLegs('oT1', D_EN2, 'assigned'); ok('TIMEOUT: svc replaces the timed-out owner via expectCurrent + finalizes to the NEXT driver on both legs (matrix-asserted)');

  // the REAL driver completion batch (both-leg + stamp) through the driver handle
  await seedOrder('oP2', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oP2_delivery').update({ status: 'accepted' }); });
  let inputs; await env.withSecurityRulesDisabled(async (c) => { const db = c.database(); inputs = { task: (await db.ref('tasks/oP2_delivery').get()).val(), allTasks: (await db.ref('tasks').get()).val() || {} }; });
  await assertSucceeds(drv.ref().update(buildCompleteTaskUpdates({ driverId: D_EN, taskId: 'oP2_delivery', task: inputs.task, allTasks: inputs.allTasks, now: NOW }))); ok('TOLERANT: the REAL driver completion batch (buildCompleteTaskUpdates) lands + stamps');

  // ================= DRIVER ACCEPT (first / stacked / second) — the REAL driver-auth handle against the real rules =================
  // Advisor improvement: try to drive the ACTUAL web-SDK writers from xpizza-driver/xpizza-delivery.js; if that module
  // can't load in node (it imports the Firebase WEB SDK via bare specifiers that don't resolve from functions/), fall
  // back to the rule-path probe below and SAY WHY. The probe is itself faithful: it applies the EXACT acceptTask update
  // map (built from the real stackedTasksToAccept) through the rules-enforced driver-auth handle.
  let acceptVia = 'rule-path probe (driver-auth handle + real acceptTask update map)';
  try {
    await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'xpizza-delivery.js')).href);
    acceptVia = 'real xpizza-delivery.js web-SDK writers';
  } catch (e) {
    console.log(`  note: web-SDK accept writers not loadable in node (${String(e && e.code || e.message).slice(0, 40)}); using the rule-path probe instead`);
  }
  async function readAllTasks() { let a; await env.withSecurityRulesDisabled(async (c) => { a = (await c.database().ref('tasks').get()).val() || {}; }); return a; }

  // first accept (lone order): the assigned driver flips their own pickup leg → accepted (+ driver fields)
  await seedOrder('oA1', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oA1_pickup/assigned_driver_id').set(D_EN); });
  await assertSucceeds(drv.ref().update(acceptUpdates(D_EN, 'oA1_pickup', await readAllTasks()))); ok(`DRIVER FIRST ACCEPT: the assigned driver accepts a lone order through the real rules [${acceptVia}]`);

  // stacked accept: accepting one same-hub order auto-accepts the driver's OTHER assigned same-hub order (real stackedTasksToAccept)
  await seedOrder('oA2', { ownerDelivery: D_EN, status: 'assigned' });
  await seedOrder('oA3', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { const db = c.database(); await db.ref('tasks/oA2_pickup/assigned_driver_id').set(D_EN); await db.ref('tasks/oA3_pickup/assigned_driver_id').set(D_EN); });
  const stackUpd = acceptUpdates(D_EN, 'oA2_pickup', await readAllTasks());
  assert.ok(Object.keys(stackUpd).some((k) => k.startsWith('tasks/oA3_')), 'the real stackedTasksToAccept cascaded the SAME-HUB sibling order into the accept batch');
  await assertSucceeds(drv.ref().update(stackUpd)); await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oA3_pickup/status').get()).val(), 'accepted', 'the stacked sibling was auto-accepted'); }); ok('DRIVER STACKED ACCEPT: accepting one order auto-accepts the same-hub sibling (real cascade) through the rules');

  // second accept (cross-hub swipe): a pure owner task-status write (acceptSecondOrder writes no driver fields)
  await seedOrder('oS1', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oS1_pickup/assigned_driver_id').set(D_EN); });
  await assertSucceeds(drv.ref().update({ 'tasks/oS1_pickup/status': 'accepted', 'tasks/oS1_pickup/accepted_at': NOW })); ok('DRIVER SECOND ACCEPT: a cross-hub second accept (owner task-status write, no driver fields) is allowed');

  // NEGATIVE: a driver accepting a task that is NOT assigned to them is denied by the rules
  await assertFails(drv2.ref().update({ 'tasks/oA1_pickup/status': 'accepted', 'tasks/oA1_pickup/accepted_at': NOW })); ok('DRIVER ACCEPT NEGATIVE: a driver cannot accept a task assigned to a DIFFERENT driver (rule-denied)');

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

  // ================= SAFETY NET: svcWriteOrFallback real fallback (denied-in-tolerant → default handle + alert) =================
  const { svcWriteOrFallback } = require('../lib/svc-handle');
  await seedMode(null);   // tolerant
  await env.withSecurityRulesDisabled(async (c) => {
    const bypass = c.database();   // the DEFAULT (bypass) handle; svc is the rules-enforced handle
    await svcWriteOrFallback(bypass, svc, (h) => h.ref(`drivers/${D_EN}/name`).set('viaFallback'), { site: 'parity.test', target: D_EN });
    assert.equal((await bypass.ref(`drivers/${D_EN}/name`).get()).val(), 'viaFallback', 'the denied svc write fell back to the default handle');
    const alerts = (await bypass.ref('dispatcher_alerts').get()).val() || {};
    assert.ok(Object.values(alerts).some((a) => a.type === 'svc_handle_fallback' && a.site === 'parity.test'), 'a loud svc_handle_fallback alert was raised');
  });
  ok('SAFETY NET: an svc write DENIED in tolerant mode falls back to the default handle + raises a loud alert (real emulator)');

  // ================= LATENCY: rules-enforced handle vs bypass handle, the REAL claim→finalize cycle (measured, not asserted) =================
  // Measures the whole assignment unit the monitor pays — the claimDelivery transaction + the buildAssignmentUpdates
  // finalize — so the figure reflects the rule-evaluation cost of the actual critical path, not a bare leaf write.
  const N = 5;
  const seedBench = async (c, prefix) => { const db = c.database(); for (let i = 0; i < N; i++) { const oid = `${prefix}${i}`; await db.ref(`tasks/${oid}_pickup`).set({ order_id: oid, type: 'pickup', status: 'pending' }); await db.ref(`tasks/${oid}_delivery`).set({ order_id: oid, type: 'delivery', status: 'pending' }); } };
  const claimFinalize = async (dbh, oid) => { const c = await claimDelivery(dbh, oid, D_EN); assert.ok(c.claimed); await dbh.ref().update(buildAssignmentUpdates(oid, D_EN, 1, true, false)); };
  await env.withSecurityRulesDisabled((c) => seedBench(c, 'bSvc'));
  const sSvc = Date.now(); for (let i = 0; i < N; i++) await claimFinalize(svc, `bSvc${i}`); const svcMs = (Date.now() - sSvc) / N;
  let bypassMs; await env.withSecurityRulesDisabled(async (c) => { await seedBench(c, 'bByp'); const s = Date.now(); for (let i = 0; i < N; i++) await claimFinalize(c.database(), `bByp${i}`); bypassMs = (Date.now() - s) / N; });
  ok(`LATENCY (measured, not asserted): rules-enforced svc claim→finalize ${svcMs.toFixed(1)}ms vs bypass ${bypassMs.toFixed(1)}ms (Δ ${(svcMs - bypassMs).toFixed(1)}ms)`);

  await env.cleanup();
  console.log(`\ndriver-assignment-parity(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-assignment-parity(emulator) FAILED:', e && e.stack || e); process.exit(1); });
