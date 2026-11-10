'use strict';
// S8 — THE DRIVER PAYABLE LEDGER STORE, end to end on the RTDB emulator (PLAN-shared-order-form.FINAL §5 S8).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:driver-ledger
// r3 design: /orders is the source of truth; a week is closed by ONE create-if-absent transaction on
// driver_ledger_weeks/{week}; the open week is derived on read. Every store call goes through an INSTRUMENTED handle that
// records each read (with its query) and each write, so the suite proves what the ledger touches, not only what it
// computes. The codex r1 (6) and r2 (4) findings are each replayed below, labelled; under r3 they are GREEN or impossible.
require('./_emulator-required')('database');

const assert = require('assert');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });   // as test/add-product.emulator.test.js
const rtdb = admin.database();
const S = require('../driver-ledger/ledger-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('driver-ledger: FAILED — exited without completing'); process.exitCode = 1; } });

// ── the instrumented handle ──
const READS = [], WRITES = [];
let ON_READ = null;          // { p, fn }: after the NEXT read of p resolves, run fn before the caller sees it (an interleaving)
let CRASH_BEFORE = null;     // a path whose NEXT transaction throws BEFORE it is sent (a crash before the commit)
function wrap(r, p, chain) {
  return new Proxy(r, { get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    return (...a) => {
      if (k === 'transaction' && CRASH_BEFORE === p) { CRASH_BEFORE = null; return Promise.reject(new Error('injected crash')); }
      if (['set', 'update', 'remove', 'transaction', 'push'].includes(k)) WRITES.push(p);
      const out = v.apply(t, a);
      if (k === 'once') {
        READS.push({ p, chain });
        if (ON_READ && ON_READ.p === p) { const { fn } = ON_READ; ON_READ = null; return out.then(async (s) => { await fn(); return s; }); }
      }
      if (['orderByChild', 'orderByKey', 'startAt', 'endAt', 'limitToLast', 'limitToFirst', 'equalTo'].includes(k)) return wrap(out, p, [...chain, k]);
      return out;
    };
  } });
}
const db = { ref: (p) => wrap(rtdb.ref(p), p, []) };
const LEDGER = /^driver_ledger_weeks(\/|$)/;

async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  await rtdb.ref().remove();
}
const HN = (iso) => Date.parse(`${iso}-06:00`);
const START = HN('2026-10-19T00:00:00');           // Monday — the ledger's go-live
const W1 = 'W2026-10-19', W2 = 'W2026-10-26', W3 = 'W2026-11-02', W4 = 'W2026-11-09';
const MON2 = HN('2026-10-26T00:10:00'), MON3 = HN('2026-11-02T00:10:00'), MON4 = HN('2026-11-09T00:10:00'), MON5 = HN('2026-11-16T00:10:00'), MON7 = HN('2026-11-30T00:10:00');
const order = (o) => ({ order_type: 'delivery', status: 'delivered', restaurant_id: 'r1', total: 300, ...o });
const val = async (p) => (await rtdb.ref(p).get()).val();
const list = (x) => (Array.isArray(x) ? x : x ? Object.values(x) : []);
const json = (x) => JSON.parse(JSON.stringify(x));
const fresh = async () => { await wipe(); ON_READ = null; CRASH_BEFORE = null; await rtdb.ref('platform_config/driver_pay').set({ base_cents: 7000, ledger_start_at: START, policy_version: 1 }); };
// in how many closed weeks (deliveries or adjustments, any driver) an order was paid
async function timesPaid(oid) {
  let k = 0;
  for (const wk of Object.values((await val('driver_ledger_weeks')) || {})) {
    for (const d of Object.values(wk.drivers || {})) {
      if (list(d.deliveries).includes(oid)) k++;
      if (list(d.adjustments).some((a) => a.order_id === oid)) k++;
    }
  }
  return k;
}

