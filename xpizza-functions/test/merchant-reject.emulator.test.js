'use strict';
/**
 * H1a amendment A-R1 — merchantReject through the REAL cancelOrderCore (cancel-order-core.js) + the REAL voidOrRefund, with a
 * stub PixelPay client, against the RTDB emulator. Run: npm run test:merchant-reject
 *   1. cash → order cancelled, outcome cancelled, no notice; the tasks are cancelled by the core.
 *   2. a captured card → exactly one void, refunded, outcome cancelled.
 *   3. a failing void → refund_pending, outcome refund_pending, ONE keyed notice (+ its marker).
 *   4. ambiguous evidence (paid, no uuid) → outcome manual_review + the keyed notice; the order stays new, claim released.
 *   5. replay of the same op → no second core call (core calls counted), the same outcome.
 *   6. two concurrent rejects (different ops) → one intent, ONE core call.
 *   7. crash after the intent commit (core never ran) → the repair sweep raises exactly one stranded notice; a second run
 *      writes nothing.
 *   8. crash after the core finalized but before the outcome → the repair writes the outcome from persisted state, by
 *      'sweep', without a core call.
 *   9. crash after the core's claim → the repair raises claim_held once.
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');
const O = require('../merchant/merchant-orders');
const R = require('../merchant/merchant-reject');
const P = require('../merchant/merchant-reject-repair');

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const db = getDatabase();
const NOW = Date.now();
// Third synthetic brand ('tb_'), never a production literal.
const resolveBrand = async (_db, rid) => (rid.startsWith('tb_') ? 'tb' : 'unknown');
const dev = (uid = 'hh_a') => ({ uid, token: { handheld: true, rid: 'tb_norte' } });
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();

// The REAL core with a stub PixelPay client; every core invocation is counted.
function realCore(client) {
  const calls = { core: 0, void: 0 };
  const stub = { voidTransaction: async (...a) => { calls.void++; return client(...a); } };
  const cancelCore = async (args) => {
    calls.core++;
    return cancelOrderCore({ db, client: stub, voidOrRefund, alert: async () => {}, serverTimestamp: NOW }, args);
  };
  return { cancelCore, calls };
}
const voidOk = async () => ({ ok: true });
const voidFails = async () => { throw new Error('412 PreconditionalResponse'); };
let claimSeq = 0;
const deps = (cancelCore) => ({ db, resolveBrand, HttpsError, now: () => Date.now(), cancelCore, newClaimId: () => `claim_emu_${++claimSeq}` });
const reject = (cancelCore, oid, op, uid) => R.runReject(deps(cancelCore), dev(uid), { rid: 'tb_norte', oid, reason: 'saturada', gone_items: [], op_id: op }, O.runOrderActionDetailed);

const base = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', order_type: 'delivery',
  display_number: 12, total: 299, total_cents: 29900, created_at: NOW - 60000, ...over });
const card = (oid, aid, over = {}) => base(oid, { payment_method: 'online', payment_status: 'confirmed', active_attempt_id: aid, ...over });

(async () => {
  await db.ref().set({
    restaurants: { tb_norte: { order_surface: 'handheld', handhelds: { hh_a: { kind: 'handheld', revoked: false }, hh_b: { kind: 'handheld', revoked: false } } } },
    orders: {
      cash1: base('cash1', { payment_method: 'cash' }),
      card1: card('card1', 'att_card1'),
      fail1: card('fail1', 'att_fail1'),
      amb1: card('amb1', 'att_amb1'),
      race1: base('race1', { payment_method: 'cash' }),
    },
    payment_attempts: {
      att_card1: { order_id: 'card1', hosted_order_id: 'card1-att_card1', hosted_state: 'paid', payment_uuid: 'S-card1', capture_verified: true },
      att_fail1: { order_id: 'fail1', hosted_order_id: 'fail1-att_fail1', hosted_state: 'paid', payment_uuid: 'S-fail1', capture_verified: true },
      att_amb1: { order_id: 'amb1', hosted_order_id: 'amb1-att_amb1', hosted_state: 'paid' },
    },
    tasks: { cash1_pickup: { status: 'pending', order_id: 'cash1' }, cash1_delivery: { status: 'pending', order_id: 'cash1', assigned_driver_id: null } },
  });

  // 1. cash
  {
    const { cancelCore, calls } = realCore(voidOk);
    const r = await reject(cancelCore, 'cash1', 'op_cash0001');
    assert.strictEqual(r.state, 'cancelled', JSON.stringify(r));
    const o = await val('orders/cash1');
    assert.strictEqual(o.status, 'cancelled');
    assert.deepStrictEqual([o.reject_outcome.state, o.reject_outcome.op_id, o.reject_outcome.by], ['cancelled', 'op_cash0001', 'handler']);
    assert.strictEqual(o.handheld_answered.kind, 'rejected');
    assert.strictEqual(o.cancel_claim_id == null, true, 'claim cleared by the core');
    assert.deepStrictEqual([calls.core, calls.void], [1, 0]);
    assert.strictEqual(await val('tasks/cash1_pickup/status'), 'cancelled');
    assert.strictEqual(await val('dispatcher_alerts'), null);
    ok('cash reject → the real core cancels; outcome cancelled; tasks cancelled; no void; no notice');
  }

  // 2. captured card
  {
    const { cancelCore, calls } = realCore(voidOk);
    const r = await reject(cancelCore, 'card1', 'op_card0001');
    assert.strictEqual(r.state, 'cancelled');
    const o = await val('orders/card1');
    assert.deepStrictEqual([o.status, o.payment_status, o.reject_outcome.state], ['cancelled', 'refunded', 'cancelled']);
    assert.deepStrictEqual([calls.core, calls.void], [1, 1]);
    ok('captured card → exactly one void; refunded; outcome cancelled');
  }

  // 3. failing void
  {
    const { cancelCore, calls } = realCore(voidFails);
    const r = await reject(cancelCore, 'fail1', 'op_fail0001');
    assert.strictEqual(r.state, 'refund_pending');
    const o = await val('orders/fail1');
    assert.deepStrictEqual([o.status, o.payment_status, o.reject_outcome.state], ['cancelled', 'refund_pending', 'refund_pending']);
    const a = await val('dispatcher_alerts/handheld_reject_refund_pending_fail1');
    assert.strictEqual(a.type, 'payment_handheld_reject_refund_pending');
    assert.strictEqual(a.detail.orderId, 'fail1');
    assert.match(a.detail.action, /^Pedido #12 cancelado por la sucursal\./);
    assert.ok(await val('merchant_reject_notices/fail1/refund_pending'));
    const keyed = Object.keys((await val('dispatcher_alerts')) || {}).filter((k) => k.startsWith('handheld_reject_'));
    assert.deepStrictEqual(keyed, ['handheld_reject_refund_pending_fail1']);
    assert.strictEqual(calls.core, 1);
    ok('failing void → refund_pending; one keyed notice with the mockup copy + its marker');
  }

  // 4. ambiguous evidence → manual_review
  {
    const { cancelCore, calls } = realCore(voidOk);
    const r = await reject(cancelCore, 'amb1', 'op_amb00001');
    assert.strictEqual(r.state, 'manual_review', JSON.stringify(r));
    const o = await val('orders/amb1');
    assert.strictEqual(o.status, 'new');
    assert.deepStrictEqual([o.reject_outcome.state, o.reject_outcome.code], ['manual_review', 'manual_review']);
    assert.strictEqual(o.cancel_claim_id == null, true, 'the core released its claim');
    assert.ok(await val('dispatcher_alerts/handheld_reject_manual_review_amb1'));
    assert.deepStrictEqual([calls.core, calls.void], [1, 0]);

    // 5. replay of the same op → no core call
    const again = await reject(cancelCore, 'amb1', 'op_amb00001');
    assert.strictEqual(again.state, 'manual_review');
    assert.strictEqual(calls.core, 1, 'replay never re-runs the core');
    ok('ambiguous evidence → manual_review + keyed notice; order stays new; replay returns the outcome with NO core call');
  }

  // 6. concurrent rejects
  {
    const { cancelCore, calls } = realCore(voidOk);
    const [a, b] = await Promise.all([reject(cancelCore, 'race1', 'op_race0001', 'hh_a'), reject(cancelCore, 'race1', 'op_race0002', 'hh_b')]);
    const winners = [a, b].filter((x) => x.ok === true);
    assert.strictEqual(winners.length, 1, `one winner: ${JSON.stringify([a, b])}`);
    assert.strictEqual(calls.core, 1, 'one core call');
    assert.strictEqual((await val('orders/race1')).status, 'cancelled');
    ok('two concurrent rejects → one intent, one core call');
  }

  // 7–9. crashes → the repair pass, on a fresh snapshot (ages pushed past the 2-min floor)
  {
    const T = Date.now();
    const intent = (oid, op) => ({ type: 'reject', reason: 'saturada', note: null, gone_items: [], op_id: op, by: 'hh_a', at: T - 3 * 60000 });
    const answered = (op) => ({ kind: 'rejected', at: T - 3 * 60000, by: 'hh_a', op_id: op });
    await db.ref('orders').update({
      crash1: base('crash1', { payment_method: 'cash', reject_intent: intent('crash1', 'op_c1'), handheld_answered: answered('op_c1') }),
      claim1: base('claim1', { payment_method: 'cash', reject_intent: intent('claim1', 'op_c2'), handheld_answered: answered('op_c2'),
        cancel_claim_id: 'claim_dead', resolving_action: 'cancel', resolving_phase: 'claimed', resolving_claimed_at: T - 3 * 60000 }),
      fin1: base('fin1', { payment_method: 'cash', reject_intent: intent('fin1', 'op_c3'), handheld_answered: answered('op_c3') }),
    });
    // fin1: the REAL core finalizes, then the "crash" — no outcome written.
    const fin = await cancelOrderCore({ db, client: { voidTransaction: voidOk }, voidOrRefund, alert: async () => {}, serverTimestamp: NOW },
      { orderId: 'fin1', actor: 'handheld:hh_a', reason: 'x', now: Date.now(), claimId: 'claim_fin1' });
    assert.strictEqual(fin.status, 200);
    assert.strictEqual(await val('orders/fin1/reject_outcome'), null);

    const before = (await val('dispatcher_alerts')) || {};
    const s1 = await P.repairRejects({ db, clock: () => Date.now() }, await val('orders'), T);
    assert.strictEqual(s1.failed, 0, JSON.stringify(s1));
    assert.ok(await val('dispatcher_alerts/handheld_reject_stranded_crash1'));
    assert.match((await val('dispatcher_alerts/handheld_reject_claim_held_claim1')).detail.action, /se libera sola en unas horas/);
    assert.deepStrictEqual(await val('orders/fin1/reject_outcome'), { state: 'cancelled', at: T, op_id: 'op_c3', by: 'sweep' });
    assert.strictEqual(await val('orders/claim1/cancel_claim_id'), 'claim_dead', 'the repair never clears a claim');
    const after1 = JSON.stringify(await val('/'));
    const s2 = await P.repairRejects({ db, clock: () => Date.now() }, await val('orders'), T + 5 * 60000);
    assert.strictEqual(s2.selected, 0);
    assert.strictEqual(JSON.stringify(await val('/')), after1, 'a second run writes nothing');
    void before;
    ok('crashes: stranded (core never ran) + claim_held (claim left) noticed once; post-finalize outcome repaired by sweep; second run is a no-op');
  }

  console.log(`\nmerchant-reject: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant-reject FAILED:', e && e.stack || e); process.exit(1); });
