'use strict';
// Phase 1b-1 — the MONEY PROOF for the order-total cutover, plus PIN B and backward-compat.
// Run: node menu-pricing-catalog.test.js
//
// Proves that pricing from guarded CATALOG tables produces BYTE-IDENTICAL output to pricing from
// the in-code tables, across a representative cart matrix, BOTH brands. This is the assertion the
// whole cutover rests on: we change WHERE prices come from, never WHAT they are.
const assert = require('assert');
const { computeServerTotal, summaryLines, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('./menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Guarded tables as getPricingTables returns them on parity: a distinct object, same values.
const catalogTables = (rid) => ({
  restaurantId: rid,
  menu: JSON.parse(JSON.stringify(MENU_BY_RESTAURANT[rid])),
  extras: JSON.parse(JSON.stringify(EXTRAS_BY_RESTAURANT[rid] || {})),
});

// A representative cart matrix per brand: plain, multi-qty, with extras, multi-line, and the
// tamper/edge shapes that must keep failing closed.
const X = Object.keys(MENU_BY_RESTAURANT.x_pizza), XE = Object.keys(EXTRAS_BY_RESTAURANT.x_pizza);
const L = Object.keys(MENU_BY_RESTAURANT.la_musa), LE = Object.keys(EXTRAS_BY_RESTAURANT.la_musa);
const CARTS = {
  x_pizza: [
    [{ name: X[0], qty: 1 }],
    [{ name: X[1], qty: 3 }],
    [{ name: X[0], qty: 1 }, { name: X[5], qty: 2 }],
    [{ name: X[2], qty: 1, extras: [{ name: XE[0] }, { name: XE[3] }] }],
    [{ name: X[X.length - 1], qty: 50 }],
    [{ name: X[0], qty: 1, extras: [] }],
    [{ name: 'NOT A REAL PIZZA', qty: 1 }],            // unknown key → must fail closed
    [{ name: X[0], qty: 0 }],                          // bad qty → must fail closed
    [{ name: X[0], qty: 1, extras: [{ name: 'ghost extra' }] }],  // unknown extra → fail closed
    [],                                                 // empty cart → error
  ],
  la_musa: [
    [{ id: L[0], qty: 1 }],
    [{ id: L[4], qty: 2 }],
    [{ id: L[0], qty: 1 }, { id: L[9], qty: 4 }],
    [{ id: L[1], qty: 2, extras: [{ id: LE[0], qty: 1 }, { id: LE[2], qty: 3 }] }],
    [{ id: L[0], qty: 1, extras: [{ id: LE[0], qty: 1 }, { id: LE[0], qty: 1 }] }], // dup extra → fail closed
    [{ id: L[0], qty: 1, extras: 'not-an-array' }],    // malformed extras → fail closed
    [{ id: 'ghost_item', qty: 1 }],                    // unknown key → fail closed
    [],
  ],
};

// ── THE MONEY PROOF: catalog-sourced pricing == code-sourced pricing, byte-identical ──
let carts = 0;
for (const rid of ['x_pizza', 'la_musa']) {
  const tables = catalogTables(rid);
  for (const items of CARTS[rid]) {
    const fromCode = computeServerTotal(items, rid);
    const fromCatalog = computeServerTotal(items, rid, tables);
    assert.deepStrictEqual(fromCatalog, fromCode, `${rid} computeServerTotal catalog==code for ${JSON.stringify(items).slice(0, 80)}`);
    const sCode = summaryLines(items, rid, null);
    const sCat = summaryLines(items, rid, null, tables);
    assert.deepStrictEqual(sCat, sCode, `${rid} summaryLines catalog==code`);
    carts++;
  }
  ok(`MONEY PROOF ${rid}: ${CARTS[rid].length} carts — computeServerTotal + summaryLines byte-identical from catalog vs code`);
}
// redemption-shaped summaryLines too (display path, still 1b-1's caller)
for (const rid of ['x_pizza', 'la_musa']) {
  const red = { model: 'add_free', items: [{ name: rid === 'x_pizza' ? X[0] : L[0], qty: 1 }] };
  const items = rid === 'x_pizza' ? [{ name: X[0], qty: 2 }] : [{ id: L[0], qty: 2 }];
  assert.deepStrictEqual(summaryLines(items, rid, red, catalogTables(rid)), summaryLines(items, rid, red));
  ok(`MONEY PROOF ${rid}: summaryLines with a redemption is byte-identical from catalog vs code`);
}

// ── NON-VACUITY: the money proof above compares catalog-vs-code output, which passes trivially if
//    `tables` is IGNORED. These assertions prove the supplied tables are actually CONSULTED — the
//    unit-level guard against a silent non-cutover (PIN E is the same guard at the emulator level).
{
  const t = catalogTables('x_pizza'); t.menu[X[0]] = 12345;          // a price only the TABLES carry
  const r = computeServerTotal([{ name: X[0], qty: 2 }], 'x_pizza', t);
  assert.deepStrictEqual(r, { total: 24690, error: null }, 'the TABLES price must drive the total, not the code table');
  assert.notStrictEqual(r.total, MENU_BY_RESTAURANT.x_pizza[X[0]] * 2, 'and it must differ from the code-table total');
  ok('non-vacuity: computeServerTotal prices from the SUPPLIED tables (ignoring them would fail here)');
}
{
  const t = catalogTables('la_musa'); t.extras[LE[0]] = 999;
  const r = computeServerTotal([{ id: L[0], qty: 1, extras: [{ id: LE[0], qty: 1 }] }], 'la_musa', t);
  assert.strictEqual(r.total, MENU_BY_RESTAURANT.la_musa[L[0]] + 999, 'EXTRAS also come from the supplied tables');
  ok('non-vacuity: EXTRAS price from the SUPPLIED tables too');
}
{
  const t = catalogTables('x_pizza'); t.menu[X[0]] = 777;
  const s = summaryLines([{ name: X[0], qty: 1 }], 'x_pizza', null, t);
  assert.ok(JSON.stringify(s).includes('77700'), 'summaryLines cents must reflect the SUPPLIED tables');
  ok('non-vacuity: summaryLines prices from the SUPPLIED tables');
}
{
  const t = catalogTables('x_pizza'); delete t.menu[X[0]];           // key absent from the TABLES only
  const r = computeServerTotal([{ name: X[0], qty: 1 }], 'x_pizza', t);
  assert.ok(r.error && /unknown menu item/.test(r.error), 'a key missing from the TABLES fails closed');
  assert.ok(Number.isNaN(r.total));
  ok('non-vacuity + PIN D: a key absent from the supplied tables still FAILS CLOSED (never prices at zero)');
}

// ── PIN B: cross-brand tables must FAIL CLOSED, never price one brand off the other's table ──
const xTables = catalogTables('x_pizza'), lTables = catalogTables('la_musa');
assert.throws(() => computeServerTotal([{ name: X[0], qty: 1 }], 'x_pizza', lTables), /restaurant/i);
ok('PIN B: x_pizza items + la_musa tables → THROWS (fail-closed, no cross-brand pricing)');
assert.throws(() => computeServerTotal([{ id: L[0], qty: 1 }], 'la_musa', xTables), /restaurant/i);
ok('PIN B: la_musa items + x_pizza tables → THROWS');
assert.throws(() => summaryLines([{ name: X[0], qty: 1 }], 'x_pizza', null, lTables), /restaurant/i);
ok('PIN B: summaryLines enforces the same-restaurant assert');
assert.throws(() => computeServerTotal([{ name: X[0], qty: 1 }], 'x_pizza', { menu: {}, extras: {} }), /restaurant/i);
ok('PIN B: UNTAGGED tables (no restaurantId) → THROWS (a tag is mandatory, not optional)');

// ── BACKWARD COMPAT: tables omitted → byte-identical to today. Protects every deferred caller
//    (the redemption cluster, fiscal pricedLineItems) which must stay 100% on the code tables. ──
const GOLDEN = [
  [[{ name: 'Margherita', qty: 1 }], 'x_pizza', 299],
  [[{ name: 'Margherita', qty: 2 }, { name: 'Pepperoni', qty: 1 }], 'x_pizza', 299 * 2 + 307],
  [[{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }] }], 'x_pizza', 299 + 50],
  [[{ id: 'dimsum_01', qty: 1 }], 'la_musa', 223],
  [[{ id: 'dimsum_01', qty: 1, extras: [{ id: 'rice_white', qty: 2 }] }], 'la_musa', 223 + 50 * 2],
];
for (const [items, rid, want] of GOLDEN) {
  assert.deepStrictEqual(computeServerTotal(items, rid), { total: want, error: null }, `golden ${rid} ${want}`);
}
ok(`backward compat: tables OMITTED → today's exact totals (${GOLDEN.length} golden carts, hard-coded values)`);
assert.deepStrictEqual(computeServerTotal([{ name: 'Margherita', qty: 1 }]), { total: 299, error: null });
ok('backward compat: the x_pizza restaurantId default still applies with no tables');

console.log(`menu-pricing-catalog: OK (${n})  [${carts} carts × 2 fns compared]`);
