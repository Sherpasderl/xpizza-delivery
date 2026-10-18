'use strict';
// H1a amendment A-R1 r3 §3 + BC1/BC3 — the reject REPAIR pass, run once per the stuck-orders sweep tick on the snapshot that sweep
// already read (no extra /orders read). It repairs from PERSISTED state only: it never calls the cancel core, never voids or
// refunds, and never clears a claim.
//
//   status 'new', cancel claim held (crash after the core's claim)  → notice claim_held
//   status 'new', outcome manual_review                             → notice manual_review (a lost notice write)
//   status 'new', otherwise                                         → notice stranded
//   status 'cancelled', no outcome (crash after finalize)           → outcome cancelled | refund_pending from payment_status,
//                                                                      refund_pending's notice FIRST
//   status 'cancelled', outcome refund_pending                      → notice refund_pending
//   status delivered | completed (codex r1 P2-4)                    → outcome not_cancelable + its notice
//   status pending_payment + manual_reconciliation (codex r1 P2-4)  → outcome referred_recon + its notice
//   any other live status (e.g. preparing), no outcome               → the same claim_held / manual_review / stranded rules as 'new'
// A notice "exists" when merchant_reject_notices/{oid}/{kind} is set (written atomically WITH the alert, by the handler too),
// so a pruned alert is never re-raised.
//
// BC1 forward progress: HANDLED orders (nothing left to repair) are excluded BEFORE the cap; the oldest UNHANDLED go first.
// BC3: each candidate in its own try/catch; the pass stops starting candidates once its time budget is spent.
// Bounds: reject_intent.at between 2 min and 24 h old; cap 25 per run; markers outside the window are pruned (cap 100).
const R = require('./merchant-reject');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TERMINAL_SUCCESS = new Set(['delivered', 'completed']);   // cancel-order.js gate: not cancelable
const MIN_AGE_MS = 2 * 60000;
const WINDOW_MS = 24 * 3600000;
const CAP = 25;
const BUDGET_MS = 30000;
const PRUNE_CAP = 100;

// What a candidate still needs: { notice: kind|null, outcome: state|null, at } — or null (not a candidate, or handled).
function needs(order, notices, nowMs) {
  if (!isObj(order) || !isObj(order.reject_intent) || !isObj(order.handheld_answered) || order.handheld_answered.kind !== 'rejected') return null;
  const at = order.reject_intent.at;
  if (typeof at !== 'number' || nowMs - at < MIN_AGE_MS || nowMs - at > WINDOW_MS) return null;
  const opId = order.reject_intent.op_id;
  const out = isObj(order.reject_outcome) && order.reject_outcome.op_id === opId ? order.reject_outcome : null;
  let notice = null; let outcome = null;
  if (order.status === 'cancelled') {
    if (!out) {
      outcome = order.payment_status === 'refund_pending' ? 'refund_pending' : 'cancelled';
      if (outcome === 'refund_pending') notice = 'refund_pending';
    } else if (out.state === 'refund_pending') notice = 'refund_pending';
  } else if (TERMINAL_SUCCESS.has(order.status)) {
    // codex r1 P2-4: the core refuses a delivered/completed order (not_cancelable) — truthful outcome + its notice
    if (!out) { outcome = 'not_cancelable'; notice = 'not_cancelable'; } else if (out.state === 'not_cancelable') notice = 'not_cancelable';
  } else if (order.status === 'pending_payment' && order.payment_status === 'manual_reconciliation') {
    // codex r1 P2-4: in the recon surface the core refers it there (in_recon_surface)
    if (!out) { outcome = 'referred_recon'; notice = 'referred_recon'; } else if (out.state === 'referred_recon') notice = 'referred_recon';
  } else if (order.resolving_action === 'cancel' && order.cancel_claim_id) notice = 'claim_held';
  else if (out && out.state === 'manual_review') notice = 'manual_review';
  else if (order.status === 'new' || !out) notice = 'stranded';   // a live order whose reject never got a known result
  else return null;
  if (notice && isObj(notices) && notices[notice] != null) notice = null;
  if (!notice && !outcome) return null;
  return { notice, outcome, at, opId, outState: out ? out.state : null };
}

// Pure: the oldest unhandled candidates, at most `cap`.
function selectCandidates(orders, noticesByOid, nowMs, cap = CAP) {
  const list = [];
  for (const [oid, order] of Object.entries(orders || {})) {
    const n = needs(order, (noticesByOid || {})[oid], nowMs);
    if (n) list.push({ oid, ...n });
  }
  list.sort((a, b) => (a.at - b.at) || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return list.slice(0, cap);
}

// Pure: marker oids to drop — the order is gone, no longer a handheld reject, or its reject is outside the window.
function staleMarkers(orders, noticesByOid, nowMs, cap = PRUNE_CAP) {
  const out = [];
  for (const oid of Object.keys(noticesByOid || {}).sort()) {
    const o = (orders || {})[oid];
    const at = isObj(o) && isObj(o.reject_intent) ? o.reject_intent.at : null;
    if (typeof at !== 'number' || nowMs - at > WINDOW_MS) out.push(oid);
    if (out.length >= cap) break;
  }
  return out;
}

// deps: { db, clock } (clock = wall time for the budget). Returns counters; throws only if the marker read fails.
async function repairRejects(deps, orders, nowMs, opts = {}) {
  const { db, clock } = deps;
  const budgetMs = opts.budgetMs || BUDGET_MS;
  const started = clock();
  const noticesByOid = (await db.ref('merchant_reject_notices').once('value')).val() || {};
  const picked = selectCandidates(orders, noticesByOid, nowMs, opts.cap || CAP);
  const stats = { selected: picked.length, repaired: 0, failed: 0, budget_stopped: 0, pruned: 0 };
  for (const c of picked) {
    if (clock() - started > budgetMs) { stats.budget_stopped = picked.length - stats.repaired - stats.failed; break; }
    try {
      const order = orders[c.oid];
      if (c.notice) await R.writeNotice(db, c.notice, c.oid, order, { outcome: c.outcome || c.outState }, nowMs);
      if (c.outcome) await R.writeOutcome(db, c.oid, c.opId, { state: c.outcome, at: nowMs, op_id: c.opId, by: 'sweep' });
      stats.repaired++;
    } catch (e) {
      stats.failed++;
      console.error(`rejectRepair: ${c.oid} failed`, e && e.message);
    }
  }
  const stale = staleMarkers(orders, noticesByOid, nowMs);
  if (stale.length && clock() - started <= budgetMs) {
    try {
      await db.ref('merchant_reject_notices').update(Object.fromEntries(stale.map((oid) => [oid, null])));
      stats.pruned = stale.length;
    } catch (e) { console.error('rejectRepair: marker prune failed', e && e.message); }
  }
  return stats;
}

module.exports = { needs, selectCandidates, staleMarkers, repairRejects, MIN_AGE_MS, WINDOW_MS, CAP, BUDGET_MS };
