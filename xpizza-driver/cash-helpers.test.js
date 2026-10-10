// Pure cash-helper tests — run: `node cash-helpers.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { computeVuelto, vueltoSuggestions, computeShiftCash, isCashPayment, collectionFor, COLLECT_WARN_TEXT, paymentRowHtml, queuePayHtml } from './cash-helpers.js';
import { createRequire } from 'node:module';

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

// ---------- isCashPayment(pm) ----------
t('isCashPayment: cash (real platform value) → true', () => assert.equal(isCashPayment('cash'), true));
t('isCashPayment: efectivo (legacy alias) → true', () => assert.equal(isCashPayment('efectivo'), true));
t('isCashPayment: Cash (case-insensitive) → true', () => assert.equal(isCashPayment('Cash'), true));
t('isCashPayment: "  cash  " (trimmed) → true', () => assert.equal(isCashPayment('  cash  '), true));
t('isCashPayment: card_delivery → false', () => assert.equal(isCashPayment('card_delivery'), false));
t('isCashPayment: online → false', () => assert.equal(isCashPayment('online'), false));
t('isCashPayment: empty → false', () => assert.equal(isCashPayment(''), false));
t('isCashPayment: null → false', () => assert.equal(isCashPayment(null), false));
t('isCashPayment: undefined → false', () => assert.equal(isCashPayment(undefined), false));
// Non-string payment_method is definitionally not a valid cash order → false (no coercion).
t('isCashPayment: ["cash"] array → false (no coercion)', () => assert.equal(isCashPayment(['cash']), false));
t('isCashPayment: {} object → false', () => assert.equal(isCashPayment({}), false));
t('isCashPayment: {toString:()=>"cash"} → false (no coercion)', () => assert.equal(isCashPayment({ toString() { return 'cash'; } }), false));

// ---------- computeShiftCash(allTasks, allOrders, uid, sinceMs) ----------
// The platform writes payment_method: 'cash' | 'card_delivery' | 'online'
// (functions ALLOWED_PAYMENT_METHODS). 'efectivo' is only a legacy alias. Cash owed
// must count 'cash' (+ legacy 'efectivo'), and MUST NOT count 'card_delivery'/'online'.
const SINCE = 1000;
const allTasks = {
  d1: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'o1' }, // cash, today
  d2: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 3000, order_id: 'o2' }, // card_delivery, today
  d3: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 500,  order_id: 'o3' }, // cash, BEFORE since
  d4: { type: 'delivery', assigned_driver_id: 'other', status: 'completed', completed_at: 2500, order_id: 'o4' }, // other driver
  d5: { type: 'delivery', assigned_driver_id: 'me', status: 'in_progress', completed_at: null, order_id: 'o5' }, // not completed
  p1: { type: 'pickup', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'o1' }, // not a delivery
  d6: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 4000, order_id: 'o6' }, // 'Cash' (case), today
  d7: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 4100, order_id: 'o7' }, // legacy 'efectivo', today
  d8: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 4200, order_id: 'o8' }, // online, today
  d9: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 4300, order_id: 'o9' }, // '  cash  ' (trim), today
};
const allOrders = {
  o1: { total: 370, payment_method: 'cash' },          // real platform value
  o2: { total: 500, payment_method: 'card_delivery' }, // NOT cash
  o3: { total: 999, payment_method: 'cash' },
  o4: { total: 800, payment_method: 'cash' },
  o6: { total: 646, payment_method: 'Cash' },          // case-insensitive
  o7: { total: 200, payment_method: 'efectivo' },      // legacy alias (back-compat)
  o8: { total: 900, payment_method: 'online' },        // NOT cash
  o9: { total: 100, payment_method: '  cash  ' },      // trims whitespace
};
t('shiftCash: cash = cash/legacy-efectivo only, never card_delivery/online', () => {
  const r = computeShiftCash(allTasks, allOrders, 'me', SINCE);
  assert.equal(r.deliveries, 6);                       // d1,d2,d6,d7,d8,d9
  // #6 fix: "Total cobrado" = what the driver actually collects at the door (cash + card_delivery).
  // o8 is online (no payment_status → unconfirmed → warning), so it is NOT counted as collected — and
  // it never was cash-owed either.
  assert.equal(r.totalCollected, 370 + 500 + 646 + 200 + 100);
  assert.equal(r.cashOwed, 370 + 646 + 200 + 100);     // cash + Cash + efectivo(legacy) + '  cash  '  (unchanged)
  assert.equal(r.cashOrderCount, 4);                   // excludes card_delivery(o2) + online(o8)
  assert.equal(r.paidOnlineTotal, 0);                  // o8 online is UNCONFIRMED → warning, not paid-online
});
t('shiftCash: empty input → zeros', () => {
  const r = computeShiftCash({}, {}, 'me', SINCE);
  assert.deepEqual(r, { deliveries: 0, totalCollected: 0, cashOwed: 0, cashOrderCount: 0, paidOnlineTotal: 0, paidOnlineCount: 0 });
});
// A fully-comped rewards redemption places the order as payment_method:'cash' + free_order:true
// (total $0). It must NOT count as a cash-collection order — no phantom +1 in the cuadre.
t('shiftCash: free_order cash order EXCLUDED from cashOwed + cashOrderCount (still a delivery)', () => {
  const tasks  = { fd: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'fo' } };
  const orders = { fo: { total: 0, payment_method: 'cash', free_order: true } };
  const r = computeShiftCash(tasks, orders, 'me', SINCE);
  assert.equal(r.deliveries, 1);       // it IS a completed delivery
  assert.equal(r.cashOwed, 0);         // nothing to collect
  assert.equal(r.cashOrderCount, 0);   // NOT a cash order → no phantom +1
});
t('shiftCash: normal cash order still counts (free_order absent) — byte-identical', () => {
  const tasks  = { nd: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'no' } };
  const orders = { no: { total: 370, payment_method: 'cash' } };
  const r = computeShiftCash(tasks, orders, 'me', SINCE);
  assert.equal(r.cashOwed, 370);
  assert.equal(r.cashOrderCount, 1);
});

