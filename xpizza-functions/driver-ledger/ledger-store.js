'use strict';
// S8 — THE DRIVER PAYABLE LEDGER, STORE (RTDB). r3 (codex r2 → advisor redesign, owner rule: simplicity): there is NO
// incremental ledger — no events, claims, cursors, unresolved paging or lease. /orders (delivered_at + the protected
// delivered_by_driver_uid) is the source of truth, and each week is closed by ONE create-if-absent transaction:
//
//   platform_config/driver_pay        { base_cents, ledger_start_at, policy_version }   Sherpa-only; absent = OFF
//   driver_ledger_weeks/{week}        the WHOLE closed week (ledger-core.js computeWeek) + closed_at; written once;
//                                     only drivers/{uid}/paid is ever set afterwards («Marcar pagado»)
//
// A crash before the commit writes nothing; a concurrent close loses its transaction and no-ops; weeks close oldest first
// so carries chain. The open week is DERIVED on read (previewWeek) and never written.
//
// S8 never reads or writes cash-to-remit / cuadre paths. /orders is read only through the bounded delivered_at range query.
const C = require('./ledger-core');

const MAX_CLOSES_PER_RUN = 60;

async function val(db, p) { const s = await db.ref(p).once('value'); return s.val(); }
async function readConfig(db) { return C.readPayConfig(await val(db, 'platform_config/driver_pay')); }

// Orders delivered in [from, to): ONE bounded index range query (orders/.indexOn delivered_at).
async function ordersIn(db, { from, to }) {
  const snap = await db.ref('orders').orderByChild('delivered_at').startAt(from).endAt(to - 1).once('value');
  const rows = []; snap.forEach((c) => { rows.push([c.key, c.val()]); });
  return rows;
}
async function readWeek(db, week) { return val(db, `driver_ledger_weeks/${week}`); }
// ALL closed weeks before `week`, read ONCE (closed weeks are immutable; only closeWeek creates them): the dedupe memory.
async function closedBefore(db, week) {
  const snap = await db.ref('driver_ledger_weeks').orderByKey().endAt(C.prevWeek(week)).once('value');
  const nodes = []; snap.forEach((c) => { nodes.push(c.val()); });
  return nodes;
}
async function computeFor(db, week, cfg) {
  const prior = await closedBefore(db, week);
  return C.computeWeek(week, await ordersIn(db, C.windowOf(week)), prior, cfg);
}

// Close ONE week: compute, then a single create-if-absent transaction. → true if this call wrote it.
async function closeWeek(db, week, cfg, now) {
  const node = { ...(await computeFor(db, week, cfg)), closed_at: now };
  // cold null → commit (absent: created; present: the server rejects and re-runs with the real node → abort)
  const tx = await db.ref(`driver_ledger_weeks/${week}`).transaction((cur) => (cur === null ? node : undefined));
  return tx.committed;
}

// The week to close next: the one after the newest closed week, or the go-live week.
async function nextToClose(db, cfg) {
  const snap = await db.ref('driver_ledger_weeks').orderByKey().limitToLast(1).once('value');
  let last = null; snap.forEach((c) => { last = c.key; });
  return last ? C.nextWeek(last) : C.weekOf(cfg.ledger_start_at);
}

/* THE SCHEDULED RUN: close every finished week, oldest first (a missed run catches up and carries chain). */
async function closeDue(db, now) {
  const cfg = await readConfig(db);
  if (!cfg) return { off: true };
  const target = C.prevWeek(C.weekOf(now));
  const closed = [];
  let w = await nextToClose(db, cfg);
  for (let i = 0; i < MAX_CLOSES_PER_RUN && C.weekBounds(w).start <= C.weekBounds(target).start; i++, w = C.nextWeek(w)) {
    if (await closeWeek(db, w, cfg, now)) closed.push(w);
  }
  return { closed };
}

/* The read for «Pagos»: a closed week as stored; the open week DERIVED (no write). The open week is shown only once the
   previous week is closed (its included lists decide what is late) — otherwise { pending_close: true }. */
async function previewWeek(db, week, now) {
  const cfg = await readConfig(db);
  if (!cfg) return { off: true };
  const w = week || C.weekOf(now);
  const stored = await readWeek(db, w);
  if (stored) return { closed: true, week: stored };
  if (C.weekBounds(w).start > now) return { future: true };
  if (C.weekBounds(w).start > C.weekBounds(C.weekOf(cfg.ledger_start_at)).start && !(await readWeek(db, C.prevWeek(w)))) return { pending_close: true };
  return { open: true, week: await computeFor(db, w, cfg) };
}

/* «Marcar pagado» — a compare-and-set on ONE driver's entry of a CLOSED week. Same op_key again → the recorded payment
   (idempotent retry); anything else on a paid entry → REFUSED with who/when. The close never touches an existing week. */
async function markPaid(db, { uid, week, amount_cents, reference, paid_on, op_key, actor }, now) {
  if (typeof uid !== 'string' || !uid || /[.#$[\]/]/.test(uid) || !C.WEEK_RE.test(String(week))) return { ok: false, reason: 'bad_request' };
  let outcome = null;
  await db.ref(`driver_ledger_weeks/${week}/drivers/${uid}`).transaction((cur) => {
    outcome = null;
    // 🔴 RTDB calls a transaction handler FIRST with the locally cached value — null on a cold handle — and re-runs it
    // with the server's value only if our write conflicts. Committing null is a no-op where the node is truly absent,
    // and is rejected (→ re-run with the real entry) where it exists; aborting here would refuse every first call.
    if (cur === null) { outcome = { ok: false, reason: 'not_closed' }; return null; }
    if (cur.paid) {
      outcome = cur.paid.op_key === op_key ? { ok: true, idempotent: true, payment: cur.paid }
        : { ok: false, reason: 'already_paid', by: cur.paid.by, at: cur.paid.at };
      return undefined;
    }
    const v = C.validatePayment(cur, { amount_cents, reference, paid_on, op_key });
    if (!v.ok) { outcome = v; return undefined; }
    const payment = { ...v.payment, by: actor, at: now };
    outcome = { ok: true, payment };
    return { ...cur, paid: payment };
  });
  return outcome || { ok: false, reason: 'aborted' };
}

module.exports = { readConfig, ordersIn, closeWeek, closeDue, previewWeek, markPaid };
