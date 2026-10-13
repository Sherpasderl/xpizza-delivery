'use strict';
// §3 FISCAL — the factura's lines in the MENU order of the version that priced the order (catalog/menu-order.js).
// Run: node catalog/menu-order.test.js
//
// The forms now send an order's lines in cart INSERTION order. The factura's PRECIO bases give the rounding residual to the
// LAST line (factura/money.js), so without this step the same cart in a different line order would print different bases.
// Everything here runs the REAL pieces: the catalog build (tables + item_order), pricedLineItems, applyRedemptionToPricing,
// reconcileLineBases through buildFacturaRecord, and the real pricing resolver's envelope (the versionId the index.js wiring
// reads). The "before §3" side is the SAME cart sent in menu order through the same real functions with no re-ordering.
const assert = require('assert');
const { buildCatalogV2 } = require('./form-menu-source');
const { createPricingResolver, envelopeOf } = require('./pricing-tables');
const { pricedLineItems } = require('../factura/pricing');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const { buildFacturaRecord } = require('../factura/build-record');
const { computeServerTotal } = require('../menu-pricing');
const { orderBreakdownCents } = require('../order-money');
const MO = require('./menu-order');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('menu-order: FAILED — exited without completing'); process.exitCode = 1; } });
const json = (v) => JSON.parse(JSON.stringify(v));

