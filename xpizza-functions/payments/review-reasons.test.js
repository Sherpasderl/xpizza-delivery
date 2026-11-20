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
//   RR-KEEP-*         (Codex #224) the new reason is set ONLY when the order has none — a prior reason (e.g. the customer-facing
//                     refunded_paid_after_close) is KEPT, decided inside the same write; Codex's repro end to end on the webhook
//   RR-RACE           (Codex #225) the webhook's reason is ONE order transaction guarded on «still in manual_review AND no reason», so no
//                     interleaving touches another writer's reason: written before the update / between the update and the transaction ⇒
//                     kept; the order leaves review in between ⇒ no stray reason; a reason written after ⇒ that one stands
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
const { needsRefundNotifyRecovery } = require('../paid-after-close-notify');
const MR = require('../manual-resolve');
const { makeHonestDb: makeDb } = require('../_honest-rtdb-model');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const OID = 'RR1', AID = 'c0ffee00c0ffee66', NOW = 1_800_000_000_000, H = 3600000;
const quiet = async (f) => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; console.log = l; } };
globalThis.fetch = async (url) => {   // a void that PixelPay confirms (the REAL client + voidOrRefund run)
  if (!String(url).endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200 });
};
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
    const reasonPatches = writes.filter((w) => w.kind === 'update' && w.v && Object.keys(w.v).some((k) => /blocked_reason|payment_status/.test(k) && (w.v[k] === 'manual_review' || /blocked_reason/.test(k))));
    assert.deepStrictEqual([reasonOf(db), reasonPatches.length], [['manual_review', 'resolve_no_charge'], 0], '🔴 RR-NO-CHARGE: review is entered WITH the reason in one transaction (no separate patch sets either)');
    ok('RR-NO-CHARGE: the resolver\'s no-charge refund ⇒ manual_review + resolve_no_charge, in one transaction');
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
    assert.deepStrictEqual([reasonOf(db), entering.length, entering[0] && Object.keys(entering[0].v).filter((k) => k.endsWith('/blocked_reason')).length, writes.filter((w) => w.kind === 'tx').length], [['manual_review', 'paid_after_cancel_no_uuid'], 1, 0, 1],
      '🔴 RR-PAID-AFTER: the base multi-path update enters review (no reason key); ONE guarded order transaction adds the reason (Codex #225)');
    ok('RR-PAID-AFTER: a paid callback for a cancelled order with no payment id ⇒ manual_review (the base update) + paid_after_cancel_no_uuid (one guarded order transaction)');
  }
  {
    // RR-READERS: the customer's poll state (the one client-facing reader of blocked_reason) is unchanged by every new reason
    for (const [st, reason] of [['new', 'cancel_stale_recovered'], ['cancelled', 'resolve_no_charge'], ['cancelled', 'resolve_stale_recovered'], ['cancelled', 'paid_after_cancel_no_uuid']]) {
      const o = { status: st, payment_status: 'manual_review' };
      assert.strictEqual(paymentPollState({ ...o, blocked_reason: reason }), paymentPollState(o), `🔴 RR-READERS: ${reason} changes nothing the customer sees`);
    }
    ok('RR-READERS: the customer\'s poll state is identical with and without each new reason');
  }
  {
    // RR-KEEP (Codex #224): a prior reason is KEPT by every writer
    const keep = async (label, initial, run) => {
      const { db } = recorded(initial);
      await quiet(() => run(db));
      assert.deepStrictEqual(reasonOf(db), ['manual_review', initial.orders[OID].blocked_reason], `🔴 ${label}: the prior reason is kept (${db.getAt(`orders/${OID}/blocked_reason`)})`);
    };
    await keep('RR-KEEP-STALE-CANCEL', { orders: { [OID]: ORDER({ blocked_reason: 'refund_pending_paid_after_close', cancel_claim_id: 'CL1', resolving_action: 'cancel', resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, resolving_claimed_at: NOW - 7 * H }) } },
      (db) => recoverStaleCancel({ db, alert: async () => {} }, OID, db.getAt(`orders/${OID}`), NOW, 6 * H));
    await keep('RR-KEEP-NO-CHARGE', { orders: { [OID]: ORDER({ status: 'pending_payment', payment_status: 'manual_reconciliation', blocked_reason: 'refund_failed_paid_after_close' }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created' } } },
      (db) => resolveManualReconciliationCore({ db, client: realClient, alert: async () => {}, sanitizeText: (t) => String(t), serverTimestamp: 0, voidOrRefund }, { orderId: OID, action: 'refund', actor: 'disp@tb', note: '', now: NOW, claimId: 'RC1' }));
    await keep('RR-KEEP-STALE-RESOLVE', { orders: { [OID]: ORDER({ status: 'pending_payment', payment_status: 'resolving_refund', blocked_reason: 'manual_refund_required_paid_after_close', resolving_action: 'refund', resolving_claim_id: 'RC1', resolving_phase: MR.PHASE.SIDE_EFFECT_STARTED, resolving_claimed_at: NOW - 7 * H }) } },
      (db) => recoverStaleResolve({ db, alert: async () => {} }, OID, db.getAt(`orders/${OID}`), NOW, 6 * H));
    // Codex's repro, end to end through the REAL webhook: a refunded paid-after-close order, then a no-uuid paid callback, then a uuid one whose
    // void PixelPay confirms — the customer keeps «closed_refunded» throughout and the refund-notice recovery still finds the order
    const HOID = `${OID}-${AID}`; const cfg = resolvePixelPayConfig();
    const { db } = recorded({ orders: { [OID]: ORDER({ status: 'cancelled', payment_status: 'refunded', blocked_reason: 'refunded_paid_after_close', customer_phone: '50499990000', refunded_at: NOW - 2 * H }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID } } });
    const deps = { db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund };
    const cb = (uuid) => quiet(() => handleHostedCallback(deps, { order: HOID, status: 'paid', amount: 299, uuid, transaction_id: `T-${uuid || 'none'}`, payment_hash: paymentHash(HOID, cfg.app_key, cfg.secret) }, NOW));
    assert.strictEqual((await cb('')).outcome, 'cancelled_no_uuid_manual_review', 'RR-KEEP-PAID-AFTER premise: parked by the real webhook');
    assert.deepStrictEqual([reasonOf(db), paymentPollState(db.getAt(`orders/${OID}`))], [['manual_review', 'refunded_paid_after_close'], 'closed_refunded'], '🔴 RR-KEEP-PAID-AFTER: the customer-facing sentinel is kept; the customer still sees closed_refunded');
    await cb('PAY-2');
    assert.strictEqual(db.getAt(`orders/${OID}/payment_status`), 'refunded', 'RR-KEEP-PAID-AFTER premise: the second (uuid) callback was voided ⇒ refunded');
    assert.strictEqual(needsRefundNotifyRecovery(db.getAt(`orders/${OID}`), NOW + 3 * H, 60 * 60 * 1000), true, '🔴 RR-KEEP-PAID-AFTER: the refund-notice recovery still finds the order');
    ok('RR-KEEP: every writer keeps a prior reason (incl. Codex\'s webhook repro: closed_refunded kept, notice recovery intact)');
  }
  {
    // RR-RACE (Codex #225): the paid-after-close refund finishing CONCURRENTLY (its own write, materialize-guard.js:178's shape) around the webhook
    const HOID = `${OID}-${AID}`; const cfg = resolvePixelPayConfig();
    const REFUND_FINISH = { payment_status: 'refunded', status: 'cancelled', blocked_reason: 'refunded_paid_after_close', refunded_at: NOW - 2 * H };
    const run = async (label, when, inject) => {
      let fired = false; let db;
      db = makeDb({ orders: { [OID]: ORDER({ status: 'cancelled', payment_status: 'pending', customer_phone: '50499990000' }) }, payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID } } }, {
        beforeWrite: async (p) => { if (when === 'before-update' && !fired && p === '') { fired = true; await inject(db); } },
        beforeTx: async (p) => { if (when === 'before-tx' && !fired && p === `orders/${OID}`) { fired = true; await inject(db); } },
      });
      const r = await quiet(() => handleHostedCallback({ db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund },
        { order: HOID, status: 'paid', amount: 299, uuid: '', transaction_id: 'T1', payment_hash: paymentHash(HOID, cfg.app_key, cfg.secret) }, NOW));
      assert.ok(fired && r.outcome === 'cancelled_no_uuid_manual_review', `${label} premise: the other writer ran ${when} (${fired}, ${r.outcome})`);
      return db;
    };
    for (const when of ['before-update', 'before-tx']) {
      const db = await run(`RR-RACE ${when}`, when, (d) => d.ref(`orders/${OID}`).update({ blocked_reason: 'refunded_paid_after_close' }));
      assert.strictEqual(db.getAt(`orders/${OID}/blocked_reason`), 'refunded_paid_after_close', `🔴 RR-RACE: a reason written ${when} is KEPT (never overwritten)`);
      assert.strictEqual(paymentPollState(db.getAt(`orders/${OID}`)), 'closed_refunded', `🔴 RR-RACE: the customer still sees closed_refunded (${when})`);
    }
    // the order LEAVES review between the update and the transaction ⇒ no stray reason
    const left = await run('RR-RACE left-review', 'before-tx', (d) => d.ref(`orders/${OID}`).update({ payment_status: 'refunded' }));
    assert.deepStrictEqual([left.getAt(`orders/${OID}/payment_status`), left.getAt(`orders/${OID}/blocked_reason`)], ['refunded', null], '🔴 RR-RACE: an order that left review gets no reason');
    // a reason written AFTER ours stands (the other writer sets its state and reason together)
    const after = await run('RR-RACE reason-after', 'before-update', async () => {});
    await after.ref(`orders/${OID}`).update(REFUND_FINISH);
    assert.deepStrictEqual([after.getAt(`orders/${OID}/blocked_reason`), paymentPollState(after.getAt(`orders/${OID}`)), needsRefundNotifyRecovery(after.getAt(`orders/${OID}`), NOW + 3 * H, H)], ['refunded_paid_after_close', 'closed_refunded', true], '🔴 RR-RACE: a reason written after ours stands; poll + notice recovery as at base');
    ok('RR-RACE: no interleaving touches another writer\'s reason (before the update / before the transaction / left review / after)');
  }
  console.log(`review-reasons: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
