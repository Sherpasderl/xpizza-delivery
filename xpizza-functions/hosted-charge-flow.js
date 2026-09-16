'use strict';
// ---------------------------------------------------------------------------
// Portal 1C Task 5 — THE HOSTED-CHECKOUT DECISION, EXTRACTED SO IT CAN BE RUN.
//
// 🔴 WHY THIS EXISTS. The card path's guarantees are about ORDER and EFFECTS: a resume must never reach
// the gate, a refusal must create no checkout, and a refusal must both release the reward hold and
// RETIRE the attempt it claimed. A source-ordering test can see the first of those and is blind to the
// rest — mutations that preserve the ordering while breaking the behaviour survive it, which is how a
// resumed payment could be 409'd mid-flight and a refusal could still mint a checkout above the
// confirmed ceiling. So the decision moves here, behind injected effects, and the assertions become
// "was the checkout created", "was the hold released", "was the attempt retired".
//
// The handler keeps the branches that have nothing to do with this guarantee (item_unavailable,
// already_paid, conflict, closed) and the mechanics of building a checkout request.
// ---------------------------------------------------------------------------

/* 🔴 A CLAIMED ATTEMPT THAT WILL NEVER BE ISSUED MUST BE RETIRED.
   The gate necessarily runs AFTER acquireHostedAttempt — that ordering is what makes resume-safe
   fresh-only gating possible — so a refusal leaves an attempt in hosted_state:'creating'. That state
   is read as `in_progress` UNCONDITIONALLY, with no expiry check (pixelpay-hosted-charge.js), so it
   does not age out: the customer re-quotes, resubmits the same order_id, and is told a checkout is
   already being created — forever. The sweep then files it as manual_reconciliation rather than
   reaping it, and with a reward the retry re-reserves a hold that was already released.
   I previously wrote the opposite into a comment — "a sweep reaps it" — on the strength of a plausible
   analogy to the cash path, which has no pre-gate attempt to strand. It was wrong, and stating it as
   fact in the source was worse than not saying it.
   Retiring uses the SAME state the post-create failure bailout uses, because these are the same
   situation: an attempt was claimed and no checkout will exist for it. */
async function retireUnissuedAttempt(db, attemptId, reason, now) {
  if (!db || !attemptId) return;
  await db.ref(`payment_attempts/${attemptId}`)
    .update({ hosted_state: 'failed_create', failed_create_reason: reason, updated_at: now })
    .catch(() => {});
}

/* Decide what a hosted-charge call should do, given the acquire outcome and the confirmed-net gate.
 * Returns { respond } to answer the request, or { proceed, provenance } to mint a checkout.
 * Every effect is injected so a test can observe it:
 *   releaseHold()      — the card path's owned-only release
 *   retireAttempt(id)  — retire a claimed-but-unissued attempt
 *   runGate()          — the confirmed-net gate (applyConfirmedNetGate, pre-bound by the caller)
 */
async function resolveHostedAttemptAction({ acq, orderId, releaseHold, retireAttempt, runGate, log = console }) {
  /* 🔴 THESE TWO RETURN BEFORE THE GATE IS EVEN CONSULTED, and that is the guarantee — not an
     accident of where the call happens to sit. A customer resuming from PixelPay is holding a checkout
     that was already minted at an already-agreed amount; re-deciding it against a price that moved
     while they were on the payment page would refuse a payment in flight. runGate is not called at
     all on these paths, which is a fact a test can check. */
  if (acq.outcome === 'in_progress') {
    // A checkout is being created for this order — don't start a 2nd (one-live-checkout, I10). PRESERVE the
    // hold: the concurrent creating checkout is backed by it (releasing would strand a payable discounted URL).
    return { respond: { status: 202, body: { ok: true, status: 'in_progress', detail: 'a checkout is being created; retry shortly', order_id: orderId } } };
  }
  // Double-submit while a checkout is still live → return the SAME url (I10). PRESERVE the hold (the live
  // checkout it backs is being reused; this call's reserve was 'reused' → we don't own it anyway).
  if (acq.outcome === 'reuse') {
    try { log.log(`chargeOnlineOrder: reuse live hosted checkout ${orderId}-${acq.attempt_id}`); } catch (_) {}
    return { respond: { status: 200, body: { ok: true, order_id: orderId, attempt_id: acq.attempt_id, poll_token: acq.poll_token, checkout_url: acq.checkout_url, payment_status: 'pending' } } };
  }
  if (acq.outcome !== 'claimed') {
    await releaseHold();                       // abandoned: no fresh attempt minted
    return { respond: { status: 503, body: { error: 'Could not start payment', detail: 'please retry', order_id: orderId } } };
  }

  // A FRESH attempt is ours. This is the only path the gate may run on.
  const applied = await runGate();
  if (applied.refuse) {
    // The hold is released by applyConfirmedNetGate itself; the ATTEMPT is this path's own cleanup.
    await retireAttempt(acq.attempt_id, 'quote_gate_refused');
    return { respond: { status: applied.refuse.status, body: applied.refuse.body } };
  }
  /* The amount the gate APPROVED travels with the decision. The handler must hand exactly this number
     to PixelPay — see the equality guard at the createHostedCharge call. Null under grace (the gate
     declined to have an opinion), which the guard reads as "nothing to bind". */
  return { proceed: true, provenance: applied.provenance, chargedCents: applied.provenance ? applied.provenance.charged_net_cents : null };
}

module.exports = { resolveHostedAttemptAction, retireUnissuedAttempt };
