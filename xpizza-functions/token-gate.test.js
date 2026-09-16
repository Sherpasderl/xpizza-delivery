'use strict';
// Portal 1C Task 4 — the confirmed-net gate. Run: node token-gate.test.js
//
// 🔴 EVERY TOKEN HERE COMES FROM THE REAL ISSUER. A hand-built token proves the verifier parses what
// the test author wrote; it says nothing about whether the issuer and the gate agree — and "issuer and
// gate agree" IS the guarantee. So issueQuote() mints every token below, and the gate is then asked
// about the same cart, a different cart, or a moved price.
const assert = require('node:assert');
const { gateConfirmedNet, applyConfirmedNetGate } = require('./token-gate');
const { issueQuote } = require('./quote-issue');
const { computeServerNet } = require('./compute-server-net');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { CARTS } = require('./parity-carts.fixture');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const SEC = 'test-gate-secret';
const T = (rid, over = {}) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid], ...(over.menu || {}) },
                                 extras: { ...EXTRAS_BY_RESTAURANT[rid], ...(over.extras || {}) } });
const withSecret = (fn) => {
  const prev = process.env.QUOTE_TOKEN_SECRET;
  process.env.QUOTE_TOKEN_SECRET = SEC;
  try { return fn(); } finally { if (prev === undefined) delete process.env.QUOTE_TOKEN_SECRET; else process.env.QUOTE_TOKEN_SECRET = prev; }
};
const mint = (items, rid, tables, reward = null, redemptionRef = null) =>
  withSecret(() => issueQuote({ items, reward, redemptionRef, rid, tables, nowMs: 1_000_000 }).quote_token);
const gate = (o) => gateConfirmedNet({ secret: SEC, nowMs: 1_000_100, ...o });

// ── 1. THE ORDINARY CASE: THE CART IS THE CART, THE PRICE HAS NOT MOVED ────────────────────────
{
  let carts = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const items of CARTS[rid]) {
      const tables = T(rid);
      const g = gate({ token: mint(items, rid, tables), submittedCart: items, rid, tables });
      assert.strictEqual(g.action, 'charge', `${rid}: an unchanged cart charges (${g.reason})`);
      assert.strictEqual(g.chargeNet, computeServerNet({ items, rid, tables }).net_total_cents,
        `${rid}: 🔴 and it charges the SERVER's net`);
      assert.ok(g.quoteId, `${rid}: the quote it honoured is identified`);
      carts += 1;
    }
  }
  assert.strictEqual(carts, 8, 'non-vacuity: all 8 real carts gated');
  ok(`${carts} real carts across both brands charge at the server net`);
}

// ── 2. 🔴 A PRICE THAT ROSE IS REFUSED; A PRICE THAT FELL IS SILENTLY HONOURED ─────────────────
// The asymmetry IS the feature. The customer never pays more than they agreed and is never
// interrupted to be told they are paying less.
{
  const rid = 'x_pizza', items = [{ name: 'Margherita', qty: 2 }];
  const at = (price) => T(rid, { menu: { Margherita: price } });
  const base = MENU_BY_RESTAURANT[rid].Margherita;
  const token = mint(items, rid, at(base));

  const rose = gate({ token, submittedCart: items, rid, tables: at(base + 50) });
  assert.strictEqual(rose.action, 'refuse_increase', '🔴 a price INCREASE is refused');
  assert.strictEqual(rose.chargeNet, (base + 50) * 2 * 100, '…and the new net is reported so the client can re-confirm');

  const fell = gate({ token, submittedCart: items, rid, tables: at(base - 50) });
  assert.strictEqual(fell.action, 'charge', '🔴 a price DROP charges');
  assert.strictEqual(fell.chargeNet, (base - 50) * 2 * 100, '🔴 …at the LOWER server net, never the confirmed one');
  assert.ok(fell.chargeNet < base * 2 * 100, 'non-vacuity: the charge really is lower than what was confirmed');

  const same = gate({ token, submittedCart: items, rid, tables: at(base) });
  assert.strictEqual(same.action, 'charge', 'an unchanged price charges');
  assert.strictEqual(same.chargeNet, base * 2 * 100, '…at exactly the confirmed net');
  ok('a risen price refuses with the new net; a fallen price charges the lower one, silently');
}

