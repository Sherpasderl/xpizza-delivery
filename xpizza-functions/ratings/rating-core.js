'use strict';
// S5 — the RATINGS WRITER, pure core (PLAN-shared-order-form.FINAL §5 S5 "Ratings writer"; advisor rulings 2026-10-22 A–E).
// One thumb per ORDER, from the «Entregado» screen, proven by the order's TRACKER token (guests may rate). The first tap is
// final. Stored as ONE create-if-absent record — order_ratings/{order_id} = { thumb, rated_at, restaurant_id } — carrying
// NO customer identity. Nothing is counted: every aggregate is DERIVED from these records (the S5 producer joins them to the
// orders' dish_ids once dish_id stamping lands), and the public «% liked» passes the ≥ 20 gate below.

const THUMBS = new Set(['up', 'down']);
const TOKEN_RE = /^[A-Za-z0-9]{8,64}$/;            // the tracker token alphabet (index.js TOKEN_ALPHABET), length-bounded
const WINDOW_MS = 7 * 24 * 3600 * 1000;            // ruling D: 7 days after fulfilment
const MIN_RATINGS = 20;                            // the plan's gate: «% liked» hidden until ≥ 20 ratings
const FULFILLED = new Set(['delivered', 'completed']);   // = stats-classify FULFILLED_STATUSES (delivery / pickup)

// The request → { ok, token, thumb } | { ok:false } (one generic refusal: never says why a token is bad)
function parseRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.tracking_token !== 'string' || !TOKEN_RE.test(b.tracking_token) || !THUMBS.has(b.thumb)) return { ok: false };
  return { ok: true, token: b.tracking_token, thumb: b.thumb };
}

// When the order was fulfilled: delivered_at (delivery) or completed_at (pickup); null if unknown.
function fulfilledAt(order) {
  if (!order) return null;
  const d = Number(order.delivered_at), c = Number(order.completed_at);
  if (Number.isFinite(d) && d > 0) return d;
  return Number.isFinite(c) && c > 0 ? c : null;
}

// May this order be rated now? → null (yes) | the refusal the tracker already makes visible (status / time), never more.
function eligibility(order, now) {
  if (!order || !FULFILLED.has(order.status)) return 'not_fulfilled';
  const at = fulfilledAt(order);
  if (at === null || now - at > WINDOW_MS) return 'rating_closed';
  return null;
}

const ratingRecord = (thumb, restaurantId, now) => ({ thumb, rated_at: now, restaurant_id: typeof restaurantId === 'string' ? restaurantId : null });

// The public «% liked»: null below the gate (hidden), else the rounded percentage.
function likedPct({ thumbs_up, ratings_n }) {
  if (!Number.isSafeInteger(ratings_n) || ratings_n < MIN_RATINGS || !Number.isSafeInteger(thumbs_up) || thumbs_up < 0 || thumbs_up > ratings_n) return null;
  return Math.round((100 * thumbs_up) / ratings_n);
}

module.exports = { THUMBS, TOKEN_RE, WINDOW_MS, MIN_RATINGS, parseRequest, fulfilledAt, eligibility, ratingRecord, likedPct };
