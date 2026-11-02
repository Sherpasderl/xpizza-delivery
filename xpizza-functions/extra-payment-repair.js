'use strict';
// Durable completion of a SECOND verified payment's alert (Codex r4). The webhook writes a small pending marker
// extra_payment_pending/{key} BEFORE it claims the record, and removes it in the SAME multi-path update that writes the alert
// and the order's review flag. A crash between the claim and that update leaves the marker; the endpoint may then dedupe every
// re-delivery without running the handler, so the five-minute sweep finishes the work here: for each marker (a bounded page of
// a tiny node) whose record is committed, it writes the alert + flag from the COMMITTED record and removes the marker in one
// update; a marker with no record is removed only after a grace longer than any delivery can take between its marker and its
// claim. Idempotent: every value written is derived from the committed record, so a re-run writes identical bytes.
const crypto = require('crypto');

const REPAIR_GRACE_MS = 10 * 60 * 1000;   // > the webhook function's timeout: a younger record-less marker may be mid-delivery
const REPAIR_LIMIT = 50;

const extraKey = (uuid) => crypto.createHash('sha256').update(String(uuid)).digest('hex');
const extraRecordPath = (attemptId, key) => `payment_attempts/${attemptId}/extra_payments/${key}`;
const pendingMarker = ({ attemptId, orderId, now }) => ({ attempt: attemptId, order: orderId, at: now });

// The ONE completion write (webhook and repair alike): alert + flag from the committed record, and the marker removed with them.
const extraCompletionUpdate = (key, rec, { orderId, attemptId }) => ({
  [`dispatcher_alerts/extra_payment_${key}`]: { type: 'payment_extra_payment_received', detail: { orderId, attemptId }, created_at: rec.at },
  [`orders/${orderId}/extra_payment_review`]: true,
  [`extra_payment_pending/${key}`]: null,
});

const SAFE_ID = /^[^./#$[\]\s]+$/;
async function repairPendingExtraPayments({ db, now, limit = REPAIR_LIMIT }) {
  const out = { completed: 0, removed: 0, kept: 0 };
  const snap = await db.ref('extra_payment_pending').orderByKey().limitToFirst(limit).once('value');
  const markers = (snap && snap.val()) || {};
  for (const [key, m] of Object.entries(markers)) {
    const attemptId = m && m.attempt; const orderId = m && m.order;
    const ids = typeof attemptId === 'string' && SAFE_ID.test(attemptId) && typeof orderId === 'string' && SAFE_ID.test(orderId);
    const rec = ids ? ((await db.ref(extraRecordPath(attemptId, key)).once('value')).val()) : null;
    if (rec && typeof rec.uuid === 'string' && extraKey(rec.uuid) === key && Number.isFinite(rec.at)) {
      await db.ref().update(extraCompletionUpdate(key, rec, { orderId, attemptId }));
      out.completed += 1;
    } else if (!rec && !(Number.isFinite(m && m.at) && now - m.at <= REPAIR_GRACE_MS)) {
      await db.ref(`extra_payment_pending/${key}`).remove();
      out.removed += 1;
    } else out.kept += 1;   // too young to judge, or a record that does not match its key (left for a person; never overwritten)
  }
  return out;
}

module.exports = { repairPendingExtraPayments, extraCompletionUpdate, extraKey, extraRecordPath, pendingMarker, REPAIR_GRACE_MS, REPAIR_LIMIT };