// ── 3. 🔴 THE TOKEN AUTHORISES ONE CART, NOT ONE AMOUNT ────────────────────────────────────────
// Including the two cases where the AMOUNT cannot tell the difference — which is the whole reason the
// fingerprint exists and the reason this gate would be defeatable without it.
{
  const rid = 'x_pizza', tables = T(rid);
  const menu = MENU_BY_RESTAURANT[rid];
  const token = mint([{ name: 'Margherita', qty: 1 }], rid, tables);

  assert.strictEqual(gate({ token, submittedCart: [{ name: 'Pepperoni', qty: 1 }], rid, tables }).action,
    'refuse_invalid', '🔴 a different cart is refused');
  assert.strictEqual(gate({ token, submittedCart: [{ name: 'Margherita', qty: 2 }], rid, tables }).action,
    'refuse_invalid', '🔴 a different quantity is refused');

  // The net-identical swap: two different dishes at the same price. Nothing but the fingerprint can
  // see this, and its net is not merely ≤ the ceiling — it is EQUAL to it.
  const twin = Object.keys(menu).find((k) => k !== 'Margherita' && menu[k] === menu.Margherita);
  if (twin) {
    const swapped = [{ name: twin, qty: 1 }];
    assert.strictEqual(computeServerNet({ items: swapped, rid, tables }).net_total_cents,
                       computeServerNet({ items: [{ name: 'Margherita', qty: 1 }], rid, tables }).net_total_cents,
      `premise: ${twin} and Margherita are NET-IDENTICAL`);
    assert.strictEqual(gate({ token, submittedCart: swapped, rid, tables }).action, 'refuse_invalid',
      `🔴 a NET-IDENTICAL swap to ${twin} is refused — the amount could not have caught it`);
  }
  ok('the token authorises one cart — including against a net-identical swap');
}

// ── 4. 🔴 A REWARD TOKEN BINDS THE RESOLVED REWARD, END TO END ─────────────────────────────────
// The T1 finding at the charge: on la_musa the reward changes no amount, so presenting a reward token
// for the same cart WITHOUT the reward — or with a different one — is invisible to every check but
// the fingerprint.
{
  for (const rid of ['x_pizza', 'la_musa']) {
    const tables = T(rid), items = CARTS[rid][0];
    const freeName = rid === 'x_pizza' ? 'Margherita' : 'dimsum_01';
    const reward = { ok: true, model: 'add_free', discount_cents: 0,
      freeItems: [{ item_id: freeName, qty: 1, price_cents: MENU_BY_RESTAURANT[rid][freeName] * 100, added: true }] };
    const token = mint(items, rid, tables, reward, 'fp-1');

    assert.strictEqual(gate({ token, submittedCart: items, reward, rid, tables }).action, 'charge',
      `${rid}: the same cart WITH the same reward charges`);
    assert.strictEqual(gate({ token, submittedCart: items, reward: null, rid, tables }).action, 'refuse_invalid',
      `${rid}: 🔴 the same cart WITHOUT the reward is refused`);
    const other = { ...reward, freeItems: [{ ...reward.freeItems[0], qty: 2 }] };
    assert.strictEqual(gate({ token, submittedCart: items, reward: other, rid, tables }).action, 'refuse_invalid',
      `${rid}: 🔴 a DIFFERENT reward is refused`);

    if (rid === 'la_musa') {
      // Spelled out, because it is the reason any of this is necessary.
      assert.strictEqual(computeServerNet({ items, reward, rid, tables }).net_total_cents,
                         computeServerNet({ items, reward: null, rid, tables }).net_total_cents,
        'la_musa: premise — the reward is NET-INVARIANT, so only the fingerprint could refuse');
    }
  }
  ok('a reward token binds the resolved reward — on la_musa, where the net cannot');
}

