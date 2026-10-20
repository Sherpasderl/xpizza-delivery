'use strict';
// TRACKER FIXES (PLAN-tracker-fixes r2.5 §1) — recomputeOrderTracker(db, orderId, deps): the ONE writer of an order's public
// tracker state. Per-order sequence acquired BEFORE any truth read; current truth only (never an event payload); one transaction
// on order_tracking/{token} (mx-txn); then the seq-valued claims index (claims-txn), written only if the node still holds this s.
// deps: { secret (tag HMAC key), now(), hold(name, ctx) (test seam, default tracking/hold.js — inert), resolveName(db, uid) (test override; default: driverNameFrom on the owner record already read) }.
// Every read is Admin once('value') on the server; a failed read THROWS (the caller's trigger is retry:true).
const { deriveOrderTracker, legsOwner } = require('./derive');
const { makeNodeUpdater } = require('./mx-txn');
const { grantUpdater, tombstoneUpdater, ownerHintUpdater } = require('./claims-txn');
const { tagOf } = require('./tag');
const { driverNameFrom } = require('./driver-name');

const { trackerHold } = require('./hold');
async function val(db, p) { return (await db.ref(p).once('value')).val(); }

async function recomputeOrderTracker(db, orderId, deps = {}) {
  const hold = deps.hold || trackerHold;   // the test seam (inert unless a test installs globalThis.__trackerHold)
  const now = deps.now || Date.now;
  const secret = deps.secret || process.env.MAKE_SECRET;
  if (!secret) throw new Error('recomputeOrderTracker: no tag secret configured');

  // 1. sequence BEFORE truth
  const seqTx = await db.ref(`tracker_seq/${orderId}`).transaction((c) => (typeof c === 'number' ? c : 0) + 1);
  const s = seqTx.snapshot.val();
  await hold('seq', { orderId, s });

  // 2. current truth
  const order = await val(db, `orders/${orderId}`);
  await hold('read:order', { orderId, s });
  if (!order) return { s, skipped: 'no_order' };
  const token = order.tracking_token;
  if (!token) return { s, skipped: 'no_token' };
  const pickupId = order.pickup_task_id || `${orderId}_pickup`, deliveryId = order.delivery_task_id || `${orderId}_delivery`;
  const pickup = await val(db, `tasks/${pickupId}`);
  const delivery = await val(db, `tasks/${deliveryId}`);
  await hold('read:tasks', { orderId, s });
  const O = legsOwner(pickup, delivery);
  let owner = null, ownerTasks = {}, driverRecord = null;
  if (O) {
    driverRecord = await val(db, `drivers/${O}`);
    const d = driverRecord || {};
    owner = { uid: O, active: d.active, current_shift_id: d.current_shift_id || null, current_task_id: d.current_task_id || null };
    ownerTasks = (await db.ref('tasks').orderByChild('assigned_driver_id').equalTo(O).once('value')).val() || {};
    await hold('read:owner', { orderId, s, O });
  }
  const derived = deriveOrderTracker({ orderId, order, pickup: pickup && { ...pickup, id: pickupId }, delivery: delivery && { ...delivery, id: deliveryId }, owner, ownerTasks });
  const claims = derived.mode === 'live' || derived.mode === 'waiting';
  // (C, r2.10.1) the name from the ONE drivers/{O} read above (driverNameFrom == resolveDriverName, tracking/driver-name.test.js);
  // a test may still inject deps.resolveName
  const name = !O ? null : (deps.resolveName ? await deps.resolveName(db, O) : driverNameFrom(O, driverRecord));
  const pub = { mode: derived.mode, owner_tag: claims ? tagOf(secret, O) : 'none', shift_id: claims ? derived.shift_id : null };
  const smp = { owner_tag: O ? tagOf(secret, O) : 'none', shift_id: O ? (owner.current_shift_id || null) : null };

  // 3. the node transaction
  await hold('node-tx', { orderId, s, mode: derived.mode });
  const tx = await db.ref(`order_tracking/${token}`).transaction(makeNodeUpdater({ s, derived: pub, smp, name, order }));
  if (!tx.committed) return { s, mode: derived.mode, committed: false };

  // 4. the claims hint index — only while this s is still the node's committed seq
  await hold('claims', { orderId, s });
  const stillMine = (await val(db, `order_tracking/${token}/mx/seq`)) === s;
  if (stillMine) {
    const at = now();
    const hint = await val(db, `tracker_claims_owner/${orderId}`);
    const claimOwner = claims ? O : null;
    await hold('claims:grant', { orderId, s, owner: claimOwner });   // AFTER stillMine, BEFORE the grant (codex r2.9 P1-1 window)
    if (claimOwner) await db.ref(`tracker_claims/${claimOwner}/${orderId}`).transaction(grantUpdater(s, at));
    await hold('claims:post-grant', { orderId, s, owner: claimOwner });   // test seam: AFTER the acknowledged grant (crash-after-grant schedules)
    const stale = new Set([hint && hint.uid, O].filter((u) => u && u !== claimOwner));
    for (const u of stale) await db.ref(`tracker_claims/${u}/${orderId}`).transaction(tombstoneUpdater(s, at));
    await db.ref(`tracker_claims_owner/${orderId}`).transaction(ownerHintUpdater(s, claimOwner, at));
  }
  return { s, mode: derived.mode, committed: true, claimOwner: claims ? O : null, owner: O, token };
}

module.exports = { recomputeOrderTracker };
