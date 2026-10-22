'use strict';
// S8 — THE DRIVER PAYABLE LEDGER, STORE (RTDB). Every write is order-keyed or create-if-absent, so a retry, a crash
// mid-run or two overlapping runs can never double an accrual or a payment.
//
//   platform_config/driver_pay              { base_cents, ledger_start_at, policy_version }   Sherpa-only; absent = OFF
//   driver_ledger/{uid}/events/{order_id}   one accrual per delivered order (kind delivery | late)
//   driver_ledger/{uid}/weeks/{week}        the IMMUTABLE weekly statement (+ its payment, set once by «Marcar pagado»)
//   driver_ledger_week_index/{week}/{uid}   which drivers a week's close must visit (no full-node scan)
//   driver_ledger_unresolved/{order_id}     a delivery with no protected stamp — listed, held out of every balance
//   driver_ledger_meta                      { cursor, last_closed_week }
//
// S8 never reads or writes cash-to-remit / cuadre paths (driver-ledger.guard asserts it). The ONLY order read is the
// bounded delivered_at window below (orders/.indexOn delivered_at) and the per-order re-read of an unresolved entry.
const C = require('./ledger-core');

const OVERLAP_MS = 48 * 3600 * 1000;        // re-read behind the cursor every run (late / offline syncs; idempotent)
const PAGE = 200;

async function val(db, p) { const s = await db.ref(p).once('value'); return s.val(); }

async function readConfig(db) { return C.readPayConfig(await val(db, 'platform_config/driver_pay')); }

// Create the event if absent (order-keyed → idempotent). Returns 'created' | 'exists'.
async function putEvent(db, uid, event) {
  const tx = await db.ref(`driver_ledger/${uid}/events/${event.order_id}`).transaction((cur) => (cur === null ? event : undefined));
  // the week index is (re)asserted on EVERY pass, created or not: a crash between the event and its index heals on the
  // next sweep (an idempotent set), so a week's close can never miss a driver who has an event in it
  const stored = tx.committed ? event : tx.snapshot.val();
  await db.ref(`driver_ledger_week_index/${(stored && stored.week) || event.week}/${uid}`).set(true);
  return tx.committed ? 'created' : 'exists';
}

/* One order through the ledger. A delivery accrued into a week whose statement appeared between our check and our write
   (the weekly close racing this sweep) is RE-HOMED as a late adjustment in the current week: the re-read happens after
   our own write, so in either interleaving the event lands in exactly one statement. */
async function accrueOrder(db, orderId, order, cfg, now) {
  const currentWeek = C.weekOf(now);
  const closedCache = {};
  const isClosed = (w) => closedCache[w];
  const a0 = C.accrualFor(orderId, order, cfg, { currentWeek, isClosed: () => false });
  if (!a0) return 'skip';
  if (a0.kind === 'unresolved') {
    await db.ref(`driver_ledger_unresolved/${orderId}`).transaction((cur) => (cur === null ? { ...a0.entry, first_seen_at: now } : undefined));
    return 'unresolved';
  }
  const uid = a0.driverUid;
  const ownWeek = a0.event.week;
  closedCache[ownWeek] = (await val(db, `driver_ledger/${uid}/weeks/${ownWeek}`)) !== null;
  const a = C.accrualFor(orderId, order, cfg, { currentWeek, isClosed });
  const r = await putEvent(db, uid, a.event);
  await db.ref(`driver_ledger_unresolved/${orderId}`).remove();       // a late stamp resolves its entry in place
  if (r === 'created' && a.event.kind === 'delivery') {
    const st = await val(db, `driver_ledger/${uid}/weeks/${ownWeek}`);
    if (st && !(st.order_ids || []).includes(orderId)) {               // closed while we wrote: re-home as a late adjustment
      await db.ref(`driver_ledger/${uid}/events/${orderId}`).update({ week: currentWeek, original_week: ownWeek, kind: 'late' });
      await db.ref(`driver_ledger_week_index/${currentWeek}/${uid}`).set(true);
    }
  }
  return r;
}

/* THE ONLY WRITER of accruals: a bounded sweep over orders by delivered_at, from max(start, cursor − 48 h), page by page,
   then a re-check of every open unresolved entry (a stamp that arrived after the order was swept). */
