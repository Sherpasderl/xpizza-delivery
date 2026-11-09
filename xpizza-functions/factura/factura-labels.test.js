'use strict';
// S1d D3 (PLAN-portal-item-edit r6 §2.5; D4c-grill/item-s1/S1d-DESIGN.md D3; OWNER 11-08: the factura uses the dish's name at
// order time, snapshotted on the order) — X. Pizza's factura lines are priced by the line's RESOLVED key (the stage's stamp)
// and described by that key's LABEL from the version that priced the order; the arithmetic is unchanged. No label: a legacy
// key is its own description (today); an opaque key is a retryable refusal (labels_unavailable), never a key on a factura.
// The comped (free) line follows the same rule. Extras keep their names. Today, every x_pizza dish's label IS its key, so
// every factura line is byte-identical. Run: node factura/factura-labels.test.js
const assert = require('assert');
const { pricedLineItems } = require('./pricing');
const { applyRedemptionToPricing } = require('../rewards-redeem-pricing');
const { computeRedemption } = require('../rewards-redeem');
const MP = require('../menu-pricing');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const stamped = (line, key) => { Object.defineProperty(line, MP.PRICING_KEY_STAMP, { value: key, enumerable: false, writable: true, configurable: true }); return line; };
const XM = MP.MENU_BY_RESTAURANT.x_pizza; const XE = MP.EXTRAS_BY_RESTAURANT.x_pizza;
const tables = (labels, over = {}) => MP.attachTablesLabels(MP.attachTablesKeyMode({ restaurantId: 'x_pizza', menu: { ...XM, ...(over.menu || {}) }, extras: { ...XE } }, 'name'), labels);
const anExtra = Object.keys(XE)[0];

// ── no-op today: every x_pizza dish's label is its key, so every line is byte-identical ──
{
  const { built } = buildSourceCandidate('x_pizza', buildSourceFromCode('x_pizza'));
  const labels = Object.fromEntries(built.items.map((i) => [i.key, i.display.name]));
  for (const [k, l] of Object.entries(labels)) assert.strictEqual(l, k, `FL-NOOP premise: ${k} — label equals key in the committed source`);
  const cart = () => built.items.slice(0, 6).map((i, ix) => stamped({ name: i.key, qty: 1 + (ix % 2), ...(ix === 0 ? { extras: [{ name: anExtra }] } : {}) }, i.key));
  const plain = built.items.slice(0, 6).map((i, ix) => ({ name: i.key, qty: 1 + (ix % 2), ...(ix === 0 ? { extras: [{ name: anExtra }] } : {}) }));
  const menu = Object.fromEntries(built.items.map((i) => [i.key, i.price]));
  assert.deepStrictEqual(pricedLineItems(cart(), menu, XE, labels), pricedLineItems(plain, menu, XE), 'FL-NOOP with labels and stamps: byte-identical to today\'s lines');
  ok('today every x_pizza label is its key: the factura lines are byte-identical');
}

// ── a renamed dish: priced by its key, described by its label; an item_key-only line too ──
{
  const KEY = Object.keys(XM)[0];
  const labels = { [KEY]: 'Nombre Nuevo' };
  const r = pricedLineItems([stamped({ name: 'Nombre Nuevo', item_key: KEY, qty: 2, extras: [{ name: anExtra }] }, KEY)], XM, XE, labels);
  assert.deepStrictEqual(r, { items: [{ qty: 2, description: `Nombre Nuevo (+${anExtra})`, line_gross_cents: (XM[KEY] * 2 + XE[anExtra]) * 100 }], error: null }, 'FL-RENAMED priced by the key, described by the label; extras keep their names');
  const only = pricedLineItems([stamped({ item_key: KEY, qty: 1 }, KEY)], XM, XE, labels);
  assert.deepStrictEqual(only.items, [{ qty: 1, description: 'Nombre Nuevo', line_gross_cents: XM[KEY] * 100 }], 'FL-ITEMKEY-ONLY a line with no name prices and describes by its key\'s label');
  const nolab = pricedLineItems([stamped({ item_key: KEY, qty: 1 }, KEY)], XM, XE, null);
  assert.deepStrictEqual(nolab.items, [{ qty: 1, description: KEY, line_gross_cents: XM[KEY] * 100 }], 'FL-LEGACY-FALLBACK no labels: a legacy key is its own description (today)');
  ok('a renamed dish is priced by its key and described by its label; a key-only line too; no labels → the key');
}

// ── an opaque key without a label: a retryable refusal, never a key on a factura ──
{
  const OK = 'i_aaaaaaaaaaaa';
  const menu = { ...XM, [OK]: 199 };
  const r = pricedLineItems([stamped({ item_key: OK, qty: 1 }, OK)], menu, XE, null);
  assert.deepStrictEqual([r.items, r.error], [null, 'labels_unavailable'], 'FL-OPAQUE-NOLABEL refused (labels_unavailable)');
  const g = pricedLineItems([stamped({ item_key: OK, qty: 1 }, OK)], menu, XE, { [OK]: 'Pizza Nueva' });
  assert.deepStrictEqual(g.items, [{ qty: 1, description: 'Pizza Nueva', line_gross_cents: 19900 }], 'FL-OPAQUE-LABEL described by its label');
  ok('an opaque key with no label is refused (labels_unavailable); with one it is described by it');
}

// ── the comped (free) line follows the same rule ──
{
  const KEY = 'Margherita';
  const paid = Object.keys(XM).find((k) => k !== KEY);
  const T0 = tables(null);
  const redemption = computeRedemption({ redeem: { type: 'free_pizza_choice', item_id: KEY }, items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', tables: T0 });
  assert.strictEqual(redemption.ok, true, 'premise: a real redemption');
  const today = applyRedemptionToPricing({ items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', redemption, totalLempiras: XM[paid], tables: T0 });
  const comped = (r) => r.factura_items.find((l) => l.redeemed);
  assert.strictEqual(comped(today).description, KEY, 'premise: today the comped line is described by its key');
  const lab = applyRedemptionToPricing({ items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', redemption, totalLempiras: XM[paid], tables: tables({ [KEY]: 'Margarita Nueva', [paid]: paid }) });
  assert.strictEqual(comped(lab).description, 'Margarita Nueva', 'FL-FREE the comped line is described by the free key\'s label');
  assert.deepStrictEqual({ ...lab, factura_items: lab.factura_items.map((l) => ({ ...l, description: null })) }, { ...today, factura_items: today.factura_items.map((l) => ({ ...l, description: null })) }, 'FL-FREE the arithmetic is unchanged');
  const same = applyRedemptionToPricing({ items: [{ name: paid, qty: 1 }], restaurantId: 'x_pizza', redemption, totalLempiras: XM[paid], tables: tables({ [KEY]: KEY, [paid]: paid }) });
  assert.deepStrictEqual(same, today, 'FL-FREE-NOOP labels equal to keys: byte-identical');
  ok('the comped line is described by the free key\'s label; its arithmetic is unchanged; today byte-identical');
}

console.log(`\nfactura-labels: OK (${n})`);
