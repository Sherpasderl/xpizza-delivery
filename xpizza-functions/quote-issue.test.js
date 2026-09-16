'use strict';
// Portal 1C Task 3 — issuing the signed quote. Run: node quote-issue.test.js
//
// The claim: the number a customer is handed to confirm is SIGNED, is the number computeServerNet
// produces, and is bound to THIS cart and THIS reward. Everything here goes through issueQuote — the
// shared issuer both quote endpoints call — rather than through a hand-assembled payload, because a
// hand-built token proves the verifier works and says nothing about what the endpoints actually issue.
const assert = require('node:assert');
const { issueQuote, EXPIRY_MS } = require('./quote-issue');
const { verifyQuoteToken, cartFingerprint, normalizeCartForFingerprint } = require('./quote-token');
const { computeServerNet } = require('./compute-server-net');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
const { CARTS } = require('./parity-carts.fixture');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = (rid) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid] }, extras: { ...EXTRAS_BY_RESTAURANT[rid] } });
const SEC = 'test-quote-secret';
const withSecret = (fn) => {
  const prev = process.env.QUOTE_TOKEN_SECRET;
  process.env.QUOTE_TOKEN_SECRET = SEC;
  try { return fn(); } finally { if (prev === undefined) delete process.env.QUOTE_TOKEN_SECRET; else process.env.QUOTE_TOKEN_SECRET = prev; }
};

// ── 1. 🔴 THE ISSUED NET IS computeServerNet's, AND THE TOKEN CARRIES IT ───────────────────────
// No divergent issuance math: the number signed is the number the charge path will recompute.
{
  let carts = 0;
  withSecret(() => {
    for (const rid of ['x_pizza', 'la_musa']) {
      for (const items of CARTS[rid]) {
        const tables = T(rid);
        const issued = issueQuote({ items, rid, tables, nowMs: 1_000_000 });
        assert.strictEqual(issued.ok, true, `${rid}: a real cart issues (${issued.error})`);
        assert.ok(issued.quote_token, `${rid}: …with a token`);

        const expected = computeServerNet({ items, rid, tables });
        assert.strictEqual(issued.net_total_cents, expected.net_total_cents,
          `${rid}: 🔴 the issued net IS computeServerNet's — no second arithmetic`);

        const v = verifyQuoteToken(issued.quote_token, SEC, 1_000_001);
        assert.strictEqual(v.reason, 'ok', `${rid}: the issued token verifies (${v.reason})`);
        assert.strictEqual(v.payload.net_total_cents, expected.net_total_cents,
          `${rid}: 🔴 …and the SIGNED net is the same number`);
        assert.deepStrictEqual(v.payload.components, expected.components, `${rid}: components are carried`);
        assert.strictEqual(v.payload.rid, rid, `${rid}: the token names its restaurant`);
        assert.strictEqual(v.payload.cart_fingerprint, cartFingerprint(normalizeCartForFingerprint(items, rid), null),
          `${rid}: 🔴 the fingerprint is over the SHARED normalization`);
        assert.strictEqual(v.payload.expires_at, 1_000_000 + EXPIRY_MS, `${rid}: expiry is issued_at + EXPIRY_MS`);
        assert.ok(v.payload.quote_id && v.payload.quote_id.length >= 16, `${rid}: a nonce is present`);
        carts += 1;
      }
    }
  });
  assert.strictEqual(carts, 8, 'non-vacuity: all 8 real carts issued');
  ok(`${carts} real carts issue a verifiable token whose signed net is computeServerNet's`);
}

