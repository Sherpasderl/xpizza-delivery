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

// a valid RTDB path segment: no . / # $ [ ], whitespace or control character (the Admin SDK throws on those)
const SAFE_ID = /^[^./#$[\]\s\u0000-\u001f\u007f]+$/;
const canon = (v) => (v && typeof v === 'object' ? JSON.stringify(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : JSON.stringify(v));
// removes the marker ONLY while it is still the one judged: a delivery that refreshed it in the meantime aborts the removal
// (its own completion, or the next run, handles it); a marker already gone is a no-op
const removeIfUnchanged = (db, key, judged) => db.ref(`extra_payment_pending/${key}`).transaction((cur) => (cur == null || canon(cur) === canon(judged) ? null : undefined));

async function repairPendingExtraPayments({ db, now, limit = REPAIR_LIMIT }) {
  const out = { completed: 0, removed: 0, quarantined: 0, kept: 0, failed: 0 };
  const snap = await db.ref('extra_payment_pending').orderByKey().limitToFirst(limit).once('value');
  const markers = (snap && snap.val()) || {};
  for (const [key, m] of Object.entries(markers)) {
    try {
      const attemptId = m && m.attempt; const orderId = m && m.order;
      const ids = typeof attemptId === 'string' && SAFE_ID.test(attemptId) && typeof orderId === 'string' && SAFE_ID.test(orderId);
      const rec = ids ? ((await db.ref(extraRecordPath(attemptId, key)).once('value')).val()) : null;
      if (rec && typeof rec.uuid === 'string' && extraKey(rec.uuid) === key && Number.isFinite(rec.at)) {
        await db.ref().update(extraCompletionUpdate(key, rec, { orderId, attemptId }));
        out.completed += 1;
      } else if (rec) {
        // a record that does not match its key: never written from, never overwritten — moved out of the page for a person
        await db.ref().update({
          [`extra_payment_quarantine/${key}`]: { ...m, reason: 'record_key_mismatch', at_quarantined: now },
          [`dispatcher_alerts/extra_payment_quarantine_${key}`]: { type: 'payment_extra_payment_quarantined', detail: { orderId, attemptId }, created_at: Number.isFinite(m.at) ? m.at : now },
        });
        const t = await removeIfUnchanged(db, key, m);
        if (t.committed) out.quarantined += 1; else out.kept += 1;
      } else if (!(Number.isFinite(m && m.at) && now - m.at <= REPAIR_GRACE_MS)) {
        const t = await removeIfUnchanged(db, key, m);
        if (t.committed) out.removed += 1; else out.kept += 1;
      } else out.kept += 1;   // too young to judge: a delivery may be between its marker and its claim
    } catch (_) { out.failed += 1; }   // one marker never blocks the page; it is retried next run
  }
  return out;
}

module.exports = { repairPendingExtraPayments, extraCompletionUpdate, extraKey, extraRecordPath, pendingMarker, REPAIR_GRACE_MS, REPAIR_LIMIT };