(async () => {
  await wipe();
  // cash-to-remit / cuadre data that S8 must never touch
  await rtdb.ref('driver_shifts/drvA/cash').set({ collected: 1234, owed: 1234 });
  await rtdb.ref('cash_settlements/x').set({ amount: 500 });
  const cashBefore = JSON.stringify([await val('driver_shifts'), await val('cash_settlements')]);

  // 1. OFF without config
  assert.deepStrictEqual(await S.closeDue(db, MON2), { off: true });
  assert.deepStrictEqual(await S.previewWeek(db, null, MON2), { off: true });
  assert.deepStrictEqual(WRITES, [], 'no config → nothing written');
  ok('platform_config/driver_pay absent → the close and the read are OFF and write nothing');

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

  // 2. the open week is derived on read, with NO write; nothing closes before the week ends
  const w0 = WRITES.length;
  const pv = await S.previewWeek(db, null, HN('2026-10-22T18:00:00'));
  assert.ok(pv.open, JSON.stringify(pv));
  assert.deepStrictEqual([list(pv.week.drivers.drvA.deliveries), pv.week.drivers.drvA.net_cents, list(pv.week.unresolved)], [['o1', 'o2'], 14000, ['o4']]);
  assert.deepStrictEqual(await S.closeDue(db, HN('2026-10-22T18:00:00')), { closed: [] }, 'the open week is never closed');
  assert.deepStrictEqual(WRITES.slice(w0), [], 'the read and an early run write nothing');
  ok('the open week is derived from /orders on read (L 70 per delivered delivery from the protected stamp; no stamp → unresolved) and nothing is written');

  // 3. the close: ONE node for the whole week
  assert.deepStrictEqual(await S.closeDue(db, MON2), { closed: [W1] });
  const n1 = await val(`driver_ledger_weeks/${W1}`);
  assert.deepStrictEqual(Object.keys(n1).sort(), ['base_cents', 'closed_at', 'drivers', 'policy_version', 'unresolved', 'week']);
  assert.deepStrictEqual([list(n1.drivers.drvA.deliveries), n1.drivers.drvA.net_cents, n1.drivers.drvA.outcome], [['o1', 'o2'], 14000, 'payable']);
  assert.deepStrictEqual([list(n1.drivers.drvB.deliveries), n1.drivers.drvB.net_cents], [['o3'], 7000]);
  assert.deepStrictEqual(list(n1.unresolved), ['o4'], 'o4 (no protected stamp) listed, held out of every balance');
  assert.deepStrictEqual(WRITES.filter((p) => LEDGER.test(p)), [`driver_ledger_weeks/${W1}`], 'exactly ONE write: the week node');
  ok('the close writes the WHOLE week as one node (pickup / pre-start / undelivered excluded) — one write, nothing else');

  // 4. bounded reads only
  const orderReads = READS.filter((r) => r.p === 'orders' || r.p.startsWith('orders/'));
  assert.ok(orderReads.length > 0, 'non-vacuity: the ledger read orders');
  for (const r of orderReads) assert.deepStrictEqual([r.p, r.chain.join()], ['orders', 'orderByChild,startAt,endAt'], `🔴 an unbounded /orders read: ${JSON.stringify(r)}`);
  for (const r of READS.filter((x) => x.p === 'driver_ledger_weeks')) assert.ok(['orderByKey,limitToLast', 'orderByKey,endAt'].includes(r.chain.join()), `🔴 an unexpected weeks read: ${JSON.stringify(r)}`);
  ok(`/orders is read only through the bounded orderByChild(delivered_at).startAt().endAt() range (${orderReads.length} reads); weeks only the last one, or every closed week before the one computed (the dedupe memory)`);

  // 5. idempotent and immutable: re-running writes nothing; a later order edit never rewrites a closed week
  await rtdb.ref('orders/o1/delivered_by_driver_uid').set('drvB');
  const w5 = WRITES.length;
  assert.deepStrictEqual(await S.closeDue(db, MON2 + 60000), { closed: [] });
  assert.strictEqual(await S.closeWeek(db, W1, await S.readConfig(db), MON2 + 120000), false, 'a direct re-close is refused by its transaction');
  assert.deepStrictEqual(await val(`driver_ledger_weeks/${W1}`), n1, '🔴 a closed week is never rewritten');
  assert.deepStrictEqual(WRITES.slice(w5), [`driver_ledger_weeks/${W1}`], '…the refused re-close is the only write attempt');
  await rtdb.ref('orders/o1/delivered_by_driver_uid').set('drvA');
  ok('re-running closes nothing; a direct re-close of a closed week (after an order edit) loses its create-if-absent transaction');

  // 6. «Marcar pagado»: full only, compare-and-set, idempotent retry, no bank field
  const pay = { uid: 'drvA', week: W1, reference: 'BAC-2210-4471', paid_on: '2026-10-26', op_key: 'op_aaaaaaaa', actor: 'adminX' };
  assert.strictEqual((await S.markPaid(db, { ...pay, amount_cents: 7000 }, MON2)).reason, 'amount_must_equal_net', 'a partial payment is refused');
  assert.strictEqual((await S.markPaid(db, { ...pay, week: W2, amount_cents: 7000 }, MON2)).reason, 'not_closed', 'an open week is refused');
  assert.strictEqual((await S.markPaid(db, { ...pay, uid: 'drvNobody', amount_cents: 7000 }, MON2)).reason, 'not_closed', 'a driver absent from the week is refused');
  assert.strictEqual((await S.markPaid(db, { ...pay, uid: 'a/b', amount_cents: 7000 }, MON2)).reason, 'bad_request', 'a path-like uid is refused');
  const p1 = await S.markPaid(db, { ...pay, amount_cents: 14000, account_number: '0011223344' }, MON2 + 5);
  assert.ok(p1.ok && !p1.idempotent, JSON.stringify(p1));
  assert.deepStrictEqual(Object.keys((await val(`driver_ledger_weeks/${W1}/drivers/drvA`)).paid).sort(), ['amount_cents', 'at', 'by', 'op_key', 'paid_on', 'reference'], 'the payment records ONLY amount/date/reference (+ op key, actor, time) — no bank field');
  assert.ok((await S.markPaid(db, { ...pay, amount_cents: 14000 }, MON2 + 9)).idempotent, 'the same op_key again → the recorded payment (idempotent)');
  const conflict = await S.markPaid(db, { ...pay, op_key: 'op_bbbbbbbb', actor: 'adminY', amount_cents: 14000 }, MON2 + 10);
  assert.deepStrictEqual([conflict.ok, conflict.reason, conflict.by, conflict.at], [false, 'already_paid', 'adminX', MON2 + 5], 'a second admin is REFUSED with who/when');
  const after = await val(`driver_ledger_weeks/${W1}`);
  const unpaid = (x) => json({ ...x, drivers: { ...x.drivers, drvA: { ...x.drivers.drvA, paid: undefined } } });
  assert.deepStrictEqual(unpaid(after), unpaid(n1), 'paying touches only drvA.paid');
  ok('«Marcar pagado»: exact net only; open week / absent driver / bad uid refused; same op_key idempotent; a conflicting retry refused with who/when; only .paid changes; no bank data');

  // 7. scope: every write is the ledger's own; cash-to-remit / cuadre untouched
  const foreign = [...new Set(WRITES.filter((p) => !LEDGER.test(p)))];
  assert.deepStrictEqual(foreign, [], `🔴 S8 wrote outside driver_ledger_weeks: ${foreign.join(', ')}`);
  assert.strictEqual(JSON.stringify([await val('driver_shifts'), await val('cash_settlements')]), cashBefore, 'cash-to-remit / cuadre data unchanged');
  assert.ok(!READS.some((r) => /^(driver_shifts|cash_|cuadre)/.test(r.p)), 'and never read');
  ok(`every write (${WRITES.length}) is under driver_ledger_weeks; cash-to-remit / cuadre never read or written`);

  // 8. a crash before the commit writes NOTHING; the retry closes the week  [r2 #1 partial close · r1 #6 crash loses carry]
  await fresh();
  await rtdb.ref('orders/a1').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
  CRASH_BEFORE = `driver_ledger_weeks/${W1}`;
  const e = await S.closeDue(db, MON2).then(() => null, (x) => x);
  assert.ok(e && /injected crash/.test(e.message), `premise: the crash fired (${e && e.message})`);
  assert.strictEqual(await val('driver_ledger_weeks'), null, '🔴 a crash before the commit left a partial week');
  assert.deepStrictEqual(await S.closeDue(db, MON2 + 60000), { closed: [W1] });
  assert.strictEqual(await timesPaid('a1'), 1);
  ok('r2#1 / r1#6: a crash before the commit writes nothing (no partial close possible); the retry closes the whole week');

  // 9. two concurrent closes → ONE week  [r1 #2 close/accrual race · r2 #3 lease without fencing]
  await fresh();
  await rtdb.ref('orders/a1').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
  let second = null;
  ON_READ = { p: 'orders', fn: async () => {                                                        // A has read /orders; B runs whole
    await rtdb.ref('orders/aX').set(order({ delivered_at: HN('2026-10-25T23:00:00'), delivered_by_driver_uid: 'drvA' }));
    second = await S.closeDue(db, MON2 + 1);
  } };
  const first = await S.closeDue(db, MON2);
  assert.deepStrictEqual(second, { closed: [W1] }, 'B closed the week');
  assert.deepStrictEqual(first, { closed: [] }, '🔴 A (stale snapshot) must lose its transaction and write nothing');
  assert.deepStrictEqual(list((await val(`driver_ledger_weeks/${W1}`)).drivers.drvA.deliveries), ['a1', 'aX'], 'the week is B\'s, whole');
  await S.closeDue(db, MON3);
  assert.deepStrictEqual([await timesPaid('a1'), await timesPaid('aX')], [1, 1], 'each order paid exactly once');
  ok('r1#2 / r2#3: two overlapping closes produce ONE week — the stale one loses its transaction; every order is paid exactly once');

  // 10. a late sync is picked up by the NEXT close  [r1 #1 driver with no entry · r2 #2 claim-only crash: no claims exist]
  await fresh();
  await rtdb.ref('orders/a1').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
  await S.closeDue(db, MON2);
  await rtdb.ref('orders/oZ').set(order({ delivered_at: HN('2026-10-25T22:00:00'), delivered_by_driver_uid: 'drvZ' }));   // syncs after W1 closed
  const pv2 = await S.previewWeek(db, null, HN('2026-10-27T10:00:00'));
  assert.deepStrictEqual(list(pv2.week.drivers.drvZ.adjustments), [{ order_id: 'oZ', original_week: W1 }], 'the open-week read already shows it');
  await S.closeDue(db, MON3);
  const z = (await val(`driver_ledger_weeks/${W2}`)).drivers.drvZ;
  assert.deepStrictEqual([list(z.adjustments), z.net_cents, z.outcome], [[{ order_id: 'oZ', original_week: W1 }], 7000, 'payable']);
  await S.closeDue(db, MON4);
  assert.strictEqual(await timesPaid('oZ'), 1, 'paid once, never again');
  ok('r1#1 / r2#2: a delivery syncing after its week closed is paid as a LATE adjustment by the next close (even for a driver with no entry that week), once');

  // 11. a stamp change after the close → attribution_review, never a second payment  [r1 #3 · r2 #4]
  await fresh();
  await rtdb.ref('orders/oY').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
  await S.closeDue(db, MON2);
  await rtdb.ref('orders/oY/delivered_by_driver_uid').set('drvB');
  await S.closeDue(db, MON4);                                                                       // closes W2 and W3
  assert.strictEqual(await timesPaid('oY'), 1, '🔴 an attribution change paid twice');
  assert.deepStrictEqual(list((await val(`driver_ledger_weeks/${W2}`)).attribution_review), [{ order_id: 'oY', paid_to: 'drvA', paid_week: W1, stamp_now: 'drvB' }]);
  assert.strictEqual((await val(`driver_ledger_weeks/${W3}`)).attribution_review, undefined, 'listed once, not repeated in later weeks');
  ok('r1#3 / r2#4: a stamp changed after the close surfaces in the next week\'s attribution_review (once) and is never paid again');

  // 12. a late stamp on an unresolved order pays once, as an adjustment; the unresolved entry is not repeated  [r1 #5]
  await fresh();
  await rtdb.ref('orders/u1').set(order({ delivered_at: HN('2026-10-24T12:00:00') }));
  await S.closeDue(db, MON2);
  assert.deepStrictEqual(list((await val(`driver_ledger_weeks/${W1}`)).unresolved), ['u1']);
  await rtdb.ref('orders/u1/delivered_by_driver_uid').set('drvA');
  await S.closeDue(db, MON4);
  assert.deepStrictEqual(list((await val(`driver_ledger_weeks/${W2}`)).drivers.drvA.adjustments), [{ order_id: 'u1', original_week: W1 }]);
  assert.strictEqual(await timesPaid('u1'), 1);
  assert.strictEqual((await val(`driver_ledger_weeks/${W2}`)).unresolved, undefined, 'not repeated');
  ok('r1#5: an unresolved delivery whose stamp arrives later is paid once as an adjustment (no re-check machinery); its unresolved entry is not repeated');

  // 13. many orders at ONE instant and hundreds in a week: all paid, no pagination to stall  [r1 #4]
  await fresh();
  const bulk = {};
  for (let i = 0; i < 250; i++) bulk[`b${String(i).padStart(3, '0')}`] = order({ delivered_at: HN('2026-10-21T13:00:00') + (i < 120 ? 0 : i), delivered_by_driver_uid: 'drvA' });
  await rtdb.ref('orders').set(bulk);
  await S.closeDue(db, MON2);
  const b = (await val(`driver_ledger_weeks/${W1}`)).drivers.drvA;
  assert.deepStrictEqual([list(b.deliveries).length, b.net_cents], [250, 250 * 7000]);
  ok('r1#4: 250 deliveries (120 at one instant) are all paid by one bounded range read — no cursor or page cap exists to stall');

  // 14. carry chains across TWO missed weeks, closed oldest first in one run
  await fresh();
  // the only fixture: a negative previous week (net < 0 cannot be produced until tips/refunds exist, S2)
  await rtdb.ref(`driver_ledger_weeks/${W1}`).set({ week: W1, policy_version: 1, base_cents: 7000, closed_at: 1, drivers: { drvC: { base_cents: 0, adjustments_cents: 0, carry_in_cents: -14000, net_cents: -14000, outcome: 'no_payment' } } });
  await rtdb.ref('orders/c1').set(order({ delivered_at: HN('2026-11-04T12:00:00'), delivered_by_driver_uid: 'drvC' }));     // W3
  assert.deepStrictEqual(await S.closeDue(db, MON5), { closed: [W2, W3, W4] }, 'missed weeks close oldest first in one run');
  const c = async (w) => { const d = (await val(`driver_ledger_weeks/${w}`)).drivers.drvC; return [d.carry_in_cents, d.net_cents, d.outcome]; };
  assert.deepStrictEqual(await c(W2), [-14000, -14000, 'no_payment']);
  assert.deepStrictEqual(await c(W3), [-14000, -7000, 'no_payment']);
  assert.deepStrictEqual(await c(W4), [-7000, -7000, 'no_payment']);
  ok('carry: a negative balance chains across two missed weeks (closed oldest first) and is offset by later deliveries');

  // 15. the open-week read waits for the previous close; a closed week reads as stored
  assert.deepStrictEqual(await S.previewWeek(db, null, HN('2026-11-23T00:05:00')), { pending_close: true }, 'the week before is not closed yet → no misleading preview');
  assert.deepStrictEqual(await S.previewWeek(db, W3, MON5), { closed: true, week: await val(`driver_ledger_weeks/${W3}`) });
  ok('the read: a closed week as stored; the open week only once the previous one is closed');

  // 16–18. delivered_at is NOT immutable (dispatch / the driver app may rewrite it): a paid order whose timestamp MOVES —
  // later or earlier — is never paid again, however far it lands from the week that paid it  [codex r3 P1]
  const moveCell = async (label, deliveredIso, closeFirst, moveMs) => {
    await fresh();
    const at0 = HN(deliveredIso);
    await rtdb.ref('orders/oM').set(order({ delivered_at: at0, delivered_by_driver_uid: 'drvA' }));
    await S.closeDue(db, closeFirst);
    assert.strictEqual(await timesPaid('oM'), 1, `premise (${label}): paid once by the first close`);
    await rtdb.ref('orders/oM/delivered_at').set(at0 + moveMs);
    const r = await S.closeDue(db, MON7);
    assert.ok(r.closed.length >= 3, `premise (${label}): later weeks closed ${JSON.stringify(r)}`);
    assert.strictEqual(await timesPaid('oM'), 1, `🔴 ${label}: the moved order was paid twice`);
    const pv = await S.previewWeek(db, null, MON7 + 3600000);
    assert.ok(pv.open && !Object.values(pv.week.drivers).length, `${label}: «Pagos» does not show it payable either: ${JSON.stringify(pv)}`);
  };
  // codex's exact repro: delivered Sun 25 Oct 23:00 HN, closed + paid in W2026-10-19, corrected +2 h to Mon 26 Oct 01:00;
  // under r3 the W2026-11-09 close re-paid it (L 140)
  await moveCell('+2 h', '2026-10-25T23:00:00', MON2, 2 * 3600000);
  ok('codex r3 repro: an order paid in its week, then moved +2 h into the next week, is never paid again by any later close (through W2026-11-23) or shown payable');
  await moveCell('+10 d', '2026-10-25T23:00:00', MON2, 10 * 86400000);
  ok('a paid order moved +10 days is never paid again');
  await moveCell('−10 d', '2026-11-04T12:00:00', MON4, -10 * 86400000);
  ok('a paid order BACKDATED −10 days (into an earlier, already-closed week) is never paid again');

  FINISHED = true;
  console.log(`\ndriver-ledger: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-ledger FAILED:', e && (e.stack || e)); process.exit(1); });
