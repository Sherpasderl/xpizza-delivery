'use strict';
// S8 — THE DRIVER PAYABLE LEDGER STORE, end to end on the RTDB emulator (PLAN-shared-order-form.FINAL §5 S8).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:driver-ledger
// Every store call goes through an INSTRUMENTED handle that records each read (with its query) and each write, so the
// suite proves what the ledger touches, not only what it computes: /orders is read ONLY through the bounded delivered_at
// query or one order at a time; every write lands under the ledger's own paths (never cash-to-remit / cuadre).
require('./_emulator-required')('database');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });   // as test/add-product.emulator.test.js
const rtdb = admin.database();
const S = require('../driver-ledger/ledger-store');
const C = require('../driver-ledger/ledger-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('driver-ledger: FAILED — exited without completing'); process.exitCode = 1; } });

// ── the instrumented handle ──
const READS = [], WRITES = [];
let HIDE = null;                                    // a path whose NEXT read returns null (interleaving a concurrent close)
function wrap(r, p, chain) {
  return new Proxy(r, { get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    return (...a) => {
      if (['set', 'update', 'remove', 'transaction', 'push'].includes(k)) WRITES.push(p);
      if (k === 'once') {
        READS.push({ p, chain });
        if (HIDE === p) { HIDE = null; return Promise.resolve({ val: () => null, forEach: () => false, exists: () => false }); }
      }
      const out = v.apply(t, a);
      if (['orderByChild', 'startAt', 'limitToFirst', 'equalTo'].includes(k)) return wrap(out, p, [...chain, k]);
      return out;
    };
  } });
}
const db = { ref: (p) => wrap(rtdb.ref(p), p, []) };
const LEDGER = /^(driver_ledger|driver_ledger_week_index|driver_ledger_unresolved|driver_ledger_meta)(\/|$)/;

async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  await rtdb.ref().remove();
}
const HN = (iso) => Date.parse(`${iso}-06:00`);
const START = HN('2026-10-19T00:00:00');           // Monday — the ledger's go-live
const W1 = 'W2026-10-19', W2 = 'W2026-10-26', W3 = 'W2026-11-02';
const order = (o) => ({ order_type: 'delivery', status: 'delivered', restaurant_id: 'r1', total: 300, ...o });
const val = async (p) => (await rtdb.ref(p).get()).val();