// ── 5. TAMPERING AND THE WRONG BRAND ───────────────────────────────────────────────────────────
{
  const rid = 'x_pizza', tables = T(rid), items = CARTS[rid][0];
  const token = mint(items, rid, tables);
  assert.strictEqual(gate({ token, submittedCart: items, rid, tables, secret: 'other-secret' }).action,
    'refuse_invalid', '🔴 a token signed by another secret is refused');
  assert.strictEqual(gate({ token: 'garbage', submittedCart: items, rid, tables }).action,
    'refuse_invalid', '🔴 garbage is refused');
  const lm = mint(CARTS.la_musa[0], 'la_musa', T('la_musa'));
  assert.strictEqual(gate({ token: lm, submittedCart: CARTS.la_musa[0], rid: 'x_pizza', tables }).action,
    'refuse_invalid', '🔴 a token for the OTHER brand is refused');
  /* 🔴 THE BRAND CHECK, ISOLATED. The case above proves a la_musa token is refused at x_pizza — but the
     CART differs too, so the fingerprint refuses it first and the rid check is never reached. To test
     the rid check it has to be the ONLY thing wrong, and that takes a cart whose fingerprint is
     brand-agnostic: x_pizza keys by name and la_musa by id, so an item carrying the SAME string as
     both fingerprints identically under either brand. Priced into both menus at the same amount, the
     net matches too — and then only the restaurant is different. */
  {
    const both = [{ id: 'Margherita', name: 'Margherita', qty: 1 }];
    const xt = T('x_pizza');
    const lt = { restaurantId: 'la_musa', menu: { Margherita: MENU_BY_RESTAURANT.x_pizza.Margherita }, extras: {} };
    const xTok = mint(both, 'x_pizza', xt);
    assert.strictEqual(gate({ token: xTok, submittedCart: both, rid: 'x_pizza', tables: xt }).action, 'charge',
      'premise: this cart gates cleanly under its OWN brand');
    assert.strictEqual(computeServerNet({ items: both, rid: 'la_musa', tables: lt }).net_total_cents,
                       computeServerNet({ items: both, rid: 'x_pizza', tables: xt }).net_total_cents,
      'premise: it prices identically under the other brand, so the amount cannot refuse it');
    const crossed = gate({ token: xTok, submittedCart: both, rid: 'la_musa', tables: lt });
    assert.strictEqual(crossed.action, 'refuse_invalid',
      '🔴 an x_pizza token cannot authorise a la_musa charge, even with a matching cart and amount');
    assert.strictEqual(crossed.reason, 'rid_mismatch', '…and the RESTAURANT is named as the reason');
  }
  ok('a forged, malformed, or wrong-brand token is refused — including when only the brand differs');
}

// ── 6. 🔴 GRACE — AND WHY A BAD SIGNATURE IS STILL REFUSED IN IT ───────────────────────────────
// Grace is the deployment story: clients that have not shipped the token, and every checkout in flight
// at deploy, must behave exactly as today. chargeNet:null says "keep what you already computed", so a
// grace order is byte-identical by construction rather than by carefulness.
{
  const rid = 'x_pizza', tables = T(rid), items = CARTS[rid][0];
  const g = gate({ token: null, submittedCart: items, rid, tables, enforce: false });
  assert.strictEqual(g.action, 'charge', 'no token under grace charges');
  assert.strictEqual(g.chargeNet, null, '🔴 …and the gate supplies NO number — the caller keeps today\'s');

  assert.strictEqual(gate({ token: null, submittedCart: items, rid, tables, enforce: true }).action,
    'refuse_no_token', 'under enforcement, no token is refused');

  // An EXPIRED token under grace behaves like no token; a FORGED one does not.
  const old = withSecret(() => issueQuote({ items, rid, tables, nowMs: 0 }).quote_token);
  const expired = gate({ token: old, submittedCart: items, rid, tables, enforce: false, nowMs: 1e12 });
  assert.strictEqual(expired.action, 'charge', 'an expired token under grace does not block an order');
  assert.strictEqual(expired.chargeNet, null, '…and still defers to the caller');
  assert.strictEqual(gate({ token: old, submittedCart: items, rid, tables, enforce: true, nowMs: 1e12 }).action,
    'refuse_invalid', 'under enforcement it is refused');
  assert.strictEqual(gate({ token: old, submittedCart: items, rid, tables, enforce: false, nowMs: 1e12, secret: 'other' }).action,
    'refuse_invalid', '🔴 a FORGED token is refused even under grace — tampering is not an ordinary event');
  ok('grace defers to today\'s behaviour, expiry is tolerated in it, and a forgery never is');
}