// ── 2. 🔴 THE TOKEN BINDS THE REWARD — INCLUDING WHERE THE NET CANNOT ──────────────────────────
// The Task 1 finding, made operational: on la_musa a reward changes nothing about the amount, so if
// the token did not bind the reward, a token issued for the plain cart would verify for the
// reward-active one and the customer would collect a free item the quote never priced.
{
  withSecret(() => {
    for (const rid of ['x_pizza', 'la_musa']) {
      const tables = T(rid);
      const items = CARTS[rid][0];
      const freeName = rid === 'x_pizza' ? 'Margherita' : 'dimsum_01';
      const reward = { ok: true, model: 'add_free', discount_cents: 0,
        freeItems: [{ item_id: freeName, qty: 1, price_cents: MENU_BY_RESTAURANT[rid][freeName] * 100, added: true }] };

      const plain = issueQuote({ items, rid, tables, nowMs: 1_000_000 });
      const rewarded = issueQuote({ items, reward, redemptionRef: 'fp-abc', rid, tables, nowMs: 1_000_000 });
      assert.strictEqual(rewarded.ok, true, `${rid}: the reward-active cart issues (${rewarded.error})`);

      const pv = verifyQuoteToken(plain.quote_token, SEC, 1_000_001).payload;
      const rv = verifyQuoteToken(rewarded.quote_token, SEC, 1_000_001).payload;

      if (rid === 'la_musa') {
        // The premise of the whole precaution, asserted rather than assumed.
        assert.strictEqual(rv.net_total_cents, pv.net_total_cents,
          'la_musa: premise — the reward is NET-INVARIANT, so the amount cannot distinguish the carts');
      }
      assert.notStrictEqual(rv.cart_fingerprint, pv.cart_fingerprint,
        `${rid}: 🔴 …and the FINGERPRINT does — a reward-active cart never fingerprints as its plain twin`);
      assert.strictEqual(rv.redemption_ref, 'fp-abc', `${rid}: the resolved reward's reference is carried`);
      assert.strictEqual(pv.redemption_ref, null, `${rid}: and is null when there is no reward`);

      // A DIFFERENT resolved reward on the same cart is a different quote.
      const other = { ...reward, freeItems: [{ ...reward.freeItems[0], qty: 2 }] };
      const rv2 = verifyQuoteToken(issueQuote({ items, reward: other, redemptionRef: 'fp-xyz', rid, tables, nowMs: 1_000_000 }).quote_token, SEC, 1_000_001).payload;
      assert.notStrictEqual(rv2.cart_fingerprint, rv.cart_fingerprint,
        `${rid}: 🔴 a different resolved reward fingerprints differently`);
    }
  });
  ok('the token binds the reward on both brands — including la_musa, where the net cannot');
}

// ── 3. THE SHARED NORMALIZATION: ONE LOGICAL CART, ONE FINGERPRINT ─────────────────────────────
// Issue and charge see the same cart through different endpoint shapes. If they normalized
// separately, an honest customer would be refused at the charge for a difference nobody made.
{
  withSecret(() => {
    const rid = 'la_musa', tables = T(rid);
    const shapes = [
      [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 3 }] }],
      [{ id: 'dimsum_01', qty: '2', extras: [{ id: 'rice_white', qty: '3' }] }],   // string quantities
    ];
    const fps = shapes.map((items) => verifyQuoteToken(issueQuote({ items, rid, tables, nowMs: 1e6 }).quote_token, SEC, 1e6 + 1).payload.cart_fingerprint);
    assert.strictEqual(fps[0], fps[1], '🔴 the same logical cart in two client shapes issues ONE fingerprint');

    // …and reordering the lines does not change it either.
    const two = [{ id: 'dimsum_01', qty: 1 }, { id: 'noodle_02', qty: 1 }];
    const a = verifyQuoteToken(issueQuote({ items: two, rid, tables, nowMs: 1e6 }).quote_token, SEC, 1e6 + 1).payload.cart_fingerprint;
    const b = verifyQuoteToken(issueQuote({ items: [two[1], two[0]], rid, tables, nowMs: 1e6 }).quote_token, SEC, 1e6 + 1).payload.cart_fingerprint;
    assert.strictEqual(a, b, '🔴 reordering the cart issues the same fingerprint');
    // NON-VACUITY: a genuinely different cart still differs.
    assert.notStrictEqual(a, verifyQuoteToken(issueQuote({ items: [{ id: 'dimsum_01', qty: 2 }], rid, tables, nowMs: 1e6 }).quote_token, SEC, 1e6 + 1).payload.cart_fingerprint,
      'non-vacuity: a different cart fingerprints differently');
  });
  ok('one logical cart issues one fingerprint — across client shapes and line order');
}

