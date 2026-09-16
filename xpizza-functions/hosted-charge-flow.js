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
async function resolveHostedAttemptAction({ acq, orderId, totalCents, releaseHold, retireAttempt, runGate, log = console }) {
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
  /* runGate is handed the total the module will actually charge, rather than the handler passing the
     gate's number and the charge's number separately. Two parameters meant two places to disagree; one
     parameter means the "approved == recorded" check and the amount that travels are the same value by
     construction, and the handler names the server total exactly once. */
  const applied = await runGate(totalCents);
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

/* ── THE CONSUMPTION, NOT JUST THE DECISION ──────────────────────────────────────────────────────
   The previous round made the DECISION runtime-testable and stopped at its boundary. The handler glue
   that consumed it — return-or-proceed, format the amount, call the gateway, release on each bailout —
   was still executed by no test, and three mutations to it survived every runnable test:
     · the amount at the gateway call site (`amountLempiras: amountStr + 1`) — the tests asserted
       decision FIELDS, never the argument createHostedCharge actually received;
     · deleting the refusal's short-circuit — a 409 decision fell through, chargedCents was null so it
       slipped past the amount guard, and a checkout was minted AFTER a refusal;
     · deleting a bailout's release — an owned hold left reserved after a real gateway failure.
   All three are reachable from an ordinary request. So issuance moves in here too, behind an injected
   createCheckout: a refusal now cannot reach the gateway because there is no path from one to the
   other, rather than because a test watches a `return` statement. */
async function issueHostedCheckout({
  attemptId, orderId, gatedCents, totalCents, toLempiras, chargeRequest,
  createCheckout, persistCreated, releaseHold, retireAttempt, now, log = console,
}) {
  /* NO gated-vs-outgoing guard here any more, deliberately. There used to be one, comparing the
     gate's approved net against a separately-passed total. Single-sourcing totalCents removed the two
     numbers it existed to reconcile: the gate is now handed the very total this function charges, so
     the comparison could no longer fail for any input — an assertion that cannot fail is not a
     safeguard, it is a mutant that can never be killed and a false sense of coverage. Removed rather
     than exempted, for the same reason the b8 non-finite guard was.
     What replaces it is stronger and IS falsifiable: hosted-charge-flow.test.js computes the expected
     net independently (computeServerNet over the fixture cart) and asserts the amount the gateway
     actually received equals it, on both an equal-price and a price-drop accept. */
  // real server total (NOT the sandbox 1-14 map) so the callback amount-check holds
  const amountLempiras = toLempiras(totalCents);

  let hosted;
  try {
    hosted = await createCheckout({ ...chargeRequest, amountLempiras });
  } catch (e) {
    try { log.error(`chargeOnlineOrder: hosted create threw for ${chargeRequest.pixelpayOrderId}`, e && e.message); } catch (_) {}
    await retireAttempt(attemptId, 'network');
    await releaseHold();          // hosted-create failed after claim → abandoned → release our hold
    return { respond: { status: 502, body: { error: 'Payment gateway error', detail: 'could not create checkout; please retry', order_id: orderId } } };
  }

  if (!hosted || !hosted.ok || !hosted.url) {
    const errs = JSON.stringify((hosted && (hosted.errors || hosted.raw)) || {}).slice(0, 400);
    try { log.error(`chargeOnlineOrder: hosted create rejected for ${chargeRequest.pixelpayOrderId}`, errs); } catch (_) {}
    await retireAttempt(attemptId, JSON.stringify((hosted && hosted.errors) || {}).slice(0, 300));
    await releaseHold();          // hosted-create rejected after claim → abandoned → release our hold
    return { respond: { status: 502, body: { error: 'Payment gateway error', detail: 'checkout not created; please retry', order_id: orderId } } };
  }

  // Persist the live checkout URL + mark 'created' (payable until expires_at). [C/#30] wrap it: if this
  // write fails the customer never receives the URL (the order can't proceed) → release our hold.
  try {
    await persistCreated(hosted.url);
  } catch (e) {
    try { log.error(`chargeOnlineOrder: persist 'created' failed for ${chargeRequest.pixelpayOrderId}`, e && e.message); } catch (_) {}
    await releaseHold();          // [C/#30] never leave a reserved hold behind a checkout the customer can't reach
    return { respond: { status: 500, body: { error: 'Payment gateway error', detail: 'checkout not persisted; please retry', order_id: orderId } } };
  }

  return { hosted, amountLempiras };
}

/* The whole card-path money decision as ONE unit: what to do about the acquire outcome, the gate, and
   — only if both say go — the gateway call. Composed here rather than in the handler so that "a refusal
   creates no checkout" is a property of the code's shape, not of a `return` a test has to watch. */
async function resolveAndIssueHostedCheckout(opts) {
  const decision = await resolveHostedAttemptAction(opts);
  if (decision.respond) return { respond: decision.respond };
  if (decision.provenance) await opts.stampProvenance(decision.provenance);
  return issueHostedCheckout({ ...opts, gatedCents: decision.chargedCents != null ? decision.chargedCents : null });
}

module.exports = { resolveHostedAttemptAction, issueHostedCheckout, resolveAndIssueHostedCheckout, retireUnissuedAttempt };
