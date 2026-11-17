'use strict';
// LEDGER S5 (PLAN-5f-ledger-shadow-s1-r3 §2; build note D4c-grill/ledger-s5/LEDGER.md) — the nightly rebuild over the honest RTDB model:
// the touched set (5 sources, L = 21 d, value-order trap), each projection = S3's projectOrder of the same sources (S3 is the oracle),
// the open set, ZERO writes on an unchanged re-run (inputs_hash), only a changed order replaced, every query on a declared index, the
// 400-s cap + the 03:30 safety restart / no-op, and the once-a-day alarm (counts only). The emulator suite repeats this end to end on
// sources from the real writers. Run: node ledger/rebuild.test.js
const assert = require('assert');
const path = require('path');
const { makeHonestDb } = require('../_honest-rtdb-model');
const LA = require('./alloc-snapshot');
const PJ = require('./projector');
const RB = require('./rebuild');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

const DAY = 86400000; const HR = 3600000;
const NOW = Date.parse('2026-11-20T09:00:00Z');            // 03:00 HN
const OLD = NOW - 40 * DAY; const NEW = NOW - 2 * DAY;
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return Object.keys(o).length ? o : null; };
const APP = { body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } };
const allocOf = (at, rec) => stored(LA.snapshotOf({ created_at: at, restaurant_id: 'x_pizza', ...rec }, LA.modeOf(APP)));
const CASH = { payment_method: 'cash', order_type: 'delivery', total_cents: 20000, subtotal_cents: 17000, tax_cents: 0, delivery_cents: 3000, tip_cents: 0 };
const CARD = { payment_method: 'online', order_type: 'delivery', total_cents: 29900, subtotal_cents: 25000, tax_cents: 0, delivery_cents: 5000, promo_discount_cents: 1000, delivery_discount_funder: 'sherpa', tip_cents: 900 };
const RATES = { commission: { _default: { k1: { bp: 1000, effective_from: Date.parse('2026-01-02T00:00:00Z') } } } };
const order = (id, at, x = {}) => ({ order_id: id, restaurant_id: 'x_pizza', created_at: at, status: 'delivered', delivered_at: at + 3600000, ...x });
const paid = (id, at, x = {}) => ({ order_id: id, hosted_state: 'paid', paid_amount_cents: 29900, paid_at: at + 60000, ledger: allocOf(at, CARD), ...x });

function seed() {
  return {
    orders: {
      C_NEW: order('C_NEW', NEW, { payment_method: 'cash' }),                                                   // created in the window
      C_OLD_DONE: order('C_OLD_DONE', OLD, { payment_method: 'cash' }),                                         // final, untouched ⇒ skipped
      C_OLD_LATE: order('C_OLD_LATE', OLD, { payment_method: 'cash', status: 'cancelled', delivered_at: null, cancelled_at: NEW }),   // a late event
      H_NEW: order('H_NEW', NEW, { payment_method: 'online', active_attempt_id: 'aH' }),
      H_OLD_REFUND: order('H_OLD_REFUND', OLD, { payment_method: 'online', active_attempt_id: 'aR' }),          // refunded today (PA window)
      U_OLD_OPEN: order('U_OLD_OPEN', OLD, { payment_method: 'online', active_attempt_id: 'aU' }),              // in the open set
      X_OLD_REVIEW: order('X_OLD_REVIEW', OLD, { payment_method: 'online', active_attempt_id: 'aX', extra_payment_review: true }),
      S_STRING: order('S_STRING', 'not-a-time', { payment_method: 'cash', delivered_at: 'x' }),                  // value-order trap
    },
    ledger_alloc: { C_NEW: allocOf(NEW, CASH), C_OLD_DONE: allocOf(OLD, CASH), C_OLD_LATE: allocOf(OLD, CASH), S_STRING: allocOf(OLD, CASH) },
    payment_attempts: {
      aH: paid('H_NEW', NEW),
      aR: paid('H_OLD_REFUND', OLD, { status: 'refunded', refunded_at: NEW }),
      aU: paid('U_OLD_OPEN', OLD, { status: 'capture_unverified' }),
      aX: paid('X_OLD_REVIEW', OLD),
    },
    ledger: { open: { U_OLD_OPEN: true, C_OLD_LATE: true } },   // C_OLD_LATE is final now ⇒ it leaves the open set
    ledger_settings: RATES,
  };
}
// the projection S3 gives for the same sources (the oracle), as stored
async function oracle(db, id) {
  const src = await RB.readSources(db, id);
  const r = PJ.projectOrder(src, { rateBp: 1000 });
  return stored({ status: r.status, reasons: r.reasons, journals: r.journals });
}
const proj = (db, id) => { const v = db.getAt(`ledger/orders/${id}`); return v && stored({ status: v.status ?? null, reasons: v.reasons ?? null, journals: v.journals ?? null }); };
function counting(init, extra = {}) {
  const writes = [];
  const db = makeHonestDb(init, { now: () => NOW, beforeWrite: (p, v) => { writes.push([p, v]); }, ...extra });
  return { db, writes, ledgerWrites: () => writes.filter(([p, v]) => p === '' && Object.keys(v).some((k) => k.startsWith('ledger/orders/'))) };
}
const clockAt = (t) => () => t;

