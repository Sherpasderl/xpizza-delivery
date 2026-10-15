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
const SWEEP_CAP_MS = 200 * 1000;                                  // the daily pass never runs longer than this

function verifiedPaid(a) {
  return !!a && (a.hosted_callback_verified === true || a.capture_verified === true || a.hosted_state === 'paid');
}

// A durable reversal state no job owns — keyed on the state alone, NOT on the paid flags, so an uncertain reversal
// reached by a direct cancel is caught too. Over-alerting beats missing.
function uncertainReversal(a) {
  if (!a) return false;
  if (PROVEN_REVERSED.has(a.status) || RECONCILER_OWNED.has(a.status)) return false;   // a proven reversal (or one a job owns) beats a surviving marker
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
function alertRecord(orderId, attemptId, ev, order, fence = 0) {
  return {
    type: ev.kind,
    order_id: orderId,
    attempt_id: attemptId,
    amount_cents: ev.amount_cents == null ? null : ev.amount_cents,
    attempt_status: ev.attempt_status == null ? null : ev.attempt_status,
    first_seen_at: ev.first_seen_at,
    restaurant_id: (order && order.restaurant_id) || null,
    created_at: ev.first_seen_at,
    version: ev.version == null ? null : ev.version,
    seq: Number(ev.seq) || 0,
    fence: Number(fence) || 0,
  };
}
const alertKey = (kind, orderId, attemptId) => `${kind}_${orderId}_${attemptId}`;

async function readRefAttempt(db, order, attemptId, attempt) {
  const ref = order && order.payment_reference;
  if (typeof ref !== 'string' || !KEY_RX.test(ref)) return null;
  if (ref === attemptId) return attempt;
  return (await db.ref(`payment_attempts/${ref}`).once('value')).val();
}

const KINDS = ['paid_superseded', 'reversal_uncertain'];
const seqOf = (x) => Number(x && x.seq) || 0;
const fenceOf = (x) => Number(x && x.fence) || 0;
const newGen = () => crypto.randomBytes(8).toString('hex');
const LEASE_MS = 2 * 60 * 1000;                                   // ≫ one order's steps (seconds), < the 10 min cadence
const LEASE_MARGIN_MS = 15 * 1000;                                // a writer stops this long before its lease expires
const leaseRef = (db, orderId) => db.ref(`ops/superseded_lease/${orderId}`);

// Durable staff dismissal (ruling B): the dispatch × records {dismissed_kind, dismissed_version} on the evidence child in
// the same multi-path update that removes the alert. Absence of an alert node therefore means nothing; this does.
const dismissedFor = (ev, kind, version) => !!ev && ev.dismissed_kind === kind && ev.dismissed_version === version;

// Per-order LEASE + FENCING TOKEN (ruling A). The lease is a transaction on ops/superseded_lease/{orderId} = {gen, fence,
// expires_at}. `fence` is strictly increasing across holders (max(clock, previous + 1)), so it survives the lease node
// being released. Every write after the fresh re-read carries the fence, and the evidence and alert transactions refuse a
// target that already holds a HIGHER fence: a paused writer whose lease expired is fenced out at its next write. Each
// write also re-checks the holder's own clock against its expiry (minus a margin).
async function acquireLease(db, orderId, gen, clock) {
  let mine = null;
  const t = clock();
  const tx = await leaseRef(db, orderId).transaction((cur) => {
    mine = null;
    if (cur && Number(cur.expires_at) > t && cur.gen !== gen) return;            // held by a live writer → back off
    const fence = Math.max(t, fenceOf(cur) + 1);
    mine = { gen, fence, expires_at: t + LEASE_MS };
    return mine;
  });
  return tx.committed && mine && tx.snapshot.val() && tx.snapshot.val().gen === gen ? mine : null;
}
async function releaseLease(db, orderId, gen) {
  await leaseRef(db, orderId).transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe
    if (!cur || cur.gen !== gen) return;                                         // a newer holder keeps its lease
    return { fence: fenceOf(cur) };                                              // keep the high-water fence, drop the hold
  });
}