// ── 4. GUEST → customer_id: null, AND THE TOKEN STILL VERIFIES ─────────────────────────────────
{
  withSecret(() => {
    const issued = issueQuote({ items: CARTS.x_pizza[0], rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 });
    const v = verifyQuoteToken(issued.quote_token, SEC, 1e6 + 1);
    assert.strictEqual(v.reason, 'ok', 'a guest quote verifies');
    assert.strictEqual(v.payload.customer_id, null, 'customer_id is null, a value rather than a gap');
    const named = issueQuote({ items: CARTS.x_pizza[0], rid: 'x_pizza', tables: T('x_pizza'), customerId: 'u-1', nowMs: 1e6 });
    assert.strictEqual(verifyQuoteToken(named.quote_token, SEC, 1e6 + 1).payload.customer_id, 'u-1', 'and a known customer is carried');
  });
  ok('a guest quote carries customer_id: null and verifies');
}

// ── 5. 🔴 NO SECRET → NO TOKEN, BUT STILL A PRICE ──────────────────────────────────────────────
// The token is what makes checkout SAFER; it must never be what makes checkout IMPOSSIBLE. An
// unprovisioned secret is a deploy-config fact, and the quote degrades to what it is today.
{
  const prev = process.env.QUOTE_TOKEN_SECRET;
  delete process.env.QUOTE_TOKEN_SECRET;
  try {
    const issued = issueQuote({ items: CARTS.x_pizza[0], rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 });
    assert.strictEqual(issued.ok, true, '🔴 the quote still succeeds without a secret');
    assert.strictEqual(issued.quote_token, null, '🔴 …with no token');
    assert.ok(issued.net_total_cents > 0, '🔴 …and the PRICE is still served');
  } finally { if (prev !== undefined) process.env.QUOTE_TOKEN_SECRET = prev; }
  ok('an absent secret degrades to a token-less price — it never crashes the quote');
}

