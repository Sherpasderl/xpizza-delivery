/**
 * X Pizza — Hosted-payment attempt acquisition (Stage H2).
 *
 * Pure, db-injected create-claim state machine for the Hosted Payment flow, mirroring
 * acquireOnlineAttempt (pixelpay-charge.js) but for the hosted lifecycle. See
 * HOSTED-PAYMENT-PLAN.md invariants I7 (single create-claim, deterministic+pre-persisted
 * hosted_order_id), I10 (exactly one live payable checkout per order), I3 (binding).
 *
 * The defining rule (plan §Authority model): a hosted checkout is PAYABLE until
 * `hosted_expires_at`, so we keep exactly ONE live checkout per order and never hand out a
 * second payable URL while one is live. `paid` → already_paid (never a new checkout).
 */
const crypto = require('crypto');
const { genAttemptId, orderFingerprint, centsToLempiras } = require('./pixelpay-charge');

// Hosted checkout validity window (the `expired_at` we send PixelPay). After this, the
// old checkout is no longer payable → a fresh attempt may be created.
const HOSTED_TTL_MS = 45 * 60 * 1000;

function genPollToken() {
  return crypto.randomBytes(12).toString('base64url'); // public token for the _complete status poll
}

// Outcomes:
//   { outcome:'claimed', attempt_id, hosted_order_id, poll_token, expires_at }
//        → we own a FRESH attempt, written as hosted_state:'creating' with the deterministic
//          hosted_order_id ALREADY persisted (I7/R2-1). Caller now calls hosted/other, then
//          marks the attempt 'created' with the checkout URL (or 'failed-create' on error).
//   { outcome:'reuse', attempt_id, checkout_url, poll_token }  → a live (un-expired) checkout
//        exists; return its URL (double-submit; I10).
//   { outcome:'in_progress', attempt_id }   → a create is in flight (hosted_state:'creating').
//   { outcome:'already_paid' }               → payment_status confirmed / attempt paid.
//   { outcome:'conflict' }                   → order_id reused for a different cart (fingerprint).
//   { outcome:'closed', reason }             → cancelled / voided / refund / manual_reconciliation
//        → order is closed/ambiguous; no new checkout (avoids double-charge / reopening).
//   { outcome:'error' }                      → could not converge.
async function acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, now, genId = genAttemptId, genTok = genPollToken) {
  const orderRef = db.ref(`orders/${orderId}`);

  for (let i = 0; i < 6; i++) {
    const order = (await orderRef.once('value')).val();

    // Order-level terminal reads.
    if (order) {
      if (order.payment_status === 'confirmed') return { outcome: 'already_paid' };
      if (order.payment_fingerprint && order.payment_fingerprint !== fingerprint) return { outcome: 'conflict' };
      if (['refunded', 'refund_pending'].includes(order.payment_status) || order.status === 'cancelled') {
        return { outcome: 'closed', reason: order.payment_status || order.status };
      }
    }

    // Decide intent from the pre-read.
    const candidate = genId();
    let decided;
    if (!order) {
      decided = { kind: 'create', newAaid: candidate };
    } else if (!order.active_attempt_id) {
      decided = { kind: 'install', newAaid: candidate };               // order exists, no lock (recovery)
    } else {
      const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
      if (!att) {
        decided = { kind: 'recover', reuseAaid: order.active_attempt_id }; // pointer set, record missing
      } else {
        const st = att.hosted_state;
        if (st === 'paid') return { outcome: 'already_paid' };
        if (st === 'creating') return { outcome: 'in_progress', attempt_id: order.active_attempt_id };
        if (st === 'created') {
          if (Number(att.hosted_expires_at) > now && att.hosted_checkout_url) {
            // I10: one live payable checkout → reuse it.
            return { outcome: 'reuse', attempt_id: order.active_attempt_id, checkout_url: att.hosted_checkout_url, poll_token: att.poll_token };
          }
          // expired 'created' (TTL passed, never paid) → old checkout is dead → fresh attempt.
          decided = { kind: 'rotate', newAaid: candidate, fromAaid: order.active_attempt_id };
        } else if (['cancel_pending', 'cancelled', 'voided', 'refund_pending', 'manual_reconciliation'].includes(st)) {
          return { outcome: 'closed', reason: st };                     // closed/ambiguous → no new checkout
        } else {
          // non-money terminal (expired / failed_create / abandoned) → fresh attempt allowed.
          decided = { kind: 'rotate', newAaid: candidate, fromAaid: order.active_attempt_id };
        }
      }
    }

    // CAS on orders/{id} (the lock). Admin SDK calls the fn with null on its first uncached
    // invocation; for non-create paths fall back to the pre-read `order` (return a value, never
    // undefined, so the SDK re-checks against the real server value rather than aborting).
    const tx = await orderRef.transaction((cur) => {
      if (decided.kind === 'create') {
        if (cur !== null) return;                                       // exists → abort, re-decide
        return { ...pendingOrderRecord, active_attempt_id: decided.newAaid, payment_fingerprint: fingerprint };
      }
      const c = cur || order;
      if (!c) return;
      if (c.payment_status === 'confirmed') return c;
      if (c.payment_fingerprint && c.payment_fingerprint !== fingerprint) return c;
      if (decided.kind === 'install') {
        if (c.active_attempt_id) return c;
        return { ...c, active_attempt_id: decided.newAaid, payment_fingerprint: c.payment_fingerprint || fingerprint };
      }
      if (decided.kind === 'recover') {
        if (c.active_attempt_id !== decided.reuseAaid) return c;
        return c;
      }
      if (decided.kind === 'rotate') {
        if (c.active_attempt_id !== decided.fromAaid) return c;
        return { ...c, active_attempt_id: decided.newAaid };
      }
      return c;
    });

    if (!tx.committed) continue;
    const committed = tx.snapshot.val();
    if (committed.payment_status === 'confirmed') return { outcome: 'already_paid' };
    if (committed.payment_fingerprint && committed.payment_fingerprint !== fingerprint) return { outcome: 'conflict' };
    const winner = committed.active_attempt_id;

    const wonFresh = (decided.kind === 'create' || decided.kind === 'install' || decided.kind === 'rotate') && winner === decided.newAaid;
    const wonRecover = decided.kind === 'recover' && winner === decided.reuseAaid;
    if (wonFresh || wonRecover) {
      const attemptId = winner;
      const hostedOrderId = `${orderId}-${attemptId}`;
      const pollToken = genTok();
      const expiresAt = now + HOSTED_TTL_MS;
      // Persist the create-claim BEFORE the caller calls PixelPay (I7/R2-1): the deterministic
      // hosted_order_id is stored now, so a paid callback that races our hosted/other response
      // still finds the binding and can recover a crashed `creating`.
      await db.ref(`payment_attempts/${attemptId}`).update({
        order_id: orderId,
        hosted_state: 'creating',
        hosted_order_id: hostedOrderId,
        hosted_created_at: now,
        hosted_expires_at: expiresAt,
        poll_token: pollToken,
        total_cents: pendingOrderRecord.total_cents
      });
      return { outcome: 'claimed', attempt_id: attemptId, hosted_order_id: hostedOrderId, poll_token: pollToken, expires_at: expiresAt };
    }
    continue;                                                           // someone else won → re-read (→ reuse/in_progress)
  }
  return { outcome: 'error' };
}

module.exports = { acquireHostedAttempt, genPollToken, HOSTED_TTL_MS, genAttemptId, orderFingerprint, centsToLempiras };