(async () => {
  await cell('RB-WINDOWS: EACH window alone pulls in an old order — orders by created_at / delivered_at / cancelled_at / refunded_at / fulfilled_offline_at, attempts by paid_at / refunded_at / voided_at / failed_at / uncertain_at / flagged_at — and a time just outside 21 days does not', async () => {
    for (const c of RB.ORDER_TIMES) {
      const at = c === 'created_at' ? NEW : OLD;
      const db = makeHonestDb({ orders: { W: { order_id: 'W', created_at: at, [c]: NEW }, OUT: { order_id: 'OUT', created_at: OLD, [c]: NOW - RB.WINDOW_MS - 1 } } });
      assert.deepStrictEqual([...(await RB.touchedSet(db, NOW))], ['W'], `🔴 RB-WINDOWS: orders by ${c}`);
    }
    for (const c of RB.ATTEMPT_TIMES) {
      const db = makeHonestDb({ orders: { W: { order_id: 'W', created_at: OLD } }, payment_attempts: { a: { order_id: 'W', [c]: NEW }, b: { order_id: 'OUT', [c]: NOW - RB.WINDOW_MS - 1 } } });
      assert.deepStrictEqual([...(await RB.touchedSet(db, NOW))], ['W'], `🔴 RB-WINDOWS: attempts by ${c}`);
    }
    assert.deepStrictEqual([RB.ORDER_TIMES.length, RB.ATTEMPT_TIMES.length, RB.WINDOW_MS], [5, 6, 21 * DAY], '🔴 RB-WINDOWS: the plan\'s 5 + 6 windows over 21 days');
  });

  await cell('RB-TOUCHED: the touched set = created / delivered / cancelled / refunded / offline in 21 d + attempts paid / refunded / voided / failed / uncertain / flagged in 21 d + the open set + extra_payment_review; an old final order is skipped; a non-numeric time never enters by the window', async () => {
    const { db } = counting(seed());
    const ids = await RB.touchedSet(db, NOW);
    assert.deepStrictEqual([...ids].sort(), ['C_NEW', 'C_OLD_LATE', 'H_NEW', 'H_OLD_REFUND', 'U_OLD_OPEN', 'X_OLD_REVIEW'], `🔴 RB-TOUCHED: ${[...ids].sort()}`);
  });

  await cell('RB-SNAPSHOT: the money snapshot is ledger_alloc (cash), else the SDK record\'s ledger, else the ACTIVE attempt\'s, else the one distinct attempt snapshot; two different attempt snapshots and no active one ⇒ none (quarantined, never guessed)', async () => {
    const a1 = allocOf(NEW, CARD); const a2 = allocOf(NEW, { ...CARD, total_cents: 1 });
    const base = { orders: { O: order('O', NEW, { payment_method: 'online' }) } };
    const pick = async (x) => (await RB.readSources(makeHonestDb({ ...base, ...x }), 'O')).alloc;
    assert.deepStrictEqual(await pick({ payment_attempts: { p: { order_id: 'O', ledger: a1 }, q: { order_id: 'O', ledger: a1 } } }), a1, 'one distinct snapshot');
    assert.deepStrictEqual(await pick({ orders: { O: order('O', NEW, { active_attempt_id: 'q' }) }, payment_attempts: { p: { order_id: 'O', ledger: a1 }, q: { order_id: 'O', ledger: a2 } } }), a2, '🔴 RB-SNAPSHOT: the active attempt');
    assert.strictEqual(await pick({ payment_attempts: { p: { order_id: 'O', ledger: a1 }, q: { order_id: 'O', ledger: a2 } } }), null, '🔴 RB-SNAPSHOT: ambiguous ⇒ none');
    assert.deepStrictEqual(await pick({ orders: { O: order('O', NEW, { payment_flow: 'sdk_auth_v1' }) }, payment_sdk: { O: { phase: 'open', ledger: a2 } }, payment_attempts: { p: { order_id: 'O', ledger: a1 } } }), a2, '🔴 RB-SNAPSHOT: the SDK record');
    assert.deepStrictEqual(await pick({ ledger_alloc: { O: a1 }, payment_attempts: { p: { order_id: 'O', ledger: a2 } } }), a1, '🔴 RB-SNAPSHOT: ledger_alloc first');
  });

  await cell('RB-ORACLE: one run writes, for every touched order, EXACTLY projectOrder of its sources (S3 is the oracle) + the open set (every non-final order in, final out) + a finished run record with counts only', async () => {
    const { db } = counting(seed());
    const r = await RB.runNightly({ db, clock: clockAt(NOW) }, { slot: 'run' });
    for (const id of ['C_NEW', 'C_OLD_LATE', 'H_NEW', 'H_OLD_REFUND', 'U_OLD_OPEN', 'X_OLD_REVIEW']) {
      assert.deepStrictEqual(proj(db, id), await oracle(db, id), `🔴 RB-ORACLE: ${id}`);
      assert.ok(/^[0-9a-f]{64}$/.test(db.getAt(`ledger/orders/${id}/inputs_hash`)), `inputs_hash ${id}`);
    }
    assert.strictEqual(db.getAt('ledger/orders/C_OLD_DONE'), null, 'an untouched order is not projected');
    assert.strictEqual(db.getAt('ledger/orders/U_OLD_OPEN/status'), 'unresolved');
    assert.deepStrictEqual(db.getAt('ledger/open'), { U_OLD_OPEN: true }, `🔴 RB-ORACLE: the open set (${JSON.stringify(db.getAt('ledger/open'))})`);
    const run = db.getAt('ledger/run/2026-11-20');
    assert.ok(run && run.finished_at === NOW && run.attempt === 1 && !run.stopped, `run record ${JSON.stringify(run)}`);
    assert.deepStrictEqual(run.counts, { touched: 6, written: 6, unchanged: 0, final: 5, open: 0, quarantined: 0, unresolved: 1 }, `counts ${JSON.stringify(run.counts)}`);
    assert.strictEqual(r.outcome, 'finished');
  });

  await cell('RB-NOOP: a re-run over unchanged sources writes NOTHING to ledger/orders (inputs_hash); a new refund on ONE order replaces only that order', async () => {
    const c = counting(seed());
    await RB.runNightly({ db: c.db, clock: clockAt(NOW) }, { slot: 'run' });
    c.db.setAt('ledger/run/2026-11-20', null);
    const before = c.ledgerWrites().length;
    await RB.runNightly({ db: c.db, clock: clockAt(NOW) }, { slot: 'run' });
    assert.strictEqual(c.ledgerWrites().length, before, '🔴 RB-NOOP: an unchanged re-run wrote');
    assert.deepStrictEqual([c.db.getAt('ledger/run/2026-11-20/counts/written'), c.db.getAt('ledger/run/2026-11-20/counts/unchanged')], [0, 6], 'the run record says so');
    c.db.setAt('payment_attempts/aH/status', 'refunded'); c.db.setAt('payment_attempts/aH/refunded_at', NOW - 1000);
    c.db.setAt('ledger/run/2026-11-20', null);
    const b2 = c.ledgerWrites().length;
    await RB.runNightly({ db: c.db, clock: clockAt(NOW) }, { slot: 'run' });
    const changed = c.ledgerWrites().slice(b2).flatMap(([, v]) => Object.keys(v).filter((k) => k.startsWith('ledger/orders/')));
    assert.deepStrictEqual(changed, ['ledger/orders/H_NEW'], `🔴 RB-NOOP: only the refunded order (${changed})`);
    assert.deepStrictEqual(proj(c.db, 'H_NEW'), await oracle(c.db, 'H_NEW'));
  });

  await cell('RB-INDEX: every child query the job runs is on a DECLARED index (xpizza-reference/database.rules.json .indexOn)', async () => {
    const { db } = counting(seed());
    await RB.runNightly({ db, clock: clockAt(NOW) }, { slot: 'run' });
    const rules = require(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json')).rules;
    const seen = new Set(db.queries.map((q) => `${q.path}#${q.child}`));
    assert.ok(seen.size >= 13, `queries ${[...seen]}`);
    for (const k of seen) { const [p, c] = k.split('#'); assert.ok(((rules[p] && rules[p]['.indexOn']) || []).includes(c), `🔴 RB-INDEX: ${p} by ${c} has no .indexOn`); }
  });

  await cell('RB-CAP: past 400 s the run stops (stopped: time_cap, not finished); the 03:30 safety slot RESTARTS FROM SCRATCH (attempt 2) and finishes; after a finished run the safety slot is a no-op that reads nothing', async () => {
    const { db } = counting(seed());
    let t = NOW; const slow = () => { const v = t; t += 150000; return v; };   // each clock read = 150 s later
    const r1 = await RB.runNightly({ db, clock: slow }, { slot: 'run' });
    assert.strictEqual(r1.outcome, 'time_cap');
    const rec = db.getAt('ledger/run/2026-11-20');
    assert.ok(rec.stopped === 'time_cap' && !rec.finished_at, `🔴 RB-CAP: ${JSON.stringify(rec)}`);
    const r2 = await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
    assert.strictEqual(r2.outcome, 'finished', '🔴 RB-CAP: the safety slot restarts');
    assert.strictEqual(db.getAt('ledger/run/2026-11-20/attempt'), 2);
    for (const id of ['C_NEW', 'H_NEW', 'U_OLD_OPEN']) assert.deepStrictEqual(proj(db, id), await oracle(db, id), `after the restart ${id}`);
    const q0 = db.queries.length;
    const r3 = await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
    assert.ok(r3.outcome === 'noop' && db.queries.length === q0, '🔴 RB-CAP: the safety slot after a finished run is a no-op');
  });

  await cell('RB-ALARM: ONE create-once dispatcher_alerts/ledger_run_<date> (type contabilidad_sombra, counts and reason codes only) when the safety slot ends unfinished, or when unresolved went up vs yesterday — never twice a day; a 03:00 failure alone is retried, not alarmed; an error stores its code, never its message', async () => {
    const boom = Object.assign(new Error('secret customer +504 9999'), { code: 'EBOOM' });
    let fail = true;
    const { db } = counting(seed(), { beforeRead: (p) => { if (fail && p === 'orders') throw boom; } });
    const r1 = await RB.runNightly({ db, clock: clockAt(NOW) }, { slot: 'run' });
    assert.strictEqual(r1.outcome, 'error');
    assert.strictEqual(db.getAt('ledger/run/2026-11-20/stopped'), 'EBOOM');
    assert.ok(!JSON.stringify(db.root.ledger.run).includes('9999'), 'no message stored');
    assert.strictEqual(db.getAt('dispatcher_alerts'), null, '🔴 RB-ALARM: a 03:00 failure is retried at 03:30, not alarmed');
    await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
    const al = db.getAt('dispatcher_alerts/ledger_run_2026-11-20');
    assert.ok(al && al.type === 'contabilidad_sombra' && al.reasons.includes('unfinished'), `🔴 RB-ALARM: unfinished after the safety slot (${JSON.stringify(al)})`);
    assert.ok(!JSON.stringify(al).includes('9999') && !JSON.stringify(al).includes('secret'), 'counts / codes only');
    fail = false;
    db.setAt('ledger/run/2026-11-20', null);
    db.setAt('ledger/run/2026-11-19', { finished_at: NOW - DAY, attempt: 1, counts: { touched: 1, written: 1, unchanged: 0, final: 1, open: 0, quarantined: 0, unresolved: 0 } });   // ⇒ this run alarms unresolved_up too
    await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
    assert.deepStrictEqual(Object.keys(db.getAt('dispatcher_alerts')), ['ledger_run_2026-11-20'], '🔴 RB-ALARM: never a second alert the same day');
    assert.deepStrictEqual(db.getAt('dispatcher_alerts/ledger_run_2026-11-20/reasons'), ['unfinished'], '🔴 RB-ALARM: the first alert of the day is never overwritten (create-once)');
    assert.strictEqual(RB.errCode(Object.assign(new Error('x'), { code: 'call +504 9999' })), 'error', '🔴 RB-ALARM: an error code that is not a bare code is stored as «error»');
    const { db: d2 } = counting({ ...seed(), ledger: { open: { U_OLD_OPEN: true }, run: { '2026-11-19': { finished_at: NOW - DAY, attempt: 1, counts: { touched: 3, written: 3, unchanged: 0, final: 3, open: 0, quarantined: 0, unresolved: 0 } } } } });
    await RB.runNightly({ db: d2, clock: clockAt(NOW) }, { slot: 'run' });
    const up = d2.getAt('dispatcher_alerts/ledger_run_2026-11-20');
    assert.ok(up && up.reasons.includes('unresolved_up') && up.counts.unresolved === 1, `🔴 RB-ALARM: unresolved went up (${JSON.stringify(up)})`);
    const { db: d3 } = counting({ ...seed(), ledger: { open: { U_OLD_OPEN: true }, run: { '2026-11-19': { finished_at: NOW - DAY, attempt: 1, counts: { touched: 3, written: 3, unchanged: 0, final: 2, open: 0, quarantined: 0, unresolved: 1 } } } } });
    await RB.runNightly({ db: d3, clock: clockAt(NOW) }, { slot: 'run' });
    assert.strictEqual(d3.getAt('dispatcher_alerts'), null, '🔴 RB-ALARM: unresolved unchanged vs yesterday ⇒ no alert');
  });
  await cell('RB-QUARANTINE-STAYS: a quarantined order stays in discovery (Codex #116 #1) — the REAL coordinator: an SDK order placed, decreased (rule 4), delivered ⇒ sdk_adjusted; 22 days later completeObligation changes no windowed field, and the next run still re-projects it', async () => {
    const { makeAdapter } = require('../payments/sdk/psp-adapter'); const { makeFakePsp } = require('../payments/sdk/fake-adapter'); const CO = require('../payments/sdk/coordinator');
    const OID = 'tb_sdk_1'; let t = NOW - 2 * DAY;
    const sdkOrder = { restaurant_id: 'x_pizza', payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery', hub_lat: 14.1, hub_lng: -87.2, items: [{ name: 'tb_item', qty: 1, unit: 100 }], items_text: '1x tb_item', lat: 14.08, lng: -87.19, address_detected: 'tb calle 1', address_details: 'tb casa azul', customer_name: 'tb Cliente', customer_phone: '+50499990000', restaurant_name: 'tb R', restaurant_phone: '+50400000000', total: 100, total_cents: 10000, created_at: t };
    const db = makeHonestDb({ orders: { [OID]: sdkOrder }, ledger_settings: RATES }, { now: () => t });
    const goLive = (dp, id) => require('../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates: require('../materialize').buildMaterializeUpdates, restaurant: { lat: 14.1, lng: -87.2, name: 'tb R', phone: '+50400000000' } }, { orderId: id, attemptId: null, now: t, trackingToken: 'TT-tb', sdkGoLive: true });
    const deps = { db, psp: makeAdapter(makeFakePsp({}, {}).impl), clock: () => t, voidEligible: () => false, releaseResources: async () => {}, goLive };
    await CO.placeOriginal(deps, { attempt_id: 'att_fixed_c00008', orderId: OID, token: 'T-tb-token', amount_cents: 10000 });
    await db.ref(`orders/${OID}/status`).set('preparing');
    await CO.requestDecrease(deps, { orderId: OID, new_total_cents: 8000, revision: { items: [{ name: 'tb_item', qty: 1, unit: 80 }], total_cents: 8000, delivery_cents: 0 } });
    await db.ref(`orders/${OID}/status`).set('delivered'); await CO.settleTerminal(deps, { orderId: OID });
    await RB.runNightly({ db, clock: () => t }, { slot: 'run' });
    assert.deepStrictEqual([db.getAt(`ledger/orders/${OID}/status`), db.getAt(`ledger/orders/${OID}/reasons`)], ['quarantined', ['sdk_adjusted']], 'premise: the real coordinator made it sdk_adjusted');
    assert.strictEqual(db.getAt(`ledger/open/${OID}`), true, '🔴 RB-QUARANTINE-STAYS: a quarantined order stays in the open set');
    t += 22 * DAY;
    await CO.completeObligation(deps, { orderId: OID, obligationId: 'refund_1', state: 'verified', bank_ref: 'BANK-1' });
    const o = db.getAt(`orders/${OID}`);
    for (const c of RB.ORDER_TIMES) assert.ok(!(o[c] >= t - RB.WINDOW_MS), `premise: no windowed order field is recent (${c})`);
    assert.strictEqual(db.getAt('payment_attempts'), null, 'premise: no attempt rows (an SDK order)');
    await RB.runNightly({ db, clock: () => t }, { slot: 'run' });
    assert.strictEqual(db.getAt(`ledger/orders/${OID}/computed_at`), t, '🔴 RB-QUARANTINE-STAYS: the later change is re-projected');
    assert.deepStrictEqual(proj(db, OID), await oracle(db, OID));
  });

  await cell('RB-ALERT-BEFORE-MARK: the alert is decided and delivered BEFORE the completion marker (Codex #116 #2) — a failed read of yesterday\'s run or a failed alert transaction leaves the run unfinished, and the 03:30 slot delivers it', async () => {
    const Y = { finished_at: NOW - DAY, attempt: 1, counts: { touched: 1, written: 1, unchanged: 0, final: 1, open: 0, quarantined: 0, unresolved: 0 } };
    for (const [label, hook] of [['yesterday read', 'beforeRead'], ['alert transaction', 'beforeTx']]) {
      let armed = true;
      const target = hook === 'beforeRead' ? 'ledger/run/2026-11-19' : 'dispatcher_alerts/ledger_run_2026-11-20';
      const db = makeHonestDb({ ...seed(), ledger: { open: { U_OLD_OPEN: true }, run: { '2026-11-19': Y } } }, { now: () => NOW, [hook]: (p) => { if (armed && p === target) { armed = false; throw Object.assign(new Error('transient'), { code: 'ETRANSIENT' }); } } });
      const r1 = await RB.runNightly({ db, clock: clockAt(NOW) }, { slot: 'run' });
      assert.ok(r1.outcome !== 'finished' && !db.getAt('ledger/run/2026-11-20/finished_at'), `🔴 RB-ALERT-BEFORE-MARK (${label}): not marked finished while the alert is undelivered (${JSON.stringify(db.getAt('ledger/run/2026-11-20'))})`);
      const r2 = await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
      assert.strictEqual(r2.outcome, 'finished', `🔴 RB-ALERT-BEFORE-MARK (${label}): the safety slot finishes`);
      assert.deepStrictEqual(db.getAt('dispatcher_alerts/ledger_run_2026-11-20/reasons'), ['unresolved_up'], `🔴 RB-ALERT-BEFORE-MARK (${label}): the alert is delivered`);
    }
  });

  await cell('RB-LIFECYCLE: the whole lifecycle is protected (Codex #116 #3) — a failing run-record read or write never throws out of the job; in the safety slot the create-once «unfinished» alarm is still attempted, independently of the record', async () => {
    for (const hook of ['beforeRead', 'beforeWrite']) {
      const db = makeHonestDb(seed(), { now: () => NOW, [hook]: (p) => { if (p === 'ledger/run/2026-11-20') throw Object.assign(new Error('down'), { code: 'EDOWN' }); } });
      const r = await RB.runNightly({ db, clock: clockAt(NOW) }, { slot: 'run' });
      assert.ok(r.outcome !== 'finished' && db.getAt('dispatcher_alerts') === null, `🔴 RB-LIFECYCLE (${hook}): the 03:00 slot neither throws nor alarms (${JSON.stringify(r)})`);
      const r2 = await RB.runNightly({ db, clock: clockAt(NOW + 1800000) }, { slot: 'safety' });
      assert.ok(r2.outcome !== 'finished', `${hook}: still unfinished`);
      assert.deepStrictEqual(db.getAt('dispatcher_alerts/ledger_run_2026-11-20/reasons'), ['unfinished'], `🔴 RB-LIFECYCLE (${hook}): the safety slot alarms although the record could not be ${hook === 'beforeRead' ? 'read' : 'written'}`);
    }
  });

  await cell('RB-STALE-HOLD: a quarantined / unresolved order whose inputs are unchanged for MORE than 60 days leaves the open set and is marked stale_hold (Codex #116 r2 (b)); at 30 days it stays; a later window event re-projects it and it rejoins', async () => {
    const t0 = NOW;
    const db = makeHonestDb({ orders: { Q: order('Q', t0, { payment_method: 'cash', status: 'preparing', delivered_at: null }) }, ledger_settings: RATES }, { now: () => t0 });   // no ledger_alloc ⇒ quarantined no_snapshot
    await RB.runNightly({ db, clock: clockAt(t0) }, { slot: 'run' });
    assert.deepStrictEqual([db.getAt('ledger/orders/Q/status'), db.getAt('ledger/open/Q')], ['quarantined', true], 'premise: quarantined, in the open set');
    await RB.runNightly({ db, clock: clockAt(t0 + 30 * DAY) }, { slot: 'run' });
    assert.deepStrictEqual([db.getAt('ledger/open/Q'), db.getAt('ledger/orders/Q/stale_hold')], [true, null], '🔴 RB-STALE-HOLD: at 30 days it stays');
    await RB.runNightly({ db, clock: clockAt(t0 + 61 * DAY) }, { slot: 'run' });
    assert.deepStrictEqual([db.getAt('ledger/open/Q'), db.getAt('ledger/orders/Q/stale_hold'), db.getAt('ledger/orders/Q/status')], [null, true, 'quarantined'], '🔴 RB-STALE-HOLD: after 60 unchanged days it leaves the open set, marked stale_hold');
    const t3 = t0 + 70 * DAY;
    db.setAt('orders/Q/status', 'delivered'); db.setAt('orders/Q/delivered_at', t3 - HR);   // a window event
    await RB.runNightly({ db, clock: clockAt(t3) }, { slot: 'run' });
    assert.deepStrictEqual([db.getAt('ledger/open/Q'), db.getAt('ledger/orders/Q/stale_hold'), db.getAt('ledger/orders/Q/computed_at')], [true, null, t3], '🔴 RB-STALE-HOLD: a window event re-projects it (stale_hold cleared, back in the open set)');
  });

  await cell('RB-SLOT: the scheduled function picks the slot by the Honduras minute — 03:00 / 03:01 ⇒ run, 03:30 ⇒ safety', async () => {
    const { slotOf } = require('./functions');
    assert.deepStrictEqual([slotOf(NOW), slotOf(NOW + 60000), slotOf(NOW + 1800000)], ['run', 'run', 'safety'], '🔴 RB-SLOT');
  });
  console.log(`\nledger-rebuild: OK (${n})`);
})().catch((e) => { console.error('ledger-rebuild FAILED:', e && e.message); process.exit(1); });
