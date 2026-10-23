'use strict';
// S5 — rateOrder: the «Entregado» one-tap thumb (server). index.js re-exports it on ONE line (inverse-fold invariant:
// tools/s5r-inverse.js). The proof is the SIGNED-IN CUSTOMER: the X-Firebase-ID-Token (customer:true, not tombstoned — the
// same verification createOrder / quoteOrder apply) whose uid is the order's customer_uid. No rate limiter: an account can
// write at most ONE record per own fulfilled order, so abuse is bounded by construction (advisor r1 redesign).
//
//   POST { order_id, thumb: "up"|"down" }   + header X-Firebase-ID-Token
//   200 { ok:true }                       recorded — or ANY repeat on an already-rated order (never reveals the stored thumb)
//   409 { ok:false, error:'not_fulfilled' }  the customer's OWN order, not yet delivered / completed
//   403 { ok:false, error:'not_allowed' }    not signed in, not a customer, not your order, unknown order, malformed body —
//                                            ONE generic refusal
// Reads deleted_uids/{uid} and orders/{order_id}; writes ONLY order_ratings/{order_id} (create-if-absent).
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { attributionUid } = require('../create-order-build');
const R = require('./rating-core');

const GENERIC = { httpStatus: 403, body: { ok: false, error: 'not_allowed' } };

// The verified customer uid, or null (any failure → null: the generic refusal)
async function customerUidOf(db, idToken, verifyIdToken) {
  if (typeof idToken !== 'string' || !idToken) return null;
  try {
    const dec = await verifyIdToken(idToken);
    if (!dec || dec.customer !== true || !dec.uid) return null;
    return attributionUid(dec, (await db.ref(`deleted_uids/${dec.uid}`).get()).exists());
  } catch (_) { return null; }
}

async function rateOrderCore(db, { body, idToken, now, verifyIdToken }) {
  const req = R.parseRequest(body);
  if (!req.ok) return GENERIC;
  const uid = await customerUidOf(db, idToken, verifyIdToken);
  if (!uid) return GENERIC;
  const order = (await db.ref(`orders/${req.orderId}`).get()).val();
  const why = R.eligibility(order, uid);
  if (why === 'not_allowed') return GENERIC;
  if (why) return { httpStatus: 409, body: { ok: false, error: why } };
  const rec = R.ratingRecord(req.thumb, order.restaurant_id, now);
  await db.ref(`order_ratings/${req.orderId}`).transaction((cur) => (cur === null ? rec : undefined));
  return { httpStatus: 200, body: { ok: true } };   // created, or already rated (first tap final) — the same answer
}

const rateOrder = onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 20, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const r = await rateOrderCore(getDatabase(), { body: req.body, idToken: req.get('x-firebase-id-token'), now: Date.now(), verifyIdToken: (t) => getAuth().verifyIdToken(t) });
    return res.status(r.httpStatus).json(r.body);
  } catch (e) {
    console.error('rateOrder', e && e.message);
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
});

module.exports = { rateOrder, rateOrderCore };