// ---------- collectionFor(order) — THE single source of truth ----------
const cf = collectionFor;
// cash / legacy efectivo → collect full, cash owed to the office
t('collectionFor: cash → collect+owed, amount=total', () => assert.deepEqual(cf({ total: 370, payment_method: 'cash' }), { kind: 'cash', collect: true, owed: true, amount: 370, chip: 'Efectivo', chipClass: 'cash' }));
t('collectionFor: legacy efectivo → cash', () => assert.equal(cf({ total: 200, payment_method: 'efectivo' }).kind, 'cash'));
t('collectionFor: Cash (case) → cash', () => assert.equal(cf({ total: 1, payment_method: 'Cash' }).kind, 'cash'));
t('collectionFor: "  cash  " (trim) → cash', () => assert.equal(cf({ total: 1, payment_method: '  cash  ' }).kind, 'cash'));
// card_delivery → collect full by POS, but NOT cash owed
t('collectionFor: card_delivery → collect, NOT owed', () => assert.deepEqual(cf({ total: 500, payment_method: 'card_delivery' }), { kind: 'card', collect: true, owed: false, amount: 500, chip: 'Tarjeta', chipClass: 'card' }));
// online + confirmed → verified paid → nothing to collect (THE fix)
t('collectionFor: online+confirmed → paid_online, no collect, amount 0', () => assert.deepEqual(cf({ total: 900, payment_method: 'online', payment_status: 'confirmed' }), { kind: 'paid_online', collect: false, owed: false, amount: 0 }));
// online NOT confirmed → warning, never a collect amount
t('collectionFor: online pending → warning', () => assert.deepEqual(cf({ total: 900, payment_method: 'online', payment_status: 'pending' }), { kind: 'warning', collect: false, owed: false, amount: 0 }));
t('collectionFor: online no status → warning (not paid)', () => assert.equal(cf({ total: 900, payment_method: 'online' }).kind, 'warning'));
t('collectionFor: online manual_review → warning', () => assert.equal(cf({ total: 900, payment_method: 'online', payment_status: 'manual_review' }).kind, 'warning'));
// free_order (cash-typed, total 0) → nothing to collect, wins over the cash branch
t('collectionFor: free_order → free, no collect', () => assert.deepEqual(cf({ total: 0, payment_method: 'cash', free_order: true }), { kind: 'free', collect: false, owed: false, amount: 0 }));
// unknown / '' / legacy tarjeta|pixel → warning (never written by the live server; pinned here)
t('collectionFor: empty method → warning', () => assert.equal(cf({ total: 5, payment_method: '' }).kind, 'warning'));
t('collectionFor: legacy tarjeta → warning (NOT collect)', () => assert.equal(cf({ total: 5, payment_method: 'tarjeta' }).kind, 'warning'));
t('collectionFor: legacy pixel → warning (NOT collect)', () => assert.equal(cf({ total: 5, payment_method: 'pixel' }).kind, 'warning'));
t('collectionFor: missing method → warning', () => assert.equal(cf({ total: 5 }).kind, 'warning'));
t('collectionFor: non-string method → warning', () => assert.equal(cf({ total: 5, payment_method: 123 }).kind, 'warning'));
t('collectionFor: null order → warning (no throw)', () => assert.equal(cf(null).kind, 'warning'));
// the safety invariant: a non-collect kind NEVER carries a positive amount
t('collectionFor: paid/warning/free carry amount 0 (no phantom collect)', () => {
  for (const o of [{ payment_method: 'online', payment_status: 'confirmed', total: 900 }, { payment_method: 'online', total: 900 }, { payment_method: '', total: 900 }, { payment_method: 'cash', free_order: true, total: 0 }]) {
    const c = cf(o);
    assert.equal(c.collect, false);
    assert.equal(c.amount, 0);
  }
});

