'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1 §2 placement row, §5 deadline index) — the handlers' audience glue, kept OUT of index.js
// (whose pinned lines each cost an inverse hunk):
//   · memberOf(req, db, { knownUid, getAuth, attributionUid }) → a LAZY thunk: the quote's verified member — the envío's uid when it already
//     verified one, else the X-Firebase-ID-Token verified here (customer claim; a tombstoned uid ⇒ attributionUid's answer); anything else
//     ⇒ null (a guest). A client-supplied uid is never read. Only an audience-exposed quote calls it.
//   · stampCash(updates, orderId, dq, nowMs): the signed codes frozen on the cash order AND audience_ids_by_day/{HN day}_{orderId} (a FLAT key: the deadline sweep's range read is bounded) in the
//     SAME multi-path update.
//   · stampCard(db, record, orderId, dq, nowMs): the day index FIRST, then the codes on the pending record (its CAS write is one path) —
//     an index entry whose order holds no codes is harmless (the deadline sweep removes it); codes without an entry could outlive it.
const AC = require('./audience-core');

function memberOf(req, db, { knownUid = null, getAuth, attributionUid }) {
  return async () => {
    if (typeof knownUid === 'string' && knownUid) return knownUid;
    const idTok = req && typeof req.get === 'function' ? req.get('x-firebase-id-token') : null;
    if (!idTok) return null;
    try {
      const dec = await getAuth().verifyIdToken(idTok);
      if (!(dec && dec.customer === true && dec.uid)) return null;
      return attributionUid(dec, (await require('../lib/rtdb-gate').afterGets(db.ref(`deleted_uids/${dec.uid}`), (r) => r.once('value'))).exists()) || null;
    } catch (_) { return null; }   // malformed / expired / foreign ⇒ a guest
  };
}

const idsOfDq = (dq) => (dq && AC.idsShapeOk(dq.audience_ids) ? dq.audience_ids : null);
// the index day = the ORDER's own created_at (what the writer and the deadline sweep read back); the caller's clock only when absent
const dayPath = (orderId, rec, nowMs) => `audience_ids_by_day/${AC.dayKey(rec && Number.isSafeInteger(rec.created_at) ? rec.created_at : nowMs, orderId)}`;

function stampCash(updates, orderId, dq, nowMs) {
  const ids = idsOfDq(dq);
  if (!ids || !updates[`orders/${orderId}`]) return updates;
  updates[`orders/${orderId}`].audience_ids = ids;
  updates[dayPath(orderId, updates[`orders/${orderId}`], nowMs)] = true;
  return updates;
}

async function stampCard(db, record, orderId, dq, nowMs) {
  const ids = idsOfDq(dq);
  if (!ids) return record;
  await db.ref(dayPath(orderId, record, nowMs)).set(true);
  record.audience_ids = ids;
  return record;
}

module.exports = { memberOf, stampCash, stampCard, dayPath };
