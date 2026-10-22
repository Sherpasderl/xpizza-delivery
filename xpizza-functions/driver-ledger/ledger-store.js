'use strict';
// S8 — THE DRIVER PAYABLE LEDGER, STORE (RTDB). r2 (codex r1): concurrency REMOVED rather than patched —
//   • ONE writer: runLedger() (the repairDriverLedger schedule) accrues → re-checks → closes in a single run, under a
//     lease lock (driver_ledger_meta/lock) on top of maxInstances 1, so two invocations can never interleave.
//   • Closed-week truth is GLOBAL: driver_ledger_meta/closed_through, written only by the close. An accrual is "late"
//     iff its week ≤ closed_through — never inferred from one driver's statement.
//   • One accrual per ORDER, globally: driver_ledger_orders/{order_id} (create-if-absent) fixes the driver, week and kind
//     before the event is written; a later stamp CHANGE never accrues again — it is recorded once as unresolved
//     'attribution_changed' for manual handling (no tool, by ruling).
//   • Pagination: a forward cursor (delivered_at, key) with startAt(value, key) tie-breaking; the 48 h overlap is a
//     SEPARATE pass with its own cap and its own rotating cursor; the unresolved re-check is a bounded page with a
//     continuation key. No pass can starve another.
//   • Carry is DERIVED at close from the previous week's stored statements; the week index is written BEFORE a statement
//     and closed_through only after every statement of the week exists, so a crash at any point re-runs to completion.
//
//   platform_config/driver_pay              { base_cents, ledger_start_at, policy_version }   Sherpa-only; absent = OFF
//   driver_ledger_orders/{order_id}         { driver_uid, week, kind, original_week? }        the ONE accrual of an order
//   driver_ledger/{uid}/events/{order_id}   the accrual, as fixed by its order claim
//   driver_ledger/{uid}/weeks/{week}        the IMMUTABLE weekly statement (+ its payment, set once by «Marcar pagado»)
//   driver_ledger_week_index/{week}/{uid}   drivers a week's close must visit
//   driver_ledger_unresolved/{order_id}     no protected stamp ('no_stamp') or a changed one ('attribution_changed')
//   driver_ledger_meta                      { fwd:{at,key}, ovl:{at,key}, unres_key, closed_through, lock }
//
// S8 never reads or writes cash-to-remit / cuadre paths. /orders is read only through bounded delivered_at pages and one
// order at a time (the unresolved re-check).
const C = require('./ledger-core');

const OVERLAP_MS = 48 * 3600 * 1000;
const LEASE_MS = 9 * 60 * 1000;            // > the function timeout (300 s): a live run always holds it
const FWD_PAGE = 200, FWD_PAGES = 10, OVL_PAGE = 200, OVL_PAGES = 2, UNRES_PAGE = 50;

async function val(db, p) { const s = await db.ref(p).once('value'); return s.val(); }
async function readConfig(db) { return C.readPayConfig(await val(db, 'platform_config/driver_pay')); }

// ── the lease ──
async function acquireLease(db, owner, now) {
  let got = false;
  await db.ref('driver_ledger_meta/lock').transaction((cur) => {
    got = false;
    if (cur && cur.owner !== owner && Number(cur.expires_at) > now) return undefined;   // held by a live run
    got = true;
    return { owner, expires_at: now + LEASE_MS };
  });
  return got;
}
async function releaseLease(db, owner) {
  // cold null → commit null (a no-op where absent; rejected and re-run where a lock exists) — never abort on the cached null
  await db.ref('driver_ledger_meta/lock').transaction((cur) => (cur === null || cur.owner === owner ? null : undefined));
}

/* ONE order through the ledger. The order claim decides everything once; the event and the week index are derived from
   the claim, so a crash between the claim and the event is repaired by the next pass with the SAME values. */
