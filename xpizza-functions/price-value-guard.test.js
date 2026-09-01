'use strict';
// Phase 1d Stage 1a — fail-closed PRICE-VALUE validation. Run: node price-value-guard.test.js
//
// One rule, three places: a usable price is a POSITIVE INTEGER lempira amount. Zero, negative, NaN,
// non-integer and undefined are corrupt values and must REJECT rather than compute.
//
// Today this is INERT — every live price is a positive integer, so the guards never fire. It exists
// for the moment the catalog becomes authoritative (Stage 2), when a portal fat-finger of a 0 must
// reject the order instead of silently charging a wrong total or misvaluing a Void-only SAR factura.
const assert = require('assert');
const { computeServerTotal, summaryLines, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
const { pricedLineItems } = require('./factura/pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const CORRUPT = [['zero', 0], ['negative', -5], ['NaN', NaN], ['non-integer', 12.5], ['undefined', undefined], ['string', '299'], ['Infinity', Infinity]];
const T = (rid, over = {}) => ({ restaurantId: rid, menu: { ...MENU_BY_RESTAURANT[rid], ...(over.menu || {}) }, extras: { ...EXTRAS_BY_RESTAURANT[rid], ...(over.extras || {}) } });

// ── 1. INERT ON CURRENT DATA — the whole point. Real menus price byte-identically. ─────────────
{
  const CARTS = {
    x_pizza: [[{ name: 'Margherita', qty: 1 }], [{ name: 'Pepperoni', qty: 3 }],
              [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }],
              [{ name: 'Carnivora NY', qty: 1 }], [{ name: 'Nutella', qty: 50 }]],
    la_musa: [[{ id: 'dimsum_01', qty: 1 }], [{ id: 'noodle_02', qty: 4 }],
              [{ id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 3 }, { id: 'sauce_aioli', qty: 1 }] }]],
  };
  // Every real key must satisfy the new rule — if any live price failed it, this slice would NOT be inert.
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const [k, p] of Object.entries(MENU_BY_RESTAURANT[rid])) assert.ok(Number.isInteger(p) && p > 0, `${rid}/${k} live menu price must satisfy the new rule`);
    for (const [k, p] of Object.entries(EXTRAS_BY_RESTAURANT[rid])) assert.ok(Number.isInteger(p) && p > 0, `${rid}/${k} live extra price must satisfy the new rule`);
  }
  ok(`inert: all ${Object.keys(MENU_BY_RESTAURANT.x_pizza).length + Object.keys(MENU_BY_RESTAURANT.la_musa).length} live menu prices + ${Object.keys(EXTRAS_BY_RESTAURANT.x_pizza).length + Object.keys(EXTRAS_BY_RESTAURANT.la_musa).length} extras already satisfy the rule — the guards cannot fire on today's data`);
  // Hard-coded expected totals: a regression lock independent of the tables themselves.
  const GOLD = [
    [[{ name: 'Margherita', qty: 1 }], 'x_pizza', 299],
    [[{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }], 'x_pizza', 299 * 2 + 50],
    [[{ id: 'dimsum_01', qty: 1, extras: [{ id: 'rice_white', qty: 2 }] }], 'la_musa', 223 + 50 * 2],
  ];
  for (const [items, rid, want] of GOLD) assert.deepStrictEqual(computeServerTotal(items, rid), { total: want, error: null }, `golden ${rid} ${want}`);
  ok('inert: golden carts still price to their exact pre-change totals (hard-coded, table-independent)');
  for (const rid of ['x_pizza', 'la_musa']) {
    for (const items of CARTS[rid]) {
      const r = computeServerTotal(items, rid);
      assert.strictEqual(r.error, null, `${rid} real cart must still price cleanly`);
      assert.ok(Number.isInteger(r.total) && r.total > 0);
      assert.deepStrictEqual(computeServerTotal(items, rid, T(rid)), r, 'catalog-tabled path identical too');
      assert.ok(summaryLines(items, rid, null), `${rid} summaryLines still renders`);
    }
  }
  ok(`inert: ${CARTS.x_pizza.length + CARTS.la_musa.length} representative real carts price cleanly, both calculators paths`);
  for (const items of CARTS.x_pizza) {
    const f = pricedLineItems(items, MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza);
    assert.strictEqual(f.error, null, 'the factura pricer is unaffected by real data');
    assert.ok(f.items.every((l) => Number.isInteger(l.line_gross_cents) && l.line_gross_cents > 0));
  }
  ok('inert: the factura line pricer still prices every real x_pizza cart identically');
}

