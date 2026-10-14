'use strict';
// PLAN-H0 — paid money on a card attempt the order does not account for, and reversals whose outcome is uncertain, are
// always FOUND and SURFACED to staff, and automation never closes an order over them. Detective only: nothing here
// moves money. Staff remediate in PixelPay.
//
// One pure classifier (classify), ONE writer (recordEvidence), and the two sweeps that call it: a frequent pass over
// indexed, cursor-paged recent attempts plus outstanding work items, and a daily full pass run at the end of
// reconcilePayments over the maps it already loaded. The cancel guard (cancel-order-core) and abandon (resolve-manual)
// only READ through unresolvedMoneyOnOrder / hasEvidenceKeys.

const crypto = require('crypto');

const PROVEN_REVERSED = new Set(['refunded', 'voided']);        // terminal writes of the reversal machine
const RECONCILER_OWNED = new Set(['refund_pending', 'reversing']); // refundReconciler selects by these statuses
const FREQUENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const PAGE = 200;
const ITEMS_PER_RUN = 100;
const CHECKPOINT_EVERY = 25;
const BACKOFF_MIN_MS = 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const KEY_RX = /^[A-Za-z0-9_-]{1,64}$/;

function verifiedPaid(a) {
  return !!a && (a.hosted_callback_verified === true || a.capture_verified === true || a.hosted_state === 'paid');
}

// A durable reversal state no job owns — keyed on the state alone, NOT on the paid flags, so an uncertain reversal
// reached by a direct cancel is caught too. Over-alerting beats missing.
function uncertainReversal(a) {
  if (!a) return false;
  if (a.status === 'manual_review') return true;
  if (a.reversing_phase === 'side_effect_started' && a.status !== 'reversing') return true;
  if (a.no_uuid_paid_callback) return true;
  if ((a.hosted_state === 'refund_pending' || a.hosted_state === 'voided')
    && !PROVEN_REVERSED.has(a.status) && !RECONCILER_OWNED.has(a.status)) return true;
  return false;
}

// Exactly ONE attempt per order owns the order's money: payment_reference when it NAMES one of this order's attempts
// (the manual materializer writes `payment_reference: attemptId`), else the active attempt. The automatic confirm
// writes payment_reference = the PixelPay transaction ref, which names no attempt, so it falls to the active one.
function accountedAttemptId(orderId, order, refAttempt) {
  const ref = order && order.payment_reference;
  if (typeof ref === 'string' && refAttempt && refAttempt.order_id === orderId) return ref;
  return (order && order.active_attempt_id) || null;
}

// → null | 'reversal_uncertain' | 'paid_superseded'. `refAttempt` = payment_attempts/{order.payment_reference} if it
// exists (else null).
function classify(orderId, order, attemptId, attempt, refAttempt) {
  if (!order || !attempt || attempt.order_id !== orderId) return null;
  if (uncertainReversal(attempt)) return 'reversal_uncertain';
  if (!verifiedPaid(attempt)) return null;
  if (PROVEN_REVERSED.has(attempt.status) || RECONCILER_OWNED.has(attempt.status)) return null;
  return attemptId === accountedAttemptId(orderId, order, refAttempt) ? null : 'paid_superseded';
}

function amountCents(attempt) {
  const n = Number(attempt && attempt.paid_amount_cents);
  return Number.isFinite(n) ? n : null;
}