(async () => {
  await wipe();
  // cash-to-remit / cuadre data that S8 must never touch
  await rtdb.ref('driver_shifts/drvA/cash').set({ collected: 1234, owed: 1234 });
  await rtdb.ref('cash_settlements/x').set({ amount: 500 });
  const cashBefore = JSON.stringify([await val('driver_shifts'), await val('cash_settlements')]);

  // 1. OFF without config
  assert.deepStrictEqual(await S.repairSweep(db, HN('2026-10-21T20:00:00')), { off: true });
  assert.deepStrictEqual(WRITES, [], 'no config → nothing written');
  ok('platform_config/driver_pay absent → the sweep is OFF and writes nothing');

  await rtdb.ref('platform_config/driver_pay').set({ base_cents: 7000, ledger_start_at: START, policy_version: 1 });
  await rtdb.ref('orders').set({
    o1: order({ delivered_at: HN('2026-10-20T19:00:00'), delivered_by_driver_uid: 'drvA' }),
    o2: order({ delivered_at: HN('2026-10-21T20:00:00'), delivered_by_driver_uid: 'drvA' }),
    o3: order({ delivered_at: HN('2026-10-22T12:00:00'), delivered_by_driver_uid: 'drvB' }),
    o4: order({ delivered_at: HN('2026-10-22T13:00:00'), delivered_by_uid: 'drvB' }),            // no PROTECTED stamp
    o5: order({ delivered_at: HN('2026-10-22T14:00:00'), order_type: 'pickup' }),
    o6: order({ delivered_at: START - 3600000, delivered_by_driver_uid: 'drvA' }),               // before go-live
    o7: order({ created_at: HN('2026-10-22T15:00:00') }),                                        // not delivered
  });

  // 2. accrual
  const now1 = HN('2026-10-22T18:00:00');
  const r1 = await S.repairSweep(db, now1);
  assert.deepStrictEqual([r1.created, r1.unresolved], [3, 1], JSON.stringify(r1));
  assert.deepStrictEqual(Object.keys((await val('driver_ledger/drvA/events')) || {}).sort(), ['o1', 'o2']);
  assert.deepStrictEqual(Object.keys((await val('driver_ledger/drvB/events')) || {}), ['o3']);
  assert.deepStrictEqual(await val('driver_ledger/drvA/events/o1'), { order_id: 'o1', driver_uid: 'drvA', delivered_at: HN('2026-10-20T19:00:00'), base_cents: 7000, policy_version: 1, week: W1, kind: 'delivery' });
  assert.ok(await val('driver_ledger_unresolved/o4'), 'o4 (no protected stamp) is listed unresolved');
  assert.strictEqual(await val('driver_ledger/drvB/events/o4'), null, '…and held out of the balance (best-effort delivered_by_uid is never money)');
  ok('accrual: L 70 per delivered delivery from the protected stamp; no stamp → unresolved + held out; pickup / pre-start / undelivered → nothing');

  // 3. bounded reads only
  const orderReads = READS.filter((r) => r.p === 'orders' || r.p.startsWith('orders/'));
  assert.ok(orderReads.length > 0, 'non-vacuity: the sweep read orders');
  for (const r of orderReads) assert.ok((r.p === 'orders' && r.chain.join() === 'orderByChild,startAt,limitToFirst') || /^orders\/[^/]+$/.test(r.p), `🔴 an unbounded /orders read: ${JSON.stringify(r)}`);
  ok(`/orders is read only through orderByChild(delivered_at).startAt().limitToFirst() or one order at a time (${orderReads.length} reads)`);

  // 4. idempotent under retry / crash
  await rtdb.ref(`driver_ledger_week_index/${W1}/drvA`).remove();                                 // a crash between event and index
  const r2 = await S.repairSweep(db, now1 + 60000);
  assert.strictEqual(r2.created, 0, 'a second run creates nothing');
  assert.strictEqual(await val(`driver_ledger_week_index/${W1}/drvA`), true, 'the missing week index heals on the next pass');
  assert.strictEqual(Object.keys((await val('driver_ledger/drvA/events')) || {}).length, 2, 'still exactly 2 events for drvA');
  ok('retry / crash: re-running accrues nothing twice and heals a missing week index');

  // 5. late / offline sync: an order whose delivered_at is BEHIND the cursor is still picked up (48 h overlap)
  const cursor = await val('driver_ledger_meta/cursor');
  await rtdb.ref('orders/o8').set(order({ delivered_at: cursor - 6 * 3600000, delivered_by_driver_uid: 'drvB' }));
  await S.repairSweep(db, now1 + 120000);
  assert.ok(await val('driver_ledger/drvB/events/o8'), 'o8 (6 h behind the cursor) accrued');
  ok('a delivery that syncs late, behind the cursor, is accrued by the trailing 48 h overlap');

  // 6. late stamp: (a) inside the overlap window the next pass resolves o4 in place; (b) OUTSIDE it (o12, older than
  //    cursor − 48 h, recorded unresolved by the real writer) only the unresolved RE-CHECK can resolve it.
  await rtdb.ref('orders/o4/delivered_by_driver_uid').set('drvB');
  await S.repairSweep(db, now1 + 180000);
  assert.ok(await val('driver_ledger/drvB/events/o4'), 'o4 accrued to drvB');
  assert.strictEqual(await val('driver_ledger_unresolved/o4'), null, 'its unresolved entry is gone');
  const o12 = order({ delivered_at: HN('2026-10-19T12:00:00') });                                   // after go-live, before the window
  await rtdb.ref('orders/o12').set(o12);
  assert.strictEqual(await S.accrueOrder(db, 'o12', o12, await S.readConfig(db), now1), 'unresolved', 'premise: the real writer records o12 unresolved');
  assert.ok((await val('driver_ledger_meta/cursor')) - 48 * 3600000 > o12.delivered_at, 'premise: o12 is OUTSIDE the overlap window');
  await rtdb.ref('orders/o12/delivered_by_driver_uid').set('drvA');
  const r3 = await S.repairSweep(db, now1 + 240000);
  assert.strictEqual(r3.resolved, 1, 'the unresolved re-check (not the window) resolved it');
  assert.ok(await val('driver_ledger/drvA/events/o12'), 'o12 accrued to drvA');
  assert.strictEqual(await val('driver_ledger_unresolved/o12'), null, 'its unresolved entry is gone');
  ok('a stamp that arrives after the order was swept resolves it in place — by the next window pass, or by the unresolved re-check outside the window');

  // 7. weekly close: immutable statements
  const mon = HN('2026-10-26T00:10:00');
  await S.closeWeeks(db, mon);
  const sA = await val(`driver_ledger/drvA/weeks/${W1}`), sB = await val(`driver_ledger/drvB/weeks/${W1}`);
  assert.deepStrictEqual([sA.deliveries, sA.net_cents, sA.outcome], [3, 21000, 'payable']);   // o1, o2, o12
  assert.deepStrictEqual([sB.deliveries, sB.net_cents], [3, 21000]);
  await rtdb.ref(`driver_ledger/drvA/events/o1/base_cents`).set(99999);                           // tamper after close
  await S.closeWeeks(db, mon + 1000); await S.closeDriverWeek(db, 'drvA', W1, mon + 2000);
  assert.deepStrictEqual(await val(`driver_ledger/drvA/weeks/${W1}`), sA, '🔴 a closed statement is never rewritten');
  await rtdb.ref(`driver_ledger/drvA/events/o1/base_cents`).set(7000);
  ok('Monday close freezes Mon–Sun statements; re-closing (and a later event edit) never rewrites one');

  // 8. late accrual into a closed week → current-week adjustment referencing the original week
  await rtdb.ref('orders/o9').set(order({ delivered_at: HN('2026-10-25T21:00:00'), delivered_by_driver_uid: 'drvA' }));
  await S.repairSweep(db, HN('2026-10-27T10:00:00'));
  assert.deepStrictEqual((({ week, original_week, kind }) => ({ week, original_week, kind }))(await val('driver_ledger/drvA/events/o9')), { week: W2, original_week: W1, kind: 'late' });
  ok('a delivery from a closed week posts as a current-week LATE adjustment referencing its original week');

  // 9. the close racing an accrual: the statement appears between the accrual's check and its write → re-homed
  await rtdb.ref('orders/o10').set(order({ delivered_at: HN('2026-11-01T20:00:00'), delivered_by_driver_uid: 'drvA' }));
  await rtdb.ref(`driver_ledger/drvA/weeks/${W2}`).set({ week: W2, order_ids: ['o9'], net_cents: 7000, outcome: 'payable', closed_at: 1 });
  HIDE = `driver_ledger/drvA/weeks/${W2}`;                                                          // the accrual's check sees it OPEN
  await S.accrueOrder(db, 'o10', await val('orders/o10'), await S.readConfig(db), HN('2026-11-02T00:10:30'));
  assert.deepStrictEqual((({ week, original_week, kind }) => ({ week, original_week, kind }))(await val('driver_ledger/drvA/events/o10')), { week: W3, original_week: W2, kind: 'late' });
  ok('a close racing an accrual cannot strand the event: re-checked after the write, it is re-homed as a late adjustment');

  // 10. carry-forward: a negative unpaid week offsets the next
  await rtdb.ref(`driver_ledger/drvC/weeks/${W1}`).set({ week: W1, net_cents: -7000, outcome: 'no_payment', order_ids: [], closed_at: 1 });
  await rtdb.ref(`driver_ledger_week_index/${W2}/drvC`).set(true);
  await S.closeDriverWeek(db, 'drvC', W2, mon);
  const sC = await val(`driver_ledger/drvC/weeks/${W2}`);
  assert.deepStrictEqual([sC.carry_in_cents, sC.net_cents, sC.outcome], [-7000, -7000, 'no_payment']);
  assert.strictEqual(await val(`driver_ledger_week_index/${W3}/drvC`), true, 'the carry is indexed into next week\'s close');
  ok('net ≤ 0 closes with no payment and the negative carries into the next week');

  // 11. «Marcar pagado»: full only, compare-and-set, idempotent retry, no bank field
  const pay = { uid: 'drvB', week: W1, reference: 'BAC-2210-4471', paid_on: '2026-10-26', op_key: 'op_aaaaaaaa', actor: 'adminX' };
  assert.strictEqual((await S.markPaid(db, { ...pay, amount_cents: 7000 }, mon)).reason, 'amount_must_equal_net', 'a partial payment is refused');
  assert.strictEqual((await S.markPaid(db, { ...pay, week: W3, amount_cents: 7000 }, mon)).reason, 'not_closed', 'an open week is refused');
  assert.strictEqual((await S.markPaid(db, { ...pay, uid: 'drvC', week: W2, amount_cents: 0 }, mon)).reason, 'nothing_to_pay', 'a no-payment week is refused');
  const p1 = await S.markPaid(db, { ...pay, amount_cents: 21000, account_number: '0011223344' }, mon + 5);
  assert.ok(p1.ok && !p1.idempotent);
  assert.deepStrictEqual(Object.keys((await val(`driver_ledger/drvB/weeks/${W1}`)).payment).sort(), ['amount_cents', 'at', 'by', 'op_key', 'paid_on', 'reference'], 'the payment records ONLY amount/date/reference (+ op key, actor, time) — no bank field');
  assert.ok((await S.markPaid(db, { ...pay, amount_cents: 21000 }, mon + 9)).idempotent, 'the same op_key again → the recorded payment (idempotent)');
  const conflict = await S.markPaid(db, { ...pay, op_key: 'op_bbbbbbbb', actor: 'adminY', amount_cents: 21000 }, mon + 10);
  assert.deepStrictEqual([conflict.ok, conflict.reason, conflict.by, conflict.at], [false, 'already_paid', 'adminX', mon + 5], 'a second admin is REFUSED with who/when');
  ok('«Marcar pagado»: exact net only; open / no-payment weeks refused; same op_key idempotent; a conflicting retry refused with who/when; no bank data stored');

  // 12. scope: every write is the ledger's own; cash-to-remit / cuadre untouched
  const foreign = [...new Set(WRITES.filter((p) => !LEDGER.test(p)))];
  assert.deepStrictEqual(foreign, [], `🔴 S8 wrote outside its ledger paths: ${foreign.join(', ')}`);
  assert.strictEqual(JSON.stringify([await val('driver_shifts'), await val('cash_settlements')]), cashBefore, 'cash-to-remit / cuadre data unchanged');
  assert.ok(!READS.some((r) => /^(driver_shifts|cash_|cuadre)/.test(r.p)), 'and never read');
  ok(`every write (${WRITES.length}) is under driver_ledger*; cash-to-remit / cuadre never read or written`);

  FINISHED = true;
  console.log(`\ndriver-ledger: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-ledger FAILED:', e && (e.stack || e)); process.exit(1); });