// THE ONLY WRITER of evidence and of these alerts (PLAN-H0; codex build r2 → structural ruling):
//   0. the work item FIRST, stamped with this writer's generation (a crash or failure from here on leaves it for the
//      work-item pass);
//   1. the per-order LEASE (fence token); busy → the item stays for the next run;
//   2. a FRESH read + classify AFTER acquiring; not alertable → release, delete only MY item generation;
//   3. evidence: a fenced transaction (create / stamp the fence / replace-on-change with seq + 1; dismissal kept);
//   4. a dismissed (kind, version) → delivered without an alert; delivered and unchanged → repair;
//   5. the alert: a fenced transaction (never over a higher fence), then a CHECK-AFTER-WRITE re-read of the evidence —
//      fenced out or dismissed meanwhile → withdraw MY alert;
//   6. delivered: a CAS on fence + version + seq; then withdraw the other kind's alert (lower fence only);
//   then release the lease and delete the item only if it still carries MY generation.
// `hooks` (tests only) pause or fail the writer at named points; `clock` drives the lease (tests: a virtual clock).
async function recordEvidence(db, { orderId, attemptId, now = Date.now(), clock = Date.now, hooks = null }) {
  if (!KEY_RX.test(String(orderId || '')) || !KEY_RX.test(String(attemptId || ''))) return { outcome: 'bad_key' };
  const hook = async (name) => { if (hooks && typeof hooks[name] === 'function') await hooks[name]({ orderId, attemptId }); };
  const itemRef = db.ref(`pending_paid_alerts/${itemKey(orderId, attemptId)}`);
  const gen = newGen();
  // 0. the work item first
  try { await itemRef.update({ order_id: orderId, attempt_id: attemptId, at: now, gen }); }
  catch (e) { if (e && typeof e === 'object') e.h0BeforeItem = true; throw e; }
  await hook('afterItem');

  // 1. the lease
  const lease = await acquireLease(db, orderId, gen, clock);
  if (!lease) return { outcome: 'lease_busy' };                                  // the item stays → retried next run
  try {
    return await underLease(db, { orderId, attemptId, now, clock, hook, itemRef, gen, lease });
  } catch (e) {
    try { await releaseLease(db, orderId, gen); } catch (_) { /* expiry frees it */ }
    throw e;                                                                     // the item stays (MY generation) → retried
  }
}

