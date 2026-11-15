'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.4; ruling A3 / owner Q2) — the resolution stage judges every cart EXTRA: a well-typed extra
// key the served tables do not hold (a removed extra) is the same typed result a removed dish already gets, menu_changed, before
// validation, pricing, the quote or any write. A malformed extra keeps today's refusal (passes through unjudged). Pure; tables
// built as the reader builds them. The four endpoints' shapes and zero effects are the emulator's (T9).
// Run: node catalog/resolve-lines-extras.test.js
const assert = require('assert');
const { resolveLines, resolutionRefusal, MENU_CHANGED_DETAIL } = require('./resolve-lines');
const { attachTablesKeyMode, extraPricingKey } = require('../menu-pricing');
const { buildTablesFromDocs } = require('./catalog-transform');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');

let n = 0; const fails = [];
function cell(label, fn) { try { fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));

for (const rid of ['x_pizza', 'la_musa']) {
  const { built } = buildSourceCandidate(rid, buildSourceFromCode(rid));
  const tables = attachTablesKeyMode({ restaurantId: rid, ...buildTablesFromDocs(built.items.map((i) => ({ key: i.key, price: i.price })), built.extras.map((e) => ({ key: e.key, price: e.price }))) }, built.key_mode);
  const dish = built.items.find((i) => !i.display.variantOf && !(built.structure.variant_items || {})[i.display.id]);
  const ex = built.extras[0];
  // a cart line as the clients send it: the dish's legacy field + its extras as display records ({id, name})
  const line = (extras) => ({ ...(rid === 'x_pizza' ? { name: dish.key } : { id: dish.key, name: dish.display.name }), qty: 1, price: dish.price, extras });
  const exOf = (e) => ({ id: e.display.id, name: e.display.name, qty: 1 });
  const removed = { id: rid === 'la_musa' ? 'quitado_01' : 'e999', name: 'Extra Quitado', qty: 1 };

  cell(`RLX-PREMISE ${rid}: a known extra's pricing key is in the served tables`, (L) => {
    assert.ok(Object.prototype.hasOwnProperty.call(tables.extras, extraPricingKey(exOf(ex), rid, built.key_mode)), L);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(tables.extras, extraPricingKey(removed, rid, built.key_mode)), false, `${L}: the removed one is not`);
  });
  cell(`RLX-KNOWN ${rid}: a cart whose extras the tables hold resolves`, (L) => {
    assert.deepStrictEqual(resolveLines(rid, { items: [line([exOf(ex)])] }, tables), { ok: true }, L);
  });
  cell(`RLX-REMOVED ${rid}: a removed extra is menu_changed at the stage, naming the line and the extra`, (L) => {
    const r = resolveLines(rid, { items: [line([]), line([exOf(ex), removed])] }, tables);
    assert.deepStrictEqual(r, { ok: false, code: 'menu_changed', at: 'extras', index: 1, extra: 1 }, L);
    assert.deepStrictEqual(resolutionRefusal(r), { status: 409, body: { error: 'menu_changed', detail: MENU_CHANGED_DETAIL, retryable: false } }, `${L}: the order endpoints' 409`);
  });
  cell(`RLX-KEYED ${rid}: an item_key cart is judged for its extras too`, (L) => {
    const r = resolveLines(rid, { items: [{ ...line([removed]), item_key: dish.key }] }, tables);
    assert.strictEqual(r.code, 'menu_changed', L);
  });
  cell(`RLX-MALFORMED-PASSES ${rid}: a malformed extra keeps today's refusal (the stage does not answer)`, (L) => {
    for (const bad of [{ id: 7, name: 7 }, { qty: 1 }, null]) {
      const body = { items: [line([bad])] };
      assert.deepStrictEqual(resolveLines(rid, clone(body), tables), { ok: true }, `${L}: ${JSON.stringify(bad)}`);
    }
  });
}

if (fails.length) { console.log(`resolve-lines-extras FAILED ${fails.length} cell(s): ${fails.join(', ')}`); process.exit(1); }
console.log(`resolve-lines-extras: OK (${n})`);
