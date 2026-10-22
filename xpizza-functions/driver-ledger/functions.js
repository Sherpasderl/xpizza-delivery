'use strict';
// S8 — the three Cloud Functions of the driver payable ledger. index.js re-exports them on ONE line (inverse-fold
// invariant: tools/driver-ledger-inverse.js). Deploy selectively: repairDriverLedger, closeDriverPayWeeks, markDriverWeekPaid.
//   repairDriverLedger   (schedule, every 30 min) — the ONLY accrual writer: a bounded delivered_at sweep + unresolved re-check
//   closeDriverPayWeeks  (schedule, Mon 00:10 America/Tegucigalpa) — freezes last week's statements (immutable)
//   markDriverWeekPaid   (callable) — «Marcar pagado»: FULL settlement, reference + date only, compare-and-set
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const S = require('./ledger-store');
const { assertCanManageDriverPay } = require('./pay-gate');

exports.repairDriverLedger = onSchedule(
  { schedule: 'every 30 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB', maxInstances: 1, concurrency: 1, retryCount: 0 },
  async () => {
    try { const r = await S.repairSweep(getDatabase(), Date.now()); console.log('driver_ledger_sweep', JSON.stringify(r)); }
    catch (e) { console.error('driver_ledger_sweep_failed', (e && e.message) || String(e)); }
  },
);

exports.closeDriverPayWeeks = onSchedule(
  { schedule: '10 0 * * 1', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB', maxInstances: 1, concurrency: 1, retryCount: 0 },
  async () => {
    try {
      const db = getDatabase(); const now = Date.now();
      await S.repairSweep(db, now);                       // accrue everything delivered up to the boundary first
      const r = await S.closeWeeks(db, now); console.log('driver_ledger_close', JSON.stringify(r));
    } catch (e) { console.error('driver_ledger_close_failed', (e && e.message) || String(e)); }
  },
);

exports.markDriverWeekPaid = onCall({ region: 'us-central1', maxInstances: 3 }, async (request) => {
  const db = getDatabase();
  const actor = await assertCanManageDriverPay(request, { db, auth: getAuth(), HttpsError });
  const d = request.data || {};
  const r = await S.markPaid(db, { uid: d.driver_uid, week: d.week, amount_cents: d.amount_cents, reference: d.reference, paid_on: d.paid_on, op_key: d.op_key, actor }, Date.now());
  if (!r.ok) throw new HttpsError(r.reason === 'already_paid' ? 'already-exists' : 'failed-precondition', r.reason, r.by ? { by: r.by, at: r.at } : undefined);
  return { ok: true, idempotent: !!r.idempotent, payment: r.payment };
});