// ── 7. AN UNPRICEABLE CART AT THE CHARGE IS REFUSED, NOT PRICED ────────────────────────────────
{
  const rid = 'x_pizza', tables = T(rid);
  const token = mint([{ name: 'Margherita', qty: 1 }], rid, tables);
  const g = gate({ token, submittedCart: [{ name: 'Does Not Exist', qty: 1 }], rid, tables });
  assert.strictEqual(g.action, 'refuse_invalid', '🔴 an unpriceable cart is refused');
  assert.strictEqual(g.chargeNet, null, '…with no amount');

  /* 🔴 THE REAL SHAPE OF THIS: A DISH DELISTED BETWEEN QUOTE AND CHARGE. The case above is refused by
     the FINGERPRINT — a different cart was submitted — so it never reaches the pricing check, and a
     gate that priced an unpriceable cart at zero would pass it. Here the cart is the SAME one the
     token was issued for; only the menu moved underneath it. The fingerprint matches, and the pricing
     failure is the only thing that can refuse. This is also the realistic version: the merchant
     delisted an item while someone was at checkout. */
  const delisted = [{ name: 'Margherita', qty: 1 }];
  const tokenBefore = mint(delisted, rid, tables);
  const withoutIt = T(rid);
  delete withoutIt.menu.Margherita;
  const after = gate({ token: tokenBefore, submittedCart: delisted, rid, tables: withoutIt });
  assert.strictEqual(after.action, 'refuse_invalid',
    '🔴 the same cart, now unpriceable, is refused rather than charged at zero');
  assert.strictEqual(after.reason, 'bad_cart', '…and the PRICING is named as the reason');
  assert.strictEqual(after.chargeNet, null, '…with no amount');
  ok('an unpriceable cart at the charge is refused, never priced — including a dish delisted mid-checkout');
}

/* Section 8 uses await, and this file is CommonJS — top-level await is not available here, so the
   async sections run inside an IIFE and the summary prints when they resolve. */
