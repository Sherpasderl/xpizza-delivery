'use strict';
// ---------------------------------------------------------------------------
// 1C Task 5 — THE CARD PATH'S GUARANTEES, RUN RATHER THAN READ.
//
// charge-gate-placement.test.js asserts source ORDER: the gate sits below the reuse/in_progress returns
// and above createHostedCharge. That is worth keeping — it fails loudly if the call is moved — but it
// is blind to everything order does not imply. Two mutations show the blindness: turning the reuse
// branch's `return` into `acq.outcome = 'claimed'`, and deleting the `return` in front of the refusal's
// response. Both leave the source order exactly as the structural test demands, and both are real
// incidents — a payment re-gated while in flight, and a refused order minting a checkout at the very
// amount the refusal exists to prevent.
//
// So these tests RUN the decision and assert its EFFECTS: was the gate consulted at all, was a checkout
// authorised, was the hold released, was the claimed attempt retired.
// ---------------------------------------------------------------------------
const assert = require('assert');
const { resolveHostedAttemptAction, retireUnissuedAttempt } = require('./hosted-charge-flow');
const { applyConfirmedNetGate } = require('./token-gate');
const { issueQuote } = require('./quote-issue');
const { computeServerNet } = require('./compute-server-net');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { CARTS } = require('./parity-carts.fixture');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const QUIET = { log() {}, warn() {}, error() {} };
const SEC = 'test-flow-secret';
const T = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });
const withSecret = (fn) => {
  const prev = process.env.QUOTE_TOKEN_SECRET;
  process.env.QUOTE_TOKEN_SECRET = SEC;
  try { return fn(); } finally { if (prev === undefined) delete process.env.QUOTE_TOKEN_SECRET; else process.env.QUOTE_TOKEN_SECRET = prev; }
};

// A recording rig. Every effect the decision can have is a spy; the gate records whether it ran AT ALL,
// which is the fact the structural test cannot reach.
function rig({ acq, gate, recordedTotalCents }) {
  const calls = { gate: 0, release: 0, retire: [] };
  const run = () => resolveHostedAttemptAction({
    acq, orderId: 'ORD-1', log: QUIET,
    releaseHold: async () => { calls.release += 1; },
    retireAttempt: async (id, reason) => { calls.retire.push({ id, reason }); },
    runGate: async () => {
      calls.gate += 1;
      return applyConfirmedNetGate({
        gateInput: { secret: SEC, nowMs: 1_000_100, ...gate },
        recordedTotalCents, releaseHold: async () => { calls.release += 1; }, orderId: 'ORD-1', log: QUIET,
      });
    },
  });
  return { calls, run };
}

