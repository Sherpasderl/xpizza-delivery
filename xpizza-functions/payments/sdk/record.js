'use strict';
// SDK payment record (PLAN-capp-native-shell-and-payments §2.11; BRIEF-sdk-payment-coordinator r5 §6). The record lives at the
// server-only payment_sdk/{orderId}; every write is a CAS on `version` (casRecord) and recomputes `derived`. Integer cents.
const TERMINAL = Object.freeze(['delivered', 'completed']);
const LEG_FINAL = Object.freeze(['captured', 'voided', 'expired', 'declined']);
const MONEY_ACTIONS = Object.freeze(['auth', 'capture', 'void']);
const HOLD_MS = 15 * 24 * 3600 * 1000;   // BAC hold window
const TTL_MS = 15 * 60 * 1000;           // sdk pending_payment TTL (server-arbitrated)

const obj = (v) => (v && typeof v === 'object' ? v : {});
const legsOf = (rec) => obj(rec && rec.legs);
const opsOf = (rec) => obj(rec && rec.ops);
const isInt = (n) => Number.isInteger(n) && n >= 0;

// The money figures, DERIVED from the legs (never patched). A captured committed leg stays in the authorization basis.
function derive(rec) {
  let committed = 0; let captured = 0; let live = 0;
  for (const l of Object.values(legsOf(rec))) {
    if (l.role === 'committed' && (l.state === 'approved' || l.state === 'captured')) committed += l.amount_cents;
    if (l.state === 'captured') captured += l.amount_cents;
    if (l.state === 'approved') live += 1;
  }
  const f = rec.fulfillment_total_cents;
  return { committed_auth_total: committed, captured_total: captured, refund_liability: Math.max(0, committed - f), delta_needed: Math.max(0, f - committed), live_holds: live };
}

const unansweredMoneyOps = (rec) => Object.entries(opsOf(rec)).filter(([, o]) => MONEY_ACTIONS.includes(o.action) && !o.result).map(([id]) => id);
const pendingProjection = (rec, order) => !!(order && order.payment_commit && order.payment_commit.revision > (rec.committed_revision || 0));

// Financially closed (r5 §6): every issued op answered, every leg final, no lock, no pending projection, settlement complete
// where a capture set exists, every obligation verified.
function isFinanciallyClosed(rec, order) {
  if (!rec) return false;
  if (rec.lock) return false;
  if (Object.values(opsOf(rec)).some((o) => !o.result)) return false;
  if (Object.values(legsOf(rec)).some((l) => !LEG_FINAL.includes(l.state))) return false;
  if (pendingProjection(rec, order)) return false;
  if (rec.frozen && (rec.frozen.capture_set || []).some((id) => !legsOf(rec)[id] || legsOf(rec)[id].state !== 'captured')) return false;
  if (rec.phase === 'open' || rec.phase === 'adjusting') return false;   // an open order is not closed
  return Object.values(obj(rec.obligations)).every((o) => o.state === 'verified');
}

// CAS on version: fn(record) returns the next record or undefined to abort. Null-first safe: an absent record is never
// fabricated (returns null, which is a no-op when the server is also absent). Resolves { applied, record }.
async function casRecord(db, orderId, fn) {
  let applied = false;
  const res = await db.ref(`payment_sdk/${orderId}`).transaction((cur) => {
    applied = false;
    if (cur == null) return null;
    const next = fn(JSON.parse(JSON.stringify(cur)));
    if (next === undefined) return undefined;
    next.version = (cur.version || 0) + 1;
    next.derived = derive(next);
    applied = true;
    return next;
  });
  const record = res && res.snapshot ? res.snapshot.val() : null;
  return { applied: !!(res && res.committed && applied && record), record };
}

// Create the record once (absent → created; present → untouched). Resolves { created, record }.
async function createRecord(db, orderId, init) {
  let created = false;
  const res = await db.ref(`payment_sdk/${orderId}`).transaction((cur) => {
    created = false;
    if (cur != null) return undefined;
    const rec = { ...init, version: 1 };
    rec.derived = derive(rec);
    created = true;
    return rec;
  });
  const record = res && res.snapshot ? res.snapshot.val() : null;
  return { created: !!(res && res.committed && created), record };
}

module.exports = { TERMINAL, LEG_FINAL, MONEY_ACTIONS, HOLD_MS, TTL_MS, derive, legsOf, opsOf, isInt, unansweredMoneyOps, pendingProjection, isFinanciallyClosed, casRecord, createRecord };