t('shiftCash: online+confirmed EXCLUDED from Total cobrado, surfaced as paidOnline', () => {
  const tasks  = { od: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'oo' } };
  const orders = { oo: { total: 900, payment_method: 'online', payment_status: 'confirmed' } };
  const r = computeShiftCash(tasks, orders, 'me', SINCE);
  assert.equal(r.deliveries, 1);
  assert.equal(r.totalCollected, 0);      // paid online → NOT "collected" by the driver
  assert.equal(r.cashOwed, 0);            // never cash owed
  assert.equal(r.cashOrderCount, 0);
  assert.equal(r.paidOnlineTotal, 900);   // surfaced on its own line instead
  assert.equal(r.paidOnlineCount, 1);
});
t('shiftCash: card_delivery counts as collected but NOT cash owed', () => {
  const tasks  = { cd: { type: 'delivery', assigned_driver_id: 'me', status: 'completed', completed_at: 2000, order_id: 'co' } };
  const orders = { co: { total: 500, payment_method: 'card_delivery' } };
  const r = computeShiftCash(tasks, orders, 'me', SINCE);
  assert.equal(r.totalCollected, 500);
  assert.equal(r.cashOwed, 0);
  assert.equal(r.cashOrderCount, 0);
});

// Pin the exact driver-facing warning copy (owner/advisor-specified) so a literal change is caught.
t('warn text is exactly the spec string', () => assert.equal(COLLECT_WARN_TEXT, 'Pago no confirmado — consultá a despacho'));

// ============================================================================
// RENDER + GOLDEN (folded in; same assertions as before). Order shapes ORIGINATE from the real server
// writers (buildCreateOrderUpdates / buildMaterializeUpdates), then flow through the REAL render code
// (paymentRowHtml / queuePayHtml from cash-helpers.js — exactly what index.html calls).
// ============================================================================
const require = createRequire(import.meta.url);
const { buildCreateOrderUpdates } = require('../xpizza-functions/create-order-build.js');
const { buildMaterializeUpdates } = require('../xpizza-functions/materialize.js');
const { COMBOS } = require('../xpizza-functions/deploy/combo-validation.js');

// Faithful copy of index.html's escapeHtml — the escaper the real render passes in.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Originate REAL order nodes from the real create writer (reuse the validated delivery combo).
const deliveryCombo = Object.values(COMBOS).find(c => c.input.orderType === 'delivery');
const OID = deliveryCombo.input.orderId;
function realOrderNode(paymentMethod) {
  const input = JSON.parse(JSON.stringify(deliveryCombo.input));
  input.fields.payment_method = paymentMethod;
  const updates = buildCreateOrderUpdates({ ...input, hubSnap: deliveryCombo.snapshot });
  return updates[`orders/${OID}`];   // the exact orders/{id} node the server writes
}
const cashOrder = realOrderNode('cash');
const cardOrder = realOrderNode('card_delivery');
// A fully-comped redemption is a cash order the server additionally stamps free_order:true + total 0.
const freeOrder = { ...realOrderNode('cash'), free_order: true, total: 0 };
// online CONFIRMED: run the REAL materialize writer — it is the writer that sets payment_status 'confirmed'
// (materialize.js:41), the exact field collectionFor keys on. Merge its orders/{id}/* field patches back.
function materializedOnlineOrder() {
  const pending = realOrderNode('online');
  const restaurant = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+504' };
  const up = buildMaterializeUpdates({ orderId: OID, order: pending, trackingToken: 'TOK', now: 999, restaurant, paymentMethod: 'online' });
  const merged = { ...pending };
  for (const [k, v] of Object.entries(up)) { const m = k.match(new RegExp(`^orders/${OID}/(.+)$`)); if (m) merged[m[1]] = v; }
  return merged;
}
const onlinePaid = materializedOnlineOrder();
const onlinePending = { ...realOrderNode('online'), payment_status: 'pending' };
const unknownMethod = realOrderNode('');   // server sanitizes any invalid method to '' (index.js:561)

t('sanity: the materialize writer is what set payment_status confirmed', () => {
  assert.equal(onlinePaid.payment_method, 'online');
  assert.equal(onlinePaid.payment_status, 'confirmed');
});