(async () => {
  const rid = 'x_pizza', tables = T(rid), items = CARTS[rid][0];
  const net = computeServerNet({ items, rid, tables }).net_total_cents;
  const token = withSecret(() => issueQuote({ items, reward: null, redemptionRef: null, rid, tables, nowMs: 1_000_000 }).quote_token);
  const goodGate = { token, submittedCart: items, reward: null, rid, tables, enforce: false };

  // ── 1. A RESUME IS NEVER RE-GATED ───────────────────────────────────────────────────────────────
  {
    const r = rig({ acq: { outcome: 'reuse', attempt_id: 'A9', poll_token: 'PT', checkout_url: 'https://pay/x' }, gate: goodGate, recordedTotalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 0, '🔴 a resume reached the gate');
    assert.strictEqual(d.respond.status, 200);
    assert.strictEqual(d.respond.body.checkout_url, 'https://pay/x', 'the SAME url, not a new one');
    assert.ok(!d.proceed, 'a resume must not authorise a second checkout');
    assert.strictEqual(r.calls.release, 0, 'the reused checkout is backed by that hold');
    ok('reuse returns the same checkout, consults no gate, keeps the hold');
  }
  {
    const r = rig({ acq: { outcome: 'in_progress' }, gate: goodGate, recordedTotalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 0, '🔴 an in-flight creation reached the gate');
    assert.strictEqual(d.respond.status, 202);
    assert.ok(!d.proceed);
    assert.strictEqual(r.calls.release, 0, 'releasing would strand the concurrent payable checkout');
    ok('in_progress answers 202, consults no gate, keeps the hold');
  }

  // ── 2. A FRESH CLAIM IS GATED, AND AN ACCEPT AUTHORISES EXACTLY THE GATED AMOUNT ────────────────
  {
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A1' }, gate: goodGate, recordedTotalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 1, 'a fresh mint MUST be gated');
    assert.ok(d.proceed, 'an unchanged cart proceeds to checkout');
    assert.strictEqual(r.calls.release, 0, 'an accepted order keeps its hold');
    assert.deepStrictEqual(r.calls.retire, [], 'an accepted attempt is not retired');
    assert.strictEqual(d.chargedCents, net, '🔴 the amount travelling to the gateway is the gated net');
    assert.strictEqual(d.provenance.confirmed_net_cents, net, 'the ceiling the customer accepted is stamped');
    assert.strictEqual(d.provenance.charged_net_cents, net, 'and the amount actually charged is stamped');
    ok('a fresh claim is gated, proceeds, and carries the gated amount + both provenance facts');
  }
  // A DROP: the server's price fell below the confirmed ceiling. The customer is charged the lower
  // number, and provenance keeps BOTH — the ceiling they agreed to and the amount they paid.
  {
    /* Halve a price the CART ACTUALLY USES. Picking an arbitrary menu key silently produced no drop at
       all on the first writing of this test, and the cell skipped itself without failing — so the
       drop is asserted to be a real drop before anything is concluded from it. */
    const { itemPricingKey } = require('./menu-pricing');
    const usedKey = itemPricingKey(items[0], rid);
    assert.ok(Object.prototype.hasOwnProperty.call(tables.menu, usedKey), `the fixture cart must price off the menu (${usedKey})`);
    const cheaper = { ...tables, menu: { ...tables.menu, [usedKey]: Math.max(1, Math.round(tables.menu[usedKey] / 2)) } };
    const lower = computeServerNet({ items, rid, tables: cheaper }).net_total_cents;
    assert.ok(lower < net, `🔴 the drop fixture must actually drop the price (${lower} vs ${net})`);

    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A2' }, gate: { ...goodGate, tables: cheaper }, recordedTotalCents: lower });
    const d = await r.run();
    assert.ok(d.proceed, 'a price DROP must still charge, not refuse');
    assert.strictEqual(d.chargedCents, lower, '🔴 the outgoing amount is the LOWER one');
    assert.strictEqual(d.provenance.charged_net_cents, lower);
    assert.strictEqual(d.provenance.confirmed_net_cents, net, '🔴 the ceiling the customer accepted is NOT overwritten by the drop');
    assert.strictEqual(r.calls.release, 0, 'a drop keeps the hold');
    ok(`a drop charges the lower amount (${lower} < ${net}) and keeps the accepted ceiling`);
  }

  // ── 3. EVERY REFUSAL: NO CHECKOUT, HOLD RELEASED, ATTEMPT RETIRED ───────────────────────────────
  // The retirement is the fix for the stranding: a refused attempt is left in hosted_state 'creating',
  // which acquireHostedAttempt reads as `in_progress` with NO expiry check — so without this the
  // customer's every retry is told "a checkout is being created" forever.
  const refusals = [
    ['an increase', { ...goodGate, tables: (() => { const up = { ...tables, menu: { ...tables.menu } };
      const k = Object.keys(up.menu)[0]; up.menu[k] = up.menu[k] * 3 + 7; return up; })() }, null],
    ['a tampered token', { ...goodGate, token: token.slice(0, -3) + 'aaa' }, net],
    ['no token at all', { ...goodGate, token: undefined, enforce: true }, net],
  ];
  for (const [label, gate, recorded] of refusals) {
    const rec = recorded === null ? 999_999_99 : recorded;
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A3' }, gate, recordedTotalCents: rec });
    const d = await r.run();
    assert.ok(d.respond && d.respond.status === 409, `${label}: must refuse (got ${d.respond && d.respond.status})`);
    assert.ok(!d.proceed, `🔴 ${label}: a refusal must authorise NO checkout`);
    assert.strictEqual(d.chargedCents, undefined, `${label}: a refusal carries no chargeable amount`);
    assert.ok(r.calls.release >= 1, `${label}: the reward hold must be released`);
    assert.deepStrictEqual(r.calls.retire, [{ id: 'A3', reason: 'quote_gate_refused' }],
      `🔴 ${label}: the claimed attempt must be RETIRED or every retry strands on in_progress`);
    ok(`${label} → 409, no checkout, hold released, attempt retired`);
  }
  // DIVERGENCE: the gate approved a number that is not the one the order records.
  {
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A4' }, gate: goodGate, recordedTotalCents: net + 1 });
    const d = await r.run();
    assert.ok(!d.proceed, '🔴 approved != recorded must authorise no checkout');
    assert.strictEqual(d.respond.status, 409);
    assert.deepStrictEqual(r.calls.retire, [{ id: 'A4', reason: 'quote_gate_refused' }], 'divergence retires the attempt too');
    ok('approved != recorded → 409, no checkout, attempt retired');
  }

  // ── 4. A FAILED ACQUIRE RELEASES BUT HAS NO ATTEMPT TO RETIRE ───────────────────────────────────
  {
    const r = rig({ acq: { outcome: 'failed' }, gate: goodGate, recordedTotalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 0, 'nothing was claimed, so nothing is gated');
    assert.strictEqual(d.respond.status, 503);
    assert.strictEqual(r.calls.release, 1, 'an abandoned reserve is released');
    assert.deepStrictEqual(r.calls.retire, [], 'no attempt was minted, so none is retired');
    ok('a failed acquire releases the hold and retires nothing');
  }

  // ── 5. RETIREMENT WRITES THE STATE THAT LETS A RETRY MINT FRESH ─────────────────────────────────
  // 'creating' is read as in_progress forever; 'failed_create' is not in the closed-state list either,
  // so a retry falls through to the rotate branch and mints a new attempt. Asserting the exact state
  // because that string is the entire mechanism.
  {
    const writes = [];
    const db = { ref: (path) => ({ update: async (v) => { writes.push({ path, v }); }, }) };
    await retireUnissuedAttempt(db, 'A7', 'quote_gate_refused', 4242);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].path, 'payment_attempts/A7');
    assert.strictEqual(writes[0].v.hosted_state, 'failed_create', '🔴 the state a retry can move past');
    assert.strictEqual(writes[0].v.failed_create_reason, 'quote_gate_refused');
    assert.strictEqual(writes[0].v.updated_at, 4242);
    ok('retirement writes hosted_state failed_create with a reason and a timestamp');
  }
  {
    // A retire that throws must not take the refusal down with it — the customer still gets their 409.
    const db = { ref: () => ({ update: async () => { throw new Error('rtdb down'); } }) };
    await retireUnissuedAttempt(db, 'A8', 'quote_gate_refused', 1);
    await retireUnissuedAttempt(null, 'A8', 'quote_gate_refused', 1);
    await retireUnissuedAttempt(db, undefined, 'quote_gate_refused', 1);
    ok('a failing or impossible retirement is swallowed, never thrown at the customer');
  }

  console.log(`\nhosted-charge-flow: ${n} checks passed`);
})().catch((e) => { console.error('hosted-charge-flow FAILED:', e && e.message); process.exit(1); });
