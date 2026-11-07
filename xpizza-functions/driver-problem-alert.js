'use strict';
// DRIVER F (PLAN-driver-server-F-problema r2, Codex r3 APPROVE) — «Problema con este pedido»: a driver's create-only report at
// driver_problems/{oid}/{pid} (rules-validated at write time) becomes ONE keyed dispatcher alert. Record + alert ONLY: no order
// or task state is touched — dispatch decides («el pedido no cambia solo»).
//   • the STORED shape is re-checked (Admin reads what landed); never the clock (`at` was `now` at write time) and never the
//     task's later state — a report the rules accepted is never discarded because the task moved on;
//   • enrichment (display number, restaurant, driver name) is best effort: a failed read drops the field, never the alert;
//   • the alert write is a cold-null-safe create-only transaction, and its errors PROPAGATE so the trigger's retry:true re-runs
//     it (unlike the catch-and-resolve alerts elsewhere). Dismiss is remove(): a rare replay after a dismiss re-creates the
//     alert — accepted (owner simplicity rule), no acknowledgment machinery.
const REASONS = ['waiting_restaurant', 'not_ready_incomplete', 'customer_no_answer', 'address_not_found', 'restaurant_closed', 'other'];
const NOTE_MAX = 200;

function validReport(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (!REASONS.includes(rec.reason)) return false;
  if (typeof rec.by !== 'string' || rec.by === '') return false;
  if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return false;
  if (rec.note !== undefined && (typeof rec.note !== 'string' || rec.note.length > NOTE_MAX)) return false;
  return true;
}

const alertKey = (oid, pid) => `driver_problem_${oid}_${pid}`;

async function bestEffort(read, log, what) {
  try { return await read(); } catch (e) { log.warn(`driver_problem: ${what} read failed — alert written without it`, e && e.message); return null; }
}

// rec: the stored report. deps.resolveDriverName(db, uid) is the shared name cascade (driver-attribution.js).
async function alertOnDriverProblem(db, { oid, pid, rec, now }, { resolveDriverName, log = console } = {}) {
  if (!validReport(rec)) { log.warn(`driver_problem: malformed report ${oid}/${pid} — no alert`); return { written: false, reason: 'malformed' }; }
  const order = await bestEffort(async () => (await db.ref(`orders/${oid}`).once('value')).val(), log, 'order');
  const name = resolveDriverName ? await bestEffort(() => resolveDriverName(db, rec.by), log, 'driver name') : null;
  const alert = { type: 'driver_problem', order_id: oid, driver_uid: rec.by, reason: rec.reason, reported_at: rec.at, created_at: now };
  if (order && order.display_number !== undefined && order.display_number !== null) alert.display_number = order.display_number;
  if (order && typeof order.restaurant_id === 'string') alert.restaurant_id = order.restaurant_id;
  if (typeof name === 'string' && name) alert.driver_name = name;
  if (typeof rec.note === 'string' && rec.note) alert.note = rec.note;
  // cold-null safe: a speculative null proposes the record; a real existing value aborts (never overwritten). Errors propagate.
  const r = await db.ref(`dispatcher_alerts/${alertKey(oid, pid)}`).transaction((cur) => (cur == null ? alert : undefined));
  return { written: !!(r && r.committed), alert };
}

module.exports = { alertOnDriverProblem, validReport, alertKey, REASONS, NOTE_MAX };