async function repairSweep(db, now, { pageSize = PAGE, maxPages = 20 } = {}) {
  const cfg = await readConfig(db);
  if (!cfg) return { off: true };
  const meta = (await val(db, 'driver_ledger_meta')) || {};
  let from = Math.max(cfg.ledger_start_at, (Number(meta.cursor) || cfg.ledger_start_at) - OVERLAP_MS);
  let seen = 0, created = 0, unresolved = 0, maxAt = Number(meta.cursor) || cfg.ledger_start_at;
  for (let p = 0; p < maxPages; p++) {
    const snap = await db.ref('orders').orderByChild('delivered_at').startAt(from).limitToFirst(pageSize).once('value');
    const rows = [];
    snap.forEach((c) => { rows.push([c.key, c.val()]); });
    for (const [oid, o] of rows) {
      seen++;
      const r = await accrueOrder(db, oid, o, cfg, now);
      if (r === 'created') created++; else if (r === 'unresolved') unresolved++;
      if (o && typeof o.delivered_at === 'number' && o.delivered_at > maxAt) maxAt = o.delivered_at;
    }
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1][1].delivered_at;
    if (!(last > from)) break;                                         // a full page at one instant: the next run continues
    from = last;
  }
  let resolved = 0;
  const open = (await val(db, 'driver_ledger_unresolved')) || {};
  for (const oid of Object.keys(open)) {
    const o = await val(db, `orders/${oid}`);
    if (o && typeof o.delivered_by_driver_uid === 'string' && o.delivered_by_driver_uid) {
      if ((await accrueOrder(db, oid, o, cfg, now)) !== 'unresolved') resolved++;
    }
  }
  await db.ref('driver_ledger_meta/cursor').set(maxAt);
  return { seen, created, unresolved, resolved, cursor: maxAt };
}

// Close ONE week for ONE driver: the statement is created if absent and never rewritten.
async function closeDriverWeek(db, uid, week, now) {
  const evSnap = await db.ref(`driver_ledger/${uid}/events`).orderByChild('week').equalTo(week).once('value');
  const events = []; evSnap.forEach((c) => { events.push(c.val()); });
  const prev = await val(db, `driver_ledger/${uid}/weeks/${C.prevWeek(week)}`);
  const st = { ...C.statementFor(week, events, prev), closed_at: now };
  const tx = await db.ref(`driver_ledger/${uid}/weeks/${week}`).transaction((cur) => (cur === null ? st : undefined));
  if (tx.committed && st.outcome === 'no_payment' && st.net_cents < 0) {
    await db.ref(`driver_ledger_week_index/${C.nextWeek(week)}/${uid}`).set(true);   // the carry must reach next week's close
  }
  return tx.committed ? st : null;
}

// Close every finished, not-yet-closed week up to the one that ended before `now` (catches up after a missed run).
async function closeWeeks(db, now) {
  const cfg = await readConfig(db);
  if (!cfg) return { off: true };
  const target = C.prevWeek(C.weekOf(now));
  const meta = (await val(db, 'driver_ledger_meta')) || {};
  let w = meta.last_closed_week ? C.nextWeek(meta.last_closed_week) : C.weekOf(cfg.ledger_start_at);
  const closed = [];
  for (let guard = 0; guard < 60 && C.weekBounds(w).start <= C.weekBounds(target).start; guard++, w = C.nextWeek(w)) {
    const drivers = Object.keys((await val(db, `driver_ledger_week_index/${w}`)) || {});
    for (const uid of drivers) if (await closeDriverWeek(db, uid, w, now)) closed.push(`${w}/${uid}`);
    await db.ref('driver_ledger_meta/last_closed_week').set(w);
  }
  return { closed };
}

/* «Marcar pagado» — a compare-and-set on the statement's payment. Same op_key again → the recorded payment (idempotent
   retry); anything else on a paid week → REFUSED with who/when. The amount must equal the net (FULL settlement). */
async function markPaid(db, { uid, week, amount_cents, reference, paid_on, op_key, actor }, now) {
  if (typeof uid !== 'string' || !uid || !C.WEEK_RE.test(String(week))) return { ok: false, reason: 'bad_request' };
  let outcome = null;
  await db.ref(`driver_ledger/${uid}/weeks/${week}`).transaction((cur) => {
    outcome = null;
    // 🔴 RTDB calls a transaction handler FIRST with the locally cached value — null on a cold handle — and re-runs it
    // with the server's value only if our write conflicts. Aborting on null would refuse every first «Marcar pagado»
    // (caught by test/driver-ledger.emulator.test.js cell 11). Committing null is a no-op where the node is truly
    // absent, and is rejected (→ re-run with the real statement) where it exists.
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

module.exports = { OVERLAP_MS, readConfig, accrueOrder, repairSweep, closeDriverWeek, closeWeeks, markPaid };