async function accrueOrder(db, orderId, order, cfg, now, closedThrough) {
  if (!C.isAccruable(order, cfg)) return 'skip';
  const stamp = order.delivered_by_driver_uid;
  const claimed = await val(db, `driver_ledger_orders/${orderId}`);
  if (claimed) {
    if (stamp !== claimed.driver_uid) {                                // attribution CHANGED after accrual: never accrue twice
      await db.ref(`driver_ledger_unresolved/${orderId}`).transaction((cur) => (cur === null
        ? { order_id: orderId, delivered_at: order.delivered_at, week: claimed.week, reason: 'attribution_changed', accrued_to: claimed.driver_uid, stamp_now: typeof stamp === 'string' ? stamp : null, first_seen_at: now }
        : undefined));
      return 'attribution_changed';
    }
    await putEvent(db, orderId, order, cfg, claimed);                   // repair a half-written accrual (idempotent)
    await db.ref(`driver_ledger_unresolved/${orderId}`).remove();
    return 'exists';
  }
  if (typeof stamp !== 'string' || !stamp) {
    const ut = await db.ref(`driver_ledger_unresolved/${orderId}`).transaction((cur) => (cur === null
      ? { order_id: orderId, delivered_at: order.delivered_at, week: C.weekOf(order.delivered_at), reason: 'no_stamp', restaurant_id: order.restaurant_id || null, first_seen_at: now }
      : undefined));
    return ut.committed ? 'unresolved' : 'still_unresolved';
  }
  const own = C.weekOf(order.delivered_at);
  const late = closedThrough != null && C.weekBounds(own).start <= C.weekBounds(closedThrough).start;
  const claim = late ? { driver_uid: stamp, week: C.weekOf(now), kind: 'late', original_week: own } : { driver_uid: stamp, week: own, kind: 'delivery' };
  const tx = await db.ref(`driver_ledger_orders/${orderId}`).transaction((cur) => (cur === null ? claim : undefined));
  const fixed = tx.committed ? claim : tx.snapshot.val();
  if (!fixed || fixed.driver_uid !== stamp) return 'raced';            // impossible under the single writer; never pay twice
  await putEvent(db, orderId, order, cfg, fixed);
  await db.ref(`driver_ledger_unresolved/${orderId}`).remove();
  return tx.committed ? 'created' : 'exists';
}
async function putEvent(db, orderId, order, cfg, claim) {
  const event = { order_id: orderId, driver_uid: claim.driver_uid, delivered_at: order.delivered_at, base_cents: cfg.base_cents, policy_version: cfg.policy_version,
    week: claim.week, kind: claim.kind, ...(claim.original_week ? { original_week: claim.original_week } : {}) };
  await db.ref(`driver_ledger_week_index/${claim.week}/${claim.driver_uid}`).set(true);
  await db.ref(`driver_ledger/${claim.driver_uid}/events/${orderId}`).transaction((cur) => (cur === null ? event : undefined));
}

// One bounded page of orders by (delivered_at, key), strictly after `from` (tie-broken by key), up to `until` if given.
async function pageAfter(db, from, size, until) {
  const q = from.key
    ? db.ref('orders').orderByChild('delivered_at').startAt(from.at, from.key).limitToFirst(size + 1)
    : db.ref('orders').orderByChild('delivered_at').startAt(from.at).limitToFirst(size);
  const snap = await q.once('value');
  const rows = []; snap.forEach((c) => { rows.push([c.key, c.val()]); });
  const out = rows.filter(([k, o]) => !(from.key && k === from.key && o && o.delivered_at === from.at))
    .filter(([, o]) => o && typeof o.delivered_at === 'number' && (until == null || o.delivered_at <= until));
  return { rows: out.slice(0, size), full: rows.length >= size + (from.key ? 1 : 0) };
}

/* THE RUN: lease → forward pass → overlap pass → unresolved re-check → close-if-due → release. */
async function runLedger(db, now, opts = {}) {
  const owner = opts.owner || `run_${now}_${Math.random().toString(36).slice(2, 10)}`;
  const cfg = await readConfig(db);
  if (!cfg) return { off: true };
  if (!(await acquireLease(db, owner, now))) return { locked: true };
  try {
    const meta = (await val(db, 'driver_ledger_meta')) || {};
    const closedThrough = meta.closed_through || null;
    const out = { created: 0, unresolved: 0, changed: 0, resolved: 0, closed: [] };
    const tally = (r) => { if (r === 'created') out.created++; else if (r === 'unresolved') out.unresolved++; else if (r === 'attribution_changed') out.changed++; };

    // forward: from the persisted (at, key), never re-reading what it has passed
    let fwd = meta.fwd || { at: cfg.ledger_start_at, key: null }, caughtUp = false;
    for (let p = 0; p < (opts.fwdPages || FWD_PAGES); p++) {
      const { rows, full } = await pageAfter(db, fwd, opts.fwdPage || FWD_PAGE);
      for (const [oid, o] of rows) { tally(await accrueOrder(db, oid, o, cfg, now, closedThrough)); fwd = { at: o.delivered_at, key: oid }; }
      await db.ref('driver_ledger_meta/fwd').set(fwd);
      if (!full) { caughtUp = true; break; }
    }

    // overlap: a SEPARATE bounded pass over [fwd.at − 48 h, fwd.at] with its own rotating cursor (late / offline syncs,
    // a stamp that arrived or changed after the forward pass)
    const winStart = Math.max(cfg.ledger_start_at, fwd.at - OVERLAP_MS);
    let ovl = meta.ovl && meta.ovl.at >= winStart ? meta.ovl : { at: winStart, key: null };
    for (let p = 0; p < (opts.ovlPages || OVL_PAGES); p++) {
      const { rows, full } = await pageAfter(db, ovl, opts.ovlPage || OVL_PAGE, fwd.at);
      for (const [oid, o] of rows) { tally(await accrueOrder(db, oid, o, cfg, now, closedThrough)); ovl = { at: o.delivered_at, key: oid }; }
      if (!full || rows.length === 0) { ovl = { at: winStart, key: null }; break; }      // reached the forward cursor: wrap
    }
    await db.ref('driver_ledger_meta/ovl').set(ovl);

    // unresolved: one bounded page after the stored continuation key, wrapping at the end
    const unresPage = opts.unresPage || UNRES_PAGE;
    const uq = meta.unres_key
      ? db.ref('driver_ledger_unresolved').orderByKey().startAfter(meta.unres_key).limitToFirst(unresPage)
      : db.ref('driver_ledger_unresolved').orderByKey().limitToFirst(unresPage);
    const usnap = await uq.once('value');
    const ukeys = []; usnap.forEach((c) => { ukeys.push(c.key); });
    for (const oid of ukeys) {
      const o = await val(db, `orders/${oid}`);
      if (o && (await accrueOrder(db, oid, o, cfg, now, closedThrough)) === 'created') out.resolved++;
    }
    await db.ref('driver_ledger_meta/unres_key').set(ukeys.length === unresPage ? ukeys[ukeys.length - 1] : null);

    // close-if-due: only once the forward pass has caught up (everything delivered so far is accrued)
    if (caughtUp) out.closed = await closeDue(db, now, cfg, closedThrough);
    return out;
  } finally {
    await releaseLease(db, owner);
  }
}

