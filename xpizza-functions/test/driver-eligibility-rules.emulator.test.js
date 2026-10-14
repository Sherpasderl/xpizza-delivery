/**
 * S1a — the commit-time driver-eligibility invariant in RTDB rules (PLAN-S1 §2/§3/§6).
 * Run: npm run test:driver-eligibility-rules
 *
 * Proves, against the REAL compiled ruleset (xpizza-reference/database.rules.json):
 *   A. TOLERANT (enforcement_mode absent — the S1a-dark default): PARITY. Every write/read that is
 *      permitted today for an ENABLED or ABSENT account still succeeds; the invariant does not bite the
 *      only account states that exist in dark (enabled:true backfills + absent). An enabled:false /
 *      deactivated record is ineligible even in tolerant (tolerant rescues only MISSING accounts) — but
 *      no such record exists until S1b, so dark behavior is unchanged.
 *   B. CLOSED (enforcement_mode='closed'): the invariant BITES (non-vacuity) — ownership create/restore,
 *      terminal→nonterminal reopen, and shift-open all require the TARGET uid's eligibility; an eligible
 *      driver still works; absent/suspended/deactivated targets are denied. svc-assigner is bound too.
 *   C. HARD-STOP WRITE (mode-independent): a DEACTIVATED actor cannot write /tasks, /orders status/stamp,
 *      /drivers, or their cuadre; an enabled actor still can.
 *   D. HARD-STOP READ (mode-independent): a DEACTIVATED reader loses /tasks /orders /drivers /order_timelines
 *      but keeps the self /driver_accounts read the sign-out listener needs; enabled drivers + dispatchers read.
 *   E. svc-assigner SCOPING: it may write only the granted assignment/shift leaves + driver_tokens; it cannot
 *      write arbitrary task fields (order_id/type), /orders, its own driver profile / staff_push / cuadre,
 *      /dispatchers, or /driver_accounts (self-exclusions + no over-grant).
 *
 * The delivery-completion stamp path is driven by the REAL writer (buildCompleteTaskUpdates). The assignment
 * and shift-open leaf writes mirror buildAssignmentUpdates (index.js:5651) and startDriverShift (index.js:4108)
 * byte-for-byte in SHAPE; part (c)'s index.js behavioral emulator tests drive those real writers end-to-end.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const DISP    = 'u_disp00000000000000000';
const SVC     = 'svc-assigner';
const D_EN    = 'u_enabled000000000000000';   // backfilled: enabled:true, active
const D_ABS   = 'u_absent0000000000000000';   // NO driver_accounts record
const D_SUSP  = 'u_suspended0000000000000';   // enabled:false (suspended / not-yet-approved)
const D_DEACT = 'u_deactivated0000000000';    // deactivated:true
const NOW = 1_760_000_000_000;

// Mirror of buildAssignmentUpdates(orderId, driverId, 1, true) (index.js:5651), non-stacked, both legs.
function assignmentFinalize(oid, driverId, { sweeper = false } = {}) {
  const u = {};
  for (const tt of ['pickup', 'delivery']) {
    const t = `tasks/${oid}_${tt}`;
    u[`${t}/assigned_driver_id`] = driverId;
    u[`${t}/status`] = 'assigned';
    u[`${t}/assigned_at`] = NOW;
    u[`${t}/assignment_deadline`] = NOW + 60000;
    u[`${t}/assignment_attempts`] = 1;
    u[`${t}/auto_assigned`] = true;
  }
  u[`tasks/${oid}_delivery/half_claim_since`] = null;
  if (sweeper) { u[`tasks/${oid}_delivery/retry_count`] = 1; u[`tasks/${oid}_delivery/last_swept`] = NOW; }
  return u;
}
// Mirror of the native startDriverShift update (index.js:4108) — driver leaves + token create.
function shiftOpen(uid, shiftId, hash) {
  return {
    [`drivers/${uid}/active`]: true,
    [`drivers/${uid}/status`]: 'available',
    [`drivers/${uid}/shift_started_at`]: NOW,
    [`drivers/${uid}/last_ping`]: NOW,
    [`drivers/${uid}/current_task_id`]: null,
    [`drivers/${uid}/current_hub_lat`]: null,
    [`drivers/${uid}/current_hub_lng`]: null,
    [`drivers/${uid}/current_restaurant_id`]: null,
    [`drivers/${uid}/current_hub_task_id`]: null,
    [`drivers/${uid}/current_shift_id`]: shiftId,
    [`drivers/${uid}/location_source`]: 'native',
    [`drivers/${uid}/ingest_token_hash`]: hash,
    [`driver_tokens/${hash}`]: { uid, shift_id: shiftId, device_id: 'dev1', issued_at: NOW, expires_at: NOW + 3600000, revoked_at: null }
  };
}

(async () => {
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  async function seedBase(ctx) {
    const db = ctx.database();
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`drivers/${DISP}`).set({ name: 'Disp', status: 'off_shift', active: false });   // a driver row for the dispatcher (P1-3 dispatcher-token test isolates the dispatcher check)
    await db.ref(`drivers/${D_EN}`).set({ name: 'EN', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_ABS}`).set({ name: 'ABS', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_SUSP}`).set({ name: 'SU', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_DEACT}`).set({ name: 'DE', status: 'off_shift', active: false });
    await db.ref(`driver_accounts/${D_EN}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
    await db.ref(`driver_accounts/${D_SUSP}`).set({ enabled: false, onboarding_state: 'active' });
    await db.ref(`driver_accounts/${D_DEACT}`).set({ enabled: true, onboarding_state: 'active', deactivated: true });
    // D_ABS: intentionally NO driver_accounts record.
  }
  async function setMode(mode) {   // mode === null → remove the key (tolerant); 'closed' → enforce
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.database().ref('platform_config/driver_enforcement_mode').set(mode);
    });
  }
  // Reset a driver to off-shift so a following active→true write is a GENUINE inactive→active transition
  // (re-setting active=true when already true is correctly NOT gated, so each clock-in assertion must start clean).
  async function resetShift(uid) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.database().ref(`drivers/${uid}`).update({ active: false, current_shift_id: null, status: 'off_shift' });
    });
  }
  async function seedPendingTask(oid, { ownerDelivery = null, status = 'pending' } = {}) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref(`tasks/${oid}_pickup`).set({ order_id: oid, type: 'pickup', status });
      const del = { order_id: oid, type: 'delivery', status };
      if (ownerDelivery) del.assigned_driver_id = ownerDelivery;
      await db.ref(`tasks/${oid}_delivery`).set(del);
    });
  }
  async function seedOrderForStamp(oid, driver) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.database();
      await db.ref(`orders/${oid}`).set({ status: 'out_for_delivery', payment_method: 'cash', total: 370, customer_name: 'Ana' });
      await db.ref(`tasks/${oid}_delivery`).set({ assigned_driver_id: driver, type: 'delivery', order_id: oid, status: 'accepted', created_at: 1 });
    });
  }
  async function completionBatch(driverId, oid) {
    let inputs;
    await env.withSecurityRulesDisabled(async (ctx) => {
      inputs = { task: (await ctx.database().ref(`tasks/${oid}_delivery`).get()).val(), allTasks: (await ctx.database().ref('tasks').get()).val() || {} };
    });
    return buildCompleteTaskUpdates({ driverId, taskId: `${oid}_delivery`, task: inputs.task, allTasks: inputs.allTasks, now: NOW });
  }

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };

  await env.withSecurityRulesDisabled(seedBase);

  const disp   = env.authenticatedContext(DISP).database();
  const svc    = env.authenticatedContext(SVC, { svc_assigner: true }).database();
  const en     = env.authenticatedContext(D_EN).database();
  const abs    = env.authenticatedContext(D_ABS).database();
  const susp   = env.authenticatedContext(D_SUSP).database();
  const deact  = env.authenticatedContext(D_DEACT).database();

  // ================= A. TOLERANT (mode absent) — PARITY =================
  await setMode(null);
  console.log('\n-- A. tolerant (enforcement_mode absent): parity --');

  await seedPendingTask('oA1');
  await ok('svc claims a delivery (null→enabled driver)', svc.ref('tasks/oA1_delivery/assigned_driver_id').set(D_EN));
  await ok('svc finalizes assignment leaves for an enabled driver', svc.ref().update(assignmentFinalize('oA1', D_EN)));

  await seedPendingTask('oA2');
  await ok('svc claims a delivery for an ABSENT-account driver (tolerant = legacy-allowed)', svc.ref('tasks/oA2_delivery/assigned_driver_id').set(D_ABS));
  await ok('svc sweeper-finalizes (retry_count + last_swept leaves) for an absent-account driver', svc.ref().update(assignmentFinalize('oA2', D_ABS, { sweeper: true })));

  await ok('svc opens a shift for an enabled driver (active→true + shift id + token)', svc.ref().update(shiftOpen(D_EN, 'shiftA1', 'hashA1')));
  await ok('svc opens a shift for an absent-account driver (tolerant)', svc.ref().update(shiftOpen(D_ABS, 'shiftA2', 'hashA2')));

  await ok('enabled driver writes telemetry (lat) on itself', en.ref(`drivers/${D_EN}/lat`).set(15.5));
  await resetShift(D_EN); await resetShift(D_ABS);
  await ok('enabled driver LEGACY direct clock-in (self active→true) — enabled stays allowed', en.ref(`drivers/${D_EN}/active`).set(true));
  await ok('absent-account driver legacy direct clock-in (self active→true) in tolerant', abs.ref(`drivers/${D_ABS}/active`).set(true));

  // enabled driver owns a task and progresses it (status change, NO ownership change) — accept/complete parity
  await seedPendingTask('oA3', { ownerDelivery: D_EN, status: 'assigned' });
  await ok('enabled owning driver advances its task status (assigned→accepted), no owner change', en.ref('tasks/oA3_delivery/status').set('accepted'));

  // first-login profile create with active:false is NOT a transition
  await ok('first-login profile create (name + active:false), no shift → allowed',
    env.authenticatedContext('u_newlogin00000000000000').database().ref('drivers/u_newlogin00000000000000').set({ name: 'New', active: false, status: 'off_shift' }));

  // tolerant does NOT rescue an enabled:false / deactivated record (designed semantics; no such record exists in dark)
  await seedPendingTask('oA4');
  await no('svc claim for a SUSPENDED (enabled:false) driver is denied even in tolerant', svc.ref('tasks/oA4_delivery/assigned_driver_id').set(D_SUSP));
  await no('svc claim for a DEACTIVATED driver is denied', svc.ref('tasks/oA4_delivery/assigned_driver_id').set(D_DEACT));

  // reads: enabled driver + dispatcher read the collections
  await ok('enabled driver reads /tasks', en.ref('tasks').get());
  await ok('enabled driver reads /orders', en.ref('orders').get());
  await ok('enabled driver reads /order_timelines', en.ref('order_timelines').get());
  await ok('dispatcher reads /drivers', disp.ref('drivers').get());

  // clearing ownership is never gated (uid→null), even toward a suspended owner's task
  await seedPendingTask('oA5', { ownerDelivery: D_EN, status: 'assigned' });
  await ok('dispatcher clears ownership (uid→null) — not gated', disp.ref('tasks/oA5_delivery/assigned_driver_id').set(null));

  // ================= B. CLOSED (mode='closed') — invariant BITES =================
  await setMode('closed');
  console.log('\n-- B. closed (enforcement_mode=closed): non-vacuity --');

  await seedPendingTask('oB1');
  await ok('CLOSED: svc claims for an ELIGIBLE (enabled) driver — still works', svc.ref('tasks/oB1_delivery/assigned_driver_id').set(D_EN));
  await ok('CLOSED: svc finalizes assignment leaves for the enabled driver', svc.ref().update(assignmentFinalize('oB1', D_EN)));

  await seedPendingTask('oB2');
  await no('CLOSED: svc claim for an ABSENT-account driver is DENIED (missing ⇒ ineligible)', svc.ref('tasks/oB2_delivery/assigned_driver_id').set(D_ABS));
  await no('CLOSED: svc claim for a SUSPENDED driver is DENIED', svc.ref('tasks/oB2_delivery/assigned_driver_id').set(D_SUSP));
  await no('CLOSED: svc claim for a DEACTIVATED driver is DENIED', svc.ref('tasks/oB2_delivery/assigned_driver_id').set(D_DEACT));

  await ok('CLOSED: svc opens a shift for the enabled driver', svc.ref().update(shiftOpen(D_EN, 'shiftB1', 'hashB1')));
  await no('CLOSED: svc opens a shift for a SUSPENDED driver — DENIED', svc.ref().update(shiftOpen(D_SUSP, 'shiftB2', 'hashB2')));
  await no('CLOSED: svc opens a shift for an ABSENT-account driver — DENIED', svc.ref().update(shiftOpen(D_ABS, 'shiftB3', 'hashB3')));

  // terminal→nonterminal reopen, even same owner (dispatcher writer)
  await seedPendingTask('oB4', { ownerDelivery: D_SUSP, status: 'cancelled' });
  await no('CLOSED: reopen cancelled→pending for a SUSPENDED owner — DENIED (terminal→nonterminal gate)', disp.ref('tasks/oB4_delivery/status').set('pending'));
  await seedPendingTask('oB5', { ownerDelivery: D_EN, status: 'cancelled' });
  await ok('CLOSED: reopen cancelled→pending for an ELIGIBLE owner — allowed', disp.ref('tasks/oB5_delivery/status').set('pending'));

  // legacy direct clock-in in closed: enabled OK, suspended/absent denied
  await resetShift(D_EN); await resetShift(D_SUSP); await resetShift(D_ABS);
  await ok('CLOSED: enabled driver legacy direct clock-in (self active→true)', en.ref(`drivers/${D_EN}/active`).set(true));
  await no('CLOSED: suspended driver legacy direct clock-in — DENIED', susp.ref(`drivers/${D_SUSP}/active`).set(true));
  await no('CLOSED: absent-account driver legacy direct clock-in — DENIED', abs.ref(`drivers/${D_ABS}/active`).set(true));

  // ================= C. HARD-STOP WRITE (deactivated actor) — mode-independent =================
  await setMode(null);   // prove it is NOT mode-gated
  console.log('\n-- C. deactivated actor: write hard-stop (tolerant mode) --');

  await seedPendingTask('oC1', { ownerDelivery: D_DEACT, status: 'assigned' });
  await no('deactivated owner cannot write its own task status', deact.ref('tasks/oC1_delivery/status').set('accepted'));
  await no('deactivated driver cannot write telemetry on itself', deact.ref(`drivers/${D_DEACT}/lat`).set(1));
  await no('deactivated driver cannot write its cuadre', deact.ref(`driver_cash/${D_DEACT}/sh1/cuadre`).set({ cash_owed: 1, cash_order_count: 1, closed_at: 1 }));

  await seedOrderForStamp('oC2', D_DEACT);
  await no('deactivated driver cannot stamp a delivery completion', deact.ref().update(await completionBatch(D_DEACT, 'oC2')));

  // parity: an enabled owner CAN do the same completion
  await seedOrderForStamp('oC3', D_EN);
  await ok('enabled assigned driver completes a delivery (real writer) — stamp lands', en.ref().update(await completionBatch(D_EN, 'oC3')));
  await ok('enabled driver writes its own cuadre', en.ref(`driver_cash/${D_EN}/sh1/cuadre`).set({ cash_owed: 370, cash_order_count: 1, closed_at: NOW }));

  // ================= D. HARD-STOP READ (deactivated reader) =================
  console.log('\n-- D. deactivated reader: read hard-stop --');
  await no('deactivated driver cannot read /tasks', deact.ref('tasks').get());
  await no('deactivated driver cannot read /orders', deact.ref('orders').get());
  await no('deactivated driver cannot read /drivers', deact.ref('drivers').get());
  await no('deactivated driver cannot read /order_timelines', deact.ref('order_timelines').get());
  await ok('deactivated driver CAN still read its own /driver_accounts (sign-out listener)', deact.ref(`driver_accounts/${D_DEACT}`).get());
  await ok('enabled driver still reads /tasks', en.ref('tasks').get());
  await ok('dispatcher (no driver account) still reads /orders', disp.ref('orders').get());

  // ================= E. svc-assigner SCOPING + self-exclusions =================
  console.log('\n-- E. svc-assigner scoping --');
  await seedPendingTask('oE1');
  await no('svc CANNOT write an arbitrary task field (order_id) — no leaf grant', svc.ref('tasks/oE1_delivery/order_id').set('hijack'));
  await no('svc CANNOT write task type — no leaf grant', svc.ref('tasks/oE1_pickup/type').set('delivery'));
  // P1-3: the sweeper marker/retry/sweep leaves are DELIVERY-leg only
  await no('svc CANNOT write retry_count on a PICKUP leg (delivery-leg only)', svc.ref('tasks/oE1_pickup/retry_count').set(1));
  await no('svc CANNOT write last_swept on a PICKUP leg', svc.ref('tasks/oE1_pickup/last_swept').set(NOW));
  await no('svc CANNOT write half_claim_since on a PICKUP leg', svc.ref('tasks/oE1_pickup/half_claim_since').set(NOW));
  await no('svc CANNOT write its own driver profile (name)', svc.ref(`drivers/${SVC}/name`).set('svc'));
  await no('svc CANNOT write its own staff_push', svc.ref(`staff_push/${SVC}`).set({ x: 1 }));
  await no('svc CANNOT write a cuadre', svc.ref(`driver_cash/${SVC}/sh/cuadre`).set({ cash_owed: 1, cash_order_count: 1, closed_at: 1 }));
  await seedOrderForStamp('oE2', D_EN);
  await no('svc CANNOT write /orders status', svc.ref('orders/oE2/status').set('delivered'));
  await no('svc CANNOT write /dispatchers', svc.ref(`dispatchers/${SVC}`).set({ name: 'x' }));
  await no('svc CANNOT write /driver_accounts', svc.ref(`driver_accounts/${D_EN}/enabled`).set(false));

  // P1-2: the reserved identity cannot ESCALATE via self-assignment (even seeded as a task owner it gets no owner/order branch)
  await no('svc CANNOT set a task owner to the reserved svc-assigner uid (assigned_driver_id validate)', svc.ref('tasks/oE1_delivery/assigned_driver_id').set(SVC));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('tasks/oE3_delivery').set({ order_id: 'oE3', type: 'delivery', status: 'assigned', assigned_driver_id: SVC });
    await ctx.database().ref('orders/oE3').set({ status: 'out_for_delivery', payment_method: 'cash', total: 100 });
  });
  await no('svc owning a task CANNOT write a non-granted task field (order_id) via the owner branch', svc.ref('tasks/oE3_delivery/order_id').set('hijack'));
  await no('svc owning a delivery task CANNOT write the order status (order owner branch excludes the reserved id)', svc.ref('orders/oE3/status').set('delivered'));
  await no('svc owning a delivery task CANNOT stamp delivered_by_driver_uid', svc.ref('orders/oE3/delivered_by_driver_uid').set(SVC));

  // P1-3/r2 P1-4: driver_tokens BOUND to the rotation — resulting uid/shift/hash + an ACTUAL rotation; delete needs a replacement.
  const tok = (uid, shift) => ({ uid, shift_id: shift, device_id: null, issued_at: NOW, expires_at: NOW + 1000, revoked_at: null });
  await ok('svc CAN create a token BOUND to the rotation (uid→hash + token.shift_id==driver.current_shift_id + actual rotation)',
    svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'shiftE', [`drivers/${D_EN}/ingest_token_hash`]: 'hashE1', 'driver_tokens/hashE1': tok(D_EN, 'shiftE') }));
  await no('svc CANNOT create an UNBOUND token (no matching drivers rotation in the update)',
    svc.ref('driver_tokens/hashUnbound').set(tok(D_EN, 'shiftE')));
  await no('svc CANNOT create a token whose shift_id ≠ the driver current_shift_id (hash matches, shift does not)',
    svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'shiftX', [`drivers/${D_EN}/ingest_token_hash`]: 'hashMis', 'driver_tokens/hashMis': tok(D_EN, 'shiftDIFFERENT') }));
  await no('svc CANNOT create a token WITHOUT an actual rotation (driver already points at this hash)',
    svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'shiftE', [`drivers/${D_EN}/ingest_token_hash`]: 'hashE1', 'driver_tokens/hashE1': tok(D_EN, 'shiftE') }));
  await no('svc CANNOT mint a token for a DISPATCHER uid even if otherwise bound',
    svc.ref().update({ [`drivers/${DISP}/current_shift_id`]: 'shiftE', [`drivers/${DISP}/ingest_token_hash`]: 'hashDisp', 'driver_tokens/hashDisp': tok(DISP, 'shiftE') }));
  await no('svc CANNOT delete a token the driver STILL points to (no replacement)', svc.ref('driver_tokens/hashE1').set(null));
  await no('svc CANNOT delete the prior token when the driver clears ingest_token_hash to NULL (no replacement installed)',
    svc.ref().update({ [`drivers/${D_EN}/ingest_token_hash`]: null, 'driver_tokens/hashE1': null }));
  await ok('svc CAN delete the prior token WITHIN a rotation (driver now points at a NEW non-null hash in the same update)',
    svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'shiftE2', [`drivers/${D_EN}/ingest_token_hash`]: 'hashE2', 'driver_tokens/hashE2': tok(D_EN, 'shiftE2'), 'driver_tokens/hashE1': null }));
  // codex r3 P1-3: delete must be bound to a REAL replacement — a resulting pointer that merely differs is not enough.
  await no('svc CANNOT delete the live token while pointing the driver at a NONEXISTENT replacement (no token created)',
    svc.ref().update({ [`drivers/${D_EN}/ingest_token_hash`]: 'no-such-token', 'driver_tokens/hashE2': null }));
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref('driver_tokens/hashOrphan').set(tok(D_EN, 'shiftOld')));
  await no('svc CANNOT delete an ORPHAN token with the driver pointer unchanged (old pointer never named it)',
    svc.ref('driver_tokens/hashOrphan').set(null));
  await no('svc CANNOT write a malformed token (missing uid/shift_id)',
    svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'shiftBad', [`drivers/${D_EN}/ingest_token_hash`]: 'hashBad', 'driver_tokens/hashBad': { device_id: 'x' } }));

  await env.cleanup();
  console.log(`\ndriver-eligibility-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-eligibility-rules(emulator) FAILED:', e && e.stack || e); process.exit(1); });
