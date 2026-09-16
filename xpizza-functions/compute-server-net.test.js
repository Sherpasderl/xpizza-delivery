'use strict';
// Portal 1C Task 1 — computeServerNet. Run: node compute-server-net.test.js
//
// 🔴 THE CLAIM THIS FILE HAS TO MAKE: consolidating the net computation changes NO charged value.
// computeServerNet becomes the one function the quote-issuer, createOrder and chargeOnlineOrder all
// call, so the only way it can be adopted safely is if, for real carts, it produces exactly what each
// of those paths produces TODAY. So the tests do not assert arithmetic in isolation — they price a
// shared fixture through the CURRENT compositions and compare, the same discipline quote-order.test.js
// uses for displayed-vs-charged.
//
// The fixtures are the SAME real carts quote-order.test.js drives, deliberately: a second, private set
// of carts would let the two files agree with each other while both drifting from production.
const assert = require('assert');
const { computeServerNet } = require('./compute-server-net');
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { orderBreakdownCents } = require('./order-money');
const { applyRedemptionToPricing } = require('./rewards-redeem-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = (rid) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid] }, extras: { ...EXTRAS_BY_RESTAURANT[rid] } });
const CARTS = {
  x_pizza: [[{ name: 'Margherita', qty: 1 }], [{ name: 'Pepperoni', qty: 3 }],
            [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }],
            [{ name: 'Carnivora NY', qty: 1 }], [{ name: 'Nutella', qty: 50 }]],
  la_musa: [[{ id: 'dimsum_01', qty: 1 }], [{ id: 'noodle_02', qty: 4 }],
            [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 3 }] }]],
};

// What the order path charges today, written out separately so a divergence would actually show.
const todaysCharge = (items, rid, tables) => {
  const { total, error } = computeServerTotal(items, rid, tables);
  if (error) return { error };
  return orderBreakdownCents(total, rid);
};

// ── 1. 🔴 NO CHARGED-VALUE CHANGE, EVERY REAL CART, BOTH BRANDS ────────────────────────────────
{
  let carts = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const items of CARTS[rid]) {
      const tables = T(rid);
      const today = todaysCharge(items, rid, tables);
      const net = computeServerNet({ items, rid, tables });
      assert.strictEqual(net.error, undefined, `${rid}: a real cart prices (${net.error})`);
      assert.strictEqual(net.net_total_cents, today.total_cents,
        `${rid}: 🔴 net_total_cents must equal what the order charges TODAY (${net.net_total_cents} vs ${today.total_cents})`);
      assert.ok(Number.isInteger(net.net_total_cents), `${rid}: the net is integer CENTS`);
      carts += 1;
    }
  }
  assert.strictEqual(carts, 8, 'non-vacuity: all 8 real carts were priced');
  ok(`no charged-value change: ${carts} real carts across both brands match today's order total exactly`);
}

// ── 2. 🔴 THE UNIT IS CENTS, CONFIRMED AGAINST THE SOURCE — NOT ASSUMED ────────────────────────
// computeServerTotal returns LEMPIRA (`total += price * qty` over table prices); orderBreakdownCents
// is what multiplies by 100. Asserting the relationship pins the unit so a future change to either
// side cannot silently make the net 100x wrong — which is the failure mode that would not look absurd
// in a log, because L680 and 68000 centavos are both plausible numbers.
{
  const items = [{ name: 'Margherita', qty: 1 }];
  const { total } = computeServerTotal(items, 'x_pizza', T('x_pizza'));
  const net = computeServerNet({ items, rid: 'x_pizza', tables: T('x_pizza') });
  assert.ok(total > 0 && total < 10000, `premise: computeServerTotal returns LEMPIRA, not cents (${total})`);
  assert.strictEqual(net.net_total_cents, Math.round(total * 100),
    '🔴 the net is the lempira total normalized to integer cents');
  ok(`the unit is cents — net === round(computeServerTotal.total × 100), verified against the source`);
}

// ── 3. 🔴 ONE REWARD COMPUTATION — ROUTED, NOT RE-DERIVED ──────────────────────────────────────
// The reward net must be the number rewards-redeem-pricing.js produces, byte for byte. Today's only
// model is add_free, which deliberately does NOT discount the charged total (`discount_cents: 0` — the
// comp is a fiscal rebaja, and the customer-facing quote shows savings separately). So the correct
// answer today is that the net is UNCHANGED by a reward, and the discount component is 0 — derived
// from the reward path's own total, never assumed.
{
  const rid = 'x_pizza', tables = T(rid);
  const items = [{ name: 'Margherita', qty: 2 }];
  const { total } = computeServerTotal(items, rid, tables);
  /* The canonical redemption carries the server-DERIVED price, and applyRedemptionToPricing checks it
     against the live menu (`unitCents !== fi0.price_cents → discount_mismatch`). Sourcing it from
     MENU_BY_RESTAURANT rather than hardcoding a number is the same real-writer discipline the carts
     follow: a literal would pass today and start failing the moment a price is edited, for a reason
     that has nothing to do with this function. */
  const freeName = 'Margherita';
  const redemption = { ok: true, model: 'add_free',
    freeItems: [{ item_id: freeName, qty: 1, price_cents: MENU_BY_RESTAURANT[rid][freeName] * 100 }] };
  const priced = applyRedemptionToPricing({ items, restaurantId: rid, redemption, totalLempiras: total, tables });
  assert.strictEqual(priced.ok, true, `premise: the reward path prices this cart (${priced.error})`);

  const net = computeServerNet({ items, reward: redemption, rid, tables });
  assert.strictEqual(net.error, undefined, `a reward-active cart prices (${net.error})`);
  assert.strictEqual(net.net_total_cents, priced.total_cents,
    '🔴 the reward-active net IS the reward path\'s total_cents — not a second computation of it');
  assert.strictEqual(net.components.reward_discount_cents, todaysCharge(items, rid, tables).total_cents - priced.total_cents,
    '🔴 the discount component is DERIVED from the reward path, not asserted');
  ok(`reward math is single-sourced: the net is rewards-redeem-pricing's own total_cents`);
}

