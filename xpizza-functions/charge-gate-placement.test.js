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
 * What cannot be unit-tested is WHERE the call sits, and on the card path the placement IS the
 * guarantee: `reuse` and `in_progress` return BEFORE it, which is what makes a customer resuming from
 * PixelPay immune to a price that moved while they were on the payment page. Re-gating a payment
 * already in flight would refuse it at the worst possible moment. An ordering property can only be
 * asserted over the source, so it is — in the same style as intake-gate-placement.test.js, and with the
 * same honesty about its limits: this locks the structure so a future edit that moves the gate fails
 * the build; it does not execute the handler.
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

// ── 1. 🔴 THE CARD GATE IS ON THE FRESH PATH ONLY ──────────────────────────────────────────────
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');

  // The resume returns come FIRST — this is the property, not a detail.
  before(card, "acq.outcome === 'reuse'", 'applyConfirmedNetGate(', 'a REUSE must return before the gate — a resumed payment is never re-gated');
  before(card, "acq.outcome === 'in_progress'", 'applyConfirmedNetGate(', 'an IN_PROGRESS must return before the gate');
  before(card, "acq.outcome === 'already_paid'", 'applyConfirmedNetGate(', 'an already-paid order must return before the gate');
  before(card, "acq.outcome === 'conflict'", 'applyConfirmedNetGate(', 'a conflicting order must return before the gate');
  before(card, "acq.outcome === 'closed'", 'applyConfirmedNetGate(', 'a closed order must return before the gate');
  before(card, "acq.outcome !== 'claimed'", 'applyConfirmedNetGate(', 'only a CLAIMED fresh attempt reaches the gate');

  // …and no hosted checkout can be created before the gate has spoken.
  before(card, 'applyConfirmedNetGate(', 'await createHostedCharge(', 'the gate must run BEFORE createHostedCharge — a refusal creates no PixelPay checkout');
  assert.strictEqual((card.match(/applyConfirmedNetGate\(/g) || []).length, 1,
    'exactly ONE gate call on the card path — a second would be a second decision');
  assert.strictEqual((card.match(/await createHostedCharge\(/g) || []).length, 1,
    'and exactly one createHostedCharge, so "before" is unambiguous');
  ok('card: the gate runs only on a fresh claim, after every resume return and before createHostedCharge');
}

// ── 2. THE CARD GATE IS WIRED TO THE CHARGED AMOUNT AND THE CARD'S OWN RELEASE ─────────────────
{
  const card = slice('const chargeOnlineApp = express();', 'chargeOnlineApp.use((err, req, res, next)');
  const call = card.slice(card.indexOf('applyConfirmedNetGate('), card.indexOf('applyConfirmedNetGate(') + 1200);

  assert.ok(/recordedTotalCents: effBreakdown\.total_cents/.test(call),
    '🔴 the gate checks the amount that is actually charged (effBreakdown.total_cents === total_cents === the createHostedCharge amount)');
  assert.ok(/releaseHold: releaseHoldIfOwned/.test(call),
    '🔴 the card path passes its OWN release — releaseHoldIfOwned frees only a debit this call owns, so a reused or in-progress hold is preserved');
  assert.ok(!/releaseRedemption\(db/.test(call),
    '…and does NOT open-code releaseRedemption, which would strand or over-release a shared hold');
  assert.ok(/reward: redemptionResolved/.test(call),
    '🔴 the gate binds the RESOLVED redemption the issuer fingerprinted, not a reconstruction');
  assert.ok(/token: body\.quote_token/.test(call), 'the token comes from the request');
  assert.ok(/submittedCart: body\.items/.test(call), 'the cart gated is the cart submitted');
  assert.ok(/enforce: false/.test(call), 'T5 ships in grace; T6 flips this');
  ok('card: the gate is wired to the charged amount, the card\'s own release, and the resolved reward');
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
  assert.ok(card.includes("acq.outcome === 'reuse'"), 'non-vacuity: the CARD slice really holds the acquire outcomes');
  assert.ok(cash.includes('returning idempotent'), 'non-vacuity: the CASH slice really holds the idempotency return');
  ok('the two handler slices are distinct — no assertion about one can pass by reading the other');
}

console.log(`\ncharge-gate-placement: OK (${n})`);
