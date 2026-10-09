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
const { paymentBindingConflict, conflictOutcome, once, formatOf, FORMAT_CANONICAL, installFingerprint } = require('./catalog/canonical-binding');   // 1D D4-b §A.3

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
//   { outcome:'item_unavailable', blocked }  → the cart holds a server-"86'd" item AND this call would
//        mint a FRESH/rotated payable checkout URL → ABORT BEFORE the CAS (writes NOTHING). See
//        KDS_2B_PLAN.md §6–8: the authoritative intake gate. A GENUINE reuse of an already-live URL and
//        every stable-terminal outcome (already_paid/closed/conflict/in_progress) return FIRST, above the
//        cartBlocked check — so a paid/closed/live-checkout order is NEVER re-rejected. `cartBlocked` is the
//        caller's checkItemAvailability().blocked labels (fail-open: [] ⇒ the CAS proceeds unchanged).
//   { outcome:'error' }                      → could not converge.
/* 1D D4-b (§A.3): `canonicalFp` — an optional LAZY thunk → { ok, fp } — is consulted ONLY when the order record a
   site is looking at is tagged canonical. Each existing site keeps its kind: the pre-read and the post-txn check
   stay ADVISORY, the transaction stays the authoritative CAS and re-checks the (format, fingerprint) PAIR on the
   record it holds. No new read, write, transaction or reordering on any path; nothing here writes a tag. */
/* P-SELFUPDATE §5 (2): `refuseFresh` — true ONLY for a request BELOW the client compatibility floor that was admitted as a
   live-checkout reuse. At the authoritative fresh-issuance decision (the same point the 86 gate uses, below every terminal
   and genuine-reuse return), such a request is refused with a NON-426 typed conflict before the CAS — it writes nothing.
   Default false → every existing caller and path is unchanged. */
/* D4-c4 §3/§0.2: `controlRefuseFresh` — true ONLY when the pause pre-gate admitted this request while the restaurant is
   PAUSED or its pause state is UNKNOWN (a non-fresh classification: reuse / in_progress / a terminal answer). If the state
   drifted and THIS call would now mint a fresh / rotated payable URL (create / install / recover / rotate), it is refused
   at the same authoritative point, FIRST, before the CAS — the EXISTING conflict shape, reason 'order_control' (the
   caller's conflict cleanup releases only a hold it owns, and answers with the kind its pre-gate recorded). Default
   false → every existing caller and path is unchanged. */
