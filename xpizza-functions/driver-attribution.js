'use strict';

const { REALTIME_TERMINAL_STATUSES } = require('./tasks-retention');   // {delivered,completed} — the edges that earn attribution (cancelled never delivered)

/**
 * Durable driver→order delivery attribution (write-side) + the shared driver-name resolver.
 *
 * Extracted from index.js so the LOAD-BEARING logic — the driver-name cascade and the terminal-edge attribution
 * + delete — is unit-testable WITHOUT the emulator (matches materialize.js / status-mirror.js / tasks-retention.js).
 * `db` is the firebase-admin RTDB handle (or a compatible fake): db.ref(path).once('value'), .update(obj), .set,
 * and .transaction(fn) (used for the first-writer-wins attribution CAS).
 *
 * The attribution write and the task delete are TWO SEPARATE writes, deliberately (NOT one atomic multi-path
 * update): the attribution must be a commit-time CAS (first-writer-wins on the delivered_by_uid leaf), which cannot
 * live inside a multi-path update. The delete stays its own unconditional, atomic multi-path null-update and is
 * load-bearing (it must never regress); attribution is additive + best-effort on top.
 *
 * Two callers in index.js, ONE source of truth for the name cascade:
 *   - sendOrderStatusNotifications (out_for_delivery) → resolveDriverName (customer WhatsApp + tracker mirror)
 *   - deleteTasksOnOrderTerminal (delivered/completed edge) → captureDeliveryAttributionAndDelete
 *
 * Field CONTRACT (the dashboard read-side depends on the exact names): orders/<id>/delivered_by_uid
 * (durable, queryable join key) + orders/<id>/delivered_by_name (point-in-time display snapshot).
 *
 * TERMINAL-INSTANT IDENTITY (known limitation, non-money): attribution is the driver assigned on the delivery task
 * AT THE MOMENT THIS HANDLER READS IT — not a snapshot taken atomically with the status→terminal transition. A
 * dispatch reassignment that lands on the still-present task in the sub-second window before the async handler runs
 * is captured as the delivering driver (then locked first-writer-wins). This mis-attributes only under an
 * operationally-weird action (reassigning an already-delivered order that fast) and never affects money safety.
 */

// TODO(brand-agnostic): DRIVER_DISPLAY_NAMES is hardwired driver UIDs — move to config (per-merchant/driver
// record) as a separate brand-agnostic-debt slice. Kept byte-identical here (extraction only, no cleanup).
const DRIVER_DISPLAY_NAMES = {
  'HUQ4nOdvNvQcbxoqyYinp8wAC7f2': 'Xavier',
  'xaHcwaRND1V63w8tpXi5VZ7n9P72': 'Hermez',
};

// resolveDriverName(db, driverId) → friendly name string, or null.
// Cascade (UNCHANGED from the old inline out_for_delivery logic, so both callers stay in lock-step):
//   1. DRIVER_DISPLAY_NAMES[driverId]      — hardcoded canonical first names (source of truth for known drivers)
//   2. drivers/<driverId>/display_name     — string, if a dispatcher set one
//   3. drivers/<driverId>/name             — raw username, capitalized (first upper, rest lower)
//   else null (no driver, or all sources empty / non-string)
async function resolveDriverName(db, driverId) {
  if (!driverId) return null;
  if (DRIVER_DISPLAY_NAMES[driverId]) return DRIVER_DISPLAY_NAMES[driverId];
  const dn = (await db.ref(`drivers/${driverId}/display_name`).once('value')).val();
  if (dn && typeof dn === 'string') return dn;
  const raw = (await db.ref(`drivers/${driverId}/name`).once('value')).val();
  if (raw && typeof raw === 'string') return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return null;
}

// writeDeliveryAttribution(db, orderId, driverId) — stamp the durable attribution FIRST-WRITER-WINS.
// Shared by BOTH task-deleters (the real-time terminal trigger and the retention-sweep backstop) so attribution
// survives whichever deletes the task; without the backstop, a real-time trigger that failed all its retries would
// let the 6-hourly sweep delete the task — assigned_driver_id's only home — and lose attribution for good.
//
// COMMIT-TIME no-clobber via a CAS on the delivered_by_uid leaf: write only if still ABSENT. This is the actual
// guarantee (a pre-commit read cannot provide it) — real-time and sweep can't overwrite each other, overlapping
// invocations converge, and a POST-terminal reassignment (dispatch reassign CASes the driver without checking
// order status, so the "terminal freeze" is not enforced upstream) can never flip an already-captured value. The
// name is written only by the invocation that WON the uid claim, so uid and name always agree.
async function writeDeliveryAttribution(db, orderId, driverId) {
  if (!driverId) return { written: false };
  const res = await db.ref(`orders/${orderId}/delivered_by_uid`).transaction((cur) => (cur === null ? driverId : undefined));
  if (!(res.committed && res.snapshot.val() === driverId)) return { written: false };   // someone already attributed → no clobber
  let name = null;
  try { name = await resolveDriverName(db, driverId); } catch (e) { /* name best-effort — the uid is the durable key */ }
  name = (typeof name === 'string' && name.trim()) ? name.trim() : null;   // durable store: trim; never a whitespace-only name
  if (name) await db.ref(`orders/${orderId}/delivered_by_name`).set(name);
  return { written: true, name };
}

// shouldBackstopAttribution(freshOrder, taskId) — the retention sweep's per-candidate decision: attempt attribution
// for a delivery task ONLY when its order actually reached a delivered/completed edge (never cancelled) and nothing
// has stamped it yet (don't even attempt when a real-time capture already won). The delete itself is unconditional
// (a terminal order's task always goes); this only gates the additive attribution attempt. The CAS in
// writeDeliveryAttribution is the true no-clobber; this is a cheap pre-filter.
function shouldBackstopAttribution(freshOrder, taskId) {
  return !!(freshOrder && String(taskId).endsWith('_delivery') &&
    REALTIME_TERMINAL_STATUSES.has(freshOrder.status) && !freshOrder.delivered_by_uid);
}

// captureDeliveryAttributionAndDelete(db, orderId) — the terminal-edge (delivered/completed) handler body. The
// delivery task is still present at this instant and this trigger is the only DELETER on this edge (delivered/
// completed have no other task reader/deleter — cancelled is excluded), so the read+delete don't race another
// handler. It is NOT immune to a dispatch REASSIGNMENT writing the task in the window before this async handler
// runs (see the terminal-instant-identity note in the header) — that's a rare, non-money mis-attribution.
//
// The DELETE is LOAD-BEARING and UNCONDITIONAL: the whole attribution step (task read + CAS + name) is wrapped so
// that ANY failure in it — a task-read throw, a CAS failure — skips attribution but STILL deletes both task legs.
// Attribution is additive and best-effort; the delete must never regress. Retry-safe (retry:true): the CAS is
// idempotent (already-set → no-op) and the delete is an idempotent null-update, so a re-run converges.
async function captureDeliveryAttributionAndDelete(db, orderId) {
  try {
    const delivery = (await db.ref(`tasks/${orderId}_delivery`).once('value')).val();
    await writeDeliveryAttribution(db, orderId, delivery && delivery.assigned_driver_id);
  } catch (e) { /* attribution best-effort — NEVER block or delay the delete below */ }
  await db.ref().update({ [`tasks/${orderId}_pickup`]: null, [`tasks/${orderId}_delivery`]: null });   // unconditional
}

module.exports = { DRIVER_DISPLAY_NAMES, resolveDriverName, writeDeliveryAttribution, shouldBackstopAttribution, captureDeliveryAttributionAndDelete };