function evidenceVersion(kind, attempt) {
  const parts = [kind, attempt.payment_uuid || null, amountCents(attempt), attempt.status || null, attempt.hosted_state || null];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

const itemKey = (orderId, attemptId) => `${orderId}_${attemptId}`;

// The dispatcher alert record (pure; the dispatch renderer is tested against exactly this shape). `order_id` is TOP-LEVEL:
// alert-prune reads only detail.* → never pruned when the order is cancelled. RTDB drops nulls, so every optional
// field is re-defaulted (a read-back evidence child lacks them).
function alertRecord(orderId, attemptId, ev, order) {
  return {
    type: ev.kind,
    order_id: orderId,
    attempt_id: attemptId,
    amount_cents: ev.amount_cents == null ? null : ev.amount_cents,
    attempt_status: ev.attempt_status == null ? null : ev.attempt_status,
    first_seen_at: ev.first_seen_at,
    restaurant_id: (order && order.restaurant_id) || null,
    created_at: ev.first_seen_at,
  };
}
const alertKey = (kind, orderId, attemptId) => `${kind}_${orderId}_${attemptId}`;

async function readRefAttempt(db, order, attemptId, attempt) {
  const ref = order && order.payment_reference;
  if (typeof ref !== 'string' || !KEY_RX.test(ref)) return null;
  if (ref === attemptId) return attempt;
  return (await db.ref(`payment_attempts/${ref}`).once('value')).val();
}

// THE ONLY WRITER of evidence and of these alerts. Reads the order and the attempt FRESH (the commit-time re-check),
// then: work item → evidence (transaction, versioned) → alert (overwrite while pending) → delivered (version CAS) →
// the work item is deleted only if it still carries the delivered version. A crash anywhere leaves the work item (or a
// `pending` child the daily pass sees), so evidence is never left without its alert.
async function recordEvidence(db, { orderId, attemptId, now = Date.now() }) {
  if (!KEY_RX.test(String(orderId || '')) || !KEY_RX.test(String(attemptId || ''))) return { outcome: 'bad_key' };
  const [orderSnap, attemptSnap] = await Promise.all([
    db.ref(`orders/${orderId}`).once('value'),
    db.ref(`payment_attempts/${attemptId}`).once('value'),
  ]);
  const order = orderSnap.val();
  const attempt = attemptSnap.val();
  const itemRef = db.ref(`pending_paid_alerts/${itemKey(orderId, attemptId)}`);
  if (!order) return { outcome: 'orphan' };   // advisor ruling: orphan paid attempts (no order) → LOG ONLY
  const refAttempt = await readRefAttempt(db, order, attemptId, attempt);
  const kind = classify(orderId, order, attemptId, attempt, refAttempt);
  if (!kind) {
    await itemRef.remove();
    return { outcome: 'not_alertable' };
  }
  const version = evidenceVersion(kind, attempt);
  // 0. the work item first — carries the version (generation-aware acknowledgement)
  await itemRef.update({ order_id: orderId, attempt_id: attemptId, at: now, version });

  // 1. evidence: create / unchanged / replace-on-change
  const evRef = db.ref(`orders/${orderId}/paid_evidence/${attemptId}`);
  const payload = {
    kind, version,
    payment_uuid: attempt.payment_uuid || null,
    amount_cents: amountCents(attempt),
    attempt_status: attempt.status || null,
    hosted_state: attempt.hosted_state || null,
  };
  const evTx = await evRef.transaction((cur) => {
    if (!cur) return { ...payload, first_seen_at: now, alert_state: 'pending' };
    if (cur.version === version) return;                                         // unchanged → no write
    return { ...payload, first_seen_at: cur.first_seen_at || now, last_changed_at: now, alert_state: 'pending' };
  });
  const ev = evTx.snapshot.val();
  if (!ev) return { outcome: 'evidence_missing' };
  if (ev.alert_state !== 'pending') {                                            // delivered and unchanged
    await deleteItemIfVersion(itemRef, ev.version);
    return { outcome: 'already_delivered' };
  }

  // 2. the alert — OVERWRITE with the current payload, so a changed version updates a still-open alert
  try {
    await db.ref(`dispatcher_alerts/${alertKey(ev.kind, orderId, attemptId)}`).set(alertRecord(orderId, attemptId, ev, order));
  } catch (e) {
    await rescheduleItem(itemRef, now);
    return { outcome: 'alert_failed' };
  }

  // 3. delivered — only if the evidence still carries the version just alerted
  const dTx = await evRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe: force the server round-trip
    if (!cur || cur.version !== ev.version) return;
    if (cur.alert_state === 'delivered') return;
    return { ...cur, alert_state: 'delivered', alert_delivered_at: now };
  });
  const after = dTx.snapshot.val();
  if (after && after.version === ev.version && after.alert_state === 'delivered') {
    await deleteItemIfVersion(itemRef, ev.version);
    return { outcome: 'delivered', kind: ev.kind };
  }
  return { outcome: 'superseded_by_newer' };
}

async function deleteItemIfVersion(itemRef, version) {
  await itemRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe
    if (!cur) return;
    if (cur.version !== version) return;                                         // a newer generation keeps its item
    return null;
  });
}

async function rescheduleItem(itemRef, now) {
  await itemRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe
    if (!cur) return;
    const attempts = (Number(cur.attempts) || 0) + 1;
    const backoff = Math.min(BACKOFF_MIN_MS * Math.pow(2, attempts - 1), BACKOFF_MAX_MS);
    return { ...cur, attempts, at: now + backoff };
  });
}

