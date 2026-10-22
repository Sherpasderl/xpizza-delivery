'use strict';
// S8 — THE DRIVER PAYABLE LEDGER STORE, end to end on the RTDB emulator (PLAN-shared-order-form.FINAL §5 S8).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:driver-ledger
// Every store call goes through an INSTRUMENTED handle that records each read (with its query) and each write, so the
// suite proves what the ledger touches, not only what it computes: /orders is read ONLY through the bounded delivered_at
// query or one order at a time; every write lands under the ledger's own paths (never cash-to-remit / cuadre).
//
// Cells 13–18 replay codex r1's six findings (24254a26) through the REAL store, one cell each. With DL_RED=1 each also
// replays the same scenario against the r1 store (`git show 24254a26`) and asserts it is RED there — the regression proof.
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
let ON_READ = null;          // { p, fn }: after the NEXT read of p resolves, run fn before the caller sees it (an interleaving)
let CRASH_AFTER = null;      // a path whose NEXT transaction commits and then throws (a crash right after that write)
function wrap(r, p, chain) {
  return new Proxy(r, { get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    return (...a) => {
      if (['set', 'update', 'remove', 'transaction', 'push'].includes(k)) WRITES.push(p);
      const out = v.apply(t, a);
      if (k === 'once') {
        READS.push({ p, chain });
        if (ON_READ && ON_READ.p === p) { const { fn } = ON_READ; ON_READ = null; return out.then(async (s) => { await fn(); return s; }); }
      }
      if (k === 'transaction' && CRASH_AFTER === p) { CRASH_AFTER = null; return out.then(() => { throw new Error('injected crash'); }); }
      if (['orderByChild', 'orderByKey', 'startAt', 'startAfter', 'limitToFirst', 'equalTo'].includes(k)) return wrap(out, p, [...chain, k]);
      return out;
    };
  } });
}
const db = { ref: (p) => wrap(rtdb.ref(p), p, []) };
const LEDGER = /^(driver_ledger|driver_ledger_orders|driver_ledger_week_index|driver_ledger_unresolved|driver_ledger_meta)(\/|$)/;

async function wipe() {
  const url = rtdb.ref().toString();
  assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, `🔴 refusing to wipe: the RTDB handle resolves to ${url}`);
  await rtdb.ref().remove();
}
const HN = (iso) => Date.parse(`${iso}-06:00`);
const START = HN('2026-10-19T00:00:00');           // Monday — the ledger's go-live
const W0 = 'W2026-10-12', W1 = 'W2026-10-19', W2 = 'W2026-10-26', W3 = 'W2026-11-02';
const order = (o) => ({ order_type: 'delivery', status: 'delivered', restaurant_id: 'r1', total: 300, ...o });
const val = async (p) => (await rtdb.ref(p).get()).val();
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o && o[k]]));

// the r1 store (24254a26), loaded only for DL_RED=1: the same scenarios must fail there
const RED = process.env.DL_RED === '1';
let O = null;
if (RED) {
  const src = execFileSync('git', ['show', '24254a26:xpizza-functions/driver-ledger/ledger-store.js'], { cwd: __dirname, encoding: 'utf8' })
    .replace("require('./ledger-core')", `require(${JSON.stringify(path.join(__dirname, '../driver-ledger/ledger-core'))})`);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-r1-')), 'ledger-store-r1.js');
  fs.writeFileSync(f, src);
  O = require(f);
}
// one adapter per store: `run` = what production runs on a schedule; `sweep` = an accrual run racing it
const NEW = { name: 'r2', run: (now, o = {}) => S.runLedger(db, now, o.r2), sweep: (now, o = {}) => S.runLedger(db, now, o.r2) };
const OLD = O && { name: 'r1', run: async (now, o = {}) => { await O.repairSweep(db, now, o.r1); await O.closeWeeks(db, now); }, sweep: (now, o = {}) => O.repairSweep(db, now, o.r1) };
async function finding(label, scenario, expected) {
  const got = await scenario(NEW);
  assert.deepStrictEqual(got, expected, `🔴 ${label} — r2 store: ${JSON.stringify(got)}`);
  let red = '';
  if (RED) {
    const was = await scenario(OLD);
    assert.notDeepStrictEqual(was, expected, `premise: ${label} reproduces on the r1 store`);
    red = `\n      r2 GREEN ${JSON.stringify(got)}  |  r1 RED ${JSON.stringify(was)}`;
  }
  ok(`${label}${red}`);
}
const statementsWith = async (uids, oid) => {
  let k = 0;
  for (const u of uids) for (const st of Object.values((await val(`driver_ledger/${u}/weeks`)) || {})) if ((st.order_ids || []).includes(oid)) k++;
  return k;
};