// ── 6. AN UNPRICEABLE CART ERRORS; AN UNFINGERPRINTABLE ONE DEGRADES ───────────────────────────
// Two different failures with two different right answers. A cart the server cannot PRICE has no
// number to show, so it errors. A cart it can price but cannot FINGERPRINT has a number — the
// customer should see it — but no token can bind it, so the price goes out unsigned.
{
  withSecret(() => {
    const bad = issueQuote({ items: [{ name: 'Does Not Exist', qty: 1 }], rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 });
    assert.strictEqual(bad.ok, false, 'an unpriceable cart errors');
    assert.strictEqual(bad.quote_token, undefined, '…and issues nothing');

    /* 🔴 THE CART THAT PRICES BUT CANNOT BE FINGERPRINTED. Finding one took a measurement rather than
       a guess: for most invalid shapes computeServerTotal refuses first, so the degradation branch is
       never reached and a test aimed at it passes vacuously. The gap is x_pizza's option model — its
       extras are name-keyed and counted once, so the PRICE ignores an extra's qty entirely, while the
       fingerprint cannot: `{name:'Mozzarella', qty:'abc'}` prices to a real number and normalizes to
       null. That is the one input that distinguishes "degrade" from "sign anyway". */
    const priceableUnfingerprintable = [{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella', qty: 'abc' }] }];
    const pu = issueQuote({ items: priceableUnfingerprintable, rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 });
    assert.strictEqual(pu.ok, true, 'premise — this cart PRICES');
    assert.ok(pu.net_total_cents > 0, 'premise — …to a real number the customer should see');
    assert.strictEqual(normalizeCartForFingerprint(priceableUnfingerprintable, 'x_pizza'), null,
      'premise — …and yet it cannot be normalized');
    assert.strictEqual(pu.quote_token, null,
      '🔴 so the price is served UNSIGNED — never signed over a fingerprint that means nothing');

    const hostile = [{ id: { toString: null }, qty: 1 }];
    const v = issueQuote({ items: hostile, rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 });
    assert.ok(v.ok === false || v.quote_token === null,
      'a cart that cannot be normalized never produces a token, and never throws');
    // The normalization itself is the guarantee — asserted directly, since it is the shared seam.
    assert.strictEqual(normalizeCartForFingerprint(hostile, 'x_pizza'), null, '🔴 an unstringifiable key does not throw, it refuses');
    assert.strictEqual(normalizeCartForFingerprint([{ id: 'a', qty: { toString: null } }], 'la_musa'), null, '🔴 nor does an unnumberable qty');
    assert.strictEqual(normalizeCartForFingerprint([{ id: 'a', qty: NaN }], 'la_musa'), null, 'a NaN qty refuses rather than hashing as null');
    assert.strictEqual(normalizeCartForFingerprint([], 'x_pizza'), null, 'an empty cart has nothing to fingerprint');
  });
  ok('unpriceable errors, unfingerprintable degrades — and neither throws');
}

// ── 7. THE REDEMPTION PATH'S NET IS THE REWARD PATH'S OWN NUMBER ───────────────────────────────
// What quoteRedemptionCore signs must equal what applyRedemptionToPricing produced, or the customer
// confirms one number and the charge recomputes another.
{
  withSecret(() => {
    for (const rid of ['x_pizza', 'la_musa']) {
      const tables = T(rid), items = CARTS[rid][2];
      const freeName = rid === 'x_pizza' ? 'Margherita' : 'dimsum_01';
      const reward = { ok: true, model: 'add_free', discount_cents: 0,
        freeItems: [{ item_id: freeName, qty: 1, price_cents: MENU_BY_RESTAURANT[rid][freeName] * 100, added: true }] };
      const { computeServerTotal } = require('./menu-pricing');
      const { total } = computeServerTotal(items, rid, tables);
      const priced = applyRedemptionToPricing({ items, restaurantId: rid, redemption: reward, totalLempiras: total, tables });
      assert.strictEqual(priced.ok, true, `${rid}: premise — the reward path prices`);
      const issued = issueQuote({ items, reward, redemptionRef: 'fp', rid, tables, nowMs: 1e6 });
      assert.strictEqual(issued.net_total_cents, priced.total_cents,
        `${rid}: 🔴 the signed reward net IS the reward path's total_cents`);
    }
  });
  ok('the redemption quote signs the reward path\'s own total, both brands');
}

// ── 8. 🔴 THE FINGERPRINT KEYS BY THE BRAND'S PRICING KEY — THE CASE WITH NO NET SIGNAL ────────
// x_pizza prices by NAME, la_musa by ID. An id-preferred fingerprint made x_pizza blind to exactly
// what it exists to witness: a crafted request with a stable id and a swapped name prices as a
// different dish while fingerprinting identically. When the two dishes cost the SAME, the amount
// carries no signal either — the fingerprint is the only witness, and it was looking at the wrong
// field. The prices below come from the real menu, so "same price" is a fact rather than an assertion.
{
  const menu = MENU_BY_RESTAURANT.x_pizza;
  const pairs = Object.keys(menu).filter((a, i, all) => all.some((b) => b !== a && menu[b] === menu[a]));
  const [d1, d2] = [pairs[0], pairs.find((x) => x !== pairs[0] && menu[x] === menu[pairs[0]])];
  assert.ok(d1 && d2 && menu[d1] === menu[d2], `premise: two DIFFERENT x_pizza dishes at the same price (${d1}/${d2} @ ${menu[d1]})`);

  const fp = (items, rid) => cartFingerprint(normalizeCartForFingerprint(items, rid), null);
  // The crafted shape: same id, different name. x_pizza prices the NAME.
  assert.notStrictEqual(fp([{ id: 'stable', name: d1, qty: 1 }], 'x_pizza'),
                        fp([{ id: 'stable', name: d2, qty: 1 }], 'x_pizza'),
    '🔴 x_pizza: a same-id NAME swap between two same-price dishes fingerprints differently');
  // …and their nets really are identical, so nothing else could have caught it.
  const netOf = (items) => computeServerNet({ items, rid: 'x_pizza', tables: T('x_pizza') }).net_total_cents;
  assert.strictEqual(netOf([{ name: d1, qty: 1 }]), netOf([{ name: d2, qty: 1 }]),
    'premise: the two carts are NET-IDENTICAL — only the fingerprint can distinguish them');

  // The same hazard one level down: options key the same way their brand's items do.
  const ex = EXTRAS_BY_RESTAURANT.x_pizza;
  const exPairs = Object.keys(ex).filter((a, i, all) => all.some((b) => b !== a && ex[b] === ex[a]));
  if (exPairs.length >= 2) {
    const [e1, e2] = [exPairs[0], exPairs.find((x) => x !== exPairs[0] && ex[x] === ex[exPairs[0]])];
    assert.notStrictEqual(fp([{ name: d1, qty: 1, extras: [{ id: 'same', name: e1 }] }], 'x_pizza'),
                          fp([{ name: d1, qty: 1, extras: [{ id: 'same', name: e2 }] }], 'x_pizza'),
      `🔴 x_pizza: a same-id OPTION swap (${e1}↔${e2}, both ${ex[e1]}) fingerprints differently`);
  }

  // la_musa still keys by ID — a swapped NAME on a stable id is the SAME dish there, and must not
  // change the fingerprint, or the gate would refuse honest la_musa carts whose display name moved.
  assert.strictEqual(fp([{ id: 'dimsum_01', name: 'Whatever', qty: 1 }], 'la_musa'),
                     fp([{ id: 'dimsum_01', name: 'Renamed Since', qty: 1 }], 'la_musa'),
    '🔴 la_musa: keyed by ID, so a display-name change is the same cart');
  assert.notStrictEqual(fp([{ id: 'dimsum_01', qty: 1 }], 'la_musa'), fp([{ id: 'noodle_02', qty: 1 }], 'la_musa'),
    'la_musa: …and a different id is a different cart');

  // The brands disagree ON PURPOSE, and the normalization proves it reads the pricing key.
  assert.strictEqual(normalizeCartForFingerprint([{ id: 'i', name: 'n', qty: 1 }], 'x_pizza')[0].id, 'n', 'x_pizza → name');
  assert.strictEqual(normalizeCartForFingerprint([{ id: 'i', name: 'n', qty: 1 }], 'la_musa')[0].id, 'i', 'la_musa → id');
  ok('the fingerprint keys by each brand\'s PRICING key — same-price swaps are caught where the net is silent');
}

// ── 9. NORMALIZATION NEVER THROWS, AND A QUOTE NEVER 500s BECAUSE OF IT ────────────────────────
// The seam guarantee T4/T5 will lean on, asserted rather than claimed. A throwing property ACCESSOR
// is the shape that escaped: the helpers were guarded, the property READ was not.
{
  const throwingQty = [{ name: 'Margherita', get qty() { throw new Error('boom'); } }];
  const throwingExtraQty = [{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella', get qty() { throw new Error('boom'); } }] }];
  const throwingName = [{ get name() { throw new Error('boom'); }, qty: 1 }];
  for (const [label, cart] of [['a throwing qty getter', throwingQty], ['a throwing extra-qty getter', throwingExtraQty], ['a throwing name getter', throwingName]]) {
    assert.strictEqual(normalizeCartForFingerprint(cart, 'x_pizza'), null, `🔴 ${label} returns null, never throws`);
    withSecret(() => {
      let issued;
      assert.doesNotThrow(() => { issued = issueQuote({ items: cart, rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 }); },
        `🔴 ${label}: issueQuote does not throw — a quote must never 500 on a cart shape`);
      /* A cart that throws on being READ cannot be priced, so there is no price to serve — what the
         guarantee buys is a typed refusal instead of a 500. When it CAN be priced, it must still be
         token-less rather than signed over a fingerprint that means nothing. */
      assert.ok(issued.ok === false || issued.quote_token === null,
        `${label}: …refuses in a typed way, or prices without a token — never a signed meaningless token`);
    });
  }
  /* 🔴 AND AN EXOTIC THROWN VALUE — the hole was inside the catch that exists to uphold the guarantee.
     `String(e)` raises TypeError on a value with no prototype (Object.create(null) has no toString),
     so the handler that was supposed to convert a failure into {ok:false} became the thing that
     crashed. Ordinary Error objects never exercise that path, which is why the earlier getter tests
     passed over it. Every shape a `throw` can carry is covered, because "what can be thrown" is not
     limited to what is usually thrown. */
  for (const [label, value] of [
    ['a no-prototype object', Object.create(null)],
    ['a bare string', 'boom'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object whose toString is not callable', { toString: null }],
  ]) {
    const cart = [{ name: 'Margherita', get qty() { throw value; } }];
    assert.strictEqual(normalizeCartForFingerprint(cart, 'x_pizza'), null, `${label}: normalization still returns null`);
    withSecret(() => {
      let issued;
      assert.doesNotThrow(() => { issued = issueQuote({ items: cart, rid: 'x_pizza', tables: T('x_pizza'), nowMs: 1e6 }); },
        `🔴 throwing ${label}: the issuer's own catch must not throw`);
      assert.strictEqual(issued.ok, false, `${label}: …and reports a typed refusal`);
    });
  }
  ok('a throwing property accessor yields null and a token-less quote — never an exception, whatever is thrown');
}

console.log(`\nquote-issue: OK (${n})`);