// ── 2. computeServerTotal REJECTS a corrupt price — menu and extras, both brands ────────────────
for (const [label, bad] of CORRUPT) {
  const x = computeServerTotal([{ name: 'Margherita', qty: 2 }], 'x_pizza', T('x_pizza', { menu: { Margherita: bad } }));
  assert.ok(Number.isNaN(x.total) && /invalid price for Margherita/.test(x.error), `x_pizza menu ${label} must reject`);
  const l = computeServerTotal([{ id: 'dimsum_01', qty: 1 }], 'la_musa', T('la_musa', { menu: { dimsum_01: bad } }));
  assert.ok(Number.isNaN(l.total) && /invalid price for dimsum_01/.test(l.error), `la_musa menu ${label} must reject`);
}
ok(`computeServerTotal: a corrupt MENU price rejects — ${CORRUPT.length} value shapes × both brands (never computes)`);
for (const [label, bad] of CORRUPT) {
  const x = computeServerTotal([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }] }], 'x_pizza', T('x_pizza', { extras: { Mozzarella: bad } }));
  assert.ok(Number.isNaN(x.total) && /invalid price for extra Mozzarella/.test(x.error), `x_pizza extra ${label} must reject`);
  const l = computeServerTotal([{ id: 'dimsum_01', qty: 1, extras: [{ id: 'rice_white', qty: 1 }] }], 'la_musa', T('la_musa', { extras: { rice_white: bad } }));
  assert.ok(Number.isNaN(l.total) && /invalid price for extra rice_white/.test(l.error), `la_musa extra ${label} must reject`);
}
ok(`computeServerTotal: a corrupt EXTRA price rejects — ${CORRUPT.length} shapes × both brands (x_pizza count-once AND la_musa qty-aware paths)`);

// ── 3. pricedLineItems (the FACTURA pricer) rejects the same shapes ─────────────────────────────
for (const [label, bad] of CORRUPT) {
  const m = pricedLineItems([{ name: 'Margherita', qty: 2 }], { ...MENU_BY_RESTAURANT.x_pizza, Margherita: bad }, EXTRAS_BY_RESTAURANT.x_pizza);
  assert.deepStrictEqual([m.items, /invalid price for Margherita/.test(m.error)], [null, true], `factura menu ${label} must reject`);
  const e = pricedLineItems([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }] }], MENU_BY_RESTAURANT.x_pizza, { ...EXTRAS_BY_RESTAURANT.x_pizza, Mozzarella: bad });
  assert.deepStrictEqual([e.items, /invalid price for extra Mozzarella/.test(e.error)], [null, true], `factura extra ${label} must reject`);
}
ok(`pricedLineItems: a corrupt menu OR extra price rejects — ${CORRUPT.length} shapes (no factura line is ever priced from it)`);

// ── 4. 🔒 LOCKSTEP — the two calculators must agree on EVERY value, or the factura line-gross sum
//     could diverge from the charged total: an order that prices but cannot factura, or a factura
//     that misvalues a Void-only SAR document. ────────────────────────────────────────────────────
{
  const cart = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }];
  const PROBE = [...CORRUPT.map(([l, v]) => [l, v]), ['valid', 299]];
  for (const [label, v] of PROBE) {
    const menu = { ...MENU_BY_RESTAURANT.x_pizza, Margherita: v };
    const totalRejected = Number.isNaN(computeServerTotal(cart, 'x_pizza', { restaurantId: 'x_pizza', menu, extras: EXTRAS_BY_RESTAURANT.x_pizza }).total);
    const facturaRejected = pricedLineItems(cart, menu, EXTRAS_BY_RESTAURANT.x_pizza).items === null;
    assert.strictEqual(totalRejected, facturaRejected, `LOCKSTEP broken for menu price "${label}": total rejected=${totalRejected}, factura rejected=${facturaRejected}`);
  }
  for (const [label, v] of PROBE) {
    const extras = { ...EXTRAS_BY_RESTAURANT.x_pizza, Mozzarella: v };
    const totalRejected = Number.isNaN(computeServerTotal(cart, 'x_pizza', { restaurantId: 'x_pizza', menu: MENU_BY_RESTAURANT.x_pizza, extras }).total);
    const facturaRejected = pricedLineItems(cart, MENU_BY_RESTAURANT.x_pizza, extras).items === null;
    assert.strictEqual(totalRejected, facturaRejected, `LOCKSTEP broken for extra price "${label}"`);
  }
  ok(`LOCKSTEP: both calculators accept/reject identically across ${PROBE.length} value shapes × menu and extras`);
}
{
  // And when both accept, the factura line-gross sum still equals the charged total (the invariant the
  // lockstep protects). Checked on real data across a cart matrix.
  for (const items of [[{ name: 'Margherita', qty: 1 }], [{ name: 'Pepperoni', qty: 3 }],
                       [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }]]) {
    const total = computeServerTotal(items, 'x_pizza');
    const f = pricedLineItems(items, MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza);
    assert.strictEqual(f.items.reduce((s, l) => s + l.line_gross_cents, 0), total.total * 100,
      'the factura line-gross sum must equal the charged total');
  }
  ok('LOCKSTEP: on accepted data the factura line-gross sum equals the charged total exactly');
}

// ── 5. The error-return CONVENTION is unchanged, so every existing caller already handles it ────
{
  const r = computeServerTotal([{ name: 'Margherita', qty: 1 }], 'x_pizza', T('x_pizza', { menu: { Margherita: 0 } }));
  assert.deepStrictEqual(Object.keys(r).sort(), ['error', 'total'], 'same {total, error} shape');
  assert.strictEqual(typeof r.error, 'string');
  const f = pricedLineItems([{ name: 'Margherita', qty: 1 }], { Margherita: 0 }, {});
  assert.deepStrictEqual(Object.keys(f).sort(), ['error', 'items'], 'same {items, error} shape');
  ok('convention: the fail path uses the existing {total,error} / {items,error} shapes — no caller change needed');
}
console.log(`price-value-guard: OK (${n})`);