(async () => {
  await wipe();
  // cash-to-remit / cuadre data that S8 must never touch
  await rtdb.ref('driver_shifts/drvA/cash').set({ collected: 1234, owed: 1234 });
  await rtdb.ref('cash_settlements/x').set({ amount: 500 });
  const cashBefore = JSON.stringify([await val('driver_shifts'), await val('cash_settlements')]);

  // 1. OFF without config
  assert.deepStrictEqual(await S.runLedger(db, HN('2026-10-21T20:00:00')), { off: true });
  assert.deepStrictEqual(WRITES, [], 'no config → nothing written');
  ok('platform_config/driver_pay absent → the run is OFF and writes nothing');

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
  const r1 = await S.runLedger(db, now1);
  assert.deepStrictEqual([r1.created, r1.unresolved], [3, 1], JSON.stringify(r1));
  assert.deepStrictEqual(Object.keys((await val('driver_ledger/drvA/events')) || {}).sort(), ['o1', 'o2']);
  assert.deepStrictEqual(Object.keys((await val('driver_ledger/drvB/events')) || {}), ['o3']);
  assert.deepStrictEqual(await val('driver_ledger/drvA/events/o1'), { order_id: 'o1', driver_uid: 'drvA', delivered_at: HN('2026-10-20T19:00:00'), base_cents: 7000, policy_version: 1, week: W1, kind: 'delivery' });
  assert.deepStrictEqual(await val('driver_ledger_orders/o1'), { driver_uid: 'drvA', week: W1, kind: 'delivery' }, 'the order claim fixes driver / week / kind once');
  assert.ok(await val('driver_ledger_unresolved/o4'), 'o4 (no protected stamp) is listed unresolved');
  assert.strictEqual(await val('driver_ledger/drvB/events/o4'), null, '…and held out of the balance (best-effort delivered_by_uid is never money)');
  assert.strictEqual(await val('driver_ledger_meta/lock'), null, 'the lease is released');
  ok('accrual: L 70 per delivered delivery from the protected stamp, claimed once per order; no stamp → unresolved + held out; pickup / pre-start / undelivered → nothing');

  // 3. bounded reads only
  const orderReads = READS.filter((r) => r.p === 'orders' || r.p.startsWith('orders/'));
  assert.ok(orderReads.length > 0, 'non-vacuity: the run read orders');
  for (const r of orderReads) assert.ok((r.p === 'orders' && r.chain.join() === 'orderByChild,startAt,limitToFirst') || /^orders\/[^/]+$/.test(r.p), `🔴 an unbounded /orders read: ${JSON.stringify(r)}`);
  const unresReads = READS.filter((r) => r.p === 'driver_ledger_unresolved');
  assert.ok(unresReads.length > 0 && unresReads.every((r) => r.chain.includes('limitToFirst')), `🔴 an unbounded unresolved read: ${JSON.stringify(unresReads)}`);
  ok(`/orders is read only through orderByChild(delivered_at).startAt().limitToFirst() or one order at a time (${orderReads.length} reads); the unresolved list only by bounded page`);

  // 4. idempotent under retry / crash
  await rtdb.ref(`driver_ledger_week_index/${W1}/drvA`).remove();                                 // a crash between index and event
  const r2 = await S.runLedger(db, now1 + 60000);
  assert.strictEqual(r2.created, 0, 'a second run creates nothing');
  assert.strictEqual(await val(`driver_ledger_week_index/${W1}/drvA`), true, 'the missing week index heals on the next (overlap) pass');
  assert.strictEqual(Object.keys((await val('driver_ledger/drvA/events')) || {}).length, 2, 'still exactly 2 events for drvA');
  ok('retry / crash: re-running accrues nothing twice and heals a missing week index');

  // 5. late / offline sync: an order whose delivered_at is BEHIND the forward cursor is still picked up (48 h overlap)
  const fwd = await val('driver_ledger_meta/fwd');
  await rtdb.ref('orders/o8').set(order({ delivered_at: fwd.at - 6 * 3600000, delivered_by_driver_uid: 'drvB' }));
  await S.runLedger(db, now1 + 120000);
  assert.ok(await val('driver_ledger/drvB/events/o8'), 'o8 (6 h behind the cursor) accrued');
  ok('a delivery that syncs late, behind the forward cursor, is accrued by the separate 48 h overlap pass');

  // 6. late stamp: (a) inside the overlap window the next pass resolves o4 in place; (b) OUTSIDE it (o12, older than
  //    cursor − 48 h, recorded unresolved by the real writer) only the unresolved RE-CHECK can resolve it.
  await rtdb.ref('orders/o4/delivered_by_driver_uid').set('drvB');
  await S.runLedger(db, now1 + 180000);
  assert.ok(await val('driver_ledger/drvB/events/o4'), 'o4 accrued to drvB');
  assert.strictEqual(await val('driver_ledger_unresolved/o4'), null, 'its unresolved entry is gone');
  const o12 = order({ delivered_at: HN('2026-10-19T12:00:00') });                                   // after go-live, before the window
  await rtdb.ref('orders/o12').set(o12);
  assert.strictEqual(await S.accrueOrder(db, 'o12', o12, await S.readConfig(db), now1, null), 'unresolved', 'premise: the real writer records o12 unresolved');
  assert.ok((await val('driver_ledger_meta/fwd')).at - 48 * 3600000 > o12.delivered_at, 'premise: o12 is OUTSIDE the overlap window');
  await rtdb.ref('orders/o12/delivered_by_driver_uid').set('drvA');
  const r3 = await S.runLedger(db, now1 + 240000);
  assert.strictEqual(r3.resolved, 1, 'the unresolved re-check (not the window) resolved it');
  assert.ok(await val('driver_ledger/drvA/events/o12'), 'o12 accrued to drvA');
  assert.strictEqual(await val('driver_ledger_unresolved/o12'), null, 'its unresolved entry is gone');
  ok('a stamp that arrives after the order was swept resolves it in place — by the overlap pass, or by the unresolved re-check outside the window');

  // 7. weekly close: immutable statements, in the same run as the accrual
  const mon = HN('2026-10-26T00:10:00');
  const rc = await S.runLedger(db, mon);
  assert.deepStrictEqual(rc.closed.sort(), [`${W1}/drvA`, `${W1}/drvB`]);
  assert.strictEqual(await val('driver_ledger_meta/closed_through'), W1);
  const sA = await val(`driver_ledger/drvA/weeks/${W1}`), sB = await val(`driver_ledger/drvB/weeks/${W1}`);
  assert.deepStrictEqual([sA.deliveries, sA.net_cents, sA.outcome], [3, 21000, 'payable']);   // o1, o2, o12
  assert.deepStrictEqual([sB.deliveries, sB.net_cents], [3, 21000]);                           // o3, o4, o8
  await rtdb.ref(`driver_ledger/drvA/events/o1/base_cents`).set(99999);                           // tamper after close
  await S.runLedger(db, mon + 1000); await S.closeDriverWeek(db, 'drvA', W1, mon + 2000);
  assert.deepStrictEqual(await val(`driver_ledger/drvA/weeks/${W1}`), sA, '🔴 a closed statement is never rewritten');
  await rtdb.ref(`driver_ledger/drvA/events/o1/base_cents`).set(7000);
  ok('the run closes finished Mon–Sun weeks after accruing; re-running (and a later event edit) never rewrites a statement');

  // 8. late accrual into a closed week → current-week adjustment referencing the original week
  await rtdb.ref('orders/o9').set(order({ delivered_at: HN('2026-10-25T21:00:00'), delivered_by_driver_uid: 'drvA' }));
  await S.runLedger(db, HN('2026-10-27T10:00:00'));
  assert.deepStrictEqual(pick(await val('driver_ledger/drvA/events/o9'), ['week', 'original_week', 'kind']), { week: W2, original_week: W1, kind: 'late' });
  ok('a delivery from a closed week (closed_through, global) posts as a current-week LATE adjustment referencing its original week');

  // 9. the lease: two overlapping invocations serialize; a stale lease is taken over; a live one is respected
  {
    const t = HN('2026-10-27T11:00:00');
    let second = null;
    ON_READ = { p: 'driver_ledger_meta', fn: async () => { second = await S.runLedger(db, t, { owner: 'run_B' }); } };   // B fires while A holds the lease
    const first = await S.runLedger(db, t, { owner: 'run_A' });
    assert.ok(second, 'premise: the second invocation ran inside the first');
    assert.deepStrictEqual(second, { locked: true }, '🔴 a second invocation must not run while the first holds the lease');
    assert.ok(!first.locked && Array.isArray(first.closed), 'the first ran to completion');
    assert.strictEqual(await val('driver_ledger_meta/lock'), null, 'and released the lease');
    await rtdb.ref('driver_ledger_meta/lock').set({ owner: 'run_live', expires_at: t + 60000 });
    const w0 = WRITES.length;
    assert.deepStrictEqual(await S.runLedger(db, t + 1000), { locked: true }, 'a live lease of another run → this run does nothing');
    assert.deepStrictEqual(WRITES.slice(w0), ['driver_ledger_meta/lock'], '…writing nothing but its refused lease attempt');
    await rtdb.ref('driver_ledger_meta/lock').set({ owner: 'run_dead', expires_at: t - 1 });
    assert.ok(!(await S.runLedger(db, t + 2000)).locked, 'an EXPIRED lease (a crashed run) is taken over');
    assert.strictEqual(await val('driver_ledger_meta/lock'), null);
  }
  ok('lease: two overlapping invocations serialize (the second is refused); a live lease is respected, an expired one taken over');

  // 10. carry-forward, DERIVED from the previous stored statement (no carry index to lose)
  await rtdb.ref(`driver_ledger/drvC/weeks/${W1}`).set({ week: W1, net_cents: -7000, outcome: 'no_payment', order_ids: [], closed_at: 1 });
  await rtdb.ref(`driver_ledger_week_index/${W1}/drvC`).set(true);
  await S.runLedger(db, HN('2026-11-02T00:10:00'));                                                 // closes W2
  const sC = await val(`driver_ledger/drvC/weeks/${W2}`);
  assert.deepStrictEqual([sC.carry_in_cents, sC.net_cents, sC.outcome], [-7000, -7000, 'no_payment']);
  assert.strictEqual(await val(`driver_ledger_week_index/${W2}/drvC`), true, 'the carried driver is indexed into the week it closed in');
  assert.strictEqual(await val('driver_ledger_meta/closed_through'), W2);
  ok('net ≤ 0 closes with no payment and the negative carries into the next week (derived at close from the stored statement)');

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

  // ── 13–18: codex r1's findings, each through the real store ──
  const fresh = async (start = START) => { await wipe(); ON_READ = null; CRASH_AFTER = null; await rtdb.ref('platform_config/driver_pay').set({ base_cents: 7000, ledger_start_at: start, policy_version: 1 }); };

  // 13. P1 #1 — a driver with NO statement in a closed week delivers late: the accrual must still reach a statement
  await finding('P1#1 a late delivery by a driver with no statement in the closed week lands in exactly one statement', async (R) => {
    await fresh();
    await rtdb.ref('orders/oA').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
    await R.run(HN('2026-10-26T00:10:00'));                                                         // closes W1 (drvA only)
    await rtdb.ref('orders/oZ').set(order({ delivered_at: HN('2026-10-25T22:00:00'), delivered_by_driver_uid: 'drvZ' }));   // syncs after the close
    await R.run(HN('2026-10-27T10:00:00'));
    await R.run(HN('2026-11-02T00:10:00'));                                                         // closes W2
    return { statements: await statementsWith(['drvZ'], 'oZ') };
  }, { statements: 1 });

  // 14. P1 #2 — an accrual racing the close: it must land in exactly one statement
  await finding('P1#2 an accrual racing the weekly close lands in exactly one statement (one writer under a lease)', async (R) => {
    await fresh();
    await rtdb.ref('orders/oA').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
    await R.run(HN('2026-10-24T12:00:00'));
    // while the Monday close has read drvA's events but not yet written the statement, oX syncs and a sweep runs
    ON_READ = { p: 'driver_ledger/drvA/events', fn: async () => {
      await rtdb.ref('orders/oX').set(order({ delivered_at: HN('2026-10-25T23:00:00'), delivered_by_driver_uid: 'drvA' }));
      await R.sweep(HN('2026-10-26T00:10:01'));
    } };
    await R.run(HN('2026-10-26T00:10:00'));
    await R.run(HN('2026-10-27T10:00:00'));
    await R.run(HN('2026-11-02T00:10:00'));
    return { statements: await statementsWith(['drvA'], 'oX') };
  }, { statements: 1 });

  // 15. P1 #3 — the stamp changes after the accrual: never pay twice; recorded once for manual handling
  await finding('P1#3 an attribution change after accrual never accrues twice (recorded once as attribution_changed)', async (R) => {
    await fresh();
    await rtdb.ref('orders/oY').set(order({ delivered_at: HN('2026-10-20T12:00:00'), delivered_by_driver_uid: 'drvA' }));
    await R.run(HN('2026-10-20T13:00:00'));
    await rtdb.ref('orders/oY/delivered_by_driver_uid').set('drvB');
    await R.run(HN('2026-10-20T14:00:00'));
    await R.run(HN('2026-10-20T15:00:00'));
    const events = [await val('driver_ledger/drvA/events/oY'), await val('driver_ledger/drvB/events/oY')].filter(Boolean).length;
    const u = await val('driver_ledger_unresolved/oY');
    return { events, unresolved: u && u.reason };
  }, { events: 1, unresolved: 'attribution_changed' });

  // 16. P2 #4 — pagination: the overlap must not eat the forward budget, and same-instant ties must not stall it
  await finding('P2#4 pagination advances past a full overlap window and past ties at one delivered_at', async (R) => {
    await fresh();
    const opts = { r1: { pageSize: 2, maxPages: 3 }, r2: { fwdPage: 2, fwdPages: 3, ovlPage: 2, ovlPages: 1 } };
    for (let h = 10; h <= 15; h++) await rtdb.ref(`orders/o${h}`).set(order({ delivered_at: HN(`2026-10-20T${h}:00:00`), delivered_by_driver_uid: 'drvA' }));
    await R.run(HN('2026-10-20T16:00:00'), opts);
    for (const k of ['t1', 't2', 't3']) await rtdb.ref(`orders/${k}`).set(order({ delivered_at: HN('2026-10-20T17:00:00'), delivered_by_driver_uid: 'drvA' }));
    await rtdb.ref('orders/t4').set(order({ delivered_at: HN('2026-10-20T17:30:00'), delivered_by_driver_uid: 'drvA' }));
    for (let i = 0; i < 3; i++) await R.run(HN('2026-10-20T18:00:00') + i * 60000, opts);
    return { events: Object.keys((await val('driver_ledger/drvA/events')) || {}).length };
  }, { events: 10 });

  // 17. P2 #5 — the unresolved re-check reads a bounded page and continues from a stored key
  await finding('P2#5 the unresolved re-check is paged (bounded reads) and still reaches every entry', async (R) => {
    await fresh();
    for (const k of ['u1', 'u2', 'u3']) await rtdb.ref(`orders/${k}`).set(order({ delivered_at: HN('2026-10-19T01:00:00') }));
    await rtdb.ref('orders/oF').set(order({ delivered_at: HN('2026-10-22T12:00:00'), delivered_by_driver_uid: 'drvA' }));   // pushes u* out of the window
    const opts = { r2: { unresPage: 2 } };
    await R.run(HN('2026-10-22T13:00:00'), opts);
    for (const k of ['u1', 'u2', 'u3']) await rtdb.ref(`orders/${k}/delivered_by_driver_uid`).set('drvA');
    const r0 = READS.length;
    await R.run(HN('2026-10-22T14:00:00'), opts);
    await R.run(HN('2026-10-22T15:00:00'), opts);
    const reads = READS.slice(r0).filter((r) => r.p === 'driver_ledger_unresolved');
    return { bounded: reads.length > 0 && reads.every((r) => r.chain.includes('limitToFirst')), events: Object.keys((await val('driver_ledger/drvA/events')) || {}).length };
  }, { bounded: true, events: 4 });

  // 18. P2 #6 — a crash right after a negative statement is written must not lose the carry
  await finding('P2#6 a crash right after a negative statement still carries it into the next week', async (R) => {
    await fresh(HN('2026-10-12T00:00:00'));
    await rtdb.ref(`driver_ledger/drvC/weeks/${W0}`).set({ week: W0, net_cents: -7000, outcome: 'no_payment', order_ids: [], closed_at: 1 });
    await rtdb.ref(`driver_ledger_week_index/${W0}/drvC`).set(true);
    await rtdb.ref(`driver_ledger_week_index/${W1}/drvC`).set(true);                                 // W0's close indexed the carry
    await rtdb.ref('driver_ledger_meta').set({ closed_through: W0, last_closed_week: W0 });
    CRASH_AFTER = `driver_ledger/drvC/weeks/${W1}`;
    const e = await R.run(HN('2026-10-26T00:10:00')).then(() => null, (x) => x);
    assert.ok(e && /injected crash/.test(e.message), `premise: the crash fired (${e && e.message})`);
    await R.run(HN('2026-10-26T00:11:00'));                                                         // the retry
    await R.run(HN('2026-11-02T00:10:00'));                                                         // closes W2
    const s = await val(`driver_ledger/drvC/weeks/${W2}`);
    return { carry_in_cents: s && s.carry_in_cents };
  }, { carry_in_cents: -7000 });

  FINISHED = true;
  console.log(`\ndriver-ledger: OK (${n})${RED ? ' — with r1 RED replay' : ''}`);
  process.exit(0);
})().catch((e) => { console.error('driver-ledger FAILED:', e && (e.stack || e)); process.exit(1); });
