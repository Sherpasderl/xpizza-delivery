'use strict';

/**
 * retentionSweepTasks execute body, extracted so the delete + the attribution backstop are executably testable
 * (index.js's onSchedule trigger is a thin wrapper that logs the result). RTDB egress Stage 1 — /tasks retention.
 *
 * Reclaims tasks the real-time deleteTasksOnOrderTerminal doesn't: CANCELLED orders (excluded there to avoid the
 * notifyDriverOnCancellation race) + ORPHANS + a drain of accumulated bloat. DRY-RUN unless
 * config/retention/tasks_mode==='execute'. This is the SECOND (and last) deleter of a delivery task, so it also
 * runs the attribution backstop: if the real-time trigger never captured, preserve driver→order attribution
 * before nuking assigned_driver_id's only home.
 */

const { tasksToDelete, confirmTaskDelete } = require('./tasks-retention');
const { shouldBackstopAttribution, writeDeliveryAttribution } = require('./driver-attribution');

// runRetentionSweep(db, { healTerminalStatuses }) → { mode, candidates, total, confirmed?, skipped? }.
// healTerminalStatuses is injected (HEAL_TERMINAL_STATUSES — ALL terminal incl. cancelled) so this module stays
// decoupled + testable.
async function runRetentionSweep(db, { healTerminalStatuses }) {
  // Read /tasks BEFORE /orders (sequential, NOT Promise.all) as defense-in-depth: a task is written atomically
  // WITH its order, so any task in this snapshot has its order committed before this read → the LATER /orders read
  // includes it. (The per-candidate fresh re-read below is the primary, obviously-correct guard.)
  const tasks = (await db.ref('tasks').once('value')).val() || {};
  const orders = (await db.ref('orders').once('value')).val() || {};
  const mode = (await db.ref('config/retention/tasks_mode').once('value')).val();
  const toDelete = tasksToDelete(orders, tasks, healTerminalStatuses);   // batch CANDIDATES
  const total = Object.keys(tasks).length;
  if (mode !== 'execute') return { mode: 'dry_run', candidates: toDelete, total };
  if (!toDelete.length) return { mode: 'execute', confirmed: 0, skipped: 0, candidates: [], total };

  // The batch /orders+/tasks reads are NOT a consistent snapshot. Before deleting each candidate, re-read its order
  // FRESH and delete ONLY if still a target (absent → orphan; terminal → done); a fresh non-terminal order = a
  // live/just-created order raced by the batch → SKIP. Never delete a live order's task (the impossible regression).
  const updates = {};
  let confirmed = 0, skipped = 0;
  for (const taskId of toDelete) {
    const orderId = (tasks[taskId] && tasks[taskId].order_id) || String(taskId).replace(/_(pickup|delivery)$/, '');
    const fresh = (await db.ref(`orders/${orderId}`).once('value')).val();
    if (!confirmTaskDelete(fresh, healTerminalStatuses)) { skipped++; continue; }   // fresh live/just-created → keep
    updates[`tasks/${taskId}`] = null; confirmed++;
    // Attribution BACKSTOP — ISOLATED per candidate: a read/CAS failure here must NEVER abort the accumulated batch
    // delete (unrelated candidates' deletes would be lost). delivered/completed only (shouldBackstopAttribution),
    // fresh per-candidate task read (post-reassignment driver == what a real-time capture would write), CAS
    // no-clobber (writeDeliveryAttribution). The delete stays unconditional.
    if (shouldBackstopAttribution(fresh, taskId)) {
      try {
        const freshTask = (await db.ref(`tasks/${taskId}`).once('value')).val();
        await writeDeliveryAttribution(db, orderId, freshTask && freshTask.assigned_driver_id);
      } catch (e) { console.warn(`runRetentionSweep: attribution backstop failed for ${orderId} — delete proceeds`, e && e.message); }
    }
  }
  if (confirmed) await db.ref().update(updates);   // batched multi-path null-update of the CONFIRMED deletes
  return { mode: 'execute', confirmed, skipped, candidates: toDelete, total };
}

module.exports = { runRetentionSweep };
