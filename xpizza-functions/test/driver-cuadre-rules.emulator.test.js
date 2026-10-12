/**
 * Driver cuadre money-grade attribution — orders/{id}/delivered_by_driver_uid RTDB rules + /driver_cash read
 * grants (PLAN-driver-cuadre-source §1/§7). Run: npm run test:driver-cuadre-rules
 *
 * The stamp assertions drive the REAL delivery writer (buildCompleteTaskUpdates from xpizza-delivery.js) —
 * the exact atomic batch completeTask applies — not a hand-built imitation. Each negative varies ONE axis
 * from the canonical PASSING completion (same order/task/driver/transition), so a failure localizes the cause:
 *   PASS: assigned non-dispatcher non-customer driver completes their delivery on the out_for_delivery→delivered
 *         transition, no prior stamp.
 *   vary driver is ALSO a dispatcher          → dual-role completion REJECTED
 *   vary driver token carries customer:true    → REJECTED
 *   vary pre-write status already 'delivered'  → off-transition REJECTED
 *   vary the stamped uid ≠ the actor           → not-self REJECTED
 *   vary actor is a pure dispatcher (create)   → dispatcher-create REJECTED (dispatchers may only modify existing)
 * Plus: write-once overwrite, parent replace, clear, clear→recreate, whole-order delete, mixed-version (old
 * client, no stamp) completion SUCCEEDS, and a real completion → reassignment → dispatcher-cancellation flow.
 * Read matrix: /driver_cash parent (dispatcher only), own child (driver), cross/parent/customer denied.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_disp00000000000000000';
const DRIVER = 'u_driver0000000000000000';
const DRIVER2 = 'u_driver2000000000000000';
const DUAL = 'u_dualrole00000000000000';   // in /dispatchers AND an assigned driver

(async () => {
  // The REAL delivery writer (buildCompleteTaskUpdates) — imported from the PURE module xpizza-delivery.js
  // itself imports and re-exports, so the test drives the exact writer the client runs. (xpizza-delivery.js
  // cannot be imported in node: it pulls the Firebase web SDK over https.)
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const NOW = 1_760_000_000_000;

  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  // ---- shared seed ----
  async function seedBase(ctx) {
    const db = ctx.database();
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`dispatchers/${DUAL}`).set({ name: 'Dual' });   // dual-role: also an assigned driver below
    await db.ref(`drivers/${DRIVER}`).set({ name: 'R1', status: 'en_route_delivery' });
    await db.ref(`drivers/${DRIVER2}`).set({ name: 'R2', status: 'en_route_delivery' });
    await db.ref(`drivers/${DUAL}`).set({ name: 'Dual', status: 'en_route_delivery' });
  }
  // Seed one fresh order + its delivery task; returns the (task, allTasks) the real writer consumes.
  async function seedOrder(ctx, { oid, driver = DRIVER, status = 'out_for_delivery', stamp = undefined }) {
    const db = ctx.database();
    const order = { status, payment_method: 'cash', total: 370, customer_name: 'Ana' };
    if (stamp !== undefined) order.delivered_by_driver_uid = stamp;
    await db.ref(`orders/${oid}`).set(order);
    await db.ref(`tasks/${oid}_delivery`).set({ assigned_driver_id: driver, type: 'delivery', order_id: oid, status: 'accepted', created_at: 1 });
  }
  async function readWriterInputs(ctx, oid) {
    const db = ctx.database();
    const task = (await db.ref(`tasks/${oid}_delivery`).get()).val();
    const allTasks = (await db.ref('tasks').get()).val() || {};
    return { task, allTasks };
  }

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };

  // Build the REAL completion batch for `driverId` completing `oid`'s delivery, read from admin state.
  async function completionBatch(driverId, oid) {
    let inputs;
    await env.withSecurityRulesDisabled(async (ctx) => { inputs = await readWriterInputs(ctx, oid); });
    return buildCompleteTaskUpdates({ driverId, taskId: `${oid}_delivery`, task: inputs.task, allTasks: inputs.allTasks, now: NOW });
  }

  await env.withSecurityRulesDisabled(seedBase);

  const driver = env.authenticatedContext(DRIVER).database();
  const driver2 = env.authenticatedContext(DRIVER2).database();
  const disp = env.authenticatedContext(DISP).database();
  const dual = env.authenticatedContext(DUAL).database();
  const customerDriver = env.authenticatedContext(DRIVER, { customer: true }).database();   // assigned driver, customer token
  const customer = env.authenticatedContext('u_cust000000000000000000', { customer: true }).database();
  const custDisp = env.authenticatedContext(DISP, { customer: true }).database();

  // ============ CANONICAL PASS (the real writer) ============
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_pass', driver: DRIVER }));
  await ok('REAL completeTask batch: assigned driver completes the delivered transition (stamp lands)',
    driver.ref().update(await completionBatch(DRIVER, 'o_pass')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    assert.strictEqual((await ctx.database().ref('orders/o_pass/delivered_by_driver_uid').get()).val(), DRIVER);
  });
  console.log(`  ok ${++n} the canonical stamp persisted as the assigned driver`);

  // ============ NEGATIVES — each varies ONE axis from the canonical pass ============
  // vary: the actor is ALSO a dispatcher (dual-role) — same order shape, driver IS the assigned driver.
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_dual', driver: DUAL }));
  await no('VARY dual-role: an assigned driver who is also a dispatcher cannot self-stamp (completion rejected)',
    dual.ref().update(await completionBatch(DUAL, 'o_dual')));

  // vary: the actor's token carries customer:true (still the assigned driver, still a valid transition).
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_cust', driver: DRIVER }));
  await no('VARY customer token: the assigned driver with a customer token cannot stamp',
    customerDriver.ref().update(await completionBatch(DRIVER, 'o_cust')));

  // vary: pre-write status already 'delivered' (off-transition).
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_off', driver: DRIVER, status: 'delivered' }));
  await no('VARY off-transition: pre-write status already delivered → stamp rejected',
    driver.ref().update(await completionBatch(DRIVER, 'o_off')));

  // vary: the stamped uid ≠ the actor (assigned driver stamps DRIVER2 on their own valid transition). Only the
  // stamp VALUE differs from the canonical order-write, so the rejection isolates the self check.
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_self', driver: DRIVER }));
  await no('VARY not-self: driver stamps another uid on a valid transition',
    driver.ref().update({ 'orders/o_self/status': 'delivered', 'orders/o_self/delivered_at': NOW, 'orders/o_self/delivered_by_driver_uid': DRIVER2 }));

  // vary: a PURE dispatcher runs the completion (dispatcher-create must be rejected; dispatchers only modify existing).
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_dispcreate', driver: DRIVER }));
  await no('VARY dispatcher-create: a dispatcher cannot CREATE a stamp (only modify an existing one)',
    disp.ref().update(await completionBatch(DRIVER, 'o_dispcreate')));

  // ============ WRITE-ONCE / PRESERVATION ============
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_stamped', driver: DRIVER, status: 'delivered', stamp: DRIVER }));
  await no('write-once: the assigned driver cannot OVERWRITE an existing stamp with a new value',
    driver.ref().update({ 'orders/o_stamped/status': 'delivered', 'orders/o_stamped/delivered_by_driver_uid': DRIVER2 }));
  await no('preservation: a non-dispatcher cannot CLEAR an existing stamp',
    driver.ref('orders/o_stamped/delivered_by_driver_uid').set(null));
  await no('preservation: parent REPLACE of the whole order by a non-dispatcher is denied (order .write dispatchers-only)',
    driver.ref('orders/o_stamped').set({ status: 'delivered', payment_method: 'cash', total: 370 }));
  await no('whole-order DELETE by a non-dispatcher is denied',
    driver.ref('orders/o_stamped').set(null));
  await no('clear→recreate: a non-dispatcher cannot null-then-reset the stamp in one batch',
    driver.ref().update({ 'orders/o_stamped/delivered_by_driver_uid': DRIVER2, 'orders/o_stamped/delivered_at': NOW }));
  await ok('a non-dispatcher CAN write a sibling leaf while the stamp is preserved unchanged',
    driver.ref('orders/o_stamped/delivered_at').set(NOW));
  await ok('a dispatcher MAY correct an existing stamp', disp.ref('orders/o_stamped/delivered_by_driver_uid').set(DRIVER2));
  await ok('a dispatcher MAY clear an existing stamp', disp.ref('orders/o_stamped/delivered_by_driver_uid').set(null));

  // ============ P1-4: a customer-token-with-dispatcher-uid cannot DELETE or modify the stamp ============
  // (codex r2 P1-4: delete skips the leaf .validate; closed by customer-exclusion on .write + the order .validate)
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_custdel', driver: DRIVER, status: 'delivered', stamp: DRIVER }));
  await no('P1-4: a customer-token-with-dispatcher-uid cannot DELETE the stamp', custDisp.ref('orders/o_custdel/delivered_by_driver_uid').set(null));
  await no('P1-4: a customer-token-with-dispatcher-uid cannot MODIFY the stamp', custDisp.ref('orders/o_custdel/delivered_by_driver_uid').set(DRIVER2));
  await env.withSecurityRulesDisabled(async (ctx) => {
    assert.strictEqual((await ctx.database().ref('orders/o_custdel/delivered_by_driver_uid').get()).val(), DRIVER, 'stamp survived the customer-dispatcher attempts');
  });
  console.log(`  ok ${++n} P1-4: the stamp survived a customer-token-with-dispatcher-uid delete + modify`);

  // ============ P2-7: reassignment BEFORE completion — the original (now-unassigned) driver cannot stamp ============
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_reassigned', driver: DRIVER2 }));   // task now assigned to DRIVER2
  await no('P2-7: a driver no longer assigned (reassigned before completion) cannot complete/stamp',
    driver.ref().update({ 'orders/o_reassigned/status': 'delivered', 'orders/o_reassigned/delivered_at': NOW, 'orders/o_reassigned/delivered_by_driver_uid': DRIVER }));

  // ============ MIXED-VERSION (old client that does not stamp) still completes ============
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_oldclient', driver: DRIVER }));
  await ok('mixed-version: a pre-2.5.0 completion (status+delivered_at, NO stamp) is NOT blocked',
    driver.ref().update({ 'orders/o_oldclient/status': 'delivered', 'orders/o_oldclient/delivered_at': NOW }));

  // ============ REAL completion → reassignment → cancellation ============
  await env.withSecurityRulesDisabled((ctx) => seedOrder(ctx, { oid: 'o_flow', driver: DRIVER }));
  await ok('flow 1/3: assigned driver completes (real writer) — stamp lands', driver.ref().update(await completionBatch(DRIVER, 'o_flow')));
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref('tasks/o_flow_delivery/assigned_driver_id').set(DRIVER2); });   // dispatcher reassigns
  await no('flow 2/3: the newly-assigned driver cannot re-stamp an already-delivered order (write-once holds across reassignment)',
    driver2.ref().update({ 'orders/o_flow/status': 'delivered', 'orders/o_flow/delivered_by_driver_uid': DRIVER2 }));
  await ok('flow 3/3: a dispatcher cancels the delivered order and the stamp is preserved', disp.ref('orders/o_flow/status').set('cancelled'));
  await env.withSecurityRulesDisabled(async (ctx) => {
    assert.strictEqual((await ctx.database().ref('orders/o_flow/delivered_by_driver_uid').get()).val(), DRIVER, 'stamp lost across cancel');
  });
  console.log(`  ok ${++n} the stamp survived reassignment + cancellation`);

  // ============ /driver_cash READS ============
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(`driver_cash/${DRIVER}/shift1/cuadre`).set({ cash_owed: 370, cash_order_count: 1, closed_at: 1 });
    await ctx.database().ref(`driver_cash/${DRIVER2}/shift9/cuadre`).set({ cash_owed: 50, cash_order_count: 1, closed_at: 1 });
  });
  await ok('dispatcher reads the /driver_cash PARENT', disp.ref('driver_cash').get());
  await ok('dispatcher reads any driver child', disp.ref(`driver_cash/${DRIVER}`).get());
  await ok('a driver reads its OWN cuadre child', driver.ref(`driver_cash/${DRIVER}`).get());
  await no('a driver CANNOT read the /driver_cash parent', driver.ref('driver_cash').get());
  await no('a driver CANNOT read ANOTHER driver\'s child', driver.ref(`driver_cash/${DRIVER2}`).get());
  await no('a customer CANNOT read the parent', customer.ref('driver_cash').get());
  await no('a customer-token-with-dispatcher-uid CANNOT read a child (absolute customer exclusion)', custDisp.ref(`driver_cash/${DRIVER}`).get());

  // ============ cuadre field validates (new provisional leaves) ============
  await ok('owner driver writes a provisional cuadre with the new fields',
    driver.ref(`driver_cash/${DRIVER}/shift2/cuadre`).set({ cash_owed: 200, cash_order_count: 1, closed_at: 2, provisional: true, legacy_provisional_count: 1, unresolved_count: 0, close_op_id: 'op-abc' }));
  await no('a non-number cash_owed is rejected by validate', driver.ref(`driver_cash/${DRIVER}/shift3/cuadre`).set({ cash_owed: 'x', cash_order_count: 1, closed_at: 3 }));
  await no('a non-boolean provisional is rejected by validate', driver.ref(`driver_cash/${DRIVER}/shift4/cuadre`).set({ cash_owed: 1, cash_order_count: 1, closed_at: 4, provisional: 'yes' }));

  // ============ cuadre write boundary: leaf-only owner write + ancestor-delete protection ============
  // The owner writes ONLY their own cuadre leaf (recordCuadre). No ancestor grant exists, so the owner cannot
  // delete the $shift_id or $driver_id parent (which would take out other shifts' receipts).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref(`driver_cash/${DRIVER}/shiftA/cuadre`).set({ cash_owed: 50, cash_order_count: 1, closed_at: 7 });
  });
  await ok('owner MAY overwrite their own ordinary cuadre leaf (recordCuadre retry)',
    driver.ref(`driver_cash/${DRIVER}/shiftA/cuadre`).set({ cash_owed: 60, cash_order_count: 1, closed_at: 8 }));
  await no('owner cannot delete the $shift_id ANCESTOR (no ancestor write grant)',
    driver.ref(`driver_cash/${DRIVER}/shiftA`).set(null));
  await no('owner cannot delete the $driver_id ANCESTOR',
    driver.ref(`driver_cash/${DRIVER}`).set(null));

  await env.cleanup();
  console.log(`\ndriver-cuadre-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-cuadre-rules(emulator) FAILED:', e && e.stack || e); process.exit(1); });