async function underLease(db, { orderId, attemptId, now, clock, hook, itemRef, gen, lease }) {
  const fence = lease.fence;
  const live = () => clock() < lease.expires_at - LEASE_MARGIN_MS;
  const done = async (outcome, extra = {}) => {
    await releaseLease(db, orderId, gen);
    await deleteItemIfGen(itemRef, gen);
    return { outcome, ...extra };
  };
  const fencedOut = async () => { await releaseLease(db, orderId, gen); return { outcome: 'fenced' }; };   // the item stays (the newer holder owns it)
  await hook('afterLease');

  // 2. fresh read + classify, AFTER the lease
  const [orderSnap, attemptSnap] = await Promise.all([
    db.ref(`orders/${orderId}`).once('value'),
    db.ref(`payment_attempts/${attemptId}`).once('value'),
  ]);
  const order = orderSnap.val();
  const attempt = attemptSnap.val();
  if (!order) return done('orphan');                                            // advisor ruling: orphan → LOG ONLY
  const refAttempt = await readRefAttempt(db, order, attemptId, attempt);
  const kind = classify(orderId, order, attemptId, attempt, refAttempt);
  await hook('afterClassify');
  if (!kind) return done('not_alertable');
  const version = evidenceVersion(kind, attempt);
  await hook('beforeEvidence');
  if (!live()) return fencedOut();

  // 3. evidence — fenced: never over a higher fence; stamps this fence even when unchanged
  const evRef = db.ref(`orders/${orderId}/paid_evidence/${attemptId}`);
  const payload = {
    kind, version,
    payment_uuid: attempt.payment_uuid || null,
    amount_cents: amountCents(attempt),
    attempt_status: attempt.status || null,
    hosted_state: attempt.hosted_state || null,
  };
  const evTx = await evRef.transaction((cur) => {
    if (!cur) return { ...payload, seq: 1, first_seen_at: now, alert_state: 'pending', fence };
    if (fenceOf(cur) > fence) return;                                            // a newer holder wrote it → fenced out
    if (cur.version === version) return fenceOf(cur) === fence ? undefined : { ...cur, fence };
    return { ...payload, seq: seqOf(cur) + 1, first_seen_at: cur.first_seen_at || now, last_changed_at: now, alert_state: 'pending', fence };
  });
  const ev = evTx.snapshot.val();
  if (!ev) return fencedOut();
  if (fenceOf(ev) !== fence || ev.version !== version) return fencedOut();
  const seq = seqOf(ev);

  // 4. dismissed by staff for exactly this (kind, version) → never re-alert; mark it delivered
  if (dismissedFor(ev, ev.kind, ev.version)) {
    await markDelivered(evRef, { fence, version, seq, now });
    await removeAlertIf(db.ref(`dispatcher_alerts/${alertKey(ev.kind, orderId, attemptId)}`), (cur) => fenceOf(cur) < fence);   // a stale writer's leftover
    await withdrawOtherKinds(db, orderId, attemptId, ev.kind, fence);
    return done('dismissed');
  }
  if (ev.alert_state !== 'pending') {                                            // delivered and unchanged
    if (!live()) return fencedOut();
    await repairAlert(db, orderId, attemptId, ev, order, fence);
    return done('already_delivered');
  }
  await hook('beforeAlert');
  if (!live()) return fencedOut();

  // 5. the alert — fenced; then check-after-write against the evidence
  const aRef = db.ref(`dispatcher_alerts/${alertKey(ev.kind, orderId, attemptId)}`);
  const rec = alertRecord(orderId, attemptId, ev, order, fence);
  try {
    await aRef.transaction((cur) => {
      if (cur && fenceOf(cur) > fence) return;                                   // a newer holder already alerted
      return rec;
    });
  } catch (e) {
    await releaseLease(db, orderId, gen);
    await rescheduleItem(itemRef, now, gen);
    return { outcome: 'alert_failed' };
  }
  await hook('afterAlert');
  const recheck = (await evRef.once('value')).val();
  if (!recheck || fenceOf(recheck) !== fence || recheck.version !== version || dismissedFor(recheck, ev.kind, version)) {
    await removeAlertIf(aRef, (cur) => fenceOf(cur) === fence);                  // withdraw only MY alert
    if (recheck && fenceOf(recheck) === fence && dismissedFor(recheck, ev.kind, version)) {
      await markDelivered(evRef, { fence, version, seq, now });
      return done('dismissed');
    }
    return fencedOut();
  }
  await hook('beforeDelivered');
  if (!live()) {                                                                 // past my lease AFTER placing my alert → withdraw it
    await removeAlertIf(aRef, (cur) => fenceOf(cur) === fence);
    return fencedOut();
  }

  // 6. delivered — a CAS on fence + version + seq
  const after = await markDelivered(evRef, { fence, version, seq, now });
  if (after && fenceOf(after) === fence && after.version === version && seqOf(after) === seq && after.alert_state === 'delivered') {
    await withdrawOtherKinds(db, orderId, attemptId, ev.kind, fence);
    return done('delivered', { kind: ev.kind });
  }
  // a newer holder owns the evidence → withdraw the alert this writer placed, if it is still this writer's
  await removeAlertIf(aRef, (cur) => fenceOf(cur) === fence);
  return fencedOut();
}

