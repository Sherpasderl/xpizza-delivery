'use strict';
// Portal 1C Task 4 — the confirmed-net gate. Run: node token-gate.test.js
//
// 🔴 EVERY TOKEN HERE COMES FROM THE REAL ISSUER. A hand-built token proves the verifier parses what
// the test author wrote; it says nothing about whether the issuer and the gate agree — and "issuer and
// gate agree" IS the guarantee. So issueQuote() mints every token below, and the gate is then asked
// about the same cart, a different cart, or a moved price.
const assert = require('node:assert');
const { gateConfirmedNet } = require('./token-gate');
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

console.log(`\ntoken-gate: OK (${n})`);