async function acquireHostedAttempt(db, orderId, pendingOrderRecord, fingerprint, now, cartBlocked = [], genId = genAttemptId, genTok = genPollToken, canonicalFp = null, refuseFresh = false, controlRefuseFresh = false) {
  const canon = once(canonicalFp);
  const orderRef = db.ref(`orders/${orderId}`);

  for (let i = 0; i < 6; i++) {
    const order = (await orderRef.once('value')).val();

    // Order-level terminal reads.
    if (order) {
      if (order.payment_status === 'confirmed') return { outcome: 'already_paid' };
      { const d = paymentBindingConflict(order, fingerprint, canon); if (d) return conflictOutcome(d); }   // advisory
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

    // KDS 2b · Slice-4 AUTHORITATIVE intake gate (closes the classify↔acquire TOCTOU, KDS_2B_PLAN.md §6–8).
    // Every stable-terminal and genuine-reuse outcome has already returned ABOVE, so reaching here means
    // `decided.kind` ∈ {create, install, recover, rotate} — i.e. THIS iteration is about to mint a fresh /
    // rotated payable checkout URL. If the caller found the cart holds a server-"86'd" item, ABORT NOW —
    // BEFORE the CAS transaction — so a blocked cart writes NOTHING (no orders/{id}, no payment_attempts,
    // no charge) and can NEVER be handed a payable URL, regardless of what the read-only classify predicted.
    // Fail-open: cartBlocked === [] (the default, and every checkItemAvailability read-error) ⇒ CAS proceeds.
    if (controlRefuseFresh === true) return { outcome: 'conflict', reason: 'order_control' };   // D4-c4 §0.2: paused / unknown → no fresh URL
    if (Array.isArray(cartBlocked) && cartBlocked.length > 0) {
      return { outcome: 'item_unavailable', blocked: cartBlocked };
    }
    // P-SELFUPDATE §5 (2): a below-floor request reaching ANY fresh issuance (create / install / recover / rotate) — a race
    // after it was admitted as a reuse — is refused here, before the CAS. NOT a 426: it is not safe-to-reload proof.
    if (refuseFresh === true) return { outcome: 'conflict', reason: 'client_update_race' };

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
      if (paymentBindingConflict(c, fingerprint, canon)) return c;     // the CAS: (format, fingerprint) on the record held
      if (decided.kind === 'install') {
        if (c.active_attempt_id) return c;
        const fill = c.payment_fingerprint || installFingerprint(c, fingerprint, canon);   // 1D D4-b: legacy record → `fingerprint`, unchanged
        if (!fill) return c;                                                              // canonical, uncomputable → no install (the re-read refuses)
        return { ...c, active_attempt_id: decided.newAaid, payment_fingerprint: fill };
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
    { const d = paymentBindingConflict(committed, fingerprint, canon); if (d) return conflictOutcome(d); }   // advisory post-txn
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

// ── classifyHostedAttempt — READ-ONLY mirror of acquireHostedAttempt's terminal/intent classification.
//
// KDS Phase 2b · Slice 4 (KDS_2B_PLAN.md §6, R4): the online intake availability gate needs to know,
// WITHOUT writing, whether this charge call would issue a FRESH payable checkout URL (create / install /
// recover / rotate) versus resolve to a terminal or already-issued outcome (already_paid / closed /
// conflict / in_progress / reuse). Only a fresh-URL-issuing call is gated for "86'd" items; terminal
// outcomes BYPASS the gate (never re-reject a paid order; never regress the "Already paid" success path).
//
// It performs the SAME read-only reads + decision as acquireHostedAttempt's pre-CAS phase (order-level
// terminal reads, then the active-attempt state), but NEVER runs the CAS/writes. The
// `hosted-classify-parity.test.js` fixtures assert this classifier agrees with acquireHostedAttempt on
// every state (fresh ⟺ outcome 'claimed'; terminal ⟺ the read-only outcomes) so the two cannot drift.
//
// Returns { willIssueFreshUrl: boolean, outcome? }. Read errors propagate to the caller, which fails
// OPEN (treats as "do not gate") — a DB hiccup must never block a sale.
async function classifyHostedAttempt(db, orderId, fingerprint, now, canonicalFp = null) {
  const order = (await db.ref(`orders/${orderId}`).once('value')).val();
  const r = await classifyFromOrder(db, order, fingerprint, now, canonicalFp);
  /* 1D D4-b §A.6: the order binding FORMAT this request is bound to, from the SAME snapshot. Reported ONLY when the
     record is tagged canonical, so every untagged result object is byte-identical to today's. */
  const f = formatOf(order, 'fp_format');
  return (order && f.ok && f.format === FORMAT_CANONICAL) ? { ...r, bindingFormat: FORMAT_CANONICAL } : r;
}
async function classifyFromOrder(db, order, fingerprint, now, canonicalFp) {
  const canon = once(canonicalFp);

  // Order-level terminal reads (mirror acquireHostedAttempt L44-49).
  if (order) {
    if (order.payment_status === 'confirmed') return { willIssueFreshUrl: false, outcome: 'already_paid' };
    { const d = paymentBindingConflict(order, fingerprint, canon); if (d) return conflictOutcome(d, { willIssueFreshUrl: false }); }   // advisory classify
    if (['refunded', 'refund_pending'].includes(order.payment_status) || order.status === 'cancelled') {
      return { willIssueFreshUrl: false, outcome: 'closed' };
    }
  }

  if (!order) return { willIssueFreshUrl: true };                    // create
  if (!order.active_attempt_id) return { willIssueFreshUrl: true };  // install (recovery, fresh URL)

  const att = (await db.ref(`payment_attempts/${order.active_attempt_id}`).once('value')).val();
  if (!att) return { willIssueFreshUrl: true };                      // recover (pointer set, record gone → fresh URL)

  const st = att.hosted_state;
  if (st === 'paid') return { willIssueFreshUrl: false, outcome: 'already_paid' };
  if (st === 'creating') return { willIssueFreshUrl: false, outcome: 'in_progress' };
  if (st === 'created') {
    if (Number(att.hosted_expires_at) > now && att.hosted_checkout_url) {
      return { willIssueFreshUrl: false, outcome: 'reuse' };         // live checkout → existing URL, no new one
    }
    return { willIssueFreshUrl: true };                              // expired/urless created → rotate (fresh URL)
  }
  if (['cancel_pending', 'cancelled', 'voided', 'refund_pending', 'manual_reconciliation'].includes(st)) {
    return { willIssueFreshUrl: false, outcome: 'closed' };
  }
  return { willIssueFreshUrl: true };                                // non-money terminal → rotate (fresh URL)
}

module.exports = { acquireHostedAttempt, classifyHostedAttempt, genPollToken, HOSTED_TTL_MS, genAttemptId, orderFingerprint, centsToLempiras };
