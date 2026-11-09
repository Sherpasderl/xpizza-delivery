'use strict';
// S1d D4 (PLAN-portal-item-edit r6 §2.5 "each order line also stores item_key and menu_version_id (additive)"; ruling Q3) — the
// keys an order was priced by are STORED, additively: each factura line (paid and comped) carries its resolved item_key and the
// menu_version_id that priced it; the order record carries menu_version_id (null on the flat route); each summary line carries
// its item_key. Nothing existing changes: every old field keeps its value, and a caller that passes no version stores none.
// Run: node factura/stored-keys.test.js
const assert = require('assert');
const { pricedLineItems } = require('./pricing');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const { computeRedemption } = require('../rewards-redeem');
const { createPricingResolver } = require('../catalog/pricing-tables');
const { buildCreateOrderUpdates } = require('../create-order-build');
const { COMBOS } = require('../deploy/combo-validation');
const MP = require('../menu-pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('stored-keys: FAILED — exited without completing'); process.exitCode = 1; } });
const stamped = (line, key) => { Object.defineProperty(line, MP.PRICING_KEY_STAMP, { value: key, enumerable: false, writable: true, configurable: true }); return line; };
const XM = MP.MENU_BY_RESTAURANT.x_pizza; const XE = MP.EXTRAS_BY_RESTAURANT.x_pizza;
const KEY = Object.keys(XM)[0];

(async () => {
  // ── factura lines ──
  {
    const r = pricedLineItems([stamped({ name: KEY, qty: 1 }, KEY)], XM, XE, null, 'v9');
    assert.deepStrictEqual(r.items, [{ qty: 1, description: KEY, line_gross_cents: XM[KEY] * 100, item_key: KEY, menu_version_id: 'v9' }], 'SK-FACTURA each line stores its resolved key and the version that priced it');
    const flat = pricedLineItems([stamped({ name: KEY, qty: 1 }, KEY)], XM, XE, null, null);
    assert.strictEqual(flat.items[0].menu_version_id, null, 'SK-FACTURA-FLAT the flat route stores null');
    const none = pricedLineItems([{ name: KEY, qty: 1 }], XM, XE);
    assert.deepStrictEqual(none.items, [{ qty: 1, description: KEY, line_gross_cents: XM[KEY] * 100, item_key: KEY }], 'SK-FACTURA-NOVERSION no version passed: none stored; the key is still stored');
    ok('factura lines store item_key and menu_version_id (null on flat; omitted when no version is passed)');
  }

  // ── the comped line, through real resolver tables (their version) ──
  {
    const cat = { menu: { ...XM }, extras: { ...XE }, versionId: 'v9', seq: 9, keyMode: 'name' };
    const T = await createPricingResolver({ reader: { getTables: async () => cat }, alarm: () => {} }).getPricingTables('x_pizza');
    const FREE = 'Margherita'; const paid = Object.keys(XM).find((k) => k !== FREE);
    const redemption = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: FREE }, items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', tables: T });
    const r = applyRedemptionToPricing({ items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', redemption, totalLempiras: XM[paid], tables: T });
    assert.strictEqual(r.ok, true, 'premise');
    const comped = r.factura_items.find((l) => l.redeemed);
    assert.deepStrictEqual([comped.item_key, comped.menu_version_id], [FREE, 'v9'], 'SK-COMPED the comped line stores its key and version');
    assert.ok(r.factura_items.filter((l) => !l.redeemed).every((l) => l.item_key === paid && l.menu_version_id === 'v9'), 'SK-PAID the paid lines too');
    ok('the comped and paid lines of a redemption store their keys and the pricing version');
  }

  // ── the order record ──
  {
    const [, combo] = Object.entries(COMBOS)[0];
    const plain = buildCreateOrderUpdates({ ...combo.input, hubSnap: combo.snapshot });
    const withV = buildCreateOrderUpdates({ ...combo.input, hubSnap: combo.snapshot, menuVersionId: 'v9' });
    const path = `orders/${combo.input.orderId}`;
    assert.strictEqual(withV[path].menu_version_id, 'v9', 'SK-ORDER the order stores the pricing version');
    assert.ok(!('menu_version_id' in plain[path]), 'SK-ORDER-ABSENT no version passed: today\'s record exactly');
    const flat = buildCreateOrderUpdates({ ...combo.input, hubSnap: combo.snapshot, menuVersionId: null });
    assert.strictEqual(flat[path].menu_version_id, null, 'SK-ORDER-FLAT the flat route stores null');
    const strip = (u) => { const c = JSON.parse(JSON.stringify(u)); delete c[path].menu_version_id; return c; };
    assert.deepStrictEqual(strip(withV), JSON.parse(JSON.stringify(plain)), 'SK-ORDER-ADDITIVE nothing else changes');
    ok('the order record stores menu_version_id (null on flat); additive only');
  }

  // ── summary lines ──
  {
    const T = MP.attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { ...XM }, extras: { ...XE } }, 'name');
    const s = MP.summaryLines([{ name: KEY, qty: 2 }], 'x_pizza', null, T);
    assert.deepStrictEqual(s, [{ name: KEY, qty: 2, cents: XM[KEY] * 200, item_key: KEY }], 'SK-SUMMARY each summary line stores its key');
    ok('summary lines store item_key');
    // codex S1d r1 #1: the FREE (reward) row carries its key too, and a name-keyed one is named by its label
    const red = { model: 'add_free', items: [{ name: 'Margherita', qty: 1, item_key: 'Margherita' }] };
    const free = (lab) => MP.summaryLines([{ name: KEY, qty: 1 }], 'x_pizza', red, MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { ...XM }, extras: { ...XE } }, 'name'), lab)).find((l) => l.cents === 0);
    assert.deepStrictEqual(free(null), { name: 'Margherita', qty: 1, cents: 0, item_key: 'Margherita' }, 'SK-FREE-SUMMARY the free row stores its key (name as today)');
    assert.strictEqual(free({ Margherita: 'Margarita Nueva' }).name, 'Margarita Nueva', 'SK-FREE-LABEL a renamed free item shows its current name');
    const LMk = Object.keys(MP.MENU_BY_RESTAURANT.la_musa)[0];
    const lmFree = (lab) => MP.summaryLines([{ id: LMk, name: 'X', qty: 1 }], 'la_musa', { model: 'add_free', items: [{ name: 'Del Cliente', qty: 1, item_key: LMk }] }, MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: 'la_musa', menu: { ...MP.MENU_BY_RESTAURANT.la_musa }, extras: { ...MP.EXTRAS_BY_RESTAURANT.la_musa } }, 'id'), lab)).find((l) => l.cents === 0);
    assert.strictEqual(lmFree({ [LMk]: 'Otro' }).name, lmFree(null).name, 'SK-FREE-IDMODE an id-keyed free row keeps today\'s name');
    ok('free summary rows store their key; a name-keyed one is named by its label; id-keyed names unchanged');
  }

  FINISHED = true;
  console.log(`\nstored-keys: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
