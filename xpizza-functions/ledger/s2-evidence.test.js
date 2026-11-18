'use strict';
// LEDGER S2 (PLAN-5f-ledger-shadow-s1-r3 §5; Codex #108 r2 #5 / r3 #3) — CAPTURE EVIDENCE, evidence only, VOID FIRST. The provider-reported
// facts ride the write each void path ALREADY performs after its void (pixelpay-confirm.js mismatch :192, pixelpay-hosted-webhook.js
// voidPaid :198) as payment_attempts/{aid}/capture_evidence/{confirm|webhook}. The builder (ledger/capture-evidence.js) is synchronous
// and NON-THROWING, so production outcomes cannot change: each handler cell runs the CURRENT module and the BASE module (compiled from
// eb3d1cb9c) on identical honest-RTDB worlds and asserts the handler result, the order and the attempt (minus capture_evidence) are
// byte-identical — including missing / malformed provider fields (pixelpay-client.js:139 treats absent capture data as a failure).
// Run: node ledger/s2-evidence.test.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { makeHonestDb } = require('../_honest-rtdb-model');
const EV = require('./capture-evidence');
const realClient = require('../pixelpay-client');
const { paymentHash } = require('../pixelpay');
const { buildMaterializeUpdates } = require('../materialize');
const { voidOrRefund } = require('../pixelpay-cancel');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
async function cell(label, fn) { try { await fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); }
const BASE_SHA = 'eb3d1cb9c';
function baseModule(rel) {   // the module as it is on BASE, compiled in place (its own requires resolve to the current tree)
  const file = path.resolve(__dirname, '..', rel);
  const src = execFileSync('git', ['-C', path.dirname(file), 'show', `${BASE_SHA}:xpizza-functions/${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(src, file);
  return m.exports;
}
const minus = (o, k) => { if (!o) return o; const c = JSON.parse(JSON.stringify(o)); delete c[k]; return c; };

// ── the builder ──
const SBOX_KEY = '1234567890', SBOX_SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
(async () => {
  await cell('S2-EV-SHAPE: provider facts normalized — amount in centavos or null, bounded key-safe uuid / reason, verified + approved booleans, at = the handler\'s now', async () => {
    assert.deepStrictEqual(EV.evidenceOf({ capture: { data: { transaction_approved_amount: 385 } }, paymentUuid: 'S-uuid', at: 6000, verified: false, approved: true, mismatchReason: 'hash_mismatch' }),
      { v: 1, amount_cents: 38500, payment_uuid: 'S-uuid', at: 6000, verified: false, approved: true, mismatch_reason: 'hash_mismatch' });
    assert.deepStrictEqual(EV.evidenceOf({ amountLempiras: 299, paymentUuid: 'P-paid-1', at: 7, verified: true, approved: true, mismatchReason: null }),
      { v: 1, amount_cents: 29900, payment_uuid: 'P-paid-1', at: 7, verified: true, approved: true, mismatch_reason: null });
  });
  await cell('S2-EV-MALFORMED: missing / non-finite / string / oversized / negative amounts ⇒ amount_cents null; unsafe uuid / reason ⇒ null; never throws', async () => {
    for (const x of [undefined, null, 'abc', '', NaN, Infinity, 1e20, 50000000, -5, {}, [1], true]) {   // 50,000,000 L: a safe integer, but over the L10M cap
      const e = EV.evidenceOf({ capture: { data: { transaction_approved_amount: x } }, paymentUuid: 'S', at: 1, verified: false, approved: false, mismatchReason: 'amount_mismatch' });
      assert.strictEqual(e.amount_cents, null, `🔴 S2-EV-MALFORMED: ${JSON.stringify(x)}`);
    }
    assert.strictEqual(EV.evidenceOf({ capture: { data: { transaction_approved_amount: '385.50' } }, at: 1 }).amount_cents, 38550, 'a decimal string the provider may send');
    for (const cap of [null, undefined, {}, { data: null }]) assert.strictEqual(EV.evidenceOf({ capture: cap, at: 1 }).amount_cents, null, `no capture data ${JSON.stringify(cap)}`);
    const e = EV.evidenceOf({ amountLempiras: 1, paymentUuid: 'x/../y' + 'z'.repeat(80), at: 1, mismatchReason: 'a b' });
    assert.deepStrictEqual([e.payment_uuid, e.mismatch_reason], [null, null]);
  });
  await cell('S2-EV-FALLBACK: a hostile capture object (a throwing getter) ⇒ the fixed { v:1, unparsed:true, at } — the path\'s own write is never at risk', async () => {
    const cap = {}; Object.defineProperty(cap, 'data', { get() { throw new Error('boom'); } });
    assert.deepStrictEqual(EV.evidenceOf({ capture: cap, at: 42 }), { v: 1, unparsed: true, at: 42 });
    assert.deepStrictEqual(EV.evidenceOf(null), { v: 1, unparsed: true, at: null });
  });

  // ── the legacy confirm mismatch void (pixelpay-confirm.js) — CURRENT vs BASE ──
  const goodHash = paymentHash('PZX-1-A', SBOX_KEY, SBOX_SECRET);
  const seed = () => ({
    orders: { 'PZX-1': { order_id: 'PZX-1', customer_name: 'Ana', customer_phone: '50488887777', items_text: 'Margherita x1', total: 385, total_cents: 38500, subtotal_cents: 33478, tax_cents: 5022,
      notes: '', payment_method: 'online', payment_status: 'pending', order_type: 'pickup', pickup_time: 'standard', status: 'pending_payment', active_attempt_id: 'A', payment_fingerprint: 'fp', created_at: 1 } },
    payment_attempts: { A: { order_id: 'PZX-1', status: 'active', total_cents: 38500, pixelpay_order_id: 'PZX-1-A', created_at: 1 } } });
  const client = (data, { voidOk = true, voidThrows = false, log = [] } = {}) => ({ calls: { void: 0 },
    interpretStatus: realClient.interpretStatus, verifyCaptureResult: realClient.verifyCaptureResult,
    async getStatus() { return { data: { status: 'authorized' } }; },
    async capture() { return { ok: true, httpStatus: 200, data }; },
    async voidTransaction() { this.calls.void++; log.push('void'); if (voidThrows) throw new Error('void net err'); return { ok: voidOk }; } });
  const RESTAURANT = { lat: 15.5, lng: -88.0, name: 'X Pizza', phone: '+50497952893' };
  const runConfirm = async (mod, data, opt = {}) => {
    const db = makeHonestDb(seed(), { now: () => 6000 });
    const c = client(data, opt);
    const r = await mod.confirmOnlinePayment({ db, client: c, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} }, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 6000 });
    return { r, order: db.getAt('orders/PZX-1'), att: db.getAt('payment_attempts/A'), voids: c.calls.void };
  };
  const CUR = require('../pixelpay-confirm'); const BASEC = baseModule('pixelpay-confirm.js');
  const VARIANTS = [
    ['hash mismatch', { response_approved: true, transaction_approved_amount: 385, payment_hash: 'deadbeef'.repeat(4) }, 38500],
    ['amount mismatch', { response_approved: true, transaction_approved_amount: 1, payment_hash: goodHash }, 100],
    ['not approved', { response_approved: false, transaction_approved_amount: 385, payment_hash: goodHash }, 38500],
    ['amount missing', { response_approved: true, payment_hash: goodHash }, null],
    ['amount non-numeric', { response_approved: true, transaction_approved_amount: 'abc', payment_hash: goodHash }, null],
    ['amount oversized', { response_approved: true, transaction_approved_amount: 1e20, payment_hash: goodHash }, null],
    ['no data', null, null],
  ];
  await cell('S2-CONFIRM-DIFF: the mismatch void through the REAL confirmOnlinePayment — result, order and attempt (minus capture_evidence) byte-identical to BASE for every provider variant, incl. missing / malformed fields', async () => {
    for (const [name, data, cents] of VARIANTS) for (const opt of [{}, { voidOk: false }, { voidThrows: true }]) {
      const cur = await runConfirm(CUR, data, opt); const base = await runConfirm(BASEC, data, opt);
      const tag = `${name} ${JSON.stringify(opt)}`;
      assert.deepStrictEqual(cur.r, base.r, `🔴 S2-CONFIRM-DIFF: the handler result (${tag})`);
      assert.deepStrictEqual(cur.order, base.order, `🔴 S2-CONFIRM-DIFF: the order (${tag})`);
      assert.deepStrictEqual(minus(cur.att, 'capture_evidence'), base.att, `🔴 S2-CONFIRM-DIFF: the attempt (${tag})`);
      assert.strictEqual(cur.voids, base.voids, `the void attempts (${tag})`);
      const ev = cur.att.capture_evidence && cur.att.capture_evidence.confirm;
      assert.ok(ev, `🔴 S2-CONFIRM-EVIDENCE: present (${tag})`);
      assert.deepStrictEqual([ev.amount_cents === undefined ? null : ev.amount_cents, ev.verified, ev.payment_uuid, ev.at], [cents, false, 'S-uuid', 6000], `🔴 S2-CONFIRM-EVIDENCE: the ACTUAL provider amount, never the order's (${tag})`);
      assert.strictEqual(cur.att.status === 'captured', false, 'never status captured');
    }
  });

  await cell('S2-VOID-FIRST: on the mismatch path the void is attempted BEFORE the write that carries the evidence (crash point b — evidence committed, void not attempted — cannot occur)', async () => {
    const log = [];
    const db = makeHonestDb(seed(), { now: () => 6000 });
    const ref0 = db.ref.bind(db);
    db.ref = (p) => { const r = ref0(p); if (p !== 'payment_attempts/A') return r; const w = Object.create(r); w.update = async (patch) => { if (patch && Object.keys(patch).some((k) => k.startsWith('capture_evidence'))) log.push('evidence'); return r.update(patch); }; return w; };
    await CUR.confirmOnlinePayment({ db, client: client(VARIANTS[0][1], { log }), restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} }, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 6000 });
    assert.deepStrictEqual(log, ['void', 'evidence'], '🔴 S2-VOID-FIRST');
  });

  await cell('S2-CRASH: (a) the void call fails ⇒ today\'s refund_pending + the evidence; (c) the provider voided but the post-void write is lost ⇒ the attempt stays `capturing` with NO evidence — the REAL stored state the projector maps to unresolved', async () => {
    const a = await runConfirm(CUR, VARIANTS[0][1], { voidThrows: true });
    assert.deepStrictEqual([a.att.status, !!a.att.capture_evidence], ['refund_pending', true], '🔴 S2-CRASH (a)');
    const db = makeHonestDb(seed(), { now: () => 6000 });
    const ref0 = db.ref.bind(db);
    db.ref = (p) => { const r = ref0(p); if (p !== 'payment_attempts/A') return r; const w = Object.create(r); w.update = async (patch) => { if (patch && 'mismatch_reason' in patch) throw new Error('crash: write lost'); return r.update(patch); }; return w; };
    const c = client(VARIANTS[0][1]);
    await assert.rejects(CUR.confirmOnlinePayment({ db, client: c, restaurant: RESTAURANT, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: () => {} }, { orderId: 'PZX-1', paymentUuid: 'S-uuid', now: 6000 }), /write lost/);
    const att = db.getAt('payment_attempts/A');
    assert.deepStrictEqual([c.calls.void, att.status, 'capture_evidence' in att], [1, 'capturing', false], '🔴 S2-CRASH (c): voided at the provider, attempt still capturing, no evidence');
  });

  // ── the hosted webhook voidPaid (pixelpay-hosted-webhook.js) — CURRENT vs BASE ──
  const A = 'a1b2c3d4e5f6a7b8';
  const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
  const wseed = () => ({ orders: { O1: { order_id: 'O1', order_type: 'pickup', payment_method: 'online', payment_status: 'pending', status: 'pending_payment', total: 299, total_cents: 29900, customer_name: 'Test', items_text: 'Margherita', active_attempt_id: A } },
    payment_attempts: { [A]: { order_id: 'O1', hosted_state: 'created', hosted_order_id: `O1-${A}`, hosted_checkout_url: 'https://pay/x', cancel_pending: true } } });
  const cbk = { order: `O1-${A}`, ref: 'PIXELPAY-INTERNAL-REF', status: 'paid', amount: 299, uuid: 'P-paid-1', transaction_id: 'TXN-1', payment_hash: paymentHash(`O1-${A}`, KEY, SECRET) };
  const runHook = async (mod, voided) => {
    const db = makeHonestDb(wseed(), { now: () => 7 });
    const r = await mod.handleHostedCallback({ db, restaurant: RESTAURANT, buildMaterializeUpdates, alert: () => {}, genToken: () => 'TOK', client: {}, voidOrRefund: async () => ({ voided }) }, { ...cbk }, 1700000000000);
    return { r, order: db.getAt('orders/O1'), att: db.getAt(`payment_attempts/${A}`) };
  };
  const CURW = require('../pixelpay-hosted-webhook'); const BASEW = baseModule('pixelpay-hosted-webhook.js');
  await cell('S2-WEBHOOK-DIFF: voidPaid through the REAL handleHostedCallback — result, order and attempt (minus capture_evidence) byte-identical to BASE; the evidence is the verified callback amount', async () => {
    for (const voided of [true, false]) {
      const cur = await runHook(CURW, voided); const base = await runHook(BASEW, voided);
      assert.deepStrictEqual(cur.r, base.r, `🔴 S2-WEBHOOK-DIFF: result (voided ${voided})`);
      assert.deepStrictEqual(cur.order, base.order, `🔴 S2-WEBHOOK-DIFF: order (voided ${voided})`);
      assert.deepStrictEqual(minus(cur.att, 'capture_evidence'), base.att, `🔴 S2-WEBHOOK-DIFF: attempt (voided ${voided})`);
      const ev = cur.att.capture_evidence && cur.att.capture_evidence.webhook;
      assert.deepStrictEqual(ev && [ev.amount_cents, ev.verified, ev.payment_uuid], [29900, true, 'P-paid-1'], `🔴 S2-WEBHOOK-EVIDENCE (voided ${voided})`);
    }
  });
  console.log(`s2-evidence: OK (${n})`);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
