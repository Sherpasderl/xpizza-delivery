'use strict';
// Portal 2a Task 7 — the REORDER RECIPE allowlist follows the catalog. Run: node catalog/reorder-catalog.test.js
//
// normalizeReorderItems is the trust boundary for "order it again": it stores ONLY menu-recognized keys
// + qty, never raw client names or prices (those would be an XSS/trust vector). The allowlist it
// validates against was the in-code menu, so after a portal edit it enforced yesterday's menu:
//   • a merchant ADDS a dish → every reorder recipe silently DROPS that line. The customer reorders and
//     the new dish is missing, with no error anywhere.
//   • a merchant REMOVES a dish → the recipe keeps accepting it.
// Not money by itself (the recipe is re-priced when the cart is rebuilt), but it is a stored artifact
// with a long life, so a wrong recipe outlives the edit that caused it.
const assert = require('assert');
const { normalizeReorderItems } = require('../reorder-normalize');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = (rid, menu, extras) => ({ restaurantId: rid, menu: menu || MENU_BY_RESTAURANT[rid], extras: extras || EXTRAS_BY_RESTAURANT[rid] });

// ── (1) STORE == CODE: byte-identical recipes for both brands ──────────────────────────────────
{
  const xCart = [
    { name: 'Margherita', qty: 2, extras: [{ name: 'Mozzarella' }, { name: 'Mozzarella' }, { name: 'Hongos' }] },
    { name: 'Pepperoni', qty: 1 },
    { name: 'Not On The Menu', qty: 1 },                      // must still be dropped
  ];
  assert.deepStrictEqual(normalizeReorderItems(xCart, 'x_pizza', T('x_pizza')), normalizeReorderItems(xCart, 'x_pizza'),
    'x_pizza: the catalog tables must reproduce the code recipe byte-identically');
  const lCart = [
    { id: 'dimsum_01', qty: 2, extras: [{ id: 'rice_white', qty: 2 }, { id: 'nope', qty: 1 }] },
    { id: 'soft_01', qty: 1 },
    { id: 'ghost_99', qty: 1 },
  ];
  assert.deepStrictEqual(normalizeReorderItems(lCart, 'la_musa', T('la_musa')), normalizeReorderItems(lCart, 'la_musa'),
    'la_musa: same');
  // non-vacuity — the comparisons above would pass just as happily on two empty arrays
  const x = normalizeReorderItems(xCart, 'x_pizza', T('x_pizza'));
  assert.deepStrictEqual(x, [{ key: 'Margherita', qty: 2, options: [{ name: 'Mozzarella', count: 2 }, { name: 'Hongos', count: 1 }] }, { key: 'Pepperoni', qty: 1 }],
    'and the x_pizza recipe is the real one, extras multiplicity included');
  assert.strictEqual(normalizeReorderItems(lCart, 'la_musa', T('la_musa')).length, 2, 'and la_musa kept 2 of 3 lines');
  ok('store == code: byte-identical recipes for both brands, with the real content (not two empty arrays)');
}

// ── (2) A STORE-ADDED ITEM SURVIVES — the code-static allowlist would drop it ───────────────────
{
  const menu = { ...MENU_BY_RESTAURANT.x_pizza, 'Truffle Funghi': 380 };
  const cart = [{ name: 'Truffle Funghi', qty: 1 }];
  assert.deepStrictEqual(normalizeReorderItems(cart, 'x_pizza', T('x_pizza', menu)), [{ key: 'Truffle Funghi', qty: 1 }],
    'a dish the merchant added must survive into the reorder recipe');
  assert.deepStrictEqual(normalizeReorderItems(cart, 'x_pizza'), [],
    'while the code-static allowlist silently DROPS it — the line vanishes from every reorder (the drift)');
  ok('a store-added item survives the recipe; the code-static allowlist drops it silently');
}
{
  const extras = { ...EXTRAS_BY_RESTAURANT.la_musa, rice_saffron: 60 };
  const cart = [{ id: 'dimsum_01', qty: 1, extras: [{ id: 'rice_saffron', qty: 1 }] }];
  assert.deepStrictEqual(normalizeReorderItems(cart, 'la_musa', T('la_musa', null, extras)),
    [{ key: 'dimsum_01', qty: 1, options: [{ id: 'rice_saffron', qty: 1 }] }], 'a store-added EXTRA survives too');
  assert.deepStrictEqual(normalizeReorderItems(cart, 'la_musa'), [{ key: 'dimsum_01', qty: 1 }],
    'while code-static drops the option and keeps a recipe that no longer matches what was ordered');
  ok('a store-added extra survives; code-static silently strips the option off the line');
}