// ── the brand's real catalog: pricing tables + the version's item_order ──
function catalogOf(rid) {
  const b = buildCatalogV2(rid);
  return { tables: { restaurantId: rid, menu: Object.fromEntries(b.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(b.extras.map((e) => [e.key, e.price])) },
    itemOrder: b.structure.item_order.slice() };
}
const XP = catalogOf('x_pizza');
const CONFIG = { restaurant_name: 'X', legal_name: 'X', rtn: '0', address_1: '', address_2: '', email: '', phone: '', cai_code: 'C', prefix: '000-001-01', fecha_limite: '2027-12-31', range_start: 1, range_end: 99999 };
// the factura record exactly as factura-helpers persists it, for an order priced like createOrder prices it
function facturaOf(rid, tables, items, priced, redeemed = null) {
  const total = computeServerTotal(json(items), rid, tables).total;
  const b = orderBreakdownCents(total, rid);
  const order = { orderId: 'o1', ...b, subtotal_cents: b.subtotal_cents, tax_cents: b.isv_cents, total_cents: b.total_cents, payment_method: 'cash', customer_name: 'C',
    items: priced.items, ...(priced.factura_items ? { factura_items: priced.factura_items } : {}), ...(redeemed ? { desc_rebaja_cents: redeemed.desc_rebaja_cents } : {}) };
  return buildFacturaRecord({ order, config: CONFIG, reserved: 1, now: 1760000000000 });
}
const permutations = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
const rankIn = (order) => (it) => order.indexOf(it.name);
const menuOrdered = (items, order) => items.slice().sort((a, b) => rankIn(order)(a) - rankIn(order)(b));

// a cart whose bases DO depend on line order (three lines + an extra), in the brand's own keys
const firstExtra = Object.keys(XP.tables.extras)[0];
const pizzas = XP.itemOrder.filter((k) => XP.tables.menu[k] > 0);
const CART = [
  { name: pizzas[0], qty: 1, extras: [{ instance: 0, name: firstExtra, price: XP.tables.extras[firstExtra] }] },
  { name: pizzas[3], qty: 2, extras: [] },
  { name: pizzas[7], qty: 1, extras: [] },
];

// ── 1. GOLDEN: every permutation of the cart → factura lines byte-identical to the menu-ordered (pre-§3) body ──
{
  const before = facturaOf('x_pizza', XP.tables, menuOrdered(CART, XP.itemOrder), pricedLineItems(json(menuOrdered(CART, XP.itemOrder)), XP.tables.menu, XP.tables.extras));
  let sensitive = false;
  for (const perm of permutations(CART)) {
    const body = json(perm);
    const priced = pricedLineItems(body, XP.tables.menu, XP.tables.extras);
    const raw = facturaOf('x_pizza', XP.tables, body, priced);
    if (JSON.stringify(raw.items) !== JSON.stringify(before.items)) sensitive = true;
    const fixed = facturaOf('x_pizza', XP.tables, body, MO.facturaLinesInMenuOrder(priced, body, XP.itemOrder));
    assert.deepStrictEqual(fixed.items, before.items, `🔴 the factura lines (descriptions, qty, PRECIO bases, residual placement) moved for body order ${perm.map((i) => i.name).join(' | ')}`);
    assert.deepStrictEqual(fixed, before, '🔴 …and the whole record is byte-identical');
  }
  assert.ok(sensitive, 'non-vacuity: WITHOUT the re-order, some body order prints different bases (the residual moves)');
  ok(`x_pizza: all ${permutations(CART).length} body orders of a 3-line cart (with an extra) → factura byte-identical to the menu-ordered body; without the step the residual moves`);
}

// ── 2. GOLDEN, REDEEMED: paid lines in menu order, the comped line LAST, the whole SAR record byte-identical ──
{
  const freeName = pizzas[1];
  const reward = { ok: true, model: 'add_free', freeItems: [{ item_id: freeName, qty: 1, price_cents: XP.tables.menu[freeName] * 100 }] };
  const redeem = (items) => applyRedemptionToPricing({ items: json(items), restaurantId: 'x_pizza', redemption: reward, totalLempiras: computeServerTotal(json(items), 'x_pizza', XP.tables).total, tables: XP.tables });
  const mo = menuOrdered(CART, XP.itemOrder);
  const r0 = redeem(mo);
  assert.ok(r0.ok, `premise: the redemption prices (${r0.error})`);
  const before = facturaOf('x_pizza', XP.tables, mo, { items: r0.items, factura_items: r0.factura_items }, r0);
  for (const perm of permutations(CART)) {
    const r = redeem(perm);
    const fixed = MO.facturaLinesInMenuOrder({ items: r.items, factura_items: r.factura_items, error: null }, json(perm), XP.itemOrder);
    assert.strictEqual(fixed.factura_items[fixed.factura_items.length - 1].redeemed, true, '🔴 the comped line stays LAST');
    assert.deepStrictEqual(facturaOf('x_pizza', XP.tables, perm, fixed, r), before, `🔴 redeemed factura moved for ${perm.map((i) => i.name).join(' | ')}`);
  }
  ok('x_pizza REDEEMED: every body order → paid lines in menu order, the comped line last, the SAR record byte-identical (bases foot to the full net)');
}

// ── 3. BRAND-AGNOSTIC: an id-keyed brand (la_musa's own catalog) ranks by the key its item_order holds ──
{
  const lm = buildCatalogV2('la_musa');
  const order = lm.structure.item_order;
  const ids = [order[5], order[0], order[12]];
  const body = ids.map((id) => ({ id, name: `n-${id}`, qty: 1 }));
  const priced = { items: ids.map((id) => ({ qty: 1, description: id, line_gross_cents: 100 })), error: null };
  const out = MO.facturaLinesInMenuOrder(priced, body, order);
  assert.deepStrictEqual(out.items.map((l) => l.description), [order[0], order[5], order[12]], '🔴 id-keyed lines follow the version\'s item_order');
  ok('la_musa (id-keyed): lines rank by the identity field the item_order holds (id), not by a brand rule');
}

// ── 4. the 1:1 refusal guard + comped-last + unknown names ──
{
  const logs = []; const log = (...a) => logs.push(a.join(' '));
  const body = json(CART);
  const priced = pricedLineItems(body, XP.tables.menu, XP.tables.extras);
  assert.strictEqual(MO.facturaLinesInMenuOrder(priced, body.slice(1), XP.itemOrder, log, 'ord_x'), priced, 'a body that does not map 1:1 → the priced result untouched');
  assert.ok(logs.some((l) => /factura_menu_order_unavailable/.test(l) && /"reason":"line_mapping"/.test(l) && /"order_id":"ord_x"/.test(l)), '…and a LOUD log with the order_id and reason');
  const bad = { ...priced, factura_items: [{ qty: 9, description: 'other', line_gross_cents: 1 }, ...priced.items.slice(1)] };
  assert.strictEqual(MO.facturaLinesInMenuOrder(bad, body, XP.itemOrder, log, 'ord_y'), bad, 'factura_items whose prefix is not the paid lines → untouched');
  assert.ok(logs.some((l) => /"reason":"factura_items_mapping"/.test(l) && /"order_id":"ord_y"/.test(l)), '…logged');
  const odd = [{ name: 'Zzz-not-on-menu', qty: 1 }, body[2], { name: 'Yyy-not-on-menu', qty: 1 }, body[0]];
  const oddPriced = { items: odd.map((it) => ({ qty: 1, description: it.name, line_gross_cents: 1 })), error: null };
  assert.deepStrictEqual(MO.facturaLinesInMenuOrder(oddPriced, odd, XP.itemOrder).items.map((l) => l.description), [body[0].name, body[2].name, 'Zzz-not-on-menu', 'Yyy-not-on-menu'], 'ranked lines first in menu order; unranked after, in body order (stable)');
  const comped = { items: priced.items, factura_items: priced.items.concat([{ qty: 1, description: 'free', line_gross_cents: 5, redeemed: true }]), error: null };
  const reversed = body.slice().reverse();
  const rp = { items: reversed.map((it) => priced.items[body.indexOf(it)]), factura_items: reversed.map((it) => priced.items[body.indexOf(it)]).concat([comped.factura_items[3]]), error: null };
  assert.strictEqual(MO.facturaLinesInMenuOrder(rp, reversed, XP.itemOrder).factura_items[3].redeemed, true, 'the comped line stays last after a re-order');
  for (const p of [null, { items: null, error: null }, { items: [], error: null }]) assert.strictEqual(MO.facturaLinesInMenuOrder(p, body, XP.itemOrder), p, `nothing to order (${JSON.stringify(p)}) → as is`);
  ok('the 1:1 refusal (line_mapping / factura_items_mapping, logged with the order_id), unranked lines after in body order, the comped line always last');
}

(async () => {
  // ── 5. missing / malformed item_order → body order + a LOUD structured log with the order_id; a read error is not cached ──
  {
    const body = json(CART).reverse();
    const priced = pricedLineItems(body, XP.tables.menu, XP.tables.extras);
    for (const [label, data, reason] of [['absent structure', null, 'no_structure'], ['no item_order', { categories: [] }, 'malformed_item_order'],
      ['not an array', { item_order: 'Carnivora' }, 'malformed_item_order'], ['empty', { item_order: [] }, 'malformed_item_order'],
      ['duplicate keys', { item_order: ['Carnivora', 'Carnivora'] }, 'malformed_item_order'], ['a non-string key', { item_order: ['Carnivora', 7] }, 'malformed_item_order']]) {
      const logs = []; const log = (...a) => logs.push(a.join(' '));
      const src = MO.createMenuOrderSource({ readStructure: async () => data, log });
      const out = await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: 'v1', orderId: 'ord_m', bodyItems: body, priced, log });
      assert.strictEqual(out, priced, `${label}: the body's order stands`);
      assert.ok(logs.some((l) => /^factura_menu_order_unavailable /.test(l) && l.includes(`"reason":"${reason}"`) && l.includes('"order_id":"ord_m"') && l.includes('"versionId":"v1"')), `${label}: a LOUD log naming the order_id, version and reason (${logs.join(' | ')})`);
    }
    { // no version (flat layout / unknown envelope) → body order, logged, NO read
      let reads = 0; const logs = [];
      const src = MO.createMenuOrderSource({ readStructure: async () => { reads++; return { item_order: XP.itemOrder }; }, log: (...a) => logs.push(a.join(' ')) });
      assert.strictEqual(await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: null, orderId: 'ord_f', bodyItems: body, priced }), priced);
      assert.strictEqual(reads, 0); assert.ok(logs.some((l) => l.includes('"reason":"no_version"') && l.includes('"order_id":"ord_f"')));
    }
    { // a read error → body order, logged, NOT cached (the next order reads again and succeeds)
      let reads = 0; const logs = [];
      const src = MO.createMenuOrderSource({ readStructure: async () => { if (++reads === 1) throw new Error('UNAVAILABLE'); return { item_order: XP.itemOrder }; }, log: (...a) => logs.push(a.join(' ')) });
      assert.strictEqual(await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: 'v1', orderId: 'ord_e', bodyItems: body, priced }), priced);
      assert.ok(logs.some((l) => l.includes('"reason":"read_failed"') && l.includes('"order_id":"ord_e"')));
      const again = await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: 'v1', orderId: 'ord_e2', bodyItems: body, priced });
      assert.notStrictEqual(again, priced, 'the failure was not cached: the next order is put in menu order');
      assert.strictEqual(reads, 2);
    }
    { // nothing to order (a brand without a platform factura → items null; a pricing error) → NO read at all
      let reads = 0;
      const src = MO.createMenuOrderSource({ readStructure: async () => { reads++; return null; } });
      for (const p of [{ items: null, error: null }, { items: null, error: 'unknown menu item' }]) assert.strictEqual(await MO.facturaInMenuOrder({ source: src, restaurantId: 'la_musa', versionId: 'v1', orderId: 'o', bodyItems: body, priced: p }), p);
      assert.strictEqual(reads, 0, 'no factura lines → no read');
    }
    ok('missing / malformed item_order (absent, not an array, empty, duplicates, non-string), no version, or a read error → body order with a LOUD log naming order_id + reason; errors are not cached; no lines → no read');
  }

  // ── 6. VERSION CACHE through the REAL resolver's envelope: a reorder published AFTER the order leaves its factura alone ──
  {
    const versions = { v1: XP.itemOrder.slice(), v2: XP.itemOrder.slice().reverse() };   // v2 = the merchant reordered the menu
    let active = 'v1'; let reads = 0;
    const resolver = createPricingResolver({ reader: { getTables: async () => ({ menu: XP.tables.menu, extras: XP.tables.extras, versionId: active, seq: active === 'v1' ? 1 : 2 }) }, alarm: () => {} });
    const src = MO.createMenuOrderSource({ readStructure: async (rid, v) => { reads++; return { item_order: versions[v] }; } });
    const body = json(CART).reverse();
    const priceWith = async () => {
      const tables = await resolver.getPricingTables('x_pizza');
      const e = envelopeOf(tables);
      return MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: e && e.versionId, orderId: 'o', bodyItems: body, priced: pricedLineItems(json(body), tables.menu, tables.extras) });
    };
    const atV1 = await priceWith();
    assert.deepStrictEqual(atV1.items.map((l) => l.description.replace(/ \(\+.*\)$/, '')), menuOrdered(CART, versions.v1).map((i) => i.name), 'priced on v1 → v1\'s menu order');
    const again = await priceWith();
    assert.strictEqual(reads, 1, 'a WARM instance does no read for a version it has seen (immutable cache)');
    assert.deepStrictEqual(again, atV1);
    active = 'v2';                                                  // the reorder is published
    const atV2 = await priceWith();
    assert.deepStrictEqual(atV2.items.map((l) => l.description.replace(/ \(\+.*\)$/, '')), menuOrdered(CART, versions.v2).map((i) => i.name), 'an order priced on v2 follows v2');
    assert.deepStrictEqual(await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: 'v1', orderId: 'o', bodyItems: body, priced: pricedLineItems(json(body), XP.tables.menu, XP.tables.extras) }), atV1,
      '🔴 the order priced on v1 keeps v1\'s order after v2 is published (its version is immutable, and so is its cache entry)');
    assert.strictEqual(reads, 2, 'v2 was read once; v1 was never re-read');
    ok('version cache via the real resolver envelope: priced on v1 → v1\'s order; after a reorder (v2) is published, a v1 order is unchanged and a v2 order follows v2; warm = zero reads');
  }

  // ── 7. DEADLINE: a hung read cannot delay order creation beyond the deadline (≤ 300 ms; DEFAULT_DEADLINE_MS) ──
  {
    assert.ok(MO.DEFAULT_DEADLINE_MS <= 300, `the deadline is tight: ${MO.DEFAULT_DEADLINE_MS} ms`);
    const logs = [];
    const src = MO.createMenuOrderSource({ readStructure: () => new Promise(() => {}), log: (...a) => logs.push(a.join(' ')) });   // never settles
    const body = json(CART).reverse();
    const priced = pricedLineItems(body, XP.tables.menu, XP.tables.extras);
    const t0 = Date.now();
    const out = await MO.facturaInMenuOrder({ source: src, restaurantId: 'x_pizza', versionId: 'v9', orderId: 'ord_h', bodyItems: body, priced });
    const took = Date.now() - t0;
    assert.strictEqual(out, priced, 'a hung read → the body order');
    assert.ok(took >= MO.DEFAULT_DEADLINE_MS - 5 && took < MO.DEFAULT_DEADLINE_MS + 250, `🔴 bounded by the deadline (${took} ms vs ${MO.DEFAULT_DEADLINE_MS} ms)`);
    assert.ok(logs.some((l) => l.includes('"reason":"read_timeout"') && l.includes('"order_id":"ord_h"')), 'logged as a timeout with the order_id');
    ok(`a hung structure read returns the body order within the ${MO.DEFAULT_DEADLINE_MS} ms deadline (took ${took} ms), logged with the order_id`);
  }
  FINISHED = true;
  console.log('\nmenu-order: OK');
})().catch((e) => { console.error('menu-order FAILED:', e); process.exit(1); });
