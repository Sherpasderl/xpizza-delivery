'use strict';
// S5 — rateOrder: the «Entregado» one-tap thumb (server). index.js re-exports it on ONE line (inverse-fold invariant:
// tools/s5r-inverse.js). Public + unauthenticated (the tracker token is the proof), rate-limited per IP AND per token.
//
//   POST { tracking_token, thumb: "up"|"down" }
//   200 { ok:true }                      recorded (or the SAME thumb again — idempotent)
//   409 { ok:false, error }              not_fulfilled | rating_closed | already_rated — only what the tracker already shows
//   400 { ok:false, error:'invalid' }    malformed body, unknown token, a token without an order — ONE generic refusal
//   429 rate_limited
// Reads order_tracking/{token} (public) → orders/{order_id}; writes ONLY order_ratings/{order_id}, create-if-absent.
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { rateLimitKey } = require('../order-dedup');
const R = require('./rating-core');

const BUCKETS = Object.freeze({
  rate_ip: { windowMs: 10 * 60 * 1000, max: 30 },     // coarse flood guard
  rate_token: { windowMs: 10 * 60 * 1000, max: 5 },   // per tracker link: a real customer taps once
});

// The same fixed-window limiter as index.js checkRateLimit (rate_limits/{bucket}/{hashed key}), fail-OPEN on a DB error.
async function limited(db, bucket, raw, now) {
  if (!raw) return false;
  const cfg = BUCKETS[bucket];
  try {
    const res = await db.ref(`rate_limits/${bucket}/${rateLimitKey(raw)}`).transaction((cur) => {
      if (!cur || now - cur.window_start >= cfg.windowMs) return { count: 1, window_start: now };
      if (cur.count >= cfg.max) return undefined;
      return { count: cur.count + 1, window_start: cur.window_start };
    });
    return !res.committed;
  } catch (_) { return false; }
}

const GENERIC = { httpStatus: 400, body: { ok: false, error: 'invalid' } };

async function rateOrderCore(db, { body, ip, now }) {
  if (await limited(db, 'rate_ip', ip, now)) return { httpStatus: 429, body: { ok: false, error: 'rate_limited' } };
  const req = R.parseRequest(body);
  if (!req.ok) return GENERIC;
  if (await limited(db, 'rate_token', req.token, now)) return { httpStatus: 429, body: { ok: false, error: 'rate_limited' } };
  const track = (await db.ref(`order_tracking/${req.token}`).get()).val();
  const orderId = track && typeof track.order_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(track.order_id) ? track.order_id : null;
  if (!orderId) return GENERIC;
  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (!order) return GENERIC;
  const why = R.eligibility(order, now);
  if (why) return { httpStatus: 409, body: { ok: false, error: why } };
  const rec = R.ratingRecord(req.thumb, order.restaurant_id, now);
  const tx = await db.ref(`order_ratings/${orderId}`).transaction((cur) => (cur === null ? rec : undefined));
  if (tx.committed) return { httpStatus: 200, body: { ok: true } };
  const existing = tx.snapshot.val();
  return existing && existing.thumb === req.thumb ? { httpStatus: 200, body: { ok: true } } : { httpStatus: 409, body: { ok: false, error: 'already_rated' } };
}

const rateOrder = onRequest({ region: 'us-central1', cors: true, timeoutSeconds: 20, memory: '256MiB', maxInstances: 5 }, async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const r = await rateOrderCore(getDatabase(), { body: req.body, ip, now: Date.now() });
    return res.status(r.httpStatus).json(r.body);
  } catch (e) {
    console.error('rateOrder', e && e.message);
    return res.status(503).json({ ok: false, error: 'unavailable' });
  }
});

module.exports = { rateOrder, rateOrderCore, BUCKETS };