// Close every finished week after closed_through, in order. Per week: the drivers = those indexed in it ∪ those whose
// previous statement carries a negative balance; index BEFORE statement; closed_through only after all statements.
async function closeDue(db, now, cfg, closedThrough) {
  const target = C.prevWeek(C.weekOf(now));
  let w = closedThrough ? C.nextWeek(closedThrough) : C.weekOf(cfg.ledger_start_at);
  const closed = [];
  for (let guard = 0; guard < 60 && C.weekBounds(w).start <= C.weekBounds(target).start; guard++, w = C.nextWeek(w)) {
    const prevW = C.prevWeek(w);
    const drivers = new Set(Object.keys((await val(db, `driver_ledger_week_index/${w}`)) || {}));
    for (const uid of Object.keys((await val(db, `driver_ledger_week_index/${prevW}`)) || {})) {
      const ps = await val(db, `driver_ledger/${uid}/weeks/${prevW}`);
      if (ps && !ps.payment && ps.net_cents < 0) drivers.add(uid);         // carry, derived from the stored statement
    }
    for (const uid of drivers) {
      await db.ref(`driver_ledger_week_index/${w}/${uid}`).set(true);       // BEFORE the statement (crash-safe carry chain)
      if (await closeDriverWeek(db, uid, w, now)) closed.push(`${w}/${uid}`);
    }
    await db.ref('driver_ledger_meta/closed_through').set(w);              // ONLY after every statement of w exists
  }
  return closed;
}

async function closeDriverWeek(db, uid, week, now) {
  const evSnap = await db.ref(`driver_ledger/${uid}/events`).orderByChild('week').equalTo(week).once('value');
  const events = []; evSnap.forEach((c) => { events.push(c.val()); });
  const prev = await val(db, `driver_ledger/${uid}/weeks/${C.prevWeek(week)}`);
  const st = { ...C.statementFor(week, events, prev), closed_at: now };
  const tx = await db.ref(`driver_ledger/${uid}/weeks/${week}`).transaction((cur) => (cur === null ? st : undefined));
  return tx.committed;
}

/* «Marcar pagado» — a compare-and-set on a CLOSED statement's payment (it never touches anything the run writes).
   Same op_key again → the recorded payment (idempotent retry); anything else on a paid week → REFUSED with who/when. */
async function markPaid(db, { uid, week, amount_cents, reference, paid_on, op_key, actor }, now) {
  if (typeof uid !== 'string' || !uid || !C.WEEK_RE.test(String(week))) return { ok: false, reason: 'bad_request' };
  let outcome = null;
  await db.ref(`driver_ledger/${uid}/weeks/${week}`).transaction((cur) => {
    outcome = null;
    // 🔴 RTDB calls a transaction handler FIRST with the locally cached value — null on a cold handle — and re-runs it
    // with the server's value only if our write conflicts. Committing null is a no-op where the node is truly absent,
    // and is rejected (→ re-run with the real statement) where it exists; aborting here would refuse every first call.
    if (cur === null) { outcome = { ok: false, reason: 'not_closed' }; return null; }
    if (cur.payment) {
      outcome = cur.payment.op_key === op_key ? { ok: true, idempotent: true, payment: cur.payment }
        : { ok: false, reason: 'already_paid', by: cur.payment.by, at: cur.payment.at };
      return undefined;
    }
    const v = C.validatePayment(cur, { amount_cents, reference, paid_on, op_key });
    if (!v.ok) { outcome = v; return undefined; }
    const payment = { ...v.payment, by: actor, at: now };
    outcome = { ok: true, payment };
    return { ...cur, payment };
  });
  return outcome || { ok: false, reason: 'aborted' };
}

module.exports = { OVERLAP_MS, LEASE_MS, readConfig, accrueOrder, runLedger, closeDue, closeDriverWeek, markPaid, acquireLease, releaseLease };
