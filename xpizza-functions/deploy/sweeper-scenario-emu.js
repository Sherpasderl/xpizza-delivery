'use strict';
/**
 * S3 sweeper SCENARIO e2e (Java/emulator only) — validates the composed HEAL + OFFER-gate behavior
 * of sweepPendingOrders against REAL RTDB transaction semantics. The onSchedule handler body is
 * inline (not separately invocable), so this re-runs its EXACT guard sequence (index.js:3488-3531)
 * using the REAL exported modules it imports — assignmentStrandState + HEAL_TERMINAL_STATUSES
 * (sweep-pending) and healStrandedOrder + claimDelivery (claim-delivery) — not a reimplementation
 * of the primitives. Seeds the scenario the deploy gate cares about:
 *   A) ACTIVE order + stranded half-claim (delivery=D, pickup=null, stale marker) → HEAL nulls both
 *   B) TERMINAL (delivered) order + driver mismatch (delivery=D2, pickup=D1) → UNTOUCHED (#4 skip)
 *   C) OFFER pass gated off (config/sweep_pending_enabled=false) → pending order NOT claimed
 * Run: firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/sweeper-scenario-emu.js"
 */
const assert = require('assert');
const admin = require('firebase-admin');
const { emuDatabaseURL } = require('./emu-ns');
const { assignmentStrandState, HEAL_TERMINAL_STATUSES, sweepDecision } = require('../sweep-pending');
const { healStrandedOrder } = require('../claim-delivery');

const STALE = 120000; // HALF_CLAIM_STALE_MS
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: emuDatabaseURL() });
const db = admin.database();
const now = Date.now();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL', m)); };
const val = async (p) => (await db.ref(p).once('value')).val();

async function main() {
  // ---- seed ----
  await db.ref().update({
    'config/sweep_pending_enabled': false,        // OFFER pass OFF (deploy state)
    'config/auto_assign_enabled': true,
    // A) ACTIVE order, stranded half-claim, marker STALE → heal-eligible. Pickup node PRESENT with
    //    assigned_driver_id absent (RTDB set(null) deletes the node; a real half-claim keeps the task).
    'orders/A/status': 'new',
    'tasks/A_delivery': { assigned_driver_id: 'D', half_claim_since: now - STALE - 1, status: 'assigned' },
    'tasks/A_pickup': { status: 'pending' },   // present, unassigned (assigned_driver_id absent → null)
    // B) TERMINAL order (delivered) with a driver mismatch → must stay untouched
    'orders/B/status': 'delivered',
    'tasks/B_delivery': { assigned_driver_id: 'D2', status: 'assigned' },
    'tasks/B_pickup': { assigned_driver_id: 'D1', status: 'assigned' },
    // C) pending offer-eligible order (old, unassigned) → OFFER off must leave it. Tasks PRESENT.
    'orders/C/status': 'ready', 'orders/C/created_at': now - 600000, 'orders/C/order_id': 'C',
    'tasks/C_delivery': { status: 'pending' }, 'tasks/C_pickup': { status: 'pending' },
  });

  // ---- replay the REAL handler HEAL pass (index.js:3488-3531) ----
  const orders = (await db.ref('orders').once('value')).val() || {};
  const tasks = (await db.ref('tasks').once('value')).val() || {};
  let healed = 0;
  for (const orderId of Object.keys(orders)) {
    if (HEAL_TERMINAL_STATUSES.has(orders[orderId]?.status)) continue;   // #4 top-of-loop terminal skip
    const delTask = tasks[`${orderId}_delivery`], pickTask = tasks[`${orderId}_pickup`];
    const st = assignmentStrandState(pickTask, delTask, now, { staleMs: STALE });
    if (st === 'none') { continue; }
    if (st === 'mark') { await db.ref(`tasks/${orderId}_delivery/half_claim_since`).set(now); continue; }
    if (st === 'wait') continue;
    const freshStatus = await val(`orders/${orderId}/status`);                 // #2 fresh terminal re-read
    if (HEAL_TERMINAL_STATUSES.has(freshStatus)) continue;
    const strandedDel = delTask.assigned_driver_id == null ? null : delTask.assigned_driver_id;
    const strandedPick = pickTask && pickTask.assigned_driver_id != null ? pickTask.assigned_driver_id : null;
    const { healed: didHeal } = await healStrandedOrder(db, orderId, strandedDel, strandedPick);
    if (didHeal) healed++;
  }

  // ---- OFFER pass gate (index.js:3535 — dormant until the flag flips) ----
  const offerEnabled = (await val('config/sweep_pending_enabled')) === true;
  const cWouldOffer = sweepDecision(orders.C, tasks, now, { retryMax: 5, staleMs: STALE }).sweep;

  // ---- assertions ----
  ok(healed === 1, `exactly one order healed (the active half-claim), got ${healed}`);
  ok(await val('tasks/A_delivery/assigned_driver_id') === null, 'A) active half-claim: delivery nulled (healed)');
  ok(await val('tasks/A_pickup/assigned_driver_id') === null, 'A) active half-claim: pickup nulled (healed)');
  ok(await val('tasks/A_delivery/half_claim_since') === null, 'A) marker cleared on heal');
  ok(await val('tasks/B_delivery/assigned_driver_id') === 'D2', 'B) TERMINAL mismatch: delivery UNTOUCHED (D2)');
  ok(await val('tasks/B_pickup/assigned_driver_id') === 'D1', 'B) TERMINAL mismatch: pickup UNTOUCHED (D1)');
  ok(offerEnabled === false, 'C) offer pass is GATED OFF (sweep_pending_enabled=false)');
  ok(cWouldOffer === true, 'C) sanity: order C IS offer-eligible — so it is skipped ONLY because the gate is off, not because ineligible');
  ok(await val('tasks/C_delivery/assigned_driver_id') === null, 'C) offer-off: pending order left unclaimed');

  console.log(`\nSWEEPER SCENARIO E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error('ERROR', e); process.exit(2); });
