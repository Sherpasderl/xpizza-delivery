'use strict';
// S1d D6 (S1b ruling Q4: the overlay + the plan's display.id test move to S1d; D4c-grill/item-s1/S1d-DESIGN.md D6) — a SERVED dish
// record is keyed by its display.id through the version's own (display.id → key) map, so a RENAMED dish (key kept, name changed)
// and an OPAQUE dish (minted key) keep their identity on the served menu; a dish the map does not hold is keyed exactly as today.
// The endpoint body also names every dish's item_key, in one top-level map from the same map (the overlay-free body the
// reconciler and the bake read does not). Run: node catalog/identity-overlay-displayid.test.js
const assert = require('assert');
const OV = require('./identity-overlay');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const menu = { items: [
  { key: 'Dish One', price: 100, display: { id: 2, name: 'Dish One Renamed' } },
  { key: 'i_aaaaaaaaaaab', price: 90, display: { id: 7, name: 'Pizza Nueva' } },
  { key: 'Dish Two', price: 80, display: { id: 1, name: 'Dish Two' } },
] };
const lmMenu = { items: [{ key: 'dimsum_01', price: 249, display: { id: 'dimsum_01', name: 'Sichuan Spicy Wonton' } }, { key: 'i_aaaaaaaaaaac', price: 120, display: { id: 'bao_nuevo', name: 'Bao Nuevo' } }] };

{
  const m = OV.servedKeyMap(menu);
  assert.deepStrictEqual([...m.entries()], [['2', 'Dish One'], ['7', 'i_aaaaaaaaaaab'], ['1', 'Dish Two']], 'OV-MAP (display.id → key) from the version\'s items');
  assert.strictEqual(OV.keyOfServed('x_pizza', { id: 2, name: 'Dish One Renamed' }, m), 'Dish One', 'OV-RENAMED a renamed dish is keyed by its kept key (today: its new name, which resolves nothing)');
  assert.strictEqual(OV.keyOfServed('x_pizza', { id: 2, name: 'Dish One Renamed' }, null), 'Dish One Renamed', 'premise: without the map, today\'s derivation');
  assert.strictEqual(OV.keyOfServed('x_pizza', { id: 7, name: 'Pizza Nueva' }, m), 'i_aaaaaaaaaaab', 'OV-OPAQUE a minted dish is keyed by its minted key');
  assert.strictEqual(OV.keyOfServed('x_pizza', { id: 1, name: 'Dish Two' }, m), 'Dish Two', 'OV-PLAIN an unrenamed dish: the same key as today');
  assert.strictEqual(OV.keyOfServed('x_pizza', { id: 99, name: 'Ghost' }, m), 'Ghost', 'OV-UNMAPPED a record the map does not hold: today\'s derivation');
  const lm = OV.servedKeyMap(lmMenu);
  assert.strictEqual(OV.keyOfServed('la_musa', { id: 'dimsum_01', name: 'Sichuan Spicy Wonton' }, lm), 'dimsum_01', 'OV-IDMODE la_musa: unchanged');
  assert.strictEqual(OV.keyOfServed('la_musa', { id: 'bao_nuevo', name: 'Bao Nuevo' }, lm), 'i_aaaaaaaaaaac', 'OV-IDMODE-OPAQUE a minted la_musa dish: its minted key, not its slug');
  ok('a served dish is keyed by display.id through the version\'s map: renamed, opaque and id-keyed dishes keep their identity');
}

{
  const body = { dishes: [{ id: 2, name: 'Dish One Renamed' }, { id: 7, name: 'Pizza Nueva' }, { id: 99, name: 'Ghost' }], extras: [{ id: 'e1', name: 'Extra X' }] };
  const before = JSON.parse(JSON.stringify(body));
  const out = OV.withServedItemKeys('x_pizza', body, OV.servedKeyMap(menu));
  assert.deepStrictEqual(body, before, 'OV-PURE the input body is not mutated');
  assert.deepStrictEqual(out.item_keys, { 2: 'Dish One', 7: 'i_aaaaaaaaaaab', 99: 'Ghost' }, 'OV-ITEMKEY one top-level map (display.id → item_key)');
  assert.deepStrictEqual(out.dishes, body.dishes, 'OV-RECORDS dish records are untouched (the frozen forms serialize them into the order)');
  assert.deepStrictEqual(out.extras, body.extras, 'OV-ITEMKEY extras are unchanged');
  ok('the endpoint body names every dish\'s item_key in one top-level map; records untouched; the input is never mutated');
}

console.log(`\nidentity-overlay-displayid: OK (${n})`);
