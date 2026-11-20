'use strict';
// «Marcar como revisado» follow-up (advisor 11-19, the owner's «no guessing in Central»): EVERY writer that moves an order into payment_status
// 'manual_review' now records WHY, as ONE literal blocked_reason in the SAME write that enters review — so Central names all seven reasons
// exactly. The four that recorded none:
//   RR-STALE-CANCEL   recoverStaleCancel (a cancel that crashed after starting its void) ⇒ 'cancel_stale_recovered', in its ONE CAS
//   RR-NO-CHARGE      the resolver's «Reembolsar» finds no charge (resolve-manual) ⇒ 'resolve_no_charge', in its ONE update
//   RR-STALE-RESOLVE  recoverStaleResolve (a resolve that crashed after its side effect) ⇒ 'resolve_stale_recovered', in its ONE CAS
//   RR-PAID-AFTER     the webhook: a paid callback for a cancelled order with no payment id ⇒ 'paid_after_cancel_no_uuid', in its ONE
//                     multi-path update
//   RR-READERS        no reader keys on the reason's ABSENCE: the customer's poll state is identical with and without each new reason
// Through the REAL writers on the honest RTDB model; each records exactly ONE order write. Run: node payments/review-reasons.test.js
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const { recoverStaleCancel } = require('../cancel-order-core');
const { resolveManualReconciliationCore, recoverStaleResolve } = require('../resolve-manual');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { voidOrRefund } = require('../pixelpay-cancel');
const realClient = require('../pixelpay-client');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');
const { resolvePixelPayConfig } = require('../pixelpay-config');
const { paymentAlert } = require('../lib/payment-alert');
const { paymentPollState } = require('../payment-poll-state');
const MR = require('../manual-resolve');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const OID = 'RR1', AID = 'c0ffee00c0ffee66', NOW = 1_800_000_000_000, H = 3600000;
const quiet = async (f) => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.log = l; } };
globalThis.fetch = async (url) => { throw new Error(`unexpected fetch ${url}`); };
const ORDER = (o = {}) => ({ order_id: OID, order_type: 'pickup', status: 'new', payment_status: 'confirmed', payment_method: 'online', total: 299, total_cents: 29900,
  customer_name: 'T', items_text: 'x', restaurant_id: 'x_pizza', active_attempt_id: AID, created_at: NOW - 10 * H, ...o });
// a db that records every ORDER write (transactions and update patches touching orders/RR1) — the reason must ride the write that enters review
const recorded = (initial) => {
  const writes = [];
  const db = makeDb(initial, {
    beforeTx: async (p) => { if (p === `orders/${OID}`) writes.push({ kind: 'tx' }); },
    beforeWrite: async (p, v) => { if (p === `orders/${OID}` || (p === '' && v && Object.keys(v).some((k) => k.startsWith(`orders/${OID}/`)))) writes.push({ kind: 'update', v }); },
  });
  return { db, writes };
};
const reasonOf = (db) => [db.getAt(`orders/${OID}/payment_status`), db.getAt(`orders/${OID}/blocked_reason`)];