// A pre-filter on whatever snapshot the caller holds; recordEvidence re-reads fresh before writing anything.
function looksAlertable(attempt) {
  return !!attempt && (verifiedPaid(attempt) || uncertainReversal(attempt));
}

async function pagedPass(db, { field, cursorName, now, log }) {
  const curRef = db.ref(`ops/superseded_sweep/${cursorName}`);
  let cur = (await curRef.once('value')).val();
  const floor = now - FREQUENT_WINDOW_MS;
  if (!cur || !Number.isFinite(cur.v) || cur.v < floor) cur = { v: floor, k: null };
  let q = db.ref('payment_attempts').orderByChild(field);
  q = cur.k ? q.startAt(cur.v, cur.k) : q.startAt(cur.v);
  const snap = await q.limitToFirst(PAGE + 1).once('value');
  const rows = [];
  snap.forEach((c) => { rows.push([c.key, c.val()]); });
  let processed = 0, last = null;
  for (const [attemptId, a] of rows) {
    if (cur.k && attemptId === cur.k && a && a[field] === cur.v) continue;      // startAt is inclusive — skip the cursor row
    if (processed >= PAGE) break;
    processed += 1;
    last = { v: a && a[field], k: attemptId };
    try {
      if (!a || !a.order_id) { log(`superseded-capture: orphan attempt ${attemptId} (no order_id)`); continue; }
      if (looksAlertable(a)) {
        const r = await recordEvidence(db, { orderId: a.order_id, attemptId, now });
        if (r.outcome === 'orphan') log(`superseded-capture: orphan attempt ${attemptId} (order ${a.order_id} absent)`);
      }
    } catch (e) { log(`superseded-capture: ${field} candidate ${attemptId} failed: ${e && e.message}`); }
    if (processed % CHECKPOINT_EVERY === 0 && last && Number.isFinite(last.v)) await curRef.set(last);
  }
  if (last && Number.isFinite(last.v)) await curRef.set(last);
  return { processed };
}

async function workItemPass(db, { now, log }) {
  const snap = await db.ref('pending_paid_alerts').orderByChild('at').startAt(1).endAt(now).limitToFirst(ITEMS_PER_RUN).once('value');
  const items = [];
  snap.forEach((c) => { items.push([c.key, c.val()]); });
  let done = 0;
  for (const [key, it] of items) {
    try {
      if (!it || !it.order_id || !it.attempt_id) { await db.ref(`pending_paid_alerts/${key}`).remove(); continue; }
      const r = await recordEvidence(db, { orderId: it.order_id, attemptId: it.attempt_id, now });
      if (r.outcome === 'orphan') await db.ref(`pending_paid_alerts/${key}`).remove();
      done += 1;
    } catch (e) {
      log(`superseded-capture: work item ${key} failed: ${e && e.message}`);
      try { await rescheduleItem(db.ref(`pending_paid_alerts/${key}`), now); } catch (_) {}
    }
  }
  return { items: done };
}

// The frequent pass (every 10 min): hosted captures (paid_at), the two guard-written uncertain states (uncertain_at),
// then the outstanding work items (re-delivery, fair: oldest first, failures rescheduled into the future).
async function frequentPass(db, { now = Date.now(), log = console.log } = {}) {
  const paid = await pagedPass(db, { field: 'paid_at', cursorName: 'paid_cursor', now, log });
  const unc = await pagedPass(db, { field: 'uncertain_at', cursorName: 'uncertain_cursor', now, log });
  const items = await workItemPass(db, { now, log });
  return { paid: paid.processed, uncertain: unc.processed, items: items.items };
}

