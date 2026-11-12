'use strict';
// §4 the durable-state resolver (PLAN-sdk-d4-r5), shared by placeSdkStatus, placement replays and the placement response.
// ONE closed outcome enum with the client's EXACT keys per outcome (capp-pay-card.js readPlacement). Rows in precedence order;
// a replay applies them to THAT attempt, a status read to the order's latest attempt. Payment state always outranks
// `unavailable` (never produced here). No status AMOUNT is relied on anywhere (advisor 11-11).
const R = require('./record');
const { declineBucketOf } = require('./decline-buckets');
const { safeToSwitch } = require('./coordinator');

const latestAttempt = (rec) => {
  let best = null;
  for (const [id, a] of Object.entries((rec && rec.attempts) || {})) if (a && (!best || a.at > best.a.at || (a.at === best.a.at && id > best.id))) best = { id, a };
  return best;
};
const authOpOf = (rec, legId) => {
  let last = null;
  for (const [id, o] of Object.entries(R.opsOf(rec))) if (o.leg_id === legId && o.action === 'auth' && (!last || o.dispatched_at >= last.o.dispatched_at)) last = { id, o };
  return last && last.o;
};
const out = (body) => ({ kind: 'outcome', body });

function resolveStatus(orderId, order, rec, { now, attempt_id } = {}) {
  const pick = attempt_id ? (rec && rec.attempts && rec.attempts[attempt_id] ? { id: attempt_id, a: rec.attempts[attempt_id] } : null) : latestAttempt(rec);
  const leg = pick ? R.legsOfRecord(rec)[pick.a.leg_id] : null;
  // 1. placed (by THIS attempt for a replay); the card label is the WINNING attempt's display; no token yet ⇒ keep polling
  const placedLeg = order && order.payment_placed ? order.payment_placed.leg_id : null;
  if (placedLeg && (!attempt_id || (pick && pick.a.leg_id === placedLeg))) {
    const win = Object.entries((rec && rec.attempts) || {}).find(([, a]) => a && a.leg_id === placedLeg);
    const d = win && win[1].display;
    if (typeof order.tracking_token === 'string' && order.tracking_token && d) return out({ outcome: 'placed', order_id: orderId, tracking_token: order.tracking_token, card: { brand: d.brand, last4: d.last4 } });
    return out({ outcome: 'bank_pending', order_id: orderId, attempt_id: win ? win[0] : (pick ? pick.id : null) });
  }
  // 2. the record locked for manual reconciliation
  if (rec && rec.lock && rec.lock.reason === 'manual_reconciliation') return out({ outcome: 'under_review', order_id: orderId });
  // 3. cancelled / past the deadline, not placed
  const deadline = order && Number.isFinite(order.pay_deadline_at) ? order.pay_deadline_at : rec && Number.isFinite(rec.ttl_at) ? rec.ttl_at : null;
  if (order && (order.payment_cancel || order.status === 'cancelled' || (deadline != null && now >= deadline))) return out({ outcome: 'expired', order_id: orderId, safe_to_switch: safeToSwitch(rec, order) });
  if (!pick || !leg) return { kind: 'no_attempt' };
  // 4. approved, unplaced ⇒ the caller runs decidePlacement
  if (leg.state === 'approved' && leg.role === 'committed') return { kind: 'decide', leg_id: pick.a.leg_id };
  const op = authOpOf(rec, pick.a.leg_id);
  // 6. a challenged original ended its attempt (Q3): declined / hard — never bank_pending
  if (leg.state === 'requires_action') return out({ outcome: 'declined', order_id: orderId, attempt_id: pick.id, decline: 'hard', pay_deadline_at: deadline });
  // 7. a definitive decline + its bucket (never the raw code)
  if (leg.state === 'declined' && op && op.result) return out({ outcome: 'declined', order_id: orderId, attempt_id: pick.id, decline: declineBucketOf(op.result) || 'hard', pay_deadline_at: deadline });
  // 5. unanswered / unknown / anything still open ⇒ bank_pending (reconcileSdkOps owns the evidence)
  return out({ outcome: 'bank_pending', order_id: orderId, attempt_id: pick.id });
}
module.exports = { resolveStatus, latestAttempt };