(async () => {
  {
    const { db, writes } = recorded({ orders: { [OID]: ORDER({ cancel_claim_id: 'CL1', resolving_action: 'cancel', resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, resolving_claimed_at: NOW - 7 * H }) } });
    const r = await quiet(() => recoverStaleCancel({ db, alert: async () => {} }, OID, db.getAt(`orders/${OID}`), NOW, 6 * H));
    assert.ok(r && r.recovered !== false, 'RR-STALE-CANCEL premise: the real recovery acted');
    assert.deepStrictEqual([reasonOf(db), writes.length], [['manual_review', 'cancel_stale_recovered'], 1], `🔴 RR-STALE-CANCEL: one CAS enters review WITH its reason (${JSON.stringify(writes)})`);
    ok('RR-STALE-CANCEL: recoverStaleCancel ⇒ manual_review + cancel_stale_recovered, in its one CAS');
  }
  {
    const { db, writes } = recorded({ orders: { [OID]: ORDER({ status: 'pending_payment', payment_status: 'manual_reconciliation' }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created' } } });
    const r = await quiet(() => resolveManualReconciliationCore({ db, client: realClient, alert: async () => {}, sanitizeText: (t) => String(t), serverTimestamp: 0, voidOrRefund }, { orderId: OID, action: 'refund', actor: 'disp@tb', note: '', now: NOW, claimId: 'RC1' }));
    assert.strictEqual(r.body.outcome, 'manual_review', `RR-NO-CHARGE premise: the real resolver found no charge (${JSON.stringify(r.body)})`);
    const entering = writes.filter((w) => w.kind === 'update' && w.v && w.v.payment_status === 'manual_review');
    assert.deepStrictEqual([reasonOf(db), entering.length, entering[0] && entering[0].v.blocked_reason], [['manual_review', 'resolve_no_charge'], 1, 'resolve_no_charge'], '🔴 RR-NO-CHARGE: the ONE update that enters review carries the reason');
    ok('RR-NO-CHARGE: the resolver\'s no-charge refund ⇒ manual_review + resolve_no_charge, in the same update');
  }
  {
    const { db, writes } = recorded({ orders: { [OID]: ORDER({ status: 'pending_payment', payment_status: 'resolving_refund', resolving_action: 'refund', resolving_claim_id: 'RC1', resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, resolving_claimed_at: NOW - 7 * H }) } });
    const r = await quiet(() => recoverStaleResolve({ db, alert: async () => {} }, OID, db.getAt(`orders/${OID}`), NOW, 6 * H));
    assert.ok(r && r.recovered, 'RR-STALE-RESOLVE premise: the real recovery acted');
    assert.deepStrictEqual([reasonOf(db), db.getAt(`orders/${OID}/status`), writes.length], [['manual_review', 'resolve_stale_recovered'], 'cancelled', 1], '🔴 RR-STALE-RESOLVE: one CAS enters review WITH its reason');
    ok('RR-STALE-RESOLVE: recoverStaleResolve ⇒ manual_review + resolve_stale_recovered, in its one CAS');
  }
  {
    const HOID = `${OID}-${AID}`; const cfg = resolvePixelPayConfig();
    const { db, writes } = recorded({ orders: { [OID]: ORDER({ status: 'cancelled', payment_status: 'pending' }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID } } });
    const r = await quiet(() => handleHostedCallback({ db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund },
      { order: HOID, status: 'paid', amount: 299, uuid: '', transaction_id: 'T1', payment_hash: paymentHash(HOID, cfg.app_key, cfg.secret) }, NOW));
    assert.strictEqual(r.outcome, 'cancelled_no_uuid_manual_review', `RR-PAID-AFTER premise: the real webhook parked it (${r.outcome})`);
    const entering = writes.filter((w) => w.kind === 'update' && w.v && w.v[`orders/${OID}/payment_status`] === 'manual_review');
    assert.deepStrictEqual([reasonOf(db), entering.length, entering[0] && entering[0].v[`orders/${OID}/blocked_reason`]], [['manual_review', 'paid_after_cancel_no_uuid'], 1, 'paid_after_cancel_no_uuid'], '🔴 RR-PAID-AFTER: the ONE multi-path update that enters review carries the reason');
    ok('RR-PAID-AFTER: a paid callback for a cancelled order with no payment id ⇒ manual_review + paid_after_cancel_no_uuid, in the same update');
  }
  {
    // RR-READERS: the customer's poll state (the one client-facing reader of blocked_reason) is unchanged by every new reason
    for (const [st, reason] of [['new', 'cancel_stale_recovered'], ['cancelled', 'resolve_no_charge'], ['cancelled', 'resolve_stale_recovered'], ['cancelled', 'paid_after_cancel_no_uuid']]) {
      const o = { status: st, payment_status: 'manual_review' };
      assert.strictEqual(paymentPollState({ ...o, blocked_reason: reason }), paymentPollState(o), `🔴 RR-READERS: ${reason} changes nothing the customer sees`);
    }
    ok('RR-READERS: the customer\'s poll state is identical with and without each new reason');
  }
  console.log(`review-reasons: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
