'use strict';

// claimOrder — retro-credit a guest order's loyalty earn on profile-claim (MONEY-PATH). PURE-ish core (the
// HTTP wrapper + verifyIdToken auth + rate-limit live in index.js as exports.claimOrder). Binds ONE
// token-or-phone-bound guest order to a verified uid and credits its earn — once, race-safe.
//
// SECURITY (money plan-gate, Option 2): the token is OPTIONAL; the PHONE-MATCH is the required gate.
//   • Tokenless (success-card) path: order_id + phone-match — works for ASAP AND scheduled (no tracking_token
//     at success-time). Uniform 403 for EVERY unclaimable case (no 404 / no oracle). Self-already-claimed → ok.
//   • Token (tracker deep-link) path: + order_tracking/{token}.order_id === order_id strict bind (belt).
// The uid is OTP-minted; a guessed order_id is useless without controlling the order's phone → phone-match is
// sufficient. No double-credit: the bind TRANSACTION admits exactly one uid, and creditEarnForOrder is
// idempotent on earn_${orderId}. Credit reads the COMMITTED post-tx snapshot (never a stale read).
// otp-lib is required LAZILY (via this wrapper) — its module-load fail-closes on a missing OTP_SALT, which is
// NOT set during `firebase deploy` source discovery (only at runtime). Loading THIS module must not trigger
// that. Existing code lazy-requires otp-lib the same way (index.js requestOtp/verifyOtp). require() is cached
// after the first call, so per-call cost is nil; phoneHash is never called during discovery.
function phoneHash(raw) { return require('./otp-lib').phoneHash(raw); }
const { creditEarnForOrder } = require('./rewards-earn');
const { shouldEarnOnStatus } = require('./rewards-core');

const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // exact claim-prefill.js guards
const TOKEN_RE = /^[A-Za-z0-9]{1,64}$/;
const FORBIDDEN = { status: 403, body: { error: 'forbidden' } };

// Pure decision for the atomic bind transaction. Commit-with-uid ONLY on a clean, unbound, phone-matching,
// not-cancelling order; self-already-bound → commit unchanged (idempotent); anything else → undefined (abort).
// Fields are order-node ONLY (CHANGE 3): status / resolving_action+cancel_claim_id (the cancel-race field,
// cancel-order-core claimDecision) / payment_status refunding. NOT payment_attempts' cancelling/cancel_pending.
function bindDecision(cur, uid, h2, now) {
  if (cur === null) return null;                                                 // null-first-safe (RTDB's speculative null → retry with the real value; a genuinely-absent order no-ops and the post-tx check rejects it)
  if (cur.customer_uid) return cur.customer_uid === uid ? cur : undefined;       // bound: self=idempotent commit, other=abort
  if (cur.status === 'cancelled') return undefined;
  if (cur.resolving_action === 'cancel' && cur.cancel_claim_id) return undefined;
  if (cur.payment_status === 'refunded' || cur.payment_status === 'refund_pending' || cur.payment_status === 'manual_review') return undefined;
  if (typeof cur.payment_status === 'string' && cur.payment_status.startsWith('resolving_')) return undefined;   // don't bind while a manual reconciliation is resolving
  if (!(cur.customer_phone && phoneHash(cur.customer_phone) === h2)) return undefined;   // phone-match re-checked IN-TX
  return { ...cur, customer_uid: uid };
}

async function claimOrderCore(db, { uid, orderId, token, now }) {
  orderId = String(orderId || '').trim();
  const hasToken = token != null && String(token).trim() !== '';
  const tok = hasToken ? String(token).trim() : null;
  // Path-safe validation (before any DB path). Uniform 403.
  if (!ORDER_ID_RE.test(orderId)) return FORBIDDEN;
  if (hasToken && !TOKEN_RE.test(tok)) return FORBIDDEN;

  // H10 durability (defense-in-depth; the wrapper also checks): a tombstoned uid never binds/earns.
  if ((await db.ref(`deleted_uids/${uid}`).get()).exists()) return FORBIDDEN;

  // Verified uid must own a profile with a stored phone_hash (h2). No profile → forbidden.
  const h2 = (await db.ref(`user_profiles/${uid}/phone_hash`).get()).val();
  if (!h2) return FORBIDDEN;

  const order = (await db.ref(`orders/${orderId}`).get()).val();
  if (!order) return FORBIDDEN;                                                   // uniform (no missing-order oracle)

  // Token path: strict token↔order bind (belt-and-suspenders; the token is the capability).
  if (hasToken) {
    const trk = (await db.ref(`order_tracking/${tok}`).get()).val();
    if (!trk || String(trk.order_id) !== orderId) return FORBIDDEN;
  }

  // REQUIRED gate — phone-match (never null === null).
  const h1 = phoneHash(order.customer_phone);
  if (!(h1 && h1 === h2)) return FORBIDDEN;

  // Atomic bind — the anti-double-credit gate. Only one uid can set customer_uid.
  const orderRef = db.ref(`orders/${orderId}`);
  const tx = await orderRef.transaction((cur) => bindDecision(cur, uid, h2, now));
  const committed = tx.committed ? tx.snapshot.val() : null;
  if (!committed || committed.customer_uid !== uid) return FORBIDDEN;             // bound-by-another / cancelled / mismatch

  // CREDIT FIRST — money before the non-money history write (money code-gate must-fix). A terminal order must
  // never end up bound-but-uncredited: the completion trigger already fired while it was a guest and will NOT
  // refire, so if we gated the credit behind a failing user_orders write it would only heal on a re-claim.
  // Credit from the COMMITTED snapshot — only for a terminal (delivered/completed) order; else bind-only
  // (earnRewardsOnCompletion credits at completion, now that customer_uid is set). Idempotent on
  // earn_${orderId} → no double grant even if both fire.
  let credited = false, delta = 0;
  if (shouldEarnOnStatus(committed.status)) {
    const r = await creditEarnForOrder(db, { orderId, order: committed, now });
    credited = r.credited; delta = r.delta;
  }
  const unit = committed.restaurant_id === 'la_musa' ? 'point' : 'punch';

  // Attribution — BEST-EFFORT (mirror attachCustomerAttribution's user_orders shape). MUST NOT block the
  // credit above; the P3 status trigger / a later history-view backfill heal a missed write. Guest orders
  // carry no reorder recipe → items [].
  try {
    await db.ref(`user_orders/${uid}/${orderId}`).set({
      ts: now,
      total: committed.total,
      order_type: committed.order_type,
      items_text: committed.items_text,
      restaurant: committed.restaurant_id || 'x_pizza',
      status: committed.status || null,
      items: Array.isArray(committed.reorder_items) ? committed.reorder_items : [],
    });
  } catch (_) { /* history is best-effort — never block the credit */ }

  // Flip has_profile on the order's OWN tracking_token so the tracker hides the guest card (best-effort;
  // scheduled orders — no tracking_token yet — get has_profile at materialize from the now-set customer_uid).
  if (committed.tracking_token) {
    try { await db.ref(`order_tracking/${committed.tracking_token}/has_profile`).set(true); } catch (_) { /* best-effort */ }
  }

  return { status: 200, body: { ok: true, credited, delta, unit } };
}

module.exports = { claimOrderCore, bindDecision };