async function markDelivered(evRef, { fence, version, seq, now }) {
  const dTx = await evRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe: force the server round-trip
    if (!cur || fenceOf(cur) !== fence || cur.version !== version || seqOf(cur) !== seq) return;
    if (cur.alert_state === 'delivered') return;
    return { ...cur, alert_state: 'delivered', alert_delivered_at: now };
  });
  return dTx.snapshot.val();
}

// Transactionally remove an alert only while `pred(cur)` holds (null-first-safe).
async function removeAlertIf(aRef, pred) {
  await aRef.transaction((cur) => {
    if (cur === null) return null;
    if (!cur || !pred(cur)) return;
    return null;
  });
}

// An evidence child changes kind (e.g. paid_superseded → reversal_uncertain): the other kind's alert for the same attempt
// is withdrawn once the newer one is delivered — only an alert from a LOWER fence (an older holder).
async function withdrawOtherKinds(db, orderId, attemptId, kind, fence) {
  for (const k of KINDS) {
    if (k === kind) continue;
    await removeAlertIf(db.ref(`dispatcher_alerts/${alertKey(k, orderId, attemptId)}`), (cur) => fenceOf(cur) < fence);
  }
}

// Delivered evidence: its alert must exist and show THIS evidence, unless staff dismissed this (kind, version) — ruling B:
// an absent alert is (re)written; a dismissed one stays dismissed. Fenced: never over a higher fence.
async function repairAlert(db, orderId, attemptId, ev, order, fence) {
  const aRef = db.ref(`dispatcher_alerts/${alertKey(ev.kind, orderId, attemptId)}`);
  if (dismissedFor(ev, ev.kind, ev.version)) {
    await removeAlertIf(aRef, (cur) => fenceOf(cur) <= fence);
  } else {
    await aRef.transaction((cur) => {
      if (cur && fenceOf(cur) > fence) return;
      if (cur && cur.version === ev.version && seqOf(cur) === seqOf(ev) && fenceOf(cur) === fence) return;   // consistent
      return alertRecord(orderId, attemptId, ev, order, fence);
    });
    const recheck = (await db.ref(`orders/${orderId}/paid_evidence/${attemptId}`).once('value')).val();
    if (!recheck || fenceOf(recheck) !== fence || dismissedFor(recheck, ev.kind, ev.version)) await removeAlertIf(aRef, (cur) => fenceOf(cur) === fence);
  }
  await withdrawOtherKinds(db, orderId, attemptId, ev.kind, fence);
}

async function deleteItemIfGen(itemRef, gen) {
  await itemRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe
    if (!cur) return;
    if (cur.gen !== gen) return;                                                 // a newer generation keeps its item
    return null;
  });
}

// Push a failed item into the future (backoff 1 min doubling to 60 min). With `gen`, only that generation's item.
async function rescheduleItem(itemRef, now, gen) {
  await itemRef.transaction((cur) => {
    if (cur === null) return null;                                               // null-first-safe
    if (!cur) return;
    if (gen !== undefined && cur.gen !== gen) return;
    const attempts = (Number(cur.attempts) || 0) + 1;
    const backoff = Math.min(BACKOFF_MIN_MS * Math.pow(2, attempts - 1), BACKOFF_MAX_MS);
    return { ...cur, attempts, at: now + backoff };
  });
}

// A pre-filter on whatever snapshot the caller holds; recordEvidence re-reads fresh before writing anything.
function looksAlertable(attempt) {
  return !!attempt && (verifiedPaid(attempt) || uncertainReversal(attempt));
}

// Ruling D — a LOW-WATER-MARK cursor. A candidate that failed before its work item existed (h0BeforeItem: nothing
// durable owns it yet) HOLDS the persisted cursor at its position, while the SAME run continues past it to the later
// candidates (re-processing them next run is idempotent: already_delivered / the lease). Never "advance and lose".
// A candidate that pins the cursor for STUCK_LOUD_RUNS consecutive runs is logged loudly (console.error + count).
const STUCK_LOUD_RUNS = 3;
function stuckNext(prevStuck, failedKey) {
  if (failedKey == null) return null;
  const runs = (prevStuck && prevStuck.k === failedKey) ? (Number(prevStuck.runs) || 0) + 1 : 1;
  return { k: failedKey, runs };
}
function reportStuck(stuck, label, err) {
  if (stuck && stuck.runs >= STUCK_LOUD_RUNS) err(`superseded-capture: ${label} candidate ${stuck.k} has failed ${stuck.runs} consecutive runs — the cursor is held at it (low-water mark)`);
}

