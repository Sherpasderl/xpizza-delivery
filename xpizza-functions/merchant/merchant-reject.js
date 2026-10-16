'use strict';
// H1a C-7 + BC2 — publishing a handheld reject to dispatch, and resolving it. The handheld NEVER cancels anything: the order
// transaction (merchant-transitions) only records orders/{oid}/reject_intent + handheld_answered; this module turns that into
// a dispatch request and back.
//   publishFromIntent (trigger on orders/{oid}/reject_intent): a transaction on merchant_requests/{rid}/{oid} that
//     - creates an open request when none exists;
//     - is a no-op for the same op_id (a replay never resets done/declined);
//     - reopens with a different op_id ONLY over done/declined AND only for a newer intent (an old replay never overwrites).
//     It fires on the order write itself, so a crash after the order commit still publishes — no client retry needed.
//   resolveRejectRequest (dispatch lane calls it): open → done|declined, a transaction conditional on the matching op_id.
//   clearOnDecline (trigger on merchant_requests/{rid}/{oid}, BC2): after a decline, clears the order's reject_intent and
//     handheld_answered ONLY when they still carry that op_id. Idempotent; retried by the trigger, so no human is needed.
const { surfaceOf } = require('./merchant-gate');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
async function readVal(db, path) { return (await db.ref(path).once('value')).val(); }

async function publishFromIntent({ db }, oid) {
  const order = await readVal(db, `orders/${oid}`);
  if (!isObj(order) || !isObj(order.reject_intent) || typeof order.restaurant_id !== 'string') return { ok: true, published: false };
  const rid = order.restaurant_id;
  if ((await surfaceOf(db, rid)) !== 'handheld') return { ok: true, published: false };
  const it = order.reject_intent;
  const request = { type: it.type, reason: it.reason, note: it.note === undefined ? null : it.note, gone_items: Array.isArray(it.gone_items) ? it.gone_items : [],
    op_id: it.op_id, by: it.by, at: it.at, state: 'open' };
  const tx = await db.ref(`merchant_requests/${rid}/${oid}`).transaction((cur) => {
    if (cur === null) return request;                                          // absent (or null-first: server re-runs us)
    if (!isObj(cur)) return undefined;
    if (cur.op_id === it.op_id) return undefined;                              // replay: never touch its lifecycle
    if ((cur.state === 'done' || cur.state === 'declined') && typeof cur.at === 'number' && it.at > cur.at) return request;
    return undefined;                                                          // open, or an older intent
  });
  return { ok: true, published: !!tx.committed };
}

async function resolveRejectRequest({ db, now }, rid, oid, opId, outcome, by) {
  if (outcome !== 'done' && outcome !== 'declined') throw new Error('bad outcome');
  const tx = await db.ref(`merchant_requests/${rid}/${oid}`).transaction((cur) => {
    if (cur === null) return null;                                             // null-first safe; truly absent → stale below
    if (!isObj(cur) || cur.op_id !== opId || cur.state !== 'open') return undefined;
    return { ...cur, state: outcome, resolved_at: now(), resolved_by: by };
  });
  const after = tx.snapshot.val();
  const ok = !!(tx.committed && isObj(after) && after.op_id === opId && after.state === outcome);
  return ok ? { ok: true } : { ok: false, code: 'stale' };
}

async function clearOnDecline({ db }, rid, oid) {
  const req = await readVal(db, `merchant_requests/${rid}/${oid}`);
  if (!isObj(req) || req.state !== 'declined') return { ok: true, cleared: false };
  const opId = req.op_id;
  const tx = await db.ref(`orders/${oid}`).transaction((node) => {
    if (node === null) return null;
    if (!isObj(node) || node.restaurant_id !== rid) return undefined;
    if (!isObj(node.reject_intent) || node.reject_intent.op_id !== opId) return undefined;   // a newer intent: leave it
    const { reject_intent, ...rest } = node; void reject_intent;
    if (isObj(rest.handheld_answered) && rest.handheld_answered.op_id === opId) delete rest.handheld_answered;
    return rest;
  });
  return { ok: true, cleared: !!tx.committed };
}

module.exports = { publishFromIntent, resolveRejectRequest, clearOnDecline };
