'use strict';
// BUILD-stacked-seq-server r5 T8 — D11 (a) RULED: the cancel promotion, flag ON only (cancel-order-core's cleanupTasksAndDriver
// keeps today's single update() verbatim when the flag is OFF).
//   1. the task cancels go FIRST, in their own update(), unconditionally — a promotion failure can never suppress them;
//   2. survivor lookup (bounded; any failure → none): the driver's EXACTLY ONE other accepted / in-progress delivery, on this
//      driver, whose pickup is completed and whose ORDER is non-terminal;
//   3. ONE transaction on drivers/{uid}, aborting unless current_task_id still names a leg of THIS order: survivor →
//      current_task_id = its delivery, status unchanged (the driver is still loaded); none → today's end state;
//   4. a failure before that commits → today's end state through the same pointer-guarded transaction; if that fails too, log
//      and return (the callers already catch cleanup failures; step 1 has landed). After a commit, nothing more.
// D13 (ACCEPTED residual): two of one driver's orders cancelled within the same seconds can leave the pointer on the second,
// cancelled order — its tracker is already terminal, the driver app shows the cancel banner, the next pointer write corrects it.
const { bounded } = require('./bounded');

const SURVIVOR_READ_MS = 3000;
const TERMINAL_ORDER = new Set(['delivered', 'completed', 'cancelled', 'refund_pending']);
const TODAY_AVAILABLE = ['assigned', 'at_restaurant', 'en_route_delivery'];   // today's cleanup allowlist

async function readSeqFlagSafe(db) {
  try { return (await db.ref('config/stack_sequencing_enabled').once('value')).val() === true; } catch (_) { return false; }
}

async function findSurvivor(db, driverId, orderId) {
  const end = Date.now() + SURVIVOR_READ_MS;
  const tasks = (await bounded(db.ref('tasks').once('value'), end - Date.now())).val() || {};
  const others = Object.entries(tasks).filter(([id, t]) => t && id.endsWith('_delivery') && t.assigned_driver_id === driverId
    && t.order_id && t.order_id !== orderId && (t.status === 'accepted' || t.status === 'in_progress'));
  if (others.length !== 1) return null;
  const [survivorId, t] = others[0];
  const pk = tasks[`${t.order_id}_pickup`];
  if (!pk || pk.status !== 'completed' || pk.assigned_driver_id !== driverId) return null;
  const st = (await bounded(db.ref(`orders/${t.order_id}/status`).once('value'), end - Date.now())).val();
  return typeof st === 'string' && !TERMINAL_ORDER.has(st) ? survivorId : null;
}

async function cleanupWithPromotion(db, orderId) {
  const pickupTaskId = `${orderId}_pickup`; const deliveryTaskId = `${orderId}_delivery`;
  const pickup = (await db.ref(`tasks/${pickupTaskId}`).once('value')).val();
  const delivery = (await db.ref(`tasks/${deliveryTaskId}`).once('value')).val();
  const taskUpdates = {};
  if (pickup && pickup.status !== 'cancelled') taskUpdates[`tasks/${pickupTaskId}/status`] = 'cancelled';
  if (delivery && delivery.status !== 'cancelled') taskUpdates[`tasks/${deliveryTaskId}/status`] = 'cancelled';
  if (Object.keys(taskUpdates).length) await db.ref().update(taskUpdates);   // 1. first, unconditionally
  const driverId = pickup && pickup.assigned_driver_id;
  if (!driverId) return;
  const ours = (cur) => !!cur && (cur.current_task_id === pickupTaskId || cur.current_task_id === deliveryTaskId);
  const pointerTxn = (survivor) => db.ref(`drivers/${driverId}`).transaction((cur) => {
    if (cur === null) return null;   // null-first-safe
    if (!ours(cur)) return undefined;   // the pointer moved on: not ours to write
    if (survivor) return { ...cur, current_task_id: survivor };
    const next = { ...cur }; delete next.current_task_id;
    if (TODAY_AVAILABLE.includes(cur.status)) next.status = 'available';
    return next;
  });
  let survivor = null;
  try { survivor = await findSurvivor(db, driverId, orderId); }
  catch (e) { console.warn(`stackseq cancel: survivor lookup failed for ${orderId} (${(e && e.message) || e}) — today's end state`); }
  if (survivor) {
    try { await pointerTxn(survivor); return; }
    catch (e) { console.warn(`stackseq cancel: promotion failed for ${orderId} (${(e && e.message) || e}) — today's end state`); }
  }
  try { await pointerTxn(null); }
  catch (e) { console.error(`stackseq cancel: driver cleanup failed for ${orderId} (${(e && e.message) || e})`); }
}

module.exports = { cleanupWithPromotion, findSurvivor, readSeqFlagSafe };