(async () => {
// ── 8. 🔴 THE CONSEQUENCES — RELEASE, DIVERGENCE, RETENTION, PROVENANCE ────────────────────────
// These lived inline in the request handler, where no unit test could reach them: deleting the
// hold-release or defeating the divergence check made NOTHING fail. Correct and unasserted, on a live
// money endpoint. They are behind an injected effect now, so "was the hold released" is an assertion.
{
  const rid = 'x_pizza', tables = T(rid), items = [{ name: 'Margherita', qty: 2 }];
  const base = MENU_BY_RESTAURANT[rid].Margherita;
  const at = (p) => T(rid, { menu: { Margherita: p } });
  const netAt = (p) => computeServerNet({ items, rid, tables: at(p) }).net_total_cents;

  const run = async (over = {}) => {
    const released = [];
    const applied = await applyConfirmedNetGate({
      gateInput: { token: mint(items, rid, tables), submittedCart: items, rid, tables,
        secret: SEC, enforce: false, nowMs: 1_000_100, ...(over.gateInput || {}) },
      recordedTotalCents: over.recordedTotalCents !== undefined ? over.recordedTotalCents : netAt(base),
      releaseHold: async () => { released.push(1); },
      orderId: 'PZX-TEST', log: { warn() {}, error() {} },
    });
    return { applied, releases: released.length };
  };

  // (a) 🔴 A GATE/RECORD DIVERGENCE REFUSES AND RELEASES. One centavo is enough — the point is that
  //     the two numbers must be the SAME number, not merely close.
  {
    const { applied, releases } = await run({ recordedTotalCents: netAt(base) + 1 });
    assert.ok(applied.refuse, '🔴 a 1-cent divergence between gated and recorded REFUSES');
    assert.strictEqual(applied.refuse.status, 409, '…with a 409');
    assert.strictEqual(applied.refuse.body.error, 'quote_invalid', '…typed quote_invalid');
    assert.strictEqual(applied.provenance, null, '…and stamps no provenance');
    assert.strictEqual(releases, 1, '🔴 …and RELEASES the reward hold');
  }

  // (b) 🔴 EVERY REFUSAL BRANCH RELEASES. An order that never exists must not strand loyalty points.
  {
    const branches = {
      increase:  { gateInput: { tables: at(base + 50) } },                                  // price rose
      invalid:   { gateInput: { submittedCart: [{ name: 'Pepperoni', qty: 1 }] } },          // cart mismatch
      forged:    { gateInput: { secret: 'other-secret' } },                                  // bad signature
      no_token:  { gateInput: { token: null, enforce: true } },                              // enforcement
      divergence:{ recordedTotalCents: netAt(base) + 1 },                                    // approved != recorded
    };
    for (const [label, over] of Object.entries(branches)) {
      const { applied, releases } = await run(over);
      assert.ok(applied.refuse, `🔴 ${label}: refuses`);
      assert.strictEqual(releases, 1, `🔴 ${label}: releases the owned hold exactly once`);
      assert.strictEqual(applied.provenance, null, `${label}: stamps nothing`);
    }
  }

  // (c) 🔴 THE CHARGE PATH RETAINS THE HOLD — the opposite mistake, and just as expensive. Completion
  //     is what consumes a reservation; releasing it here would hand the points back on a live order.
  {
    const { applied, releases } = await run();
    assert.strictEqual(applied.refuse, null, 'a clean gated order proceeds');
    assert.strictEqual(releases, 0, '🔴 …and does NOT release the hold');
    assert.ok(applied.provenance, '…and stamps provenance');
  }

  // (d) 🔴 PROVENANCE RECORDS THE CEILING AND THE CHARGE AS TWO FACTS. On a price DROP they differ,
  //     and that difference is the whole point of a signed token: what was OFFERED and ACCEPTED, not
  //     merely what was billed.
  {
    const dropped = netAt(base - 50);
    const { applied } = await run({ gateInput: { tables: at(base - 50) }, recordedTotalCents: dropped });
    assert.strictEqual(applied.refuse, null, 'a price drop still charges');
    assert.strictEqual(applied.provenance.charged_net_cents, dropped, '🔴 charged_net_cents is the LOWER amount');
    assert.strictEqual(applied.provenance.confirmed_net_cents, netAt(base),
      '🔴 confirmed_net_cents is the CEILING the customer accepted — not the amount billed');
    assert.ok(applied.provenance.confirmed_net_cents > applied.provenance.charged_net_cents,
      'non-vacuity: on a drop the two genuinely differ, which is what makes this provenance');
    assert.ok(applied.provenance.quote_id, 'and the quote it honoured is identified');

    // On an unchanged price they agree — so the difference above is the drop, not a sign error.
    const { applied: same } = await run();
    assert.strictEqual(same.provenance.confirmed_net_cents, same.provenance.charged_net_cents,
      'non-vacuity: with no drop the ceiling and the charge are the same number');
  }

  // (e) GRACE STAMPS NOTHING AND RELEASES NOTHING — which is how a grace order stays byte-identical.
  {
    const { applied, releases } = await run({ gateInput: { token: null, enforce: false }, recordedTotalCents: netAt(base) });
    assert.strictEqual(applied.refuse, null, 'grace proceeds');
    assert.strictEqual(applied.provenance, null, '🔴 …stamping NO provenance, which is how it is told from a gated order');
    assert.strictEqual(releases, 0, '…and releasing nothing');
  }
  ok('the consequences are asserted: release on every refusal, retain on charge, refuse on divergence, two-fact provenance');
}

// ── 9. THE REWARD COMES FROM THE REAL prepare→intake SEAM ──────────────────────────────────────
// Everything above uses a hand-assembled resolved reward. This proves the binding the handler actually
// relies on: the object prepareRedemption produces is the object the issuer fingerprints AND the object
// the gate re-fingerprints. A fixture that happened to have the right shape would prove neither.
{
  const { computeRedemption } = require('./rewards-redeem');
  const rid = 'la_musa', tables = T(rid);
  const items = [{ id: 'dimsum_01', qty: 2 }];
  const resolved = computeRedemption({ redeem: { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }] },
    items, restaurantId: rid, tables, eligible: null });
  assert.strictEqual(resolved.ok, true, `premise: the REAL resolver produced a redemption (${resolved.reason})`);
  assert.strictEqual(resolved.model, 'add_free', 'premise: …of the model the pricing consumes');

  const token = mint(items, rid, tables, resolved, 'fp-real');
  assert.strictEqual(gate({ token, submittedCart: items, reward: resolved, rid, tables }).action, 'charge',
    '🔴 a token issued over the REAL resolved reward gates cleanly at the charge');
  assert.strictEqual(gate({ token, submittedCart: items, reward: null, rid, tables }).action, 'refuse_invalid',
    '🔴 …and the same cart without it is refused, on the brand where the NET cannot tell');
  ok('the prepare→issue→gate reward binding is proven with the real resolver, not a fixture');
}


console.log(`\ntoken-gate: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
