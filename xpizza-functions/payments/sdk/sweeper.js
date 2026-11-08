'use strict';
// The durable SDK payments sweeper (BRIEF r5 §5) — independent of the app and of the status trigger. It reads ONE bounded
// page of the due index (payment_sdk_due/{orderId} = next visit time) and RESCHEDULES each visited entry before working it,
// so persistent unknowns rotate and can never starve later orders. A visit reconciles, settles a terminal order (including
// one whose trigger never ran), resumes a cancellation, expires a pending order past its TTL, re-opens a missed obligation,
// tracks surplus holds to a CONFIRMED expiry, and raises the overdue alerts. The entry is removed only when the record is
// financially closed and the entry still holds the value this visit wrote (a newer enrol is never erased).
const R = require('./record');
const C = require('./coordinator');

const PAGE = 50;
const REVISIT_MS = 5 * 60 * 1000;
const CAPTURE_OVERDUE_MS = 15 * 60 * 1000;
const SURPLUS_ALERT_MS = 24 * 3600 * 1000;   // a surplus hold not confirmed expired/voided one day after its 15-day expiry

async function visitDueOrder(deps, orderId) {
  const now = deps.clock();
  let order = await C.readOrder(deps.db, orderId);
  if (!order || order.payment_flow !== 'sdk_auth_v1') return 'not_sdk';
  await C.reconcileSdkOps(deps, { orderId });
  order = await C.readOrder(deps.db, orderId);
  if (order.payment_cancel) await C.cancelSdkOrder(deps, { orderId, kind: order.payment_cancel.kind });
  else if (R.TERMINAL.includes(order.status) || order.payment_terminal) await C.settleTerminal(deps, { orderId });
  else if (order.status === 'pending_payment' && !order.payment_placed) {
    const rec = await C.readRecord(deps.db, orderId);
    if (rec && now >= rec.ttl_at) await C.expirePending(deps, { orderId });
  }
  await C.sweepPendingRoles(deps, orderId);
  await C.trackExpiry(deps, orderId);
  const rec = await C.readRecord(deps.db, orderId);
  order = await C.readOrder(deps.db, orderId);
  if (rec && rec.frozen && order && order.payment_terminal && now - order.payment_terminal.at > CAPTURE_OVERDUE_MS
      && (rec.frozen.capture_set || []).some((id) => !rec.legs[id] || rec.legs[id].state !== 'captured')) {
    await C.alertOnce(deps, 'capture_overdue', orderId, {});
  }
  if (rec) for (const [legId, l] of Object.entries(R.legsOfRecord(rec))) {
    if (l.state === 'approved' && l.role === 'surplus' && now >= l.hold_expires_at + SURPLUS_ALERT_MS) await C.alertOnce(deps, 'surplus_unconfirmed', orderId, { leg_id: legId }, legId);
  }
  return R.isFinanciallyClosed(rec, order) ? 'closed' : 'open';
}

async function sweepSdkPayments(deps) {
  const now = deps.clock();
  const snap = await deps.db.ref('payment_sdk_due').orderByValue().endAt(now).limitToFirst(PAGE).once('value');
  const page = (snap && snap.val()) || {};
  const out = { visited: 0, closed: 0, failed: 0 };
  for (const [orderId, at] of Object.entries(page)) {
    const next = now + REVISIT_MS;
    // reschedule FIRST — the rotation that prevents first-page starvation (conditional: a newer enrol is kept)
    await deps.db.ref(`payment_sdk_due/${orderId}`).transaction((cur) => (cur == null ? null : cur === at ? next : undefined));
    out.visited += 1;
    let state;
    try { state = await visitDueOrder(deps, orderId); } catch (e) { out.failed += 1; continue; }   // one order never blocks the page
    if (state === 'closed' || state === 'not_sdk') {
      await deps.db.ref(`payment_sdk_due/${orderId}`).transaction((cur) => (cur == null ? null : cur === next ? null : undefined));
      out.closed += 1;
    }
  }
  return out;
}

module.exports = { sweepSdkPayments, visitDueOrder, PAGE, REVISIT_MS };
