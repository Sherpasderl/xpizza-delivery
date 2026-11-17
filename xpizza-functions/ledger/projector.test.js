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
const ONLY = process.env.PR_ONLY;   // run ONE cell (RED proofs against an older projector)
async function cell(label, fn) { if (ONLY && !label.startsWith(`${ONLY}:`) && !label.startsWith(`${ONLY} `)) return; try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }

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
      [{ status: 'captured', capture_verified: true, manual_verified: true }, 'manual_unverified'], [{ status: 'voided', mismatch_reason: 'hash_mismatch' }, 'capture_unproven'], [{ status: 'some_future_state', hosted_state: 'paid', paid_amount_cents: 29900 }, 'attempt_state_unknown']]) {   // no evidence ⇒ the captured AMOUNT is unproven (Codex #114 #2)
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
  // ── Codex #114: writer-driven cells ──
  const HC2 = (aid) => ({ order: `O1-${aid}`, ref: 'R', status: 'paid', amount: 299, transaction_id: 'T', payment_hash: paymentHash(`O1-${aid}`, KEY, SECRET) });
  const hostedWorld = (over = {}, attOver = {}, hooks = {}) => makeHonestDb({ orders: { O1: { order_id: 'O1', order_type: 'pickup', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'M', active_attempt_id: A, created_at: ORDER_AT, ...over } },
    payment_attempts: { [A]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${A}`, ...attOver } } }, { now: () => ORDER_AT + 60000, ...hooks });
  const PICK = { payment_method: 'online', order_type: 'pickup', total_cents: 29900, subtotal_cents: 29900, tax_cents: 0 };
  const proj = (db, extra = {}) => PJ.projectOrder({ orderId: 'O1', order: db.getAt('orders/O1'), alloc: allocOf(PICK), attempts: db.getAt('payment_attempts'), refunds: db.getAt('refund_attempts'), ...extra }, { rateBp: RATE });
  const realVoid = (client) => async (deps, args) => require('../pixelpay-cancel').voidOrRefund({ ...deps, client }, args);

  await cell('PR-REVERSING-CRASH (Codex #114 #1): the REAL voidOrRefund voids at the provider, then the terminal attempt write is lost (hosted paid, status reversing, side_effect_started) — never final; its bound refund evidence proves the ONE reversal', async () => {
    const db = hostedWorld();
    await handleHostedCallback({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) }, { ...HC2(A), uuid: 'P-1' }, ORDER_AT + 60000);   // a real paid order
    let armed = true;
    const ref0 = db.ref.bind(db);
    db.ref = (p) => { const r = ref0(p); if (p !== `payment_attempts/${A}`) return r; const w = Object.create(r); w.update = async (patch) => { if (armed && patch && 'refunded_at' in patch) throw new Error('crash: terminal write lost'); return r.update(patch); }; return w; };
    await require('../pixelpay-cancel').voidOrRefund({ db, client: { voidTransaction: async () => ({ ok: true }) }, alert: () => {} }, { orderId: 'O1', attemptId: A, pixelpayOrderId: `O1-${A}`, paymentUuid: 'P-1', reason: 'cancel', now: ORDER_AT + 70000 }).catch(() => {});
    armed = false; db.ref = ref0;
    const att = db.getAt(`payment_attempts/${A}`);
    assert.deepStrictEqual([att.hosted_state, att.status, att.reversing_phase], ['paid', 'reversing', 'side_effect_started'], `premise: the real crash state (${JSON.stringify(att)})`);
    const noEv = proj(db, { refunds: null });
    assert.deepStrictEqual([noEv.status, noEv.reasons.includes('reversal_pending')], ['unresolved', true], '🔴 PR-REVERSING-CRASH: without the refund evidence ⇒ unresolved, never final');
    const withEv = proj(db);
    assert.ok(Object.values(db.getAt('refund_attempts')).some((r) => r.voided === true), 'premise: the immutable refund evidence exists');
    assert.deepStrictEqual([byFamily(withEv, 'collection').length, byFamily(withEv, 'reversal').length, withEv.reasons.includes('reversal_pending')], [1, 1, false], '🔴 PR-REVERSING-CRASH: the bound refund evidence proves ONE reversal');
  });

  await cell('PR-MANUAL-STATES (Codex #114 #1): a paid callback with NO payment uuid on a cancelled order (manual_review) and a callback failing verification (manual_reconciliation) — the REAL webhook — are unresolved, never final', async () => {
    const a = hostedWorld({}, { cancel_pending: true });
    await handleHostedCallback({ db: a, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) }, { ...HC2(A) }, ORDER_AT + 60000);
    assert.deepStrictEqual([proj(a).status, proj(a).reasons.includes('manual_review')], ['unresolved', true], '🔴 PR-MANUAL-STATES: manual_review');
    const b = hostedWorld();
    await handleHostedCallback({ db: b, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) }, { ...HC2(A), uuid: 'P-1', payment_hash: 'deadbeef'.repeat(4) }, ORDER_AT + 60000);
    assert.deepStrictEqual([proj(b).status, proj(b).reasons.includes('manual_reconciliation')], ['unresolved', true], '🔴 PR-MANUAL-STATES: manual_reconciliation');
  });

  await cell('PR-MISMATCH-RETRY (Codex #114 #2): the REAL confirm captures L100 for an L299 order and its void FAILS (refund_pending + evidence) ⇒ the suspense receipt + unresolved reversal_pending; the REAL voidOrRefund retry succeeds ⇒ exactly ONE reversal', async () => {
    const realClient = require('../pixelpay-client');
    const db = makeHonestDb({ orders: { 'PZX-1': { order_id: 'PZX-1', customer_name: 'Ana', customer_phone: '50488887777', items_text: 'M x1', total: 299, total_cents: 29900, subtotal_cents: 29900, tax_cents: 0, notes: '', payment_method: 'online', payment_status: 'pending', order_type: 'pickup', pickup_time: 'standard', status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: ORDER_AT } },
      payment_attempts: { A: { order_id: 'PZX-1', status: 'active', total_cents: 29900, pixelpay_order_id: 'PZX-1-A', created_at: 1 } } }, { now: () => ORDER_AT + 5 });
    const client = (voidOk) => ({ interpretStatus: realClient.interpretStatus, verifyCaptureResult: realClient.verifyCaptureResult, async getStatus() { return { data: { status: 'authorized' } }; },
      async capture() { return { ok: true, httpStatus: 200, data: { response_approved: true, transaction_approved_amount: 100, payment_hash: paymentHash('PZX-1-A', KEY, SECRET) } }; }, async voidTransaction() { return { ok: voidOk }; } });
    const { voidOrRefund } = require('../pixelpay-cancel');
    await require('../pixelpay-confirm').confirmOnlinePayment({ db, client: client(false), restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} }, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: ORDER_AT + 5 });
    const p = (o) => PJ.projectOrder({ orderId: 'PZX-1', order: db.getAt('orders/PZX-1'), alloc: allocOf(PICK), attempts: db.getAt('payment_attempts'), refunds: db.getAt('refund_attempts') }, o);
    const pend = p({ rateBp: RATE });
    assert.strictEqual(db.getAt('payment_attempts/A').status, 'refund_pending', 'premise: the void failed');
    assert.deepStrictEqual([amt(byFamily(pend, 'mismatch_capture')[0] || { lines: [] }, 'customer_refund_suspense', 'cr'), byFamily(pend, 'reversal').length, pend.status, pend.reasons.includes('reversal_pending')], [10000, 0, 'unresolved', true], '🔴 PR-MISMATCH-RETRY: pending');
    await voidOrRefund({ db, client: client(true), alert: () => {} }, { orderId: 'PZX-1', attemptId: 'A', pixelpayOrderId: 'PZX-1-A', paymentUuid: 'S-uuid', reason: 'retry', now: ORDER_AT + 9 });
    const done = p({ rateBp: RATE });
    balanced(done);
    assert.deepStrictEqual([byFamily(done, 'mismatch_capture').length, byFamily(done, 'reversal').length, done.reasons.includes('reversal_pending'), byFamily(done, 'commission').length], [1, 1, false, 0], '🔴 PR-MISMATCH-RETRY: proven ⇒ the receipt + exactly one reversal, no sale');
  });

  await cell('PR-OFFLINE (Codex #114 #4): the REAL close_fulfilled (status completed, resolution offline_fulfilled, fulfilled_offline_at) on a paid order ⇒ the manual hold — unresolved, no sale posted', async () => {
    const db = hostedWorld({ restaurant_id: 'tb_rest', payment_status: 'manual_reconciliation', status: 'new', blocked_reason: 'x', items: [{ qty: 1, description: 'P', line_gross_cents: 29900 }], subtotal_cents: 29900, tax_cents: 0 },
      { hosted_state: 'paid', payment_uuid: 'P-1', paid_amount_cents: 29900, paid_at: ORDER_AT + 1 });
    const r = await require('../resolve-manual').resolveManualReconciliationCore({ db, client: {}, alert: async () => {}, sanitizeText: (x) => x, serverTimestamp: ORDER_AT + 2 }, { orderId: 'O1', action: 'close_fulfilled', actor: 'disp@x', note: 'entregado', now: ORDER_AT + 2, claimId: 'C1' });
    const o = db.getAt('orders/O1');
    assert.deepStrictEqual([o.status, o.resolution, !!o.fulfilled_offline_at], ['completed', 'offline_fulfilled', true], `premise: the real offline close (${JSON.stringify(r)})`);
    const out = proj(db);
    assert.deepStrictEqual([out.status, out.reasons.includes('manual_unverified'), byFamily(out, 'collection').length, byFamily(out, 'commission').length], ['unresolved', true, 0, 0], '🔴 PR-OFFLINE');
  });

  await cell('PR-ZERO-FOOD (Codex #114 #5): a 100 %-off offer (L150 off L150) charged only net envío + tip ⇒ no commission journal, the collection / envío / tip intact, no throw', async () => {
    const OFP = require('../marketing/offer-price');
    const offer = OFP.frozenOf({ offer_id: 'of_full', rev: 1, type: 'lps', name: 'Gratis', discount_cents: 15000, waived_envio_cents: 0 });
    const rec = { payment_method: 'online', order_type: 'delivery', total_cents: 4900, subtotal_cents: 0, tax_cents: 0, desc_rebaja_cents: 15000, delivery_cents: 4000, tip_cents: 900, offer };
    const db = hostedWorld({ total: 49, total_cents: 4900 }, {}); await handleHostedCallback({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) }, { ...HC2(A), amount: 49, uuid: 'P-1' }, ORDER_AT + 60000);
    const out = PJ.projectOrder({ orderId: 'O1', order: db.getAt('orders/O1'), alloc: allocOf(rec), attempts: db.getAt('payment_attempts') }, { rateBp: RATE });
    balanced(out);
    const [c] = byFamily(out, 'collection');
    assert.deepStrictEqual([amt(c, 'processor_receivable', 'dr'), amt(c, 'restaurant_payable', 'cr'), amt(c, 'delivery_revenue', 'cr'), amt(c, 'tip_liability', 'cr'), byFamily(out, 'commission').length], [4900, 0, 4000, 900, 0], '🔴 PR-ZERO-FOOD');
  });

  await cell('PR-SUPERSEDED: the REAL webhook pays a NON-active attempt (attempt_superseded) and a second payment id on the active one (extra) ⇒ both in customer_refund_suspense, ONE sale, ONE commission', async () => {
    const B = 'b1b2c3d4e5f6a7b8';
    const db = makeHonestDb({ orders: { O1: { order_id: 'O1', order_type: 'pickup', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', total: 299, total_cents: 29900, customer_name: 'T', items_text: 'M', active_attempt_id: B, created_at: ORDER_AT } },
      payment_attempts: { [A]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${A}` }, [B]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${B}` } } }, { now: () => ORDER_AT + 60000 });
    const d = { db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided: true }) };
    await handleHostedCallback(d, { ...HC2(B), uuid: 'P-B' }, ORDER_AT + 60000);
    assert.strictEqual((await handleHostedCallback(d, { ...HC2(A), uuid: 'P-A' }, ORDER_AT + 60001)).outcome, 'attempt_superseded', 'premise');
    assert.strictEqual((await handleHostedCallback(d, { ...HC2(B), uuid: 'P-B2' }, ORDER_AT + 60002)).outcome, 'extra_payment_recorded', 'premise');
    const out = proj(db);
    balanced(out);
    const sus = Object.values(out.journals).reduce((s2, j) => s2 + amt(j, 'customer_refund_suspense', 'cr'), 0);
    assert.deepStrictEqual([byFamily(out, 'collection').length, byFamily(out, 'superseded_receipt').length, byFamily(out, 'extra_receipt').length, sus, byFamily(out, 'commission').length], [1, 1, 1, 59800, 1], '🔴 PR-SUPERSEDED');
  });

  await cell('PR-NETS-ZERO: a fully reversed card order nets EVERY account to zero — the collection, the Sherpa envío promo and the commission + ISV', async () => {
    const h = await hosted({ cancel: true });
    const out = PJ.projectOrder({ orderId: 'O1', order: h.order, alloc: allocOf(CARD_REC), attempts: h.attempts }, { rateBp: RATE });
    const net = {}; for (const j of Object.values(out.journals)) for (const l of j.lines) net[l.account] = (net[l.account] || 0) + (l.dr || 0) - (l.cr || 0);
    assert.ok(Object.values(net).every((v) => v === 0), `🔴 PR-NETS-ZERO: ${JSON.stringify(net)}`);
  });

  // ── SDK, through the REAL coordinator (placeOriginal → delivered → settleTerminal; cancel; decrease) ──
  const { makeAdapter } = require('../payments/sdk/psp-adapter'); const { makeFakePsp } = require('../payments/sdk/fake-adapter');
  const C = require('../payments/sdk/coordinator'); const SOID = 'tb_sdk_1';
  const sdkOrder = (o = {}) => ({ restaurant_id: 'tb_rest', payment_flow: 'sdk_auth_v1', status: 'pending_payment', payment_status: 'pending', payment_method: 'online', order_type: 'delivery', hub_lat: 14.1, hub_lng: -87.2, items: [{ name: 'tb_item', qty: 1, unit: 100 }], items_text: '1x tb_item', lat: 14.08, lng: -87.19, address_detected: 'c', address_details: 'd', customer_name: 'Ana', total_cents: 10000, subtotal_cents: 10000, tax_cents: 0, created_at: ORDER_AT, ...o });
  const sdkWorld = (seed = {}, hooks = {}) => {
    let t = ORDER_AT + 1000;
    const db = makeHonestDb({ orders: { [SOID]: sdkOrder() }, ...seed }, { now: () => t, ...hooks });
    const fake = makeFakePsp({}, {});
    const deps = { db, psp: makeAdapter(fake.impl), clock: () => t, voidEligible: () => false, releaseResources: async () => {},
      goLive: (dp, id) => require('../pixelpay-confirm').confirmAndMaterialize({ db, buildMaterializeUpdates, restaurant: { lat: 14.1, lng: -87.2, name: 'tb R', phone: '+50400000000' } }, { orderId: id, attemptId: null, now: t, trackingToken: 'TT', sdkGoLive: true }) };
    return { db, deps, tick: (ms) => { t += ms; } };
  };
  const SALLOC = allocOf({ payment_method: 'online', order_type: 'delivery', total_cents: 10000, subtotal_cents: 10000, tax_cents: 0 }, { sdk: true });
  const sproj = (w, extra = {}) => PJ.projectOrder({ orderId: SOID, order: w.db.getAt(`orders/${SOID}`), alloc: SALLOC, sdk: w.db.getAt(`payment_sdk/${SOID}`), ...extra }, { rateBp: RATE });
  await cell('PR-SDK: the REAL coordinator — a placed, uncaptured order is OPEN with nothing posted; delivered + settled ⇒ ONE collection keyed by order + leg, FINAL; an order cancelled before capture posts nothing', async () => {
    const w = sdkWorld();
    await C.placeOriginal(w.deps, { attempt_id: 'att_fixed_p00001', orderId: SOID, token: 'T', amount_cents: 10000 });
    const placed = sproj(w);
    assert.deepStrictEqual([placed.status, Object.keys(placed.journals).length], ['open', 0], '🔴 PR-SDK: placed, not captured ⇒ open, nothing');
    await w.db.ref(`orders/${SOID}/status`).set('delivered'); await C.settleTerminal(w.deps, { orderId: SOID });
    const done = sproj(w);
    balanced(done);
    assert.deepStrictEqual([byFamily(done, 'collection').length, byFamily(done, 'collection')[0].id, done.status], [1, PJ.idOf('sdk_collection', `${SOID}+L1`), 'final'], '🔴 PR-SDK: captured ⇒ one collection, final');
    const c = sdkWorld();
    await C.placeOriginal(c.deps, { attempt_id: 'att_fixed_p00002', orderId: SOID, token: 'T', amount_cents: 10000 });
    await C.cancelSdkOrder(c.deps, { orderId: SOID, kind: 'cancel' });
    assert.deepStrictEqual(Object.keys(sproj(c).journals).length, 0, '🔴 PR-SDK: an uncaptured cancel posts nothing');
  });

  await cell('PR-SDK-REWARD (Codex #114 #3): a REAL SDK order whose reward the settlement CONSUMED is final with rewardState consumed; without the reward state it stays open', async () => {
    const RWP = 'user_rewards/tb_uid/tb_rest';
    const w = sdkWorld({ orders: { [SOID]: sdkOrder({ customer_uid: 'tb_uid', redemption: { cost: 5, item: 'tb_item' } }) }, user_rewards: { tb_uid: { tb_rest: { balance: 10, reserved: 5, reservations: { [SOID]: { state: 'reserved', cost: 5, created_at: 1 } } } } } });
    await C.placeOriginal(w.deps, { attempt_id: 'att_fixed_p00003', orderId: SOID, token: 'T', amount_cents: 10000 });
    await w.db.ref(`orders/${SOID}/status`).set('delivered'); await C.settleTerminal(w.deps, { orderId: SOID });
    const st = w.db.getAt(`${RWP}/reservations/${SOID}/state`);
    assert.strictEqual(st, 'consumed', 'premise: the real settlement consumed the reward');
    assert.strictEqual(sproj(w, { rewardState: st }).status, 'final', '🔴 PR-SDK-REWARD: settled reward ⇒ final');
    assert.strictEqual(sproj(w).status, 'open', '🔴 PR-SDK-REWARD: no reward state ⇒ open');
  });

  await cell('PR-SDK-ADJUSTED: the REAL requestDecrease (rule 4) ⇒ quarantined sdk_adjusted; and a decrease committed on the ORDER whose record projection crashed (pending projection) ⇒ quarantined too', async () => {
    const REV = (cents) => ({ items: [{ name: 'tb_item', qty: 1, unit: cents / 100 }], total_cents: cents, delivery_cents: 0 });
    const w = sdkWorld();
    await C.placeOriginal(w.deps, { attempt_id: 'att_fixed_p00004', orderId: SOID, token: 'T', amount_cents: 10000 });
    await w.db.ref(`orders/${SOID}/status`).set('preparing');
    await C.requestDecrease(w.deps, { orderId: SOID, new_total_cents: 8000, revision: REV(8000) });
    assert.deepStrictEqual([sproj(w).status, sproj(w).reasons], ['quarantined', ['sdk_adjusted']], '🔴 PR-SDK-ADJUSTED: committed revision');
    let crash = false;
    const p = sdkWorld({}, { beforeTx: async (path, api) => { if (crash && path === `payment_sdk/${SOID}` && api.getAt(`orders/${SOID}/payment_commit`)) throw new Error('crash: projection lost'); } });
    await C.placeOriginal(p.deps, { attempt_id: 'att_fixed_p00005', orderId: SOID, token: 'T', amount_cents: 10000 });
    await p.db.ref(`orders/${SOID}/status`).set('preparing');
    crash = true; await C.requestDecrease(p.deps, { orderId: SOID, new_total_cents: 8000, revision: REV(8000) }).catch(() => {}); crash = false;
    const rec = p.db.getAt(`payment_sdk/${SOID}`); const ord = p.db.getAt(`orders/${SOID}`);
    assert.ok(ord.payment_commit && (rec.committed_revision || 0) < ord.payment_commit.revision, `premise: committed on the order, not projected (${JSON.stringify([ord.payment_commit, rec.committed_revision])})`);
    assert.deepStrictEqual([sproj(p).status, sproj(p).reasons], ['quarantined', ['sdk_adjusted']], '🔴 PR-SDK-ADJUSTED: pending projection');
  });
  console.log(`projector: OK (${n})`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