// ── 4. DELIVERY IS A SERVER-COMPUTED SLOT, ZERO TODAY ──────────────────────────────────────────
{
  const net = computeServerNet({ items: [{ name: 'Margherita', qty: 1 }], rid: 'x_pizza', tables: T('x_pizza') });
  assert.strictEqual(net.components.delivery_cents, 0, 'delivery is free today');
  /* 🔴 A CONTEXT CARRYING A FEE IS IGNORED. The slot exists so distance pricing lands later without a
     call-site change, and the whole point is that the amount is SERVER-computed — a context that
     arrives with a number in it must not become one. Passing an empty object would not have tested
     that; these do. */
  for (const hostile of [{ fee: 9999 }, { delivery_cents: 9999 }, { amount: 9999 }, { fee_cents: 9999 }]) {
    const withCtx = computeServerNet({ items: [{ name: 'Margherita', qty: 1 }], rid: 'x_pizza', tables: T('x_pizza'), deliveryContext: hostile });
    assert.strictEqual(withCtx.components.delivery_cents, 0,
      `🔴 a context carrying ${JSON.stringify(hostile)} is still free — the client never supplies a fee`);
    assert.strictEqual(withCtx.net_total_cents, net.net_total_cents, 'and it changes no charged value');
  }
  ok(`delivery_cents is a server-computed slot, 0 today, and the client cannot supply it`);
}

// ── 5. 🔴 THE BREAKDOWN FOOTS TO THE NET ───────────────────────────────────────────────────────
// fiscal_cents is INFORMATIONAL and must NOT be an addend: ISV 15% is tax-INCLUSIVE (order-money.js),
// so the tax is broken OUT of the total, never added to it. Adding it would double-charge the tax on
// every x_pizza order — the single most expensive arithmetic mistake available in this codebase.
{
  for (const rid of ['x_pizza', 'la_musa']) {
    const items = CARTS[rid][0];
    const net = computeServerNet({ items, rid, tables: T(rid) });
    const c = net.components;
    assert.strictEqual(net.net_total_cents, c.base_cents - c.reward_discount_cents + c.delivery_cents,
      `${rid}: 🔴 the net foots to base − reward + delivery`);
    assert.ok(c.fiscal_cents >= 0, `${rid}: fiscal_cents is present`);
    assert.ok(c.fiscal_cents < net.net_total_cents, `${rid}: …and is a PART of the net, not an addend`);
    if (rid === 'la_musa') assert.strictEqual(c.fiscal_cents, 0, 'la_musa: no platform ISV split');
  }
  ok(`the breakdown foots to the net, and tax-inclusive fiscal is never added on top`);
}

// ── 6. 🔴 UNPRICEABLE IS AN ERROR, NEVER A ZERO ────────────────────────────────────────────────
{
  const bad = [
    [{ name: 'Does Not Exist', qty: 1 }, 'x_pizza', 'an unknown dish'],
    [{ id: 'no_such_dish', qty: 1 }, 'la_musa', 'an unknown id'],
    [{ name: 'Margherita', qty: 0 }, 'x_pizza', 'a zero quantity'],
    [{ name: 'Margherita', qty: -2 }, 'x_pizza', 'a negative quantity'],
    [{ name: 'Margherita', qty: 1, extras: [{ name: 'No Such Extra' }] }, 'x_pizza', 'an unknown extra'],
  ];
  for (const [item, rid, label] of bad) {
    const net = computeServerNet({ items: [item], rid, tables: T(rid) });
    assert.ok(net.error, `🔴 ${label} is an ERROR (${JSON.stringify(net)})`);
    assert.strictEqual(net.net_total_cents, undefined, `🔴 …and carries NO total — pricing it as free would make a tampered name the cheapest attack`);
  }
  assert.ok(computeServerNet({ items: [], rid: 'x_pizza', tables: T('x_pizza') }).error, 'an empty cart errors');
  assert.ok(computeServerNet({ items: null, rid: 'x_pizza', tables: T('x_pizza') }).error, 'a null cart errors');
  ok(`${bad.length + 2} unpriceable shapes all return an error and no total`);
}

// ── 7. A REWARD THE REWARD PATH REFUSES IS AN ERROR, NOT A SILENT FULL-PRICE CHARGE ────────────
// If the redemption cannot be priced, the safe answer is to refuse — charging full price for an order
// the customer believes carries a reward is a money-visible surprise in the other direction.
{
  const rid = 'x_pizza', tables = T(rid);
  const items = [{ name: 'Margherita', qty: 1 }];
  const net = computeServerNet({ items, reward: { ok: true, model: 'add_free', freeItems: [{ item_id: 'Not A Dish', qty: 1 }] }, rid, tables });
  assert.ok(net.error, `🔴 an unpriceable reward errors rather than quietly charging full price (${JSON.stringify(net)})`);
  ok(`a reward the reward path refuses is an error, not a silent full-price charge`);
}

console.log(`\ncompute-server-net: OK (${n})`);
