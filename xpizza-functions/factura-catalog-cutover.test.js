'use strict';
// Phase 1b-2 — the NON-redeem X. Pizza factura prices from the guarded catalog tables.
// Run: node factura-catalog-cutover.test.js
//
// This is the LAST code-table read on the fiscal path. The factura is a SAR-authorized document drawn
// from a permanently consumed CAI sequence number: once issued it can only be Voided, never corrected.
// So the bar is byte-identical line values, and — because a catalog-vs-code comparison passes trivially
// if the tables are ignored — a sentinel proving the tables are actually consulted.
const assert = require('assert');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, resolvePriceTables } = require('./menu-pricing');
const { pricedLineItems } = require('./factura/pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const XP = (over = {}) => ({ restaurantId: 'x_pizza', menu: { ...MENU_BY_RESTAURANT.x_pizza, ...(over.menu || {}) }, extras: { ...EXTRAS_BY_RESTAURANT.x_pizza, ...(over.extras || {}) } });
const LM = { restaurantId: 'la_musa', menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa };
// A representative X. Pizza cart: single, multi-qty, extras, multi-line, and an 18" NY item.
const CARTS = [
  [{ name: 'Margherita', qty: 1 }],
  [{ name: 'Pepperoni', qty: 3 }],
  [{ name: 'Margherita', qty: 1 }, { name: 'Ham', qty: 2 }],
  [{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Basil Pesto' }] }],
  [{ name: 'Carnivora NY', qty: 1, extras: [{ name: 'Prosciutto' }] }],
  [{ name: 'Nutella', qty: 50 }],
];
// Exactly how index.js resolves them at the factura sites.
const viaResolver = (tables) => resolvePriceTables('x_pizza', tables);

// ── 1. FISCAL PARITY: catalog-fed factura lines are byte-identical to code-fed ──────────────────
for (const items of CARTS) {
  const { menu: cm, extraPrices: ce } = viaResolver(XP());
  const cat = pricedLineItems(items, cm, ce);
  const code = pricedLineItems(items, MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza);
  assert.strictEqual(cat.error, null, 'the representative cart must price cleanly');
  assert.deepStrictEqual(cat, code, `factura lines byte-identical for ${JSON.stringify(items).slice(0, 70)}`);
}
ok(`FISCAL parity: ${CARTS.length} X. Pizza carts — factura line items byte-identical catalog-vs-code`);
{
  // The line_gross_cents are what the SAR document asserts — pin them explicitly, not just by deepEqual.
  const { menu: cm, extraPrices: ce } = viaResolver(XP());
  const r = pricedLineItems([{ name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }] }], cm, ce);
  const expect = (MENU_BY_RESTAURANT.x_pizza.Margherita * 2 + EXTRAS_BY_RESTAURANT.x_pizza.Mozzarella) * 100;
  assert.strictEqual(r.items[0].line_gross_cents, expect, 'the catalog-fed line gross must equal the code arithmetic');
  ok(`FISCAL parity: an explicit line gross (${expect} cents) matches the code arithmetic exactly`);
}

// ── 2. NON-VACUITY: a sentinel only the tables carry must drive the factura line cents ──────────
{
  const { menu: cm, extraPrices: ce } = viaResolver(XP({ menu: { Margherita: 4242 } }));
  const r = pricedLineItems([{ name: 'Margherita', qty: 2 }], cm, ce);
  assert.strictEqual(r.items[0].line_gross_cents, 4242 * 2 * 100, 'the SENTINEL table price must drive the factura line');
  assert.notStrictEqual(r.items[0].line_gross_cents, MENU_BY_RESTAURANT.x_pizza.Margherita * 2 * 100);
  ok('non-vacuity: a table-only price drives the factura line cents (ignoring the tables would fail here)');
}
{
  const { menu: cm, extraPrices: ce } = viaResolver(XP({ extras: { Mozzarella: 999 } }));
  const r = pricedLineItems([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }] }], cm, ce);
  assert.strictEqual(r.items[0].line_gross_cents, (MENU_BY_RESTAURANT.x_pizza.Margherita + 999) * 100, 'EXTRAS also come from the tables');
  ok('non-vacuity: a table-only EXTRA price drives the factura line cents too');
}

// ── 3. PIN B: cross-brand / untagged tables fail closed before any factura line is priced ───────
assert.throws(() => viaResolver(LM), /restaurant/i);
ok('PIN B: la_musa-tagged tables at the x_pizza factura site → THROWS (no cross-brand fiscal document)');
assert.throws(() => resolvePriceTables('x_pizza', { menu: {}, extras: {} }), /restaurant/i);
ok('PIN B: UNTAGGED tables → THROWS (a tag is mandatory)');

// ── 4. FAIL-SAFE, NO DROP: catalog trouble yields the CODE tables and the factura still prices ──
{
  // Post-1b-1b, resolvePricingTables never returns null — on catalog trouble it hands back a
  // code-TAGGED object. The factura site must price from it without throwing (it is not a
  // hard-contract seam: a fiscal document must never be dropped because the catalog blinked).
  const codeTagged = { restaurantId: 'x_pizza', menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza };
  let r;
  assert.doesNotThrow(() => { const { menu, extraPrices } = viaResolver(codeTagged); r = pricedLineItems(CARTS[0], menu, extraPrices); });
  assert.deepStrictEqual(r, pricedLineItems(CARTS[0], MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza));
  ok('fail-safe: a code-tagged fallback prices the factura identically and never throws (no dropped SAR doc)');
}

// ── 5. BACKWARD COMPAT: pricedLineItems is unchanged for any caller passing raw code tables ─────
{
  const r = pricedLineItems([{ name: 'Ham', qty: 1 }], MENU_BY_RESTAURANT.x_pizza, EXTRAS_BY_RESTAURANT.x_pizza);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.items[0].line_gross_cents, MENU_BY_RESTAURANT.x_pizza.Ham * 100);
  assert.deepStrictEqual(resolvePriceTables('x_pizza', null), { menu: MENU_BY_RESTAURANT.x_pizza, extraPrices: EXTRAS_BY_RESTAURANT.x_pizza });
  ok('backward compat: pricedLineItems unchanged; resolvePriceTables(rid, null) → the code tables');
}

// ── 6. STRUCTURAL: both non-redeem factura sites are cut, and the branches that must NOT move ──
{
  const SRC = require('fs').readFileSync(require('path').join(__dirname, 'index.js'), 'utf8');
  assert.strictEqual((SRC.match(/pricedLineItems\(body\.items, facturaMenu, facturaExtras\)/g) || []).length, 2,
    'BOTH non-redeem factura sites must price from the guarded tables');
  assert.ok(!/pricedLineItems\(body\.items, MENU_PRICES, EXTRA_PRICES\)/.test(SRC),
    'no non-redeem factura site may still read the raw code tables');
  assert.strictEqual((SRC.match(/resolvePriceTables\(restaurantId, pricingTables\)/g) || []).length, 2,
    'each site resolves through the shared PIN-B resolver, reusing the ALREADY-resolved pricingTables (never re-resolving)');
  assert.strictEqual((SRC.match(/factura_items: \(usesPlatformFactura\(restaurantId\) \? redemptionPriced\.factura_items : null\)/g) || []).length, 2,
    'the REDEEMED factura branch (1b-1b) is untouched');
  assert.strictEqual((SRC.match(/: \{ items: null, error: null \}/g) || []).length, 2,
    'the la_musa {items:null} branch is untouched');
  ok('structural: both sites cut via the shared resolver; redeemed + la_musa branches byte-unchanged');
}
console.log(`factura-catalog-cutover: OK (${n})`);