async function pagedPass(db, { field, cursorName, now, log, err = console.error, hooks, clock }) {
  const curRef = db.ref(`ops/superseded_sweep/${cursorName}`);
  let cur = (await curRef.once('value')).val();
  const floor = now - FREQUENT_WINDOW_MS;
  const prevStuck = cur && cur.stuck;
  if (!cur || !Number.isFinite(cur.v) || cur.v < floor) cur = { v: floor, k: null };
  let q = db.ref('payment_attempts').orderByChild(field);
  q = cur.k ? q.startAt(cur.v, cur.k) : q.startAt(cur.v);
  const snap = await q.limitToFirst(PAGE + 1).once('value');
  const rows = [];
  snap.forEach((c) => { rows.push([c.key, c.val()]); });
  let processed = 0, last = null, low = null, failedKey = null;
  const mark = () => (low || last);
  for (const [attemptId, a] of rows) {
    if (cur.k && attemptId === cur.k && a && a[field] === cur.v) continue;      // startAt is inclusive — skip the cursor row
    if (processed >= PAGE) break;
    processed += 1;
    const prev = last;
    last = { v: a && a[field], k: attemptId };
    try {
      if (!a || !a.order_id) { log(`superseded-capture: orphan attempt ${attemptId} (no order_id)`); continue; }
      if (looksAlertable(a)) {
        const r = await recordEvidence(db, { orderId: a.order_id, attemptId, now, clock, hooks });
        if (r.outcome === 'orphan') log(`superseded-capture: orphan attempt ${attemptId} (order ${a.order_id} absent)`);
      }
    } catch (e) {
      log(`superseded-capture: ${field} candidate ${attemptId} failed: ${e && e.message}`);
      // no work item was written for it → hold the persisted cursor just before it (once), but keep going
      if (e && e.h0BeforeItem && !low) { low = prev || { v: cur.v, k: cur.k }; failedKey = attemptId; }
    }
    if (processed % CHECKPOINT_EVERY === 0 && mark() && Number.isFinite(mark().v)) await curRef.set(mark());
  }
  const stuck = stuckNext(prevStuck, failedKey);
  reportStuck(stuck, field, err);
  const m = mark();
  if (m && Number.isFinite(m.v)) await curRef.set(stuck ? { ...m, stuck } : m);
  return { processed, held: !!low };
}