// The daily pass, run at the END of reconcilePayments over the maps it already loaded (no new enumeration read).
// Budgeted against the REMAINING invocation time; the cursor is checkpointed every CHECKPOINT_EVERY candidates and wraps,
// so every attempt is visited within one full scan cycle even when earlier reconcile work eats the budget.
async function dailyPass(db, { orders, attempts, invocationStartedAt, invocationBudgetMs = 300000, reserveMs = 20000, now = Date.now(), clock = Date.now, log = console.log }) {
  const deadline = invocationStartedAt + invocationBudgetMs - reserveMs;
  const curRef = db.ref('ops/superseded_sweep/daily_cursor');
  const ids = Object.keys(attempts || {}).sort();
  let startIdx = 0;
  const cur = (await curRef.once('value')).val();
  if (cur && typeof cur.k === 'string') {
    const i = ids.findIndex((id) => id > cur.k);
    startIdx = i < 0 ? 0 : i;                                                    // wrap after the last id
  }
  let visited = 0, alerted = 0, last = null, outOfTime = false;
  for (let n = 0; n < ids.length; n += 1) {
    if (clock() >= deadline) { outOfTime = true; break; }
    const attemptId = ids[(startIdx + n) % ids.length];
    const a = attempts[attemptId];
    visited += 1;
    last = attemptId;
    try {
      const order = a && a.order_id ? (orders || {})[a.order_id] : null;
      if (a && a.order_id && !order) { if (looksAlertable(a)) log(`superseded-capture: orphan attempt ${attemptId}`); }
      else if (order) {
        const refAttempt = typeof order.payment_reference === 'string' ? (attempts || {})[order.payment_reference] || null : null;
        if (classify(a.order_id, order, attemptId, a, refAttempt)) {
          const r = await recordEvidence(db, { orderId: a.order_id, attemptId, now });
          if (r.outcome === 'delivered') alerted += 1;
        }
      }
    } catch (e) { log(`superseded-capture: daily candidate ${attemptId} failed: ${e && e.message}`); }
    if (visited % CHECKPOINT_EVERY === 0) await curRef.set({ k: last, at: now });
  }
  if (last) await curRef.set({ k: last, at: now });
  // re-deliver any evidence child still `pending` that the loaded orders map shows (even without a work item)
  let redelivered = 0;
  if (!outOfTime) {
    for (const [orderId, o] of Object.entries(orders || {})) {
      if (clock() >= deadline) break;
      const ev = o && o.paid_evidence;
      if (!ev || typeof ev !== 'object') continue;
      for (const [attemptId, e] of Object.entries(ev)) {
        if (!e || e.alert_state !== 'pending') continue;
        try { await recordEvidence(db, { orderId, attemptId, now }); redelivered += 1; } catch (err) { log(`superseded-capture: redeliver ${orderId}/${attemptId} failed: ${err && err.message}`); }
      }
    }
  }
  return { visited, alerted, redelivered, outOfTime, total: ids.length };
}

// READ-ONLY, for the cancel guard: from the claim snapshot (fresh at the claim), the candidates are the CURRENT evidence
// keys plus the active attempt; each is read FRESH and classified. → null, or { attemptId, kind } for the first
// unresolved one.
async function unresolvedMoneyOnOrder(db, orderId, orderSnapshot) {
  if (!orderSnapshot) return null;
  const ids = new Set(Object.keys((orderSnapshot.paid_evidence && typeof orderSnapshot.paid_evidence === 'object') ? orderSnapshot.paid_evidence : {}));
  if (orderSnapshot.active_attempt_id) ids.add(orderSnapshot.active_attempt_id);
  const valid = [...ids].filter((id) => KEY_RX.test(id));
  if (!valid.length) return null;
  const reads = await Promise.all(valid.map((id) => db.ref(`payment_attempts/${id}`).once('value')));
  const byId = {};
  valid.forEach((id, i) => { byId[id] = reads[i].val(); });
  const ref = orderSnapshot.payment_reference;
  let refAttempt = null;
  if (typeof ref === 'string' && KEY_RX.test(ref)) refAttempt = byId[ref] !== undefined ? byId[ref] : (await db.ref(`payment_attempts/${ref}`).once('value')).val();
  for (const id of valid) {
    const kind = classify(orderId, orderSnapshot, id, byId[id], refAttempt);
    if (kind) return { attemptId: id, kind };
  }
  return null;
}

// The reconciler's no-uuid park (PLAN-H0 §4): refundReconciler never calls voidOrRefund without a payment uuid (its
// no-uuid branch reports 'refunded' without reversing anything). The attempt is parked for staff; the sweep's
// uncertain_at pass alerts it as reversal_uncertain.
async function parkReconcilerNoUuid(db, attemptId, now) {
  await db.ref(`payment_attempts/${attemptId}`).update({ status: 'manual_review', refund_message: 'no_uuid_reconciler', uncertain_at: now });
}

function hasEvidenceKeys(order) {
  return !!(order && order.paid_evidence && typeof order.paid_evidence === 'object' && Object.keys(order.paid_evidence).length);
}

module.exports = {
  classify, uncertainReversal, verifiedPaid, accountedAttemptId, evidenceVersion,
  recordEvidence, frequentPass, dailyPass, unresolvedMoneyOnOrder, hasEvidenceKeys, deleteItemIfVersion, rescheduleItem, alertRecord, parkReconcilerNoUuid,
  FREQUENT_WINDOW_MS, PAGE, ITEMS_PER_RUN, CHECKPOINT_EVERY,
};
