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
const { resolveHostedAttemptAction, resolveAndIssueHostedCheckout, retireUnissuedAttempt } = require('./hosted-charge-flow');
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
function rig({ acq, gate, totalCents }) {
  const calls = { gate: 0, release: 0, retire: [] };
  const run = () => resolveHostedAttemptAction({
    acq, orderId: 'ORD-1', log: QUIET, totalCents,
    releaseHold: async () => { calls.release += 1; },
    retireAttempt: async (id, reason) => { calls.retire.push({ id, reason }); },
    runGate: async (recordedTotalCents) => {   // ← the module supplies it; production does the same
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
    const r = rig({ acq: { outcome: 'reuse', attempt_id: 'A9', poll_token: 'PT', checkout_url: 'https://pay/x' }, gate: goodGate, totalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 0, '🔴 a resume reached the gate');
    assert.strictEqual(d.respond.status, 200);
    assert.strictEqual(d.respond.body.checkout_url, 'https://pay/x', 'the SAME url, not a new one');
    assert.ok(!d.proceed, 'a resume must not authorise a second checkout');
    assert.strictEqual(r.calls.release, 0, 'the reused checkout is backed by that hold');
    ok('reuse returns the same checkout, consults no gate, keeps the hold');
  }
  {
    const r = rig({ acq: { outcome: 'in_progress' }, gate: goodGate, totalCents: net });
    const d = await r.run();
    assert.strictEqual(r.calls.gate, 0, '🔴 an in-flight creation reached the gate');
    assert.strictEqual(d.respond.status, 202);
    assert.ok(!d.proceed);
    assert.strictEqual(r.calls.release, 0, 'releasing would strand the concurrent payable checkout');
    ok('in_progress answers 202, consults no gate, keeps the hold');
  }

  // ── 2. A FRESH CLAIM IS GATED, AND AN ACCEPT AUTHORISES EXACTLY THE GATED AMOUNT ────────────────
  {
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A1' }, gate: goodGate, totalCents: net });
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

    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A2' }, gate: { ...goodGate, tables: cheaper }, totalCents: lower });
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
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A3' }, gate, totalCents: rec });
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
    const r = rig({ acq: { outcome: 'claimed', attempt_id: 'A4' }, gate: goodGate, totalCents: net + 1 });
    const d = await r.run();
    assert.ok(!d.proceed, '🔴 approved != recorded must authorise no checkout');
    assert.strictEqual(d.respond.status, 409);
    assert.deepStrictEqual(r.calls.retire, [{ id: 'A4', reason: 'quote_gate_refused' }], 'divergence retires the attempt too');
    ok('approved != recorded → 409, no checkout, attempt retired');
  }

  // ── 4. A FAILED ACQUIRE RELEASES BUT HAS NO ATTEMPT TO RETIRE ───────────────────────────────────
  {
    const r = rig({ acq: { outcome: 'failed' }, gate: goodGate, totalCents: net });
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

  // ══ THE CONSUMPTION ═════════════════════════════════════════════════════════════════════════════
  // Everything above tests the DECISION. These test what the handler does WITH it — the glue that three
  // surviving mutations lived in. The rig below drives acquire-outcome → gateway-call-or-not and spies
  // on the gateway itself, so "a refusal creates no checkout" and "the gateway got the gated amount"
  // are executed rather than read off the source.
  const centsToLempiras = (c) => (c / 100).toFixed(2);
  function fullRig({ acq, gate, totalCents, checkout = { ok: true, url: 'https://pay/new' }, persistThrows = false }) {
    const calls = { gate: 0, release: 0, retire: [], checkout: [], stamped: [], persisted: [] };
    const run = () => resolveAndIssueHostedCheckout({
      acq, orderId: 'ORD-1', log: QUIET, attemptId: acq.attempt_id,
      totalCents, toLempiras: centsToLempiras,
      chargeRequest: { pixelpayOrderId: 'ORD-1-A1', firstName: 'Ana', lastName: 'Paz', email: 'a@b.co' },
      releaseHold: async () => { calls.release += 1; },
      retireAttempt: async (id, reason) => { calls.retire.push({ id, reason }); },
      stampProvenance: async (prov) => { calls.stamped.push(prov); },
      createCheckout: async (req) => {
        calls.checkout.push(req);
        if (checkout instanceof Error) throw checkout;
        return checkout;
      },
      persistCreated: async (url) => { if (persistThrows) throw new Error('rtdb down'); calls.persisted.push(url); },
      runGate: async (recordedTotalCents) => {   // ← the module supplies it; production does the same
        calls.gate += 1;
        return applyConfirmedNetGate({
          gateInput: { secret: SEC, nowMs: 1_000_100, ...gate },
          recordedTotalCents, releaseHold: async () => { calls.release += 1; }, orderId: 'ORD-1', log: QUIET,
        });
      },
    });
    return { calls, run };
  }

  // ── 6. 🔴 AN ACCEPT CALLS THE GATEWAY EXACTLY ONCE, AT THE GATED AMOUNT ────────────────────────
  // This is the assertion that kills `amountLempiras: amountStr + 1`. It reads the argument the
  // gateway actually received, not a field of the decision.
  {
    const r = fullRig({ acq: { outcome: 'claimed', attempt_id: 'A1' }, gate: goodGate, totalCents: net});
    const out = await r.run();
    assert.strictEqual(r.calls.checkout.length, 1, 'exactly one checkout is created');
    assert.strictEqual(r.calls.checkout[0].amountLempiras, centsToLempiras(net),
      `🔴 the gateway must receive the GATED amount (${centsToLempiras(net)}), got ${r.calls.checkout[0].amountLempiras}`);
    assert.strictEqual(out.amountLempiras, centsToLempiras(net));
    assert.strictEqual(out.hosted.url, 'https://pay/new');
    assert.deepStrictEqual(r.calls.persisted, ['https://pay/new'], 'the live URL is persisted');
    assert.strictEqual(r.calls.release, 0);
    assert.deepStrictEqual(r.calls.stamped, [{ quote_id: r.calls.stamped[0].quote_id, confirmed_net_cents: net, charged_net_cents: net }]);
    ok(`an accept calls the gateway once at the gated amount (${centsToLempiras(net)})`);
  }
  // …and on a DROP the gateway gets the LOWER number, not the confirmed ceiling.
  {
    const { itemPricingKey } = require('./menu-pricing');
    const k = itemPricingKey(items[0], rid);
    const cheaper = { ...tables, menu: { ...tables.menu, [k]: Math.max(1, Math.round(tables.menu[k] / 2)) } };
    const lower = computeServerNet({ items, rid, tables: cheaper }).net_total_cents;
    assert.ok(lower < net, 'non-vacuity: the drop fixture really drops');
    const r = fullRig({ acq: { outcome: 'claimed', attempt_id: 'A2' }, gate: { ...goodGate, tables: cheaper }, totalCents: lower});
    await r.run();
    assert.strictEqual(r.calls.checkout.length, 1);
    assert.strictEqual(r.calls.checkout[0].amountLempiras, centsToLempiras(lower),
      '🔴 a drop must charge the LOWER amount at the gateway');
    ok(`a drop calls the gateway at the lower amount (${centsToLempiras(lower)} < ${centsToLempiras(net)})`);
  }

  // ── 7. 🔴 A REFUSAL NEVER REACHES THE GATEWAY ──────────────────────────────────────────────────
  // The mutation this kills: deleting the handler's `if (decision.respond) return`. A 409 fell through,
  // chargedCents was null so it slipped past the amount guard, and a checkout was minted after a refusal.
  {
    const up = { ...tables, menu: { ...tables.menu } };
    const k0 = Object.keys(up.menu)[0]; up.menu[k0] = up.menu[k0] * 3 + 7;
    for (const [label, gate, recorded] of [
      ['an increase', { ...goodGate, tables: up }, 999_999_99],
      ['a tampered token', { ...goodGate, token: token.slice(0, -3) + 'aaa' }, net],
      ['no token at all', { ...goodGate, token: undefined, enforce: true }, net],
      // The gate computes its own net from the tables; the module hands it the total it will charge.
      // A disagreement between those two is the divergence case — still real, still refuses.
      ['the server total disagrees with the gate\'s net', goodGate, net + 1],
    ]) {
      const r = fullRig({ acq: { outcome: 'claimed', attempt_id: 'A3' }, gate, totalCents: recorded});
      const out = await r.run();
      assert.strictEqual(out.respond.status, 409, `${label}: refuses`);
      assert.strictEqual(r.calls.checkout.length, 0, `🔴 ${label}: a refusal created a checkout`);
      assert.deepStrictEqual(r.calls.persisted, [], `${label}: and persisted nothing`);
      assert.ok(r.calls.release >= 1, `${label}: the hold is released`);
      assert.deepStrictEqual(r.calls.retire, [{ id: 'A3', reason: 'quote_gate_refused' }], `${label}: the attempt is retired`);
    }
    ok('every refusal reaches the gateway ZERO times, releases the hold, and retires the attempt');
  }
  // A resume likewise never reaches the gateway — it already has one.
  for (const acq of [{ outcome: 'reuse', attempt_id: 'A9', checkout_url: 'https://pay/x' }, { outcome: 'in_progress' }, { outcome: 'failed' }]) {
    const r = fullRig({ acq, gate: goodGate, totalCents: net});
    await r.run();
    assert.strictEqual(r.calls.checkout.length, 0, `🔴 ${acq.outcome} must not create a checkout`);
  }
  ok('reuse / in_progress / failed-acquire each create ZERO checkouts');

  // ── 8. 🔴 THE AMOUNT IS THE INDEPENDENTLY-COMPUTED SERVER NET ─────────────────────────────────
  // There is no longer a gated-vs-outgoing guard to test: totalCents is single-sourced, so the gate is
  // handed the very number this flow charges and the two cannot disagree by construction. What matters
  // is that the number is RIGHT, which cells 12-13 establish against computeServerNet run separately
  // over the fixture cart — not against anything the flow produced. Re-asserted here for a reward cart,
  // where a la_musa redemption is net-invariant and an off-by-one would otherwise hide.
  {
    const r = fullRig({ acq: { outcome: 'claimed', attempt_id: 'A5' }, gate: goodGate, totalCents: net });
    await r.run();
    const independent = computeServerNet({ items, rid, tables }).net_total_cents;
    assert.strictEqual(r.calls.checkout[0].amountLempiras, centsToLempiras(independent),
      '🔴 the gateway amount must equal the independently recomputed server net');
    assert.notStrictEqual(independent, 0, 'non-vacuity: the expected net is a real number');
    ok(`the gateway amount equals an independently recomputed server net (${centsToLempiras(independent)})`);
  }

  // ── 9. 🔴 EVERY POST-CLAIM BAILOUT RELEASES THE OWNED HOLD — ASSERTED PER BRANCH ────────────────
  // Previously "enumerated" by counting `releaseHoldIfOwned()` occurrences in the source. That count
  // matched a COMMENTED-OUT call, so deleting a real release passed the guard. Each branch is now run.
  {
    const cases = [
      ['gateway throws (network)', { checkout: new Error('ECONNRESET') }, 502, 'network', true],
      ['gateway rejects (!ok)', { checkout: { ok: false, errors: { _amount: 'bad' } } }, 502, '{"_amount":"bad"}', true],
      ['gateway returns no url', { checkout: { ok: true, url: null } }, 502, '{}', true],
      ['persisting the URL fails', { persistThrows: true }, 500, null, false],
    ];
    for (const [label, over, status, reason, retires] of cases) {
      const r = fullRig({ acq: { outcome: 'claimed', attempt_id: 'A6' }, gate: goodGate, totalCents: net, ...over });
      const out = await r.run();
      assert.strictEqual(out.respond.status, status, `${label}: responds ${status}`);
      assert.strictEqual(r.calls.release, 1, `🔴 ${label}: the owned hold MUST be released — otherwise the points stay debited`);
      if (retires) assert.deepStrictEqual(r.calls.retire, [{ id: 'A6', reason }], `${label}: and the unissued attempt is retired`);
      else assert.deepStrictEqual(r.calls.retire, [], `${label}: the attempt WAS issued, so it is not retired — only the hold is freed`);
    }
    ok('each post-claim bailout (network / rejected / no-url / persist-fail) releases the owned hold');
  }

  console.log(`\nhosted-charge-flow: ${n} checks passed`);
})().catch((e) => { console.error('hosted-charge-flow FAILED:', e && e.message); process.exit(1); });
