// Pure cash-helper tests — run: `node cash-helpers.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { computeVuelto, vueltoSuggestions, computeShiftCash } from './cash-helpers.js';

let passed = 0;
function t(name, fn) { fn(); passed++; }

// ---------- computeVuelto(total, tendered) ----------
t('vuelto: tendered > total', () => assert.equal(computeVuelto(370, 500), 130));
t('vuelto: exact pay = 0', () => assert.equal(computeVuelto(370, 370), 0));
t('vuelto: short pay = null (never negative)', () => assert.equal(computeVuelto(370, 300), null));
t('vuelto: numeric strings coerced', () => assert.equal(computeVuelto('370', '500'), 130));
t('vuelto: non-numeric → null', () => assert.equal(computeVuelto(370, 'abc'), null));
t('vuelto: NaN total → null', () => assert.equal(computeVuelto(NaN, 500), null));

// ---------- vueltoSuggestions(total) ----------
t('suggestions: 370 → [400,500,1000]', () => assert.deepEqual(vueltoSuggestions(370), [400, 500, 1000]));
t('suggestions: 500 → [500,1000] (deduped)', () => assert.deepEqual(vueltoSuggestions(500), [500, 1000]));
t('suggestions: 1000 → [1000]', () => assert.deepEqual(vueltoSuggestions(1000), [1000]));
t('suggestions: 646 → [700,1000]', () => assert.deepEqual(vueltoSuggestions(646), [700, 1000]));
t('suggestions: bad input → []', () => assert.deepEqual(vueltoSuggestions(0), []));

// ---------- computeShiftCash(allTasks, allOrders, uid, sinceMs) ----------
const SINCE = 1000;
const allTasks = {
  d1: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'o1' }, // cash, today
  d2: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 3000, order_id: 'o2' }, // card, today
  d3: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 500,  order_id: 'o3' }, // cash, BEFORE since
  d4: { type: 'delivery', assigned_driver_id: 'other', status: 'completed', completed_at: 2500, order_id: 'o4' }, // other driver
  d5: { type: 'delivery', assigned_driver_id: 'me', status: 'in_progress', completed_at: null, order_id: 'o5' }, // not completed
  p1: { type: 'pickup', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'o1' }, // not a delivery
  d6: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 4000, order_id: 'o6' }, // cash, today
};
const allOrders = {
  o1: { total: 370, payment_method: 'efectivo' },
  o2: { total: 500, payment_method: 'Tarjeta' },
  o3: { total: 999, payment_method: 'efectivo' },
  o4: { total: 800, payment_method: 'efectivo' },
  o6: { total: 646, payment_method: 'Efectivo' }, // capitalized
};
t('shiftCash: counts only my completed deliveries since cutoff', () => {
  const r = computeShiftCash(allTasks, allOrders, 'me', SINCE);
  assert.equal(r.deliveries, 3);                 // d1, d2, d6
  assert.equal(r.totalCollected, 370 + 500 + 646);
  assert.equal(r.cashOwed, 370 + 646);           // d1 + d6 (efectivo, case-insensitive)
  assert.equal(r.cashOrderCount, 2);
});
t('shiftCash: empty input → zeros', () => {
  const r = computeShiftCash({}, {}, 'me', SINCE);
  assert.deepEqual(r, { deliveries: 0, totalCollected: 0, cashOwed: 0, cashOrderCount: 0 });
});

console.log(`✓ cash-helpers: ${passed} tests passed`);
