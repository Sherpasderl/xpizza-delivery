'use strict';
// GET placeSdkStatus?order_id=… (PLAN-sdk-d4-r5 §4) — the handler core (the HTTP wiring lands in S7). Auth C2/C3 (order-auth.js);
// a non-SDK order ≡ an absent one (404); a status read of a pending order re-enrols it (W1). ONE consistent read of the record:
// no attempt AND no PSP-call record ⇒ 409 { error: 'attempt_unknown' } (advisor ruling 11-12) — the placement path journals the
// attempt and its op BEFORE any adapter call, so a claimed attempt can never be reported unknown. An approved-but-unplaced
// original is decided here (decidePlacement), then the order is resolved again.
const C = require('./coordinator');
const F = require('./flow');
const R = require('./record');
const { authorizeExistingOrder } = require('./order-auth');
const { resolveStatus } = require('./status');
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function placeSdkStatusCore(deps, { headers = {}, query = {} } = {}) {
  const orderId = query.order_id;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return { status: 400, body: { error: 'bad_request' } };
  const auth = await authorizeExistingOrder(deps, { authorization: headers.authorization, ticket: headers['x-sherpa-order-ticket'] }, orderId);
  if (!auth.ok) return { status: auth.status, body: { error: auth.error || 'not_found' } };
  let order = await C.readOrder(deps.db, orderId);
  if (!F.isSdkOrder(order)) return { status: 404, body: { error: 'not_found' } };
  if (order.status === 'pending_payment' && !order.payment_placed) await deps.db.ref(`payment_sdk_due/${orderId}`).set(deps.clock());   // W1
  return answerOrder(deps, orderId, order);
}
// The §4 answer for an SDK order: ONE read of the record per resolution; an approved-but-unplaced original is decided
// (decidePlacement), then resolved again. Shared with the intake's replay lookup (B2), which passes the replayed attempt_id.
async function answerOrder(deps, orderId, order, { attempt_id } = {}) {
  for (let pass = 0; pass < 2; pass += 1) {
    const rec = await C.readRecord(deps.db, orderId);   // ONE read per resolution
    const r = resolveStatus(orderId, order, rec, { now: deps.clock(), attempt_id });
    if (r.kind === 'outcome') return { status: 200, body: r.body };
    if (r.kind === 'no_attempt') {
      const anyOp = rec && Object.values(R.opsOf(rec)).some((o) => R.MONEY_ACTIONS.includes(o.action));
      if (anyOp) return { status: 200, body: { outcome: 'under_review', order_id: orderId } };   // a journal no attempt maps to: a person
      return { status: 409, body: { error: 'attempt_unknown' } };
    }
    if (r.kind === 'decide' && pass === 0) { await C.decidePlacement(deps, orderId, r.leg_id); order = await C.readOrder(deps.db, orderId); continue; }
    break;
  }
  return { status: 200, body: { outcome: 'under_review', order_id: orderId } };
}
module.exports = { placeSdkStatusCore, answerOrder };
