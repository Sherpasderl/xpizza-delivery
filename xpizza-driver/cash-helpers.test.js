// Pure cash-helper tests — run: `node cash-helpers.test.js` (no framework, repo idiom).
import assert from 'node:assert/strict';
import { computeVuelto, vueltoSuggestions, computeShiftCash, isCashPayment, collectionFor, COLLECT_WARN_TEXT } from './cash-helpers.js';

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

console.log(`✓ cash-helpers: ${passed} tests passed`);
