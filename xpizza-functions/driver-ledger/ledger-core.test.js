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

// ── accrual for one order ──
const at = HN('2026-10-21T19:30:00');
const del = (o = {}) => ({ order_type: 'delivery', delivered_at: at, delivered_by_driver_uid: 'drvA', restaurant_id: 'r1', ...o });
const env = { currentWeek: 'W2026-10-19', isClosed: () => false };
const a = C.accrualFor('o1', del(), cfg, env);
assert.deepStrictEqual(a, { kind: 'event', driverUid: 'drvA', event: { order_id: 'o1', driver_uid: 'drvA', delivered_at: at, base_cents: 7000, policy_version: 1, week: 'W2026-10-19', kind: 'delivery' } });
assert.strictEqual(C.accrualFor('o2', del({ order_type: 'pickup' }), cfg, env), null, 'a pickup earns nothing');
assert.strictEqual(C.accrualFor('o3', del({ delivered_at: undefined }), cfg, env), null, 'not delivered → nothing');
assert.strictEqual(C.accrualFor('o4', del({ delivered_at: cfg.ledger_start_at - 1 }), cfg, env), null, 'before ledger_start_at → nothing (no backfill)');
const u = C.accrualFor('o5', del({ delivered_by_driver_uid: undefined, delivered_by_uid: 'drvA' }), cfg, env);
assert.strictEqual(u.kind, 'unresolved', 'no PROTECTED stamp → unresolved, even with the best-effort delivered_by_uid');
const late = C.accrualFor('o6', del(), cfg, { currentWeek: 'W2026-10-26', isClosed: (w) => w === 'W2026-10-19' });
assert.deepStrictEqual([late.event.week, late.event.original_week, late.event.kind], ['W2026-10-26', 'W2026-10-19', 'late'], 'a delivery from a CLOSED week posts into the current week, referencing the original');
ok('accrual: L 70 per delivered DELIVERY from the protected stamp; pickup / undelivered / pre-start → nothing; no stamp → unresolved; closed week → late adjustment');

// ── statements ──
const ev = (id, week, kind = 'delivery', extra = {}) => ({ order_id: id, week, kind, base_cents: 7000, ...extra });
const s = C.statementFor('W2026-10-19', [ev('a', 'W2026-10-19'), ev('b', 'W2026-10-19'), ev('c', 'W2026-10-19', 'late', { original_week: 'W2026-10-12' }), ev('x', 'W2026-10-12')], null);
assert.deepStrictEqual([s.deliveries, s.base_cents, s.adjustments_cents, s.carry_in_cents, s.net_cents, s.outcome], [2, 14000, 7000, 0, 21000, 'payable']);
assert.deepStrictEqual(s.order_ids, ['a', 'b', 'c'], 'only this week\'s events, late ones included');
assert.deepStrictEqual(s.adjustments, [{ order_id: 'c', original_week: 'W2026-10-12', cents: 7000 }]);
const neg = { net_cents: -7000, outcome: 'no_payment' };
const s2 = C.statementFor('W2026-10-26', [], neg);
assert.deepStrictEqual([s2.carry_in_cents, s2.net_cents, s2.outcome], [-7000, -7000, 'no_payment'], 'a negative unpaid balance carries forward and closes again with no payment');
const s3 = C.statementFor('W2026-10-26', [ev('d', 'W2026-10-26'), ev('e', 'W2026-10-26')], neg);
assert.deepStrictEqual([s3.carry_in_cents, s3.net_cents, s3.outcome], [-7000, 7000, 'payable'], '…and offsets the next payable');
assert.strictEqual(C.statementFor('W2026-10-26', [], { net_cents: 14000, outcome: 'payable' }).carry_in_cents, 0, 'a POSITIVE unpaid week never carries (it stays payable on its own statement)');
assert.strictEqual(C.statementFor('W2026-10-26', [], { net_cents: -7000, payment: { amount_cents: 1 } }).carry_in_cents, 0, 'a paid statement carries nothing');
ok('statement: net = base + late adjustments + carry (tips join in S2); ≤ 0 closes with no payment and carries; a positive unpaid week stays on its own statement');

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
