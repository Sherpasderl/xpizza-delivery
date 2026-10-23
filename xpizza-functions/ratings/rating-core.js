'use strict';
// S5 — the RATINGS WRITER, pure core (PLAN-shared-order-form.FINAL §5 S5 "Ratings writer"; advisor rulings 2026-10-22, r1
// redesign after codex r1). One thumb per ORDER, from the «Entregado» screen, by the SIGNED-IN CUSTOMER who placed it (the
// order's customer_uid — the member-history attribution field). Guests cannot rate; staff accounts are not customer accounts.
// Eligible when the order is FULFILLED (delivered, or a pickup completed by the KDS) — status only, no timestamp. The first tap
// is final, and any repeat answers the same 200 without revealing the stored thumb. Stored as ONE create-if-absent record —
// order_ratings/{order_id} = { thumb, rated_at, restaurant_id } — carrying NO customer identity. Nothing is counted: every
// aggregate is DERIVED from these records (the S5 producer joins them to the orders' dish_ids once dish_id stamping lands),
// and the public «% liked» passes the ≥ 20 gate below.

const THUMBS = new Set(['up', 'down']);
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_RATINGS = 20;                                    // the plan's gate: «% liked» hidden until ≥ 20 ratings
const FULFILLED = new Set(['delivered', 'completed']);    // = stats-classify FULFILLED_STATUSES (delivery / pickup)

// The request → { ok, orderId, thumb } | { ok:false }
function parseRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.order_id !== 'string' || !ORDER_ID_RE.test(b.order_id) || !THUMBS.has(b.thumb)) return { ok: false };
  return { ok: true, orderId: b.order_id, thumb: b.thumb };
}

// May THIS customer rate this order now? → null (yes) | 'not_allowed' (unknown / not theirs — ONE generic refusal, never
// revealing whether an order exists) | 'not_fulfilled' (their own order, not yet delivered / completed)
function eligibility(order, uid) {
  if (!order || typeof uid !== 'string' || !uid || order.customer_uid !== uid) return 'not_allowed';
  if (!FULFILLED.has(order.status)) return 'not_fulfilled';
  return null;
}

const ratingRecord = (thumb, restaurantId, now) => ({ thumb, rated_at: now, restaurant_id: typeof restaurantId === 'string' ? restaurantId : null });

// The public «% liked»: null below the gate (hidden), else the rounded percentage.
function likedPct({ thumbs_up, ratings_n }) {
  if (!Number.isSafeInteger(ratings_n) || ratings_n < MIN_RATINGS || !Number.isSafeInteger(thumbs_up) || thumbs_up < 0 || thumbs_up > ratings_n) return null;
  return Math.round((100 * thumbs_up) / ratings_n);
}

module.exports = { THUMBS, ORDER_ID_RE, MIN_RATINGS, parseRequest, eligibility, ratingRecord, likedPct };