{
  // x_pizza extras are keyed by NAME and counted per occurrence — a separate code branch from la_musa's
  // id-keyed one, so it needs its own proof that the allowlist moved.
  const extras = { ...EXTRAS_BY_RESTAURANT.x_pizza, Trufa: 90 };
  const cart = [{ name: 'Margherita', qty: 2, extras: [{ name: 'Trufa' }, { name: 'Trufa' }] }];
  assert.deepStrictEqual(normalizeReorderItems(cart, 'x_pizza', T('x_pizza', null, extras)),
    [{ key: 'Margherita', qty: 2, options: [{ name: 'Trufa', count: 2 }] }], 'a store-added x_pizza extra survives, multiplicity intact');
  assert.deepStrictEqual(normalizeReorderItems(cart, 'x_pizza'), [{ key: 'Margherita', qty: 2 }],
    'while code-static strips it — the reorder silently loses the topping the customer paid for');
  // and removal follows too
  const fewer = { ...EXTRAS_BY_RESTAURANT.x_pizza }; delete fewer.Mozzarella;
  assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1, extras: [{ name: 'Mozzarella' }] }], 'x_pizza', T('x_pizza', null, fewer)),
    [{ key: 'Margherita', qty: 1 }], 'a retired x_pizza extra stops entering recipes');
  ok('x_pizza name-keyed extras follow the store both ways (its own code branch, proven separately)');
}

// ── (3) The allowlist FOLLOWS the store in the removing direction too ──────────────────────────
{
  const menu = { ...MENU_BY_RESTAURANT.x_pizza };
  delete menu.Margherita;                                        // the merchant retires a pizza
  assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'x_pizza', T('x_pizza', menu)), [],
    'a retired dish must stop entering new recipes');
  assert.strictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'x_pizza').length, 1,
    'while code-static would keep minting recipes for a dish that no longer exists');
  ok('a store-removed item stops entering recipes (the allowlist follows the store both ways)');
}

// ── (4) The TRUST BOUNDARY is unchanged — this is the reason the allowlist exists ──────────────
{
  const hostile = [
    { name: '<img src=x onerror=alert(1)>', qty: 1 },
    { name: 'Margherita', qty: 1, price: 1, extras: [{ name: '<script>', price: 0 }] },
    { name: 'Margherita', qty: 0 }, { name: 'Margherita', qty: 99 }, { name: 'Margherita', qty: 1.5 },
  ];
  const out = normalizeReorderItems(hostile, 'x_pizza', T('x_pizza'));
  assert.deepStrictEqual(out, [{ key: 'Margherita', qty: 1 }], 'only recognized keys + qty survive');
  const json = JSON.stringify(out);
  assert.ok(!json.includes('script') && !json.includes('onerror') && !json.includes('price'),
    'no raw client name or price may ever be persisted — the recipe is a stored artifact');
  assert.strictEqual(normalizeReorderItems(Array.from({ length: 500 }, () => ({ name: 'Margherita', qty: 1 })), 'x_pizza', T('x_pizza')).length, 100,
    'and the line cap still holds');
  ok('the trust boundary is unchanged: hostile names/prices dropped, qty bounds and the line cap enforced');
}

// ── (5) FAIL-SAFE + PIN B ──────────────────────────────────────────────────────────────────────
{
  // Omitted tables ⇒ the code menu ⇒ today's exact behaviour. A recipe is not worth failing an order for.
  assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'x_pizza', null), [{ key: 'Margherita', qty: 1 }],
    'omitted tables fall back to the code menu (today)');
  assert.throws(() => normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'x_pizza', T('la_musa')),
    /pricing_tables_restaurant_mismatch/, 'PIN B: la_musa tables must never be applied to an x_pizza cart');
  // an unknown restaurant is still an empty recipe, not a throw
  assert.deepStrictEqual(normalizeReorderItems([{ name: 'Margherita', qty: 1 }], 'nobody'), [], 'an unknown restaurant yields no recipe');
  ok('fail-safe to the code menu when tables are omitted; PIN B rejects cross-brand tables');
}

// ── (6) WIRING — both producers must pass the resolved tables ──────────────────────────────────
{
  const strip = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const IDX = strip('index.js'), BUILD = strip('create-order-build.js');
  // There are exactly two producers of reorder_items; anything else copies an already-normalized recipe.
  const calls = [...IDX.matchAll(/normalizeReorderItems\(([^)]*)\)/g), ...BUILD.matchAll(/normalizeReorderItems\(([^)]*)\)/g)].map((m) => m[1]);
  assert.strictEqual(calls.length, 2, `expected the 2 producers, found ${calls.length}`);
  for (const args of calls) assert.strictEqual(args.split(',').length, 3, `every producer must pass tables — found normalizeReorderItems(${args})`);
  assert.ok(/normalizeReorderItems\(body\.items, restaurantId, pricingTables\)/.test(IDX), 'the online producer passes the request-resolved tables');
  assert.ok(/normalizeReorderItems\(meta\.items, meta\.restaurantId, meta\.tables\)/.test(BUILD), 'the cash producer takes them from its meta');
  // ...and the meta must actually carry them at BOTH attachCustomerAttribution call sites, or the
  // parameter is threaded to a value that is always undefined — silently today's behaviour forever.
  const attach = [...IDX.matchAll(/attachCustomerAttribution\(([^;]*?)\);/g)].map((m) => m[1]);
  assert.strictEqual(attach.length, 2, `expected 2 attribution sites, found ${attach.length}`);
  for (const a of attach) assert.ok(/tables:\s*pricingTables/.test(a), `an attribution site must pass tables: ${a.slice(0, 80)}`);
  ok('both reorder producers pass the resolved tables, and both attribution sites supply them');
}
console.log(`reorder-catalog: OK (${n})`);
