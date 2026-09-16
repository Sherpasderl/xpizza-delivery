'use strict';
/**
 * Portal 1C Task 5 — placement guard for the confirmed-net gate on BOTH charge endpoints.
 * Run: `node charge-gate-placement.test.js`
 *
 * 🔴 WHAT THIS PROVES, AND WHAT IT DELIBERATELY DOES NOT.
 * The gate's DECISION and its CONSEQUENCES are runtime-tested in token-gate.test.js — refuse on an
 * increase, charge the lower net on a drop, release the hold on every refusal, retain it on the charge,
 * two-fact provenance. None of that is re-litigated here.
 *
 * This file asserts WHERE the calls sit. I previously justified it by claiming the placement "cannot be
 * unit-tested" — that was wrong, and it was the kind of wrong that buys a weaker test a permanent
 * excuse. The card path's decision has since been extracted behind injected effects
 * (hosted-charge-flow.js), and hosted-charge-flow.test.js RUNS it: reuse and in_progress are proven to
 * consult no gate, a refusal is proven to authorise no checkout and to release the hold and retire the
 * claimed attempt, and an accept is proven to carry the gated amount. Those are the guarantees.
 *
 * What survives here is narrower and still worth having: a SOURCE-LEVEL tripwire. The runtime tests
 * exercise the extracted decision, not the 450-line express handler around it, so an edit that stops
 * calling the decision, moves it below createHostedCharge, or reintroduces an inline gate would leave
 * every runtime test green. This file fails the build on exactly that — in the same style as
 * intake-gate-placement.test.js. It locks the wiring; it does not execute the handler.
 */
const fs = require('fs');
const assert = require('assert');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SRC = fs.readFileSync(require.resolve('./index.js'), 'utf8');
const slice = (from, to) => {
  const a = SRC.indexOf(from); assert.ok(a !== -1, `marker not found: ${from}`);
  const b = SRC.indexOf(to, a + from.length); assert.ok(b !== -1, `marker not found: ${to}`);
  return SRC.slice(a, b);
};
const before = (hay, a, b, msg) => {
  const ia = hay.indexOf(a), ib = hay.indexOf(b);
  assert.ok(ia !== -1, `not found: ${a}`);
  assert.ok(ib !== -1, `not found: ${b}`);
  assert.ok(ia < ib, `${msg}\n  expected "${a}"\n  BEFORE   "${b}"  (got ${ia} vs ${ib})`);
};

