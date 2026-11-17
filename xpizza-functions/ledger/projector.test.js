'use strict';
// LEDGER S3 (PLAN-5f-ledger-shadow-s1-r3 §4, + the Codex #110 r2 date condition) — the PURE projector: one order's durable sources ⇒
// its status + balanced journals. Sources come from the REAL writers wherever one exists: the allocation snapshot from ledger/alloc-snapshot
// (on the real record builder), the hosted attempt from the REAL handleHostedCallback (paid; cancel ⇒ voidPaid) and the REAL legacy
// confirmOnlinePayment, on the honest RTDB model. Run: node ledger/projector.test.js
const assert = require('assert');
const { makeHonestDb } = require('../_honest-rtdb-model');
const LA = require('./alloc-snapshot');
const PJ = require('./projector');
const { handleHostedCallback } = require('../pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('../materialize');
const { paymentHash } = require('../pixelpay');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

const RATE = 1000;   // 10 % (owner: 1,000 bp on the food the customer paid, ISV included)
const stored = (v) => { if (v === null || typeof v !== 'object') return v; const o = {}; for (const [k, x] of Object.entries(v)) { const y = stored(x); if (y !== null && !(typeof y === 'object' && !Object.keys(y).length)) o[k] = y; } return o; };
const sum = (lines, side) => lines.reduce((s, l) => s + (l[side] || 0), 0);
const balanced = (out) => { for (const [id, j] of Object.entries(out.journals)) assert.strictEqual(sum(j.lines, 'dr'), sum(j.lines, 'cr'), `🔴 PR-ZEROSUM: ${id} (${j.family}) balances`); };
const byFamily = (out, f) => Object.values(out.journals).filter((j) => j.family === f);
const amt = (j, account, side) => j.lines.filter((l) => l.account === account).reduce((s, l) => s + (l[side] || 0), 0);
const ORDER_AT = 1763300000000;

// the snapshot as the REAL S1 writer stores it (null leaves dropped), from a record shaped by the real order fields
const allocOf = (rec, mode = { body: { entry_mode: 'app' }, clientHdr: { app: 'capp', deployment: 'orders-app' } }) => stored(LA.snapshotOf({ created_at: ORDER_AT - 5, restaurant_id: 'x_pizza', ...rec }, LA.modeOf(mode)));

// ── real hosted attempts (the webhook) ──
const A = 'a1b2c3d4e5f6a7b8'; const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
async function hosted({ cancel = false, voided = true, total = 29900 } = {}) {
  const db = makeHonestDb({ orders: { O1: { order_id: 'O1', order_type: 'delivery', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', total: total / 100, total_cents: total, customer_name: 'T', items_text: 'M', active_attempt_id: A, created_at: ORDER_AT, lat: 15.51, lng: -88.03, address_detected: 'x', address_details: 'y' } },
    payment_attempts: { [A]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${A}`, hosted_checkout_url: 'https://pay/x', ...(cancel ? { cancel_pending: true } : {}) } } }, { now: () => ORDER_AT + 60000 });
  await handleHostedCallback({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided }) },
    { order: `O1-${A}`, ref: 'R', status: 'paid', amount: total / 100, uuid: 'P-1', transaction_id: 'T', payment_hash: paymentHash(`O1-${A}`, KEY, SECRET) }, ORDER_AT + 60000);
  return { order: db.getAt('orders/O1'), attempts: db.getAt('payment_attempts') };
}
// food 25000 + envío 5000 − Sherpa promo 1000 (net 4000) + tip 900 = 29900
const CARD_REC = { payment_method: 'online', order_type: 'delivery', total_cents: 29900, subtotal_cents: 25000, tax_cents: 0, delivery_cents: 5000, promo_discount_cents: 1000, delivery_discount_funder: 'sherpa', tip_cents: 900 };

(async () => {
  await cell('PR-CARD-PAID: a verified hosted payment ⇒ ONE collection (Dr PR / Cr RP food, delivery_revenue net envío, tip_liability) + the Sherpa envío promo contra + ONE commission accrual with its ISV', async () => {
    const h = await hosted();
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: RATE });
    balanced(out);
    const [c] = byFamily(out, 'collection');
    assert.deepStrictEqual([amt(c, 'processor_receivable', 'dr'), amt(c, 'restaurant_payable', 'cr'), amt(c, 'delivery_revenue', 'cr'), amt(c, 'tip_liability', 'cr')], [29900, 25000, 4000, 900], '🔴 PR-CARD-PAID: the collection');
    const [p] = byFamily(out, 'envio_promo');
    assert.deepStrictEqual([amt(p, 'delivery_promo_expense', 'dr'), amt(p, 'delivery_revenue', 'cr')], [1000, 1000], '🔴 PR-CARD-PAID: the Sherpa-funded envío promo');
    const [k] = byFamily(out, 'commission');
    assert.deepStrictEqual([amt(k, 'restaurant_payable', 'dr'), amt(k, 'commission_revenue', 'cr'), amt(k, 'isv_payable', 'cr')], [2875, 2500, 375], '🔴 PR-CARD-PAID: 10 % of the food paid + 15 % ISV on it');
    assert.strictEqual(byFamily(out, 'collection').length + byFamily(out, 'commission').length, 2);
  });

  await cell('PR-COMMISSION: 1,000 bp on the food the customer PAID (ISV included — never subtotal_cents), round half up; ISV 15 % on the commission, round half up (owner Q2: L 230 → L 23)', async () => {
    assert.deepStrictEqual(PJ.commissionOf(23000, RATE), { commission: 2300, isv: 345 });
    assert.deepStrictEqual(PJ.commissionOf(12345, RATE), { commission: 1235, isv: 185 }, 'half up: 1234.5 → 1235; 185.25 → 185');
    assert.deepStrictEqual(PJ.commissionOf(5, RATE), { commission: 1, isv: 0 }, '0.5 → 1; 0.15 → 0');
    const h = await hosted({ total: 29900 });
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf({ ...CARD_REC, subtotal_cents: 21739, tax_cents: 3261 }), attempts: h.attempts }, { rateBp: RATE });
    assert.strictEqual(amt(byFamily(out, 'commission')[0], 'commission_revenue', 'cr'), 2500, '🔴 PR-COMMISSION: the base is total − net envío − tip (the ISV-inclusive food), not the ex-ISV subtotal');
  });

  await cell('PR-CARD-VOIDED: a payment on a cancelled order (the REAL voidPaid) ⇒ the collection, ONE reversal of it, and the commission reversed with its ISV — the restaurant nets zero', async () => {
    const h = await hosted({ cancel: true });
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: RATE });
    balanced(out);
    assert.deepStrictEqual([byFamily(out, 'collection').length, byFamily(out, 'reversal').length, byFamily(out, 'commission').length, byFamily(out, 'commission_reversal').length], [1, 1, 1, 1], '🔴 PR-CARD-VOIDED: one of each');
    const rp = Object.values(out.journals).reduce((s, j) => s + amt(j, 'restaurant_payable', 'cr') - amt(j, 'restaurant_payable', 'dr'), 0);
    assert.strictEqual(rp, 0, '🔴 PR-CARD-VOIDED: restaurant payable nets 0');
    assert.strictEqual(out.status, 'final');
  });

  await cell('PR-ONE-REVERSAL (Codex #108 r2 #3): voidOrRefund\'s status refunded AND the webhook\'s hosted_state voided observe ONE reversal — one identity, never two', async () => {
    const h = await hosted({ cancel: true });
    const att = { ...h.attempts[A], status: 'refunded', refunded_at: ORDER_AT + 61000 };   // the voidOrRefund write beside the webhook's
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: { [A]: att } }, { rateBp: RATE });
    assert.strictEqual(byFamily(out, 'reversal').length, 1, '🔴 PR-ONE-REVERSAL');
    assert.strictEqual(byFamily(out, 'reversal')[0].id, PJ.idOf('reversal', PJ.idOf('collection', A)));
  });

  await cell('PR-EXTRA (Codex #108 r2 #4): an extra receipt on an attempt ⇒ Dr PR / Cr customer_refund_suspense at the provider amount — no commission, no restaurant credit', async () => {
    const h = await hosted();
    const att = { ...h.attempts[A], extra_payments: { k1: { uuid: 'P-2', amount_cents: 29900, at: ORDER_AT + 70000 } } };
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: { [A]: att } }, { rateBp: RATE });
    balanced(out);
    const [x] = byFamily(out, 'extra_receipt');
    assert.deepStrictEqual([amt(x, 'processor_receivable', 'dr'), amt(x, 'customer_refund_suspense', 'cr'), x.lines.length], [29900, 29900, 2], '🔴 PR-EXTRA');
    assert.strictEqual(x.id, PJ.idOf('extra', `${A}+k1`));
    assert.strictEqual(byFamily(out, 'commission').length, 1, 'still ONE commission (the sale)');
  });

  await cell('PR-CASH: a cash order — commission accrual ONLY at fulfilment (delivered / completed), no collection posted (no receipt evidence), coverage reason cash_not_evidenced; a cancelled cash order posts nothing', async () => {
    const cash = allocOf({ payment_method: 'cash', order_type: 'delivery', total_cents: 25000, subtotal_cents: 25000, tax_cents: 0 }, { body: {}, clientHdr: {} });
    const open = PJ.projectOrder({ orderId: 'C1', order: { status: 'preparing', created_at: ORDER_AT, payment_method: 'cash' }, alloc: cash, attempts: null }, { rateBp: RATE });
    assert.deepStrictEqual([open.status, Object.keys(open.journals).length], ['open', 0], 'not fulfilled yet ⇒ open, nothing posted');
    const done = PJ.projectOrder({ orderId: 'C1', order: { status: 'delivered', delivered_at: ORDER_AT + 1, created_at: ORDER_AT, payment_method: 'cash' }, alloc: cash, attempts: null }, { rateBp: RATE });
    balanced(done);
    assert.deepStrictEqual([done.status, byFamily(done, 'commission').length, byFamily(done, 'collection').length, done.reasons], ['final', 1, 0, ['cash_not_evidenced']], '🔴 PR-CASH');
    const gone = PJ.projectOrder({ orderId: 'C1', order: { status: 'cancelled', created_at: ORDER_AT, payment_method: 'cash' }, alloc: cash, attempts: null }, { rateBp: RATE });
    assert.deepStrictEqual([gone.status, Object.keys(gone.journals).length], ['final', 0]);
  });

  await cell('PR-QUARANTINE: no snapshot / the fallback / a mode mismatch / an app pickup paid in cash / an adjusted SDK order ⇒ quarantined with its reason, NOTHING posted', async () => {
    const o = { status: 'delivered', created_at: ORDER_AT, payment_method: 'cash' };
    const cases = [
      [{ alloc: null }, 'no_snapshot'],
      [{ alloc: LA.FALLBACK }, 'snapshot_unparsed'],
      [{ alloc: allocOf({ payment_method: 'cash', order_type: 'delivery', total_cents: 100 }, { body: {}, clientHdr: { deployment: 'orders-app' } }) }, 'mode_mismatch'],
      [{ alloc: allocOf({ payment_method: 'cash', order_type: 'pickup', total_cents: 100 }) }, 'app_pickup_cash'],
      [{ alloc: allocOf({ payment_method: 'online', order_type: 'delivery', total_cents: 100 }, { sdk: true }), sdk: { phase: 'open', committed_revision: 1, legs: {} } }, 'sdk_adjusted'],
    ];
    for (const [src, why] of cases) {
      const out = PJ.projectOrder({ orderId: 'Q', order: o, attempts: null, ...src }, { rateBp: RATE });
      assert.deepStrictEqual([out.status, out.reasons, Object.keys(out.journals).length], ['quarantined', [why], 0], `🔴 PR-QUARANTINE: ${why}`);
    }
  });

  await cell('PR-UNRESOLVED (r3 §5): an attempt in capturing / capture_unverified, a manually verified capture, or a voided mismatch without evidence ⇒ unresolved, nothing posted for it', async () => {
    const order = { status: 'pending_payment', created_at: ORDER_AT, payment_method: 'online', active_attempt_id: A };
    for (const [att, why] of [[{ status: 'capturing' }, 'capture_unproven'], [{ status: 'capture_unverified' }, 'capture_unproven'],
      [{ status: 'captured', capture_verified: true, manual_verified: true }, 'manual_unverified'], [{ status: 'voided', mismatch_reason: 'hash_mismatch' }, 'reversal_unproven']]) {
      const out = PJ.projectOrder({ orderId: 'U', order, alloc: allocOf(CARD_REC), attempts: { [A]: { order_id: 'U', ...att } } }, { rateBp: RATE });
      assert.deepStrictEqual([out.status, out.reasons.includes(why), byFamily(out, 'collection').length], ['unresolved', true, 0], `🔴 PR-UNRESOLVED: ${JSON.stringify(att)}`);
    }
  });

  await cell('PR-MISMATCH: a mismatched capture voided by the REAL confirm path (S2 evidence) ⇒ in to customer_refund_suspense and out again at the PROVIDER amount — no sale, no commission', async () => {
    const realClient = require('../pixelpay-client');
    const db = makeHonestDb({ orders: { 'PZX-1': { order_id: 'PZX-1', customer_name: 'Ana', customer_phone: '50488887777', items_text: 'M x1', total: 299, total_cents: 29900, subtotal_cents: 29900, tax_cents: 0,
      notes: '', payment_method: 'online', payment_status: 'pending', order_type: 'pickup', pickup_time: 'standard', status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: ORDER_AT } },
    payment_attempts: { A: { order_id: 'PZX-1', status: 'active', total_cents: 29900, pixelpay_order_id: 'PZX-1-A', created_at: 1 } } }, { now: () => ORDER_AT + 5 });
    const client = { interpretStatus: realClient.interpretStatus, verifyCaptureResult: realClient.verifyCaptureResult, async getStatus() { return { data: { status: 'authorized' } }; },
      async capture() { return { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 100, payment_hash: paymentHash('PZX-1-A', KEY, SECRET) } }; }, async voidTransaction() { return { ok: true }; } };
    await require('../pixelpay-confirm').confirmOnlinePayment({ db, client, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund: require('../pixelpay-cancel').voidOrRefund, staleMs: 90000, alert: () => {} }, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: ORDER_AT + 5 });
    const out = PJ.projectOrder({ orderId: 'PZX-1', order: db.getAt('orders/PZX-1'), alloc: allocOf({ payment_method: 'online', order_type: 'pickup', total_cents: 29900, subtotal_cents: 29900 }), attempts: db.getAt('payment_attempts') }, { rateBp: RATE });
    balanced(out);
    const [m] = byFamily(out, 'mismatch_capture');
    assert.deepStrictEqual([amt(m, 'processor_receivable', 'dr'), amt(m, 'customer_refund_suspense', 'cr'), byFamily(out, 'reversal').length, byFamily(out, 'collection').length, byFamily(out, 'commission').length], [10000, 10000, 1, 0, 0], '🔴 PR-MISMATCH');
  });

  await cell('PR-SDK: a captured SDK leg ⇒ a collection keyed by order + leg; voided AFTER capture ⇒ its one reversal; an approved leg voided before capture posts nothing', async () => {
    const alloc = allocOf({ ...CARD_REC }, { sdk: true });
    const order = { status: 'delivered', created_at: ORDER_AT, payment_method: 'online', payment_flow: 'sdk_auth_v1' };
    const rec = (legState, extra = {}) => ({ flow: 'sdk_auth_v1', phase: 'closed', committed_revision: 0, legs: { L1: { kind: 'auth', amount_cents: 29900, state: legState, ...extra } } });
    const cap = PJ.projectOrder({ orderId: 'S1', order, alloc, sdk: rec('captured', { captured_at: ORDER_AT + 9 }) }, { rateBp: RATE });
    balanced(cap);
    assert.deepStrictEqual([byFamily(cap, 'collection').length, byFamily(cap, 'collection')[0].id], [1, PJ.idOf('sdk_collection', 'S1+L1')], '🔴 PR-SDK: captured');
    const rev = PJ.projectOrder({ orderId: 'S1', order: { ...order, status: 'cancelled' }, alloc, sdk: rec('voided', { captured_at: ORDER_AT + 9 }) }, { rateBp: RATE });
    assert.deepStrictEqual([byFamily(rev, 'collection').length, byFamily(rev, 'reversal').length], [1, 1], '🔴 PR-SDK: voided after capture');
    const auth = PJ.projectOrder({ orderId: 'S1', order: { ...order, status: 'cancelled' }, alloc, sdk: rec('voided') }, { rateBp: RATE });
    assert.deepStrictEqual([Object.keys(auth.journals).length, auth.status], [0, 'final'], '🔴 PR-SDK: an uncaptured void is non-posting');
  });

  await cell('PR-DATE (Codex #110 r2 condition): every journal is dated by orders/{id}.created_at — never by the snapshot\'s informational created_at', async () => {
    const h = await hosted({ cancel: true });
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: RATE });
    for (const j of Object.values(out.journals)) assert.strictEqual(j.date, h.order.created_at, `🔴 PR-DATE: ${j.family}`);
    assert.notStrictEqual(allocOf(CARD_REC).created_at, h.order.created_at, 'premise: the two differ');
  });

  await cell('PR-RATE + PR-DETERMINISTIC: a missing / invalid rate ⇒ unresolved rate_missing; the same sources ⇒ byte-identical output', async () => {
    const h = await hosted();
    for (const r of [undefined, -1, 10001, 1.5, '1000']) {
      const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: r });
      assert.deepStrictEqual([out.status, out.reasons.includes('rate_missing'), byFamily(out, 'commission').length], ['unresolved', true, 0], `🔴 PR-RATE: ${JSON.stringify(r)}`);
    }
    const a = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: RATE });
    const b = PJ.projectOrder(JSON.parse(JSON.stringify({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts })), { rateBp: RATE });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), '🔴 PR-DETERMINISTIC');
  });
  console.log(`projector: OK (${n})`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