async function workItemPass(db, { now, log, hooks, clock }) {
  const snap = await db.ref('pending_paid_alerts').orderByChild('at').startAt(1).endAt(now).limitToFirst(ITEMS_PER_RUN).once('value');
  const items = [];
  snap.forEach((c) => { items.push([c.key, c.val()]); });
  let done = 0;
  for (const [key, it] of items) {
    try {
      if (!it || !it.order_id || !it.attempt_id) {                               // malformed: remove it only while it still is
        await db.ref(`pending_paid_alerts/${key}`).transaction((c) => (c === null ? null : (!c || !c.order_id || !c.attempt_id) ? null : undefined));
        continue;
      }
      await recordEvidence(db, { orderId: it.order_id, attemptId: it.attempt_id, now, clock, hooks });   // its own generation-guarded cleanup
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
async function frequentPass(db, { now = Date.now(), clock = Date.now, log = console.log, err = console.error, hooks = null } = {}) {
  const paid = await pagedPass(db, { field: 'paid_at', cursorName: 'paid_cursor', now, log, err, hooks, clock });
  const unc = await pagedPass(db, { field: 'uncertain_at', cursorName: 'uncertain_cursor', now, log, err, hooks, clock });
  const items = await workItemPass(db, { now, log, hooks, clock });
  return { paid: paid.processed, uncertain: unc.processed, items: items.items };
}

// The daily pass, run at the END of reconcilePayments over the maps it already loaded (no new enumeration read).
// Budgeted against the REMAINING invocation time minus the reserve AND a fixed SWEEP_CAP_MS from its own start, whichever
// is sooner — checked before every candidate and every pending child. The cursor is checkpointed every CHECKPOINT_EVERY candidates and wraps,
// so every attempt is visited within one full scan cycle even when earlier reconcile work eats the budget.
async function dailyPass(db, { orders, attempts, invocationStartedAt, invocationBudgetMs = 300000, reserveMs = 20000, sweepCapMs = SWEEP_CAP_MS, now = Date.now(), clock = Date.now, log = console.log, err = console.error, hooks = null }) {
  const deadline = Math.min(invocationStartedAt + invocationBudgetMs - reserveMs, clock() + sweepCapMs);
  const curRef = db.ref('ops/superseded_sweep/daily_cursor');
  const ids = Object.keys(attempts || {}).sort();
  let startIdx = 0;
  const cur = (await curRef.once('value')).val();
  if (cur && typeof cur.from === 'string') {                                     // a low-water mark: start AT that id
    const i = ids.findIndex((id) => id >= cur.from);
    startIdx = i < 0 ? 0 : i;
  } else if (cur && typeof cur.k === 'string') {
    const i = ids.findIndex((id) => id > cur.k);
    startIdx = i < 0 ? 0 : i;                                                    // wrap after the last id
  }
  let visited = 0, alerted = 0, last = null, low = null, outOfTime = false;
  const mark = () => (low ? { from: low, at: now } : (last ? { k: last, at: now } : null));
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
        if (classify(a.order_id, order, attemptId, a, refAttempt)) {           // a pre-filter; recordEvidence re-reads fresh
          const r = await recordEvidence(db, { orderId: a.order_id, attemptId, now, clock, hooks });
          if (r.outcome === 'delivered') alerted += 1;
        }
      }
    } catch (e) {
      log(`superseded-capture: daily candidate ${attemptId} failed: ${e && e.message}`);
      if (e && e.h0BeforeItem && !low) low = attemptId;                          // hold the cursor AT it; keep going
    }
    if (visited % CHECKPOINT_EVERY === 0 && mark()) await curRef.set(mark());
  }
  const stuck = stuckNext(cur && cur.stuck, low);
  reportStuck(stuck, 'daily', err);
  if (mark()) await curRef.set(stuck ? { ...mark(), stuck } : mark());
  // re-deliver any evidence child still `pending` that the loaded orders map shows (even without a work item) —
  // regardless of any scan failure above; only the deadline stops it
  let redelivered = 0;
  if (!outOfTime) {
    outer: for (const [orderId, o] of Object.entries(orders || {})) {
      const ev = o && o.paid_evidence;
      if (!ev || typeof ev !== 'object') continue;
      for (const [attemptId, e] of Object.entries(ev)) {
        if (!e || e.alert_state !== 'pending') continue;
        if (clock() >= deadline) { outOfTime = true; break outer; }             // checked per pending child
        try { await recordEvidence(db, { orderId, attemptId, now, clock, hooks }); redelivered += 1; } catch (er) { log(`superseded-capture: redeliver ${orderId}/${attemptId} failed: ${er && er.message}`); }
      }
    }
  }
  return { visited, alerted, redelivered, outOfTime, total: ids.length, held: !!low };
}

