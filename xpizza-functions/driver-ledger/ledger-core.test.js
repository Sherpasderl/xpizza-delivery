'use strict';
// S8 — the pure core of the driver payable ledger. Run: node driver-ledger/ledger-core.test.js
const assert = require('assert');
const C = require('./ledger-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const HN = (iso) => Date.parse(`${iso}-06:00`);     // a Honduras wall-clock instant

// ── weeks: Mon 00:00 … Sun 23:59:59.999 America/Tegucigalpa (UTC−6, no DST) ──
assert.strictEqual(C.weekOf(HN('2026-10-19T00:00:00')), 'W2026-10-19', 'Monday 00:00 HN opens its week');
assert.strictEqual(C.weekOf(HN('2026-10-25T23:59:59.999')), 'W2026-10-19', 'Sunday 23:59:59.999 HN is still that week');
assert.strictEqual(C.weekOf(HN('2026-10-26T00:00:00')), 'W2026-10-26', 'the next Monday 00:00 HN is the next week');
assert.strictEqual(C.weekOf(Date.parse('2026-10-26T05:59:59Z')), 'W2026-10-19', 'UTC Monday 05:59 = Sunday 23:59 HN — the OLD week');
assert.deepStrictEqual(C.weekBounds('W2026-10-19'), { start: HN('2026-10-19T00:00:00'), end: HN('2026-10-26T00:00:00') });
assert.strictEqual(C.prevWeek('W2026-01-05'), 'W2025-12-29', 'across a year boundary');
assert.strictEqual(C.nextWeek('W2026-10-19'), 'W2026-10-26');
assert.throws(() => C.weekBounds('2026-10-19'), /bad week key/);
ok('weeks are Mon–Sun Honduras time; boundaries, UTC/HN skew, year rollover, bad keys');

// ── config: absent or incomplete = OFF ──
const cfg = C.readPayConfig({ base_cents: 7000, ledger_start_at: HN('2026-10-19T00:00:00'), policy_version: 1 });
assert.ok(cfg && cfg.base_cents === 7000);
for (const bad of [null, {}, { base_cents: 0, ledger_start_at: 1, policy_version: 1 }, { base_cents: 7000, ledger_start_at: 1 }, { base_cents: 70.5, ledger_start_at: 1, policy_version: 1 }]) assert.strictEqual(C.readPayConfig(bad), null);
ok('platform_config/driver_pay absent or incomplete → the ledger is OFF');

// ── the week, computed from /orders ──
const W1 = 'W2026-10-19', W2 = 'W2026-10-26';
const at = HN('2026-10-21T19:30:00');
const del = (o = {}) => ({ order_type: 'delivery', delivered_at: at, delivered_by_driver_uid: 'drvA', restaurant_id: 'r1', ...o });
assert.deepStrictEqual(C.windowOf(W2), { from: C.weekBounds(W2).start - 14 * 86400000, to: C.weekBounds(W2).end });
const w1 = C.computeWeek(W1, [
  ['o2', del()], ['o1', del({ delivered_at: at - 3600000 })], ['o3', del({ delivered_by_driver_uid: 'drvB' })],
  ['o4', del({ delivered_by_driver_uid: undefined, delivered_by_uid: 'drvB' })],               // no PROTECTED stamp
  ['o5', del({ order_type: 'pickup' })], ['o6', del({ delivered_at: cfg.ledger_start_at - 1 })],
  ['o7', del({ delivered_at: undefined })], ['o8', del({ delivered_at: C.weekBounds(W1).end })],   // next week: not this one
], [], cfg);
assert.deepStrictEqual(w1.drivers.drvA, { deliveries: ['o1', 'o2'], adjustments: [], base_cents: 14000, adjustments_cents: 0, carry_in_cents: 0, net_cents: 14000, outcome: 'payable' });
assert.deepStrictEqual(Object.keys(w1.drivers).sort(), ['drvA', 'drvB']);
assert.deepStrictEqual([w1.unresolved, w1.attribution_review, w1.week, w1.policy_version, w1.base_cents], [['o4'], [], W1, 1, 7000]);
ok('week: L 70 per delivered DELIVERY of the week from the protected stamp; pickup / undelivered / pre-start / other weeks → nothing; no stamp → unresolved');

// next week: a late sync, a late stamp, a changed stamp, an already-paid order, de-duplicated review lists
const closed1 = { ...w1, closed_at: 1 };
const late = (o) => del({ delivered_at: at + 3600000, ...o });                                  // delivered in W1
const w2rows = [
  ['o1', del({ delivered_at: at - 3600000 })],                                                    // paid in W1: never again
  ['o2', del({ delivered_by_driver_uid: 'drvB' })],                                               // paid to drvA, stamp now drvB
  ['o4', del({ delivered_by_driver_uid: 'drvB' })],                                               // unresolved in W1, stamp arrived
  ['oZ', late({ delivered_by_driver_uid: 'drvZ' })],                                              // synced after W1 closed
  ['oU', late({ delivered_by_driver_uid: undefined })],                                           // still no stamp
  ['n1', del({ delivered_at: C.weekBounds(W2).start + 3600000 })],
];
const w2 = C.computeWeek(W2, w2rows, [closed1], cfg);
assert.deepStrictEqual(w2.drivers.drvA.deliveries, ['n1']);
assert.deepStrictEqual(w2.drivers.drvB.adjustments, [{ order_id: 'o4', original_week: W1 }], 'a late stamp pays as an adjustment');
assert.deepStrictEqual(w2.drivers.drvZ, { deliveries: [], adjustments: [{ order_id: 'oZ', original_week: W1 }], base_cents: 0, adjustments_cents: 7000, carry_in_cents: 0, net_cents: 7000, outcome: 'payable' }, 'a late sync by a driver with NO entry that week still pays');
assert.deepStrictEqual(w2.attribution_review, [{ order_id: 'o2', paid_to: 'drvA', paid_week: W1, stamp_now: 'drvB' }], 'a changed stamp → review only, no money');
assert.deepStrictEqual(w2.unresolved, ['oU']);
const w3 = C.computeWeek('W2026-11-02', w2rows, [{ ...w2, closed_at: 2 }, closed1], cfg);
assert.deepStrictEqual([w3.attribution_review, w3.unresolved, Object.keys(w3.drivers)], [[], [], []], 'review lists are not repeated in later weeks; nothing pays twice');
const moved = C.computeWeek('W2026-11-09', [['o1', del({ delivered_at: C.weekBounds('W2026-11-09').start - 86400000 })]], [closed1, { ...w2, closed_at: 2 }, { week: 'W2026-11-02', drivers: {} }], cfg);
assert.deepStrictEqual(Object.keys(moved.drivers), [], 'an order paid weeks ago whose delivered_at was MOVED into the window is never paid again (dedupe = all closed weeks)');
ok('next weeks: late sync / late stamp → adjustment once; paid order never again; changed stamp → attribution_review once; lists de-duplicated');

// carry: a negative unpaid previous entry carries (also into a driver with no deliveries); paid or positive never does
const neg = { week: W1, drivers: { drvC: { deliveries: [], adjustments: [], net_cents: -7000 }, drvP: { net_cents: 14000 }, drvQ: { net_cents: -7000, paid: { at: 1 } } } };
const c2 = C.computeWeek(W2, [['m1', del({ delivered_at: C.weekBounds(W2).start + 1, delivered_by_driver_uid: 'drvC' })], ['m2', del({ delivered_at: C.weekBounds(W2).start + 2, delivered_by_driver_uid: 'drvC' })]], [neg], cfg);
assert.deepStrictEqual([c2.drivers.drvC.carry_in_cents, c2.drivers.drvC.net_cents, c2.drivers.drvC.outcome], [-7000, 7000, 'payable']);
assert.deepStrictEqual(Object.keys(c2.drivers), ['drvC'], 'a positive unpaid week stays on its own entry; a paid one carries nothing');
const c3 = C.computeWeek(W2, [], [neg], cfg);
assert.deepStrictEqual([c3.drivers.drvC.carry_in_cents, c3.drivers.drvC.net_cents, c3.drivers.drvC.outcome], [-7000, -7000, 'no_payment'], 'a carry with no deliveries closes again with no payment');
ok('carry: net < 0 unpaid carries forward (with or without deliveries); positive unpaid and paid entries never carry');

const s = { net_cents: 21000, outcome: 'payable' }, s2 = c3.drivers.drvC;
// ── «Marcar pagado» validation: FULL settlement, reference + date only ──
const req = { amount_cents: 21000, reference: 'BAC-2210-4471', paid_on: '2026-10-26', op_key: 'op_abcdefgh' };
assert.deepStrictEqual(C.validatePayment(s, req), { ok: true, payment: { amount_cents: 21000, paid_on: '2026-10-26', reference: 'BAC-2210-4471', op_key: 'op_abcdefgh' } });
assert.strictEqual(C.validatePayment(s, { ...req, amount_cents: 20000 }).reason, 'amount_must_equal_net', 'a PARTIAL payment is refused');
assert.strictEqual(C.validatePayment(s, { ...req, amount_cents: 22000 }).reason, 'amount_must_equal_net', 'an OVER-payment is refused');
assert.strictEqual(C.validatePayment(s2, req).reason, 'nothing_to_pay', 'a no-payment week cannot be marked paid');
assert.strictEqual(C.validatePayment(null, req).reason, 'not_closed', 'an open week cannot be marked paid');
assert.strictEqual(C.validatePayment(s, { ...req, reference: ' ' }).reason, 'bad_reference');
assert.strictEqual(C.validatePayment(s, { ...req, paid_on: '26/10/2026' }).reason, 'bad_date');
assert.strictEqual(C.validatePayment(s, { ...req, op_key: 'x' }).reason, 'bad_op_key');
assert.deepStrictEqual(Object.keys(C.validatePayment(s, { ...req, account_number: '1234', bank: 'BAC' }).payment).sort(), ['amount_cents', 'op_key', 'paid_on', 'reference'], 'extra (bank) fields in the request never reach the payment record');
ok('«Marcar pagado»: only the exact net, a reference and a date; partial / over / no-payment / open week refused; bank fields never recorded');

console.log(`\ndriver-ledger core: ${n} passed`);