// ── 1. 🔴 THE CARD DECISION IS REACHED ON THE FRESH PATH, AND BEFORE ANY CHECKOUT EXISTS ───────
// The branch ordering itself now lives in hosted-charge-flow.js and is RUN in hosted-charge-flow.test.js
// (reuse and in_progress are proven to consult no gate). What only the source can show is that the
// handler still routes through that decision at all, and still does so before createHostedCharge.
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');

  // The terminal outcomes still return in the handler, above the decision.
  before(card, "acq.outcome === 'already_paid'", 'resolveHostedAttemptAction(', 'an already-paid order must return before the decision');
  before(card, "acq.outcome === 'conflict'", 'resolveHostedAttemptAction(', 'a conflicting order must return before the decision');
  before(card, "acq.outcome === 'closed'", 'resolveHostedAttemptAction(', 'a closed order must return before the decision');

  // …and no hosted checkout can be created before the decision has spoken.
  before(card, 'resolveHostedAttemptAction(', 'await createHostedCharge(', 'the decision must run BEFORE createHostedCharge — a refusal creates no PixelPay checkout');
  assert.strictEqual((card.match(/resolveHostedAttemptAction\(/g) || []).length, 1,
    'exactly ONE decision on the card path — a second would be a second chance to charge');
  assert.strictEqual((card.match(/applyConfirmedNetGate\(/g) || []).length, 1,
    'and exactly ONE gate call, inside that decision — no inline gate may reappear beside it');
  assert.strictEqual((card.match(/await createHostedCharge\(/g) || []).length, 1,
    'and exactly one createHostedCharge, so "before" is unambiguous');
  ok('card: the decision is reached on the fresh path and runs before createHostedCharge');
}

// ── 2. THE DECISION MODULE KEEPS THE RESUME RETURNS ABOVE THE GATE ─────────────────────────────
// Runtime tests prove reuse/in_progress consult no gate. This adds the one thing they cannot: that the
// early returns are still returns. A future edit that lets either branch fall through would be caught
// by hosted-charge-flow.test.js too — this is the belt to that's braces, and it costs nothing.
{
  const FLOW = fs.readFileSync(require.resolve('./hosted-charge-flow.js'), 'utf8');
  before(FLOW, "acq.outcome === 'in_progress'", 'await runGate()', 'an IN_PROGRESS must return before the gate');
  before(FLOW, "acq.outcome === 'reuse'", 'await runGate()', 'a REUSE must return before the gate — a resumed payment is never re-gated');
  before(FLOW, "acq.outcome !== 'claimed'", 'await runGate()', 'only a CLAIMED fresh attempt reaches the gate');
  assert.ok(/await retireAttempt\(acq\.attempt_id, 'quote_gate_refused'\)/.test(FLOW),
    '🔴 a refusal must retire the attempt it claimed — otherwise it strands in hosted_state creating, which reads as in_progress with no expiry');
  ok('flow: every resume returns above the gate, and a refusal retires its attempt');
}

// ── 2b. THE CARD GATE IS WIRED TO THE CHARGED AMOUNT AND THE CARD'S OWN RELEASE ────────────────
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  const i = card.indexOf('resolveHostedAttemptAction(');
  const call = card.slice(i, i + 2000);

  assert.ok(/recordedTotalCents: effBreakdown\.total_cents/.test(call),
    '🔴 the gate checks the amount that is actually charged (effBreakdown.total_cents === total_cents === the createHostedCharge amount)');
  assert.ok(/releaseHold: releaseHoldIfOwned/.test(call),
    '🔴 the card path passes its OWN release — releaseHoldIfOwned frees only a debit this call owns, so a reused or in-progress hold is preserved');
  assert.ok(!/releaseRedemption\(db/.test(call),
    '…and does NOT open-code releaseRedemption, which would strand or over-release a shared hold');
  assert.ok(/retireAttempt: \(attemptId, reason\) => retireUnissuedAttempt\(db/.test(call),
    '🔴 and passes a real retirement, so a refused attempt cannot strand');
  assert.ok(/reward: redemptionResolved/.test(call),
    '🔴 the gate binds the RESOLVED redemption the issuer fingerprinted, not a reconstruction');
  assert.ok(/token: body\.quote_token/.test(call), 'the token comes from the request');
  assert.ok(/submittedCart: body\.items/.test(call), 'the cart gated is the cart submitted');
  assert.ok(/enforce: false/.test(call), 'T5 ships in grace; T6 flips this');
  ok('card: the gate is wired to the charged amount, the card\'s own release, the retirement, and the resolved reward');
}

// ── 2c. 🔴 THE AMOUNT THAT LEAVES IS THE AMOUNT THAT WAS GATED ─────────────────────────────────
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  before(card, 'gatedCents !== total_cents', 'const amountStr = centsToLempiras(total_cents)',
    'the gated/outgoing equality must be checked BEFORE the amount is formatted for the gateway');
  before(card, 'const amountStr = centsToLempiras(total_cents)', 'await createHostedCharge(',
    'and that formatted amount is what travels');
  assert.ok(/amount: amountStr/.test(card) || /amountStr/.test(card.slice(card.indexOf('await createHostedCharge('), card.indexOf('await createHostedCharge(') + 600)),
    '🔴 createHostedCharge is handed the amount derived from total_cents, not a recomputation');
  ok('card: the outgoing gateway amount is bound to the gated cents');
}

// ── 3. THE CARD PATH CAPTURES THE RESOLVED REWARD ──────────────────────────────────────────────
// Without this the gate would fingerprint a null reward and refuse every reward-active card order —
// or, worse, accept a cart whose reward had been swapped.
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  assert.ok(/redemptionResolved = prep\.redemption/.test(card),
    '🔴 the card path captures prep.redemption — the same object the quote issuer fingerprinted');
  before(card, 'redemptionResolved = prep.redemption', 'applyConfirmedNetGate(', 'and captures it before the gate reads it');
  ok('card: the resolved reward is captured from prep, before the gate');
}

// ── 4. THE CASH GATE KEEPS ITS OWN PLACEMENT ───────────────────────────────────────────────────
// Re-asserted here so both endpoints' placement lives in one file: a future edit that moves either is
// a build failure, and "the other one is fine" is not something to discover in production.
{
  const cash = slice('const createOrderApp = express();', 'createOrderApp.use((err, req, res, next)');
  before(cash, 'returning idempotent', 'applyConfirmedNetGate(', 'an idempotent re-submit must return before the gate — it must not re-gate or re-charge');
  before(cash, 'resolveRedemptionForOrder(db, {', 'applyConfirmedNetGate(', 'the reward must be resolved before the gate binds it');
  before(cash, 'applyConfirmedNetGate(', 'db.ref().update(', 'the gate must run BEFORE anything is written — a refusal leaves no order behind');
  assert.ok(/recordedTotalCents: priceBreakdown\.total_cents/.test(cash),
    'cash: the gate checks the amount the order records and the driver collects');
  assert.strictEqual((cash.match(/applyConfirmedNetGate\(/g) || []).length, 1, 'exactly one gate call on the cash path');
  ok('cash: the gate still runs after idempotency and reward resolution, and before any write');
}

// ── 5. NON-VACUITY — the slicer really is reading the two different handlers ────────────────────
// Both endpoints contain similar code; a slice bug would let assertions about one silently pass by
// reading the other.
{
  const cash = slice('const createOrderApp = express();', 'createOrderApp.use((err, req, res, next)');
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  assert.ok(cash.length > 5000 && card.length > 5000, 'both slices are substantial');
  assert.ok(!cash.includes('createHostedCharge('), 'non-vacuity: the CASH slice contains no hosted-charge call');
  assert.ok(!card.includes('resolveRedemptionForOrder('), 'non-vacuity: the CARD slice contains no cash reward resolver');
  assert.ok(card.includes("acq.outcome === 'already_paid'"), 'non-vacuity: the CARD slice really holds the terminal acquire outcomes');
  // reuse / in_progress deliberately no longer appear here — they moved into hosted-charge-flow.js so
  // they could be RUN. Asserting their ABSENCE keeps this honest: if someone re-inlines that branch
  // beside the delegating call, there would be two answers to "what happens on a resume" and only one
  // of them would be tested.
  assert.ok(!card.includes("acq.outcome === 'reuse'"), 'non-vacuity: the resume branch lives in the flow module, not re-inlined here');
  const FLOW2 = fs.readFileSync(require.resolve('./hosted-charge-flow.js'), 'utf8');
  assert.ok(FLOW2.includes("acq.outcome === 'reuse'") && FLOW2.includes("acq.outcome === 'in_progress'"),
    'non-vacuity: …and the flow module really is where they live');
  assert.ok(cash.includes('returning idempotent'), 'non-vacuity: the CASH slice really holds the idempotency return');
  ok('the two handler slices are distinct — no assertion about one can pass by reading the other');
}

console.log(`\ncharge-gate-placement: OK (${n})`);
