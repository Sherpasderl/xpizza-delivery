'use strict';
// S-A (d) customer read (PLAN §S-A(d) «Customer read») — getMyRating: the C-2 rating sheet's ONE read of the caller's OWN rating.
//   GET ?order_id=<id>   header x-firebase-id-token (the capp transport, as rateOrder / getMyOrders)
//   → 200 { ok, rating: null | { store, dishes, delivery, comment, legacy_thumb, rated_at, edited_at }, can_rate, editable_until }
//   | 400 bad_request | 403 { ok:false, error:'not_allowed' } (ONE generic refusal) | 405 | 429
// PREDICATE — the SAME as the writer (rate-order.js): a verified customer token, the uid NOT tombstoned (customerUidOf), and the order's
// customer_uid === that uid. Any failure is the one generic 403: it never reveals whether the order or a rating exists.
// PAYLOAD — ONLY through rating-v2.readCountable (live AND owner not tombstoned — the reader contract) AND only when the node's
// owner_uid is the caller; withdrawn / deleted ⇒ rating null. The window (can_rate / editable_until) comes from
// rating-v2.readRatingWindow — fulfilled_at + state only. Never returned: owner_uid, token_hash, revoked, restaurant_id, state, rev.
const V2 = require('./rating-v2');

const GENERIC = { status: 403, body: { ok: false, error: 'not_allowed' } };
const reply = (status, body) => ({ status, body });

async function myRatingCore({ db, verifyIdToken, checkRateLimit, now }, req) {
  if (req.method !== 'GET') return reply(405, { ok: false, error: 'method_not_allowed' });
  const q = req.query && typeof req.query === 'object' ? req.query : {};
  const orderId = q.order_id;
  if (Object.keys(q).some((k) => k !== 'order_id') || typeof orderId !== 'string' || !V2.ORDER_ID_RE.test(orderId)) return reply(400, { ok: false, error: 'bad_request' });
  const { customerUidOf } = require('./rate-order');
  const uid = await customerUidOf(db, typeof req.get === 'function' ? req.get('x-firebase-id-token') : null, verifyIdToken);
  if (!uid) return GENERIC;
  const rl = await checkRateLimit(db, 'get_my_rating', uid);
  if (!rl || rl.allowed !== true) return reply(429, { ok: false, error: 'rate_limited', retry_after: (rl && rl.retryAfterSec) || 60 });
  const order = (await db.ref(`orders/${orderId}/customer_uid`).once('value')).val();
  if (order !== uid) return GENERIC;

  const node = await V2.readCountable(db, orderId);
  const mine = node && node.owner_uid === uid ? node : null;
  const w = await V2.readRatingWindow(db, orderId);
  const until = w.state !== V2.STATES.DELETED && Number.isFinite(w.fulfilled_at) ? w.fulfilled_at + V2.WINDOW_MS : null;
  return reply(200, {
    ok: true,
    rating: mine ? { store: mine.store ?? null, dishes: mine.dishes || {}, delivery: mine.delivery ?? null, comment: mine.comment ?? null,
      legacy_thumb: mine.legacy_thumb ?? null, rated_at: mine.rated_at ?? null, edited_at: mine.edited_at ?? null } : null,
    can_rate: until != null && now() <= until,
    editable_until: until,
  });
}

function makeMyRating({ getDatabase, getAuth, checkRateLimit, now = () => Date.now() }) {
  return {
    async getMyRating(req, res) {
      res.set('Cache-Control', 'no-store');
      let out;
      try { out = await myRatingCore({ db: getDatabase(), verifyIdToken: (t) => getAuth().verifyIdToken(t), checkRateLimit, now }, req); }
      catch (e) { console.error('getMyRating', e && e.message); out = reply(503, { ok: false, error: 'unavailable' }); }
      res.status(out.status).json(out.body);
    },
  };
}

module.exports = { makeMyRating, myRatingCore };
