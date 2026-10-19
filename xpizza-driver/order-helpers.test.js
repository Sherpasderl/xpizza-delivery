// Pure order-helper tests — run: `node order-helpers.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { displayOrderLabel, endShiftPrompt } from './order-helpers.js';

let passed = 0;
function t(name, fn) { fn(); passed++; }

// ---------- displayOrderLabel(o) — the human-friendly order # (display only; never a key) ----------
// display_number present → '#N'
t('label: display_number 47 → "#47"', () => assert.equal(displayOrderLabel({ display_number: 47, order_id: 'PZX-x' }), '#47'));
t('label: display_number 1 → "#1"', () => assert.equal(displayOrderLabel({ display_number: 1 }), '#1'));
t('label: numeric-string "47" → "#47"', () => assert.equal(displayOrderLabel({ display_number: '47' }), '#47'));
// absent → graceful fallback to order_id (never blank), until Core stamps the number
t('label: no display_number → order_id fallback', () => assert.equal(displayOrderLabel({ order_id: 'PZX-260716-1' }), 'PZX-260716-1'));
t('label: no display_number → orderId (wrapper) fallback', () => assert.equal(displayOrderLabel({ orderId: 'PZX-abc' }), 'PZX-abc'));
// robustness — never throws, never a bogus "#"
t('label: null → ""', () => assert.equal(displayOrderLabel(null), ''));
t('label: undefined → ""', () => assert.equal(displayOrderLabel(undefined), ''));
t('label: {} → ""', () => assert.equal(displayOrderLabel({}), ''));
t('label: display_number 0 (never occurs) → fallback, not "#0"', () => assert.equal(displayOrderLabel({ display_number: 0, order_id: 'PZX-z' }), 'PZX-z'));
t('label: junk display_number → fallback, not "#abc"', () => assert.equal(displayOrderLabel({ display_number: 'abc', order_id: 'PZX-j' }), 'PZX-j'));

// ---------- endShiftPrompt(driverOrders) — O4 end-of-shift confirmation (null when N=0) ----------
// shape mirrors getDriverOrders: { orderId, phase, order, deliveryTask }
const DO = (phase, order, deliveryTask) => ({ orderId: (order && order.order_id) || 'o?', phase, order, deliveryTask: deliveryTask || {} });

// N = 0 → null (no sheet; the shift ends through the usual cuadre, unchanged)
t('prompt: no orders → null', () => assert.equal(endShiftPrompt([]), null));
t('prompt: null input → null', () => assert.equal(endShiftPrompt(null), null));
t('prompt: undefined input → null', () => assert.equal(endShiftPrompt(undefined), null));
t('prompt: only non-delivery phases → null', () => assert.equal(endShiftPrompt([DO('pickup', { order_id: 'oP' }), DO('awaiting_acceptance', { order_id: 'oA' }), DO('completed', { order_id: 'oC' })]), null));

// N = 1 → singular copy + one row, fields from the live order
t('prompt: one delivery → singular + row', () => {
  const p = endShiftPrompt([DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'Col. Trejo, casa 1215' })]);
  assert.equal(p.n, 1);
  assert.equal(p.title, 'Todavía tenés 1 pedido en camino');
  assert.equal(p.question, '¿Terminar turno igual?');
  assert.equal(p.orders.length, 1);
  assert.deepEqual(p.orders[0], { label: '#12', name: 'Ana', address: 'Col. Trejo, casa 1215' });
});

// N = 2 → plural copy + two rows
t('prompt: two deliveries → plural + two rows', () => {
  const p = endShiftPrompt([
    DO('delivery', { order_id: 'oD1', display_number: 12, customer_name: 'Ana', address_detected: 'Addr 1' }),
    DO('delivery', { order_id: 'oD2', display_number: 13, customer_name: 'Beto', address_detected: 'Addr 2' }),
  ]);
  assert.equal(p.n, 2);
  assert.equal(p.title, 'Todavía tenés 2 pedidos en camino');
  assert.equal(p.orders.length, 2);
  assert.deepEqual(p.orders.map((o) => o.label), ['#12', '#13']);
});

// WRONG-PHASE mutant killer: mixed phases → ONLY the delivery-phase order counts
t('prompt: mixed phases → counts only delivery', () => {
  const p = endShiftPrompt([
    DO('pickup', { order_id: 'oP', customer_name: 'P' }),
    DO('delivery', { order_id: 'oD', customer_name: 'Deliv' }),
    DO('awaiting_acceptance', { order_id: 'oA', customer_name: 'A' }),
  ]);
  assert.equal(p.n, 1);
  assert.equal(p.title, 'Todavía tenés 1 pedido en camino');
  assert.equal(p.orders[0].name, 'Deliv');
});

// field fallbacks: no customer_name/address_detected → delivery TASK fields; no display_number → order_id label
t('prompt: fallbacks to deliveryTask + order_id label', () => {
  const p = endShiftPrompt([DO('delivery', { order_id: 'PZX-9' }, { recipient_name: 'Carlos', destination_address: 'Res. Castaños' })]);
  assert.deepEqual(p.orders[0], { label: 'PZX-9', name: 'Carlos', address: 'Res. Castaños' });
});

// null order record (task without an order node) → label from orderId, name/address '—'
t('prompt: null order record → orderId label + dashes', () => {
  const p = endShiftPrompt([{ orderId: 'oNull', phase: 'delivery', order: null, deliveryTask: {} }]);
  assert.deepEqual(p.orders[0], { label: 'oNull', name: '—', address: '—' });
});

console.log(`✓ order-helpers: ${passed} tests passed`);
