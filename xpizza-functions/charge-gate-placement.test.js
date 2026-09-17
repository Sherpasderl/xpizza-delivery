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
const { readFileSync } = fs;
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
  before(card, "acq.outcome === 'already_paid'", 'resolveAndIssueHostedCheckout(', 'an already-paid order must return before the decision');
  before(card, "acq.outcome === 'conflict'", 'resolveAndIssueHostedCheckout(', 'a conflicting order must return before the decision');
  before(card, "acq.outcome === 'closed'", 'resolveAndIssueHostedCheckout(', 'a closed order must return before the decision');

  /* 🔴 THE HANDLER MUST NOT BE ABLE TO CHARGE ON ITS OWN. createHostedCharge is no longer CALLED in
     index.js at all — it is passed into the flow module as an injected effect, which is what makes
     "a refusal creates no checkout" a property of the shape rather than of a watched `return`. If a
     direct call ever reappears here, there would be a charge path no runtime test covers. */
  assert.strictEqual((card.match(/await createHostedCharge\(/g) || []).length, 0,
    '🔴 the handler must not call the gateway directly — it injects it into the gated flow');
  assert.strictEqual((card.match(/createCheckout: createHostedCharge/g) || []).length, 1,
    'the gateway is handed to the flow exactly once');
  assert.strictEqual((card.match(/resolveAndIssueHostedCheckout\(/g) || []).length, 1,
    'exactly ONE decision on the card path — a second would be a second chance to charge');
  assert.strictEqual((card.match(/applyConfirmedNetGate\(/g) || []).length, 1,
    'and exactly ONE gate call, inside that decision — no inline gate may reappear beside it');
  ok('card: the handler routes through the gated flow and never calls the gateway itself');
}

// ── 2. THE DECISION MODULE KEEPS THE RESUME RETURNS ABOVE THE GATE ─────────────────────────────
// Runtime tests prove reuse/in_progress consult no gate. This adds the one thing they cannot: that the
// early returns are still returns. A future edit that lets either branch fall through would be caught
// by hosted-charge-flow.test.js too — this is the belt to that's braces, and it costs nothing.
{
  const FLOW = fs.readFileSync(require.resolve('./hosted-charge-flow.js'), 'utf8');
  before(FLOW, "acq.outcome === 'in_progress'", 'await runGate(totalCents)', 'an IN_PROGRESS must return before the gate');
  before(FLOW, "acq.outcome === 'reuse'", 'await runGate(totalCents)', 'a REUSE must return before the gate — a resumed payment is never re-gated');
  before(FLOW, "acq.outcome !== 'claimed'", 'await runGate(totalCents)', 'only a CLAIMED fresh attempt reaches the gate');
  assert.ok(/await retireAttempt\(acq\.attempt_id, 'quote_gate_refused'\)/.test(FLOW),
    '🔴 a refusal must retire the attempt it claimed — otherwise it strands in hosted_state creating, which reads as in_progress with no expiry');
  ok('flow: every resume returns above the gate, and a refusal retires its attempt');
}

// ── 2b. THE CARD GATE IS WIRED TO THE CHARGED AMOUNT AND THE CARD'S OWN RELEASE ────────────────
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  // The gate wiring lives in hostedFlowOpts, built above the call so issuance can use the request
  // fields; slice from there rather than from the invocation.
  const i = card.indexOf('const hostedFlowOpts = {');
  assert.ok(i !== -1, 'non-vacuity: the flow options block was found');
  const call = card.slice(i, i + 2000);

  /* 🔴 ONE SERVER TOTAL, NAMED ONCE. effBreakdown.total_cents is handed to the flow as `totalCents`,
     and the flow passes that same value back into the gate as recordedTotalCents — so "the number the
     gate approved" and "the number PixelPay is asked for" are the same binding, not two expressions
     that happen to agree today. The bare shorthand is the assertion: a literal here (`: 0`, or a
     recomputation) would mean the gate is checking something other than what travels. */
  assert.ok(/totalCents: effBreakdown\.total_cents,/.test(call),
    '🔴 the flow is handed the SERVER total, named once');
  assert.ok(/^\s*recordedTotalCents,\s*\/\//m.test(call),
    '🔴 and the gate is given exactly that total back — not a literal and not a second expression');
  assert.ok(!/recordedTotalCents:/.test(call),
    '…so no separate number can be introduced for the gate to check');
  assert.ok(/releaseHold: releaseHoldIfOwned/.test(call),
    '🔴 the card path passes its OWN release — releaseHoldIfOwned frees only a debit this call owns, so a reused or in-progress hold is preserved');
  assert.ok(!/releaseRedemption\(db/.test(call),
    '…and does NOT open-code releaseRedemption, which would strand or over-release a shared hold');
  assert.ok(/retireAttempt: \(aid, reason\) => retireUnissuedAttempt\(db/.test(call),
    '🔴 and passes a real retirement, so a refused attempt cannot strand');
  /* 🔴 THE ATTACH IS THE FLOW'S TO CALL, NOT THE HANDLER'S. attachAttempt binds attempt_id and
     hosted_expires_at onto the reward hold and is only correct for an ACCEPTED FRESH CLAIM. It used to
     sit inline, protected by the resume returns above it; when issuance moved into the flow the
     invocation landed below it and a resume silently nulled a live hold's expiry. It is an injected
     effect now — so if a bare attachAttempt( call ever reappears in this handler, that protection has
     been lost again. */
  assert.ok(/attachReservation: redemptionCanonical/.test(call),
    '🔴 the reservation attach is injected into the gated flow, which calls it only on an accepted fresh claim');
  assert.strictEqual((card.match(/await attachAttempt\(/g) || []).length, 0,
    '🔴 the handler must not attach on its own — that is what let a resume rewrite a live hold');
  assert.ok(/reward: redemptionResolved/.test(call),
    '🔴 the gate binds the RESOLVED redemption the issuer fingerprinted, not a reconstruction');
  /* 🔴 THE REQUEST→GATE MAPPING MOVED, AND THAT IS THE POINT. These used to assert the field names
     inline at each call site — which is exactly the check that could not catch a rename, because it
     read the same literal the handler did. The mapping now lives in ONE function (gateInputFromRequest)
     and is driven end-to-end by composition.test.mjs: the real client's body → the real adapter → the
     real gate. What is asserted here is only that the handler routes through it rather than rebuilding
     the mapping locally, which is what would put the names back in two places. */
  assert.ok(/gateInput: gateInputFromRequest\(body,/.test(call),
    '🔴 the card gate must build its input through the ONE shared request→gate mapping');
  assert.ok(!/token: body\.quote_token/.test(card),
    '…and must not re-inline the field mapping — two copies is how a rename survives the suite');
  assert.ok(/submittedCart: body\.items/.test(readFileSync(require.resolve('./token-gate.js'), 'utf8')),
    'non-vacuity: the shared mapping really is the thing that reads the cart off the request');
  /* 🔴 T6: THE FLAG IS READ, NOT HARDCODED. A literal `false` here would pin the card path to grace
     forever — the flip would land in config, the owner would see the flag go true, and card orders
     would still never enforce. That is a silent no-op, which is the worst kind: it looks shipped.
     The flag itself fails safe to grace (tokenEnforceEnabled), so reading it is never the risky half. */
  assert.ok(/enforce: tokenEnforce\b/.test(call),
    '🔴 the card gate must READ the enforce flag — a hardcoded value makes the rollout flip a no-op');
  assert.ok(!/enforce: (false|true)\b/.test(call), '…and must not hardcode either direction');
  // The ceiling now travels through the shared mapping, asserted end-to-end in composition.test.mjs.
  // Re-asserting the literal here would restore the two-copies problem the extraction removed.
  assert.ok(/gateInputFromRequest\(body,/.test(call),
    '🔴 the client ceiling reaches the gate through the shared mapping, not a local copy of it');
  ok('card: the gate is wired to the charged amount, the card\'s own release, the retirement, and the resolved reward');
}

// ── 2c. 🔴 THE AMOUNT THAT LEAVES IS THE AMOUNT THAT WAS GATED ─────────────────────────────────
// The binding itself is RUN in hosted-charge-flow.test.js (the spy reads the argument the gateway
// actually received, on both an equal-price and a price-drop accept). What is asserted here is only
// that the handler hands the flow the right total and formatter — a source fact, since the handler
// itself is not executed.
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  const i = card.indexOf('resolveAndIssueHostedCheckout(');
  const call = card.slice(i, i + 1200);
  assert.ok(/toLempiras: centsToLempiras/.test(call), 'the flow formats the amount with the real formatter');
  assert.ok(!/amountLempiras:/.test(card), '🔴 the handler must not format the gateway amount itself — the flow does, from the gated total');
  ok('card: the flow is handed the recorded total and the real formatter');
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
  // T6: the cash gate is the OTHER flip point — same no-op hazard, same guard.
  assert.ok(/enforce: tokenEnforce\b/.test(cash), '🔴 the cash gate must READ the enforce flag too');
  assert.ok(/gateInputFromRequest\(body,/.test(cash), 'and build its gate input through the shared mapping');
  assert.strictEqual((cash.match(/const tokenEnforce = await tokenEnforceEnabled\(db\)/g) || []).length, 1,
    'read exactly once per request — a second read could answer differently about the same order');
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