// GOLDEN: cash / card / free render BYTE-IDENTICAL to the 37dcf43 inline templates (same escaper).
function legacyPaymentRow(order) {
  const isFree = !!order.free_order;
  const isCash = /efectivo|cash/i.test(order.payment_method || '');
  const isCard = /tarjeta|pixel|card/i.test(order.payment_method || '');
  const paymentClass = isCash ? 'cash' : isCard ? 'card' : '';
  const paymentChipLabel = isCash ? 'Efectivo' : isCard ? 'Tarjeta' : (order.payment_method || '—');
  const totalFmt = order.total != null ? Number(order.total).toLocaleString('es-HN') : '—';
  return isFree
    ? `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount free-amount">Nada que cobrar</div></div><div class="payment-method free">Pedido gratis</div></div>`
    : `<div class="payment-row"><div><div class="pay-label">A COBRAR</div><div class="payment-amount"><span class="pay-cur">L</span>${totalFmt}</div></div><div class="payment-method ${paymentClass}">${escapeHtml(paymentChipLabel)}</div></div>`;
}
function legacyQpay(order) {
  const isFree = !!order.free_order;
  const isCash = /efectivo|cash/i.test(order.payment_method || '');
  const isCard = /tarjeta|pixel|card/i.test(order.payment_method || '');
  const payClass = isCash ? '' : isCard ? 'card' : '';
  const payLabel = isFree ? 'Gratis' : isCash ? `L ${Number(order.total || 0).toLocaleString('es-HN')}` : isCard ? 'Tarjeta' : (order.payment_method || '—');
  return `<span class="qpay ${payClass}">${escapeHtml(payLabel)}</span>`;
}
t('golden: cash payment row byte-identical', () => assert.equal(paymentRowHtml(cashOrder, escapeHtml), legacyPaymentRow(cashOrder)));
t('golden: card_delivery payment row byte-identical', () => assert.equal(paymentRowHtml(cardOrder, escapeHtml), legacyPaymentRow(cardOrder)));
t('golden: free payment row byte-identical', () => assert.equal(paymentRowHtml(freeOrder, escapeHtml), legacyPaymentRow(freeOrder)));
t('golden: cash qpay byte-identical', () => assert.equal(queuePayHtml(cashOrder, escapeHtml), legacyQpay(cashOrder)));
t('golden: card qpay byte-identical', () => assert.equal(queuePayHtml(cardOrder, escapeHtml), legacyQpay(cardOrder)));
t('golden: free qpay byte-identical', () => assert.equal(queuePayHtml(freeOrder, escapeHtml), legacyQpay(freeOrder)));

// THE FIX: a verified-paid online order NEVER shows "A COBRAR" or an amount.
t('paid online: row says Pagado, no A COBRAR, no L amount', () => {
  const row = paymentRowHtml(onlinePaid, escapeHtml);
  assert.ok(row.includes('Pagado — nada que cobrar'), row);
  assert.ok(!row.includes('A COBRAR'), 'must NOT say A COBRAR on a paid order');
  assert.ok(!/<span class="pay-cur">L<\/span>/.test(row), 'must NOT render an L amount');
  assert.ok(row.includes('payment-method paid'));
});
t('paid online: qpay says Pagado (never a raw method, never an amount)', () => {
  const q = queuePayHtml(onlinePaid, escapeHtml);
  assert.ok(q.includes('>Pagado<'), q);
  assert.ok(!q.includes('online'));
  assert.ok(!q.includes('L '));
});

// online UNCONFIRMED + unknown/'' → warning, never a collect amount.
for (const [label, ord] of [['online pending', onlinePending], ['unknown/empty method', unknownMethod]]) {
  t(`warning: ${label} → consultá a despacho, no amount`, () => {
    const row = paymentRowHtml(ord, escapeHtml);
    assert.ok(row.includes(COLLECT_WARN_TEXT), row);
    assert.ok(!row.includes('A COBRAR'));
    assert.ok(!/<span class="pay-cur">L<\/span>/.test(row));
    assert.ok(queuePayHtml(ord, escapeHtml).includes('>Revisar<'));
  });
}

// brand-agnostic: identical render for x_pizza and la_musa (driver UI is shared).
t('brand-agnostic: la_musa renders identically to x_pizza', () => {
  for (const base of [cashOrder, cardOrder, freeOrder, onlinePaid, onlinePending, unknownMethod]) {
    const xp = { ...base, restaurant_id: 'x_pizza' };
    const lm = { ...base, restaurant_id: 'la_musa' };
    assert.equal(paymentRowHtml(lm, escapeHtml), paymentRowHtml(xp, escapeHtml));
    assert.equal(queuePayHtml(lm, escapeHtml), queuePayHtml(xp, escapeHtml));
  }
});

console.log(`✓ cash-helpers: ${passed} tests passed`);