// READ-ONLY, for the cancel guard: from the claim snapshot (fresh at the claim), the candidates are the CURRENT evidence
// keys; each is read FRESH and classified. → null, or { attemptId, kind } for the first unresolved one.
// EVIDENCE-DRIVEN ONLY (codex build r3 P1; advisor ruling): the candidates are the persisted paid_evidence keys of the
// claim snapshot (read after the claim, so evidence written mid-cancel is caught) — never the active attempt on its own.
// An order with NO paid_evidence → a strict no-op: the cancel behaves byte-identically to 8f1e017.
async function unresolvedMoneyOnOrder(db, orderId, orderSnapshot) {
  if (!orderSnapshot) return null;
  const ids = new Set(Object.keys((orderSnapshot.paid_evidence && typeof orderSnapshot.paid_evidence === 'object') ? orderSnapshot.paid_evidence : {}));
  const valid = [...ids].filter((id) => KEY_RX.test(id));
  if (!valid.length) return null;
  const reads = await Promise.all(valid.map((id) => db.ref(`payment_attempts/${id}`).once('value')));
  const byId = {};
  valid.forEach((id, i) => { byId[id] = reads[i].val(); });
  const ref = orderSnapshot.payment_reference;
  let refAttempt = null;
  if (typeof ref === 'string' && KEY_RX.test(ref)) refAttempt = byId[ref] !== undefined ? byId[ref] : (await db.ref(`payment_attempts/${ref}`).once('value')).val();
  const evs = (orderSnapshot.paid_evidence && typeof orderSnapshot.paid_evidence === 'object') ? orderSnapshot.paid_evidence : {};
  for (const id of valid) {
    const kind = classify(orderId, orderSnapshot, id, byId[id], refAttempt);
    if (!kind) continue;
    if (dismissedFor(evs[id], kind, evidenceVersion(kind, byId[id]))) continue;   // ruling C: staff handled exactly this state
    return { attemptId: id, kind };
  }
  return null;
}

/* Ruling C — the staff manual path. The × on an H0 alert records {dismissed_kind, dismissed_version} on the evidence
   (ruling B); staff use it once they have handled the money in PixelPay. An evidence child is RESOLVED for the guards
   only while that dismissal names its stored (kind, version) — a changed money state is a new version and blocks again
   (and re-alerts). Stored-only: for the abandon CAS, which cannot read attempts. */
function evidenceResolved(child) {
  return !!child && typeof child === 'object' && dismissedFor(child, child.kind, child.version);
}
function hasUnresolvedEvidenceKeys(order) {
  if (!hasEvidenceKeys(order)) return false;
  return Object.values(order.paid_evidence).some((c) => !evidenceResolved(c));
}
// The abandon pre-check, FRESH: each evidence key is resolved only if its stored dismissal still matches AND the attempt
// read now is either no longer alertable or still in exactly the dismissed (kind, version). A read failure throws (the
// caller refuses: fail closed).
async function unresolvedEvidenceOnOrder(db, orderId, order) {
  if (!hasEvidenceKeys(order)) return null;
  const ids = Object.keys(order.paid_evidence);
  for (const id of ids) {
    const child = order.paid_evidence[id];
    if (!evidenceResolved(child) || !KEY_RX.test(id)) return { attemptId: id, kind: child && child.kind };
    const attempt = (await db.ref(`payment_attempts/${id}`).once('value')).val();
    const refAttempt = await readRefAttempt(db, order, id, attempt);
    const kind = classify(orderId, order, id, attempt, refAttempt);
    if (kind && !dismissedFor(child, kind, evidenceVersion(kind, attempt))) return { attemptId: id, kind };
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
  recordEvidence, frequentPass, dailyPass, unresolvedMoneyOnOrder, hasEvidenceKeys, hasUnresolvedEvidenceKeys, unresolvedEvidenceOnOrder, evidenceResolved, deleteItemIfGen, rescheduleItem, repairAlert, alertRecord, parkReconcilerNoUuid,
  FREQUENT_WINDOW_MS, PAGE, ITEMS_PER_RUN, CHECKPOINT_EVERY, SWEEP_CAP_MS, LEASE_MS, LEASE_MARGIN_MS, STUCK_LOUD_RUNS, dismissedFor, acquireLease, releaseLease,
};
