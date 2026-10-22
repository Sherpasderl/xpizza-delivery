'use strict';
// S8 — the Cloud Functions of the driver payable ledger. index.js re-exports them on ONE line (inverse-fold invariant:
// tools/driver-ledger-inverse.js). Deploy selectively: closeDriverPayWeeks, getDriverPayWeek, markDriverWeekPaid.
//   closeDriverPayWeeks  (schedule, every 30 min) — closes every finished week, oldest first, each by ONE create-if-absent
//                        transaction computed from /orders (ledger-store.js closeDue); a no-op until a week is due
//   getDriverPayWeek     (callable) — «Pagos»: a closed week as stored, or the open week derived from /orders (no write)
//   markDriverWeekPaid   (callable) — «Marcar pagado»: FULL settlement, reference + date only, compare-and-set
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const S = require('./ledger-store');
const { assertCanManageDriverPay } = require('./pay-gate');

exports.closeDriverPayWeeks = onSchedule(
  { schedule: 'every 30 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB', maxInstances: 1, concurrency: 1, retryCount: 0 },
  async () => {
    try { const r = await S.closeDue(getDatabase(), Date.now()); console.log('driver_ledger_close', JSON.stringify(r)); }
    catch (e) { console.error('driver_ledger_close_failed', (e && e.message) || String(e)); }
  },
);

exports.getDriverPayWeek = onCall({ region: 'us-central1', maxInstances: 3 }, async (request) => {
  const db = getDatabase();
  await assertCanManageDriverPay(request, { db, auth: getAuth(), HttpsError });
  const week = request.data && request.data.week;
  if (week != null && !/^W\d{4}-\d{2}-\d{2}$/.test(String(week))) throw new HttpsError('invalid-argument', 'bad_week');
  return S.previewWeek(db, week || null, Date.now());
});

exports.markDriverWeekPaid = onCall({ region: 'us-central1', maxInstances: 3 }, async (request) => {
  const db = getDatabase();
  const actor = await assertCanManageDriverPay(request, { db, auth: getAuth(), HttpsError });
  const d = request.data || {};
  const r = await S.markPaid(db, { uid: d.driver_uid, week: d.week, amount_cents: d.amount_cents, reference: d.reference, paid_on: d.paid_on, op_key: d.op_key, actor }, Date.now());
  if (!r.ok) throw new HttpsError(r.reason === 'already_paid' ? 'already-exists' : 'failed-precondition', r.reason, r.by ? { by: r.by, at: r.at } : undefined);
  return { ok: true, idempotent: !!r.idempotent, payment: r.payment };
});
