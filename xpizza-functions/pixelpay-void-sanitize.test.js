'use strict';
/**
 * No raw PixelPay text in any payment alert or record. The shared voidOrRefund — and through it the dispatcher CANCEL path
 * (cancelOrderCore), the hosted FIRST-PAYMENT void (handleHostedCallback on a cancelled order) and the REFUND RECONCILER
 * (voidOrRefund with the reconciler's own arguments on a refund_pending attempt) — records and alerts a FIXED message plus a
 * short code; the provider's own code passes only through an allowlist (anything else → 'unknown'). A HOSTILE provider
 * (markup, card-like digits, a bearer string, in its message, its errors and its code; or a thrown network error carrying the
 * same) must leave no trace in the database or the alert log.
 * REAL voidOrRefund / pixelpay-client / paymentAlert / cancelOrderCore / handleHostedCallback; fetch stubbed with real
 * Response objects and validated; the honest RTDB model. Each failure message starts with its cell label.
 * Run: node pixelpay-void-sanitize.test.js
 */
process.env.PIXELPAY_MODE = 'sandbox';
const assert = require('assert');
const realClient = require('./pixelpay-client');
const { voidOrRefund } = require('./pixelpay-cancel');
const { paymentAlert } = require('./lib/payment-alert');
const { cancelOrderCore } = require('./cancel-order-core');
const { handleHostedCallback } = require('./pixelpay-hosted-webhook');
const { buildMaterializeUpdates } = require('./materialize');
const { paymentHash } = require('./pixelpay');
const { makeHonestDb: makeDb } = require('./_honest-rtdb-model');
const PP = require('./pixelpay'); const { resolvePixelPayConfig } = require('./pixelpay-config');

const HOSTILE = ['<script>x</script>', '4111111111111111', 'Bearer SECRET-TOKEN', 'CVV 123'];
const HOSTILE_TEXT = HOSTILE.join(' | ');
const KEY = '1234567890', SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const OID = 'TBVS1', AID = 'b0b0b0b0b0b0b0b0', HOID = `${OID}-${AID}`;

let provider = { kind: 'decline' }; let calls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('/api/v2/transaction/status')) return new Response(JSON.stringify({ success: true, data: { status: provider.status || 'authorized' } }), { status: 200 });
  if (u.endsWith('/api/v2/transaction/capture')) {
    calls += 1;
    return new Response(JSON.stringify({ success: false, message: HOSTILE_TEXT, code: `E-${HOSTILE[1]}`, errors: { card: [HOSTILE_TEXT] } }), { status: provider.captureHttp || 402 });
  }
  if (!u.endsWith('/api/v2/transaction/void')) throw new Error(`unexpected fetch ${url}`);
  const cfg = resolvePixelPayConfig(); const h = init.headers || {}; const body = JSON.parse(init.body);
  if (init.method !== 'POST' || h['x-auth-key'] !== cfg.app_key || h['x-auth-hash'] !== cfg.auth_hash) throw new Error('provider stub: bad request');
  if (h['x-auth-user'] !== PP.platformUser(cfg.merchant_email) || body.void_signature !== PP.voidSignature(cfg.merchant_email, HOID, cfg.secret)) throw new Error('provider stub: bad signature');
  calls += 1;
  if (provider.kind === 'throw') throw new Error(`socket hang up ${HOSTILE_TEXT}`);
  if (provider.kind === 'ok') return new Response(JSON.stringify({ success: true, message: `anulada ${HOSTILE_TEXT}`, code: 'X-HOSTILE-CODE' }), { status: 200 });
  const status = provider.kind === 'http' ? 500 : 200;
  return new Response(JSON.stringify({ success: false, message: HOSTILE_TEXT, code: `E-${HOSTILE[1]}`, errors: { card: [HOSTILE_TEXT] } }), { status });
};

// every alert also goes to the log through paymentAlert's console.warn — capture it
const logged = []; const realWarn = console.warn; const realErr = console.error;
console.warn = (...a) => { logged.push(a.map(String).join(' ')); }; console.error = (...a) => { logged.push(a.map(String).join(' ')); };

const FIXED = new Set(['void confirmed', 'void declined by the provider', 'void request failed at the provider', 'void request did not complete', 'no payment to void']);
function clean(L, db) {
  const blob = JSON.stringify(db.root) + '\n' + logged.join('\n');
  for (const s of HOSTILE) assert.ok(!blob.includes(s), `${L}: raw provider text «${s}» reached a record, alert or log line`);
  assert.ok(!blob.includes('X-HOSTILE-CODE'), `${L}: a non-allowlisted provider code reached a record or alert`);
}
const records = (db) => Object.values(db.getAt('refund_attempts') || {});
const alerts = (db, type) => Object.values(db.getAt('dispatcher_alerts') || {}).filter((a) => !type || a.type === `payment_${type}`);

let pass = 0; const fails = [];
async function cell(name, kind, fn) { provider = { kind }; calls = 0; logged.length = 0; try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.log(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }
const vdeps = (db) => ({ db, client: realClient, alert: (k, d) => paymentAlert(db, k, d) });
const capturedAttempt = (over = {}) => ({ order_id: OID, hosted_order_id: HOID, status: 'captured', capture_verified: true, payment_uuid: 'PAY-1', ...over });

(async () => {
  // ── the REFUND RECONCILER: voidOrRefund exactly as refundReconciler calls it, on an aged refund_pending attempt ──
  for (const [kind, code] of [['decline', 'provider_declined'], ['http', 'provider_http_error'], ['throw', 'provider_unreachable']]) {
    await cell(`VS-RECONCILER-${kind.toUpperCase()}`, kind, async () => {
      const L = `VS-RECONCILER-${kind.toUpperCase()}`;
      const db = makeDb({ payment_attempts: { [AID]: capturedAttempt({ status: 'refund_pending' }) } });
      const r = await voidOrRefund(vdeps(db), { orderId: OID, attemptId: AID, pixelpayOrderId: HOID, paymentUuid: 'PAY-1', reason: 'xpizza_refund_retry', now: 5000 });
      assert.strictEqual(calls, 1, `${L}: PREMISE — the provider was called once`);
      assert.ok(r.voided === false && r.code === code && FIXED.has(r.message), `${L}: the result carries the fixed message and code ${code} (got ${JSON.stringify(r)})`);
      const rec = records(db)[0];
      assert.ok(rec && rec.code === code && FIXED.has(rec.message) && rec.provider_code === (kind === 'throw' ? 'none' : 'unknown'), `${L}: the audit record: fixed message, code, allowlisted provider code (got ${JSON.stringify(rec)})`);
      const att = db.getAt(`payment_attempts/${AID}`);
      assert.ok(att.status === 'refund_pending' && FIXED.has(att.refund_message) && att.refund_code === code, `${L}: the attempt (got ${JSON.stringify({ s: att.status, m: att.refund_message, c: att.refund_code })})`);
      const al = alerts(db, 'refund_pending')[0];
      assert.ok(al && al.detail.code === code && FIXED.has(al.detail.message), `${L}: the refund_pending alert (got ${JSON.stringify(al && al.detail)})`);
      clean(L, db);
    });
  }
  await cell('VS-RECONCILER-OK', 'ok', async () => {
    const L = 'VS-RECONCILER-OK';
    const db = makeDb({ payment_attempts: { [AID]: capturedAttempt({ status: 'refund_pending' }) } });
    const r = await voidOrRefund(vdeps(db), { orderId: OID, attemptId: AID, pixelpayOrderId: HOID, paymentUuid: 'PAY-1', reason: 'xpizza_refund_retry', now: 5000 });
    assert.ok(r.voided === true && r.code === 'voided' && r.message === 'void confirmed', `${L}: a confirmed void reads 'void confirmed' (got ${JSON.stringify(r)})`);
    assert.strictEqual(db.getAt(`payment_attempts/${AID}/status`), 'refunded', `${L}: PREMISE — refunded`);
    clean(L, db);
  });
  await cell('VS-NO-UUID-FIXED', 'decline', async () => {
    const L = 'VS-NO-UUID-FIXED';
    const db = makeDb({ payment_attempts: { [AID]: { order_id: OID, status: 'pending' } } });
    const r = await voidOrRefund(vdeps(db), { orderId: OID, attemptId: AID, pixelpayOrderId: HOID, paymentUuid: null, reason: 'x', now: 5000 });
    assert.ok(calls === 0 && r.code === 'no_payment_to_void' && r.message === 'no payment to void', `${L}: (got ${JSON.stringify(r)})`);
  });
  await cell('VS-AUDIT-WRITE-FAILURE-FIXED', 'decline', async () => {
    const L = 'VS-AUDIT-WRITE-FAILURE-FIXED';
    const db = makeDb({ payment_attempts: { [AID]: capturedAttempt({ status: 'refund_pending' }) } },
      { beforeWrite: async (p) => { if (p.startsWith('refund_attempts/')) throw new Error(`write failed at /refund_attempts ${HOSTILE_TEXT}`); } });
    await voidOrRefund(vdeps(db), { orderId: OID, attemptId: AID, pixelpayOrderId: HOID, paymentUuid: 'PAY-1', reason: 'x', now: 5000 });
    const al = alerts(db, 'refund_audit_write_failed')[0];
    assert.ok(al && al.detail.error === 'audit_write_failed', `${L}: the alert carries a fixed error code (got ${JSON.stringify(al && al.detail)})`);
    clean(L, db);
  });

  // ── the dispatcher CANCEL path: cancelOrderCore on a captured online order ──
  await cell('VS-CANCEL-PATH-HOSTILE', 'decline', async () => {
    const L = 'VS-CANCEL-PATH-HOSTILE';
    const db = makeDb({ orders: { [OID]: { order_id: OID, status: 'new', payment_method: 'online', payment_status: 'confirmed', active_attempt_id: AID, total: 299, total_cents: 29900 } },
      payment_attempts: { [AID]: capturedAttempt() } });
    const r = await cancelOrderCore({ db, client: realClient, voidOrRefund, alert: (k, d) => paymentAlert(db, k, d), serverTimestamp: 0 }, { orderId: OID, actor: 'disp@tb', reason: 'customer', now: 5000, claimId: 'CL1' });
    assert.strictEqual(calls, 1, `${L}: PREMISE — the cancel path called the provider (got ${calls}; ${JSON.stringify(r && r.body)})`);
    assert.ok(alerts(db, 'refund_pending').length === 1, `${L}: PREMISE — the declined void raised refund_pending`);
    clean(L, db);
  });

  // ── the hosted FIRST-PAYMENT void: a verified paid callback on a cancelled order ──
  await cell('VS-FIRST-PAYMENT-VOID-HOSTILE', 'decline', async () => {
    const L = 'VS-FIRST-PAYMENT-VOID-HOSTILE';
    const db = makeDb({ orders: { [OID]: { order_id: OID, order_type: 'pickup', status: 'cancelled', payment_status: 'pending', payment_method: 'online', total: 299, total_cents: 29900, active_attempt_id: AID } },
      payment_attempts: { [AID]: { order_id: OID, hosted_state: 'created', hosted_order_id: HOID } } });
    const deps = { db, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, alert: (k, d) => paymentAlert(db, k, d), genToken: () => 'TOK', client: realClient, voidOrRefund };
    const r = await handleHostedCallback(deps, { order: HOID, status: 'paid', amount: 299, uuid: 'PAY-1', transaction_id: 'TXN-1', payment_hash: paymentHash(HOID, KEY, SECRET) }, 5000);
    assert.ok(calls === 1 && r.outcome === 'cancelled_refund_pending', `${L}: PREMISE — the first payment's void was attempted and declined (got ${r.outcome}, calls ${calls})`);
    clean(L, db);
  });

  // ── the legacy CAPTURE decline (confirmOnlinePayment → the authenticated confirm response's `detail`): the DECISION is
  //    unchanged (capture_failed, attempt declined, order failed); only the provider's text is replaced ──
  const { confirmOnlinePayment } = require('./pixelpay-confirm');
  const pending = () => ({ orders: { [OID]: { order_id: OID, order_type: 'pickup', pickup_time: 'standard', customer_name: 'T', customer_phone: '50400000000', items_text: 'x', total: 299, total_cents: 29900,
    payment_method: 'online', payment_status: 'pending', status: 'pending_payment', active_attempt_id: AID, created_at: 1 } },
    payment_attempts: { [AID]: { order_id: OID, status: 'active', total_cents: 29900, pixelpay_order_id: HOID, created_at: 1 } } });
  const cdeps = (db) => ({ db, client: realClient, restaurant: { lat: 15.5, lng: -88, name: 'TB', phone: 'p' }, buildMaterializeUpdates, voidOrRefund, staleMs: 90000, alert: (k, d) => paymentAlert(db, k, d) });
  for (const [label, captureHttp, code, message] of [['DECLINE', 402, 'capture_declined', 'capture declined by the provider'], ['412-NOT-PAID', 412, 'capture_not_found', 'capture not found']]) {
    await cell(`VS-CAPTURE-${label}-HOSTILE`, 'decline', async () => {
      const L = `VS-CAPTURE-${label}-HOSTILE`;
      provider.captureHttp = captureHttp; provider.status = 'authorized';
      const db = makeDb(pending());
      const r = await confirmOnlinePayment(cdeps(db), { orderId: OID, paymentUuid: 'PAY-1', now: 5000, trackingToken: 'TOK' });
      assert.ok(calls === 1 && r.outcome === 'capture_failed', `${L}: PREMISE/DECISION — one capture, capture_failed (got ${r.outcome}, calls ${calls})`);
      assert.ok(db.getAt(`payment_attempts/${AID}/status`) === 'declined' && db.getAt(`orders/${OID}/payment_status`) === 'failed', `${L}: the decision is unchanged: attempt declined, order failed`);
      assert.strictEqual(r.message, message, `${L}: the result (→ the legacy confirm response's detail) carries the fixed message`);
      const a = db.getAt(`payment_attempts/${AID}`);
      assert.ok(a.decline_message === message && a.decline_code === code && a.provider_code === 'unknown', `${L}: the attempt records fixed text + code + allowlisted provider code (got ${JSON.stringify({ m: a.decline_message, c: a.decline_code, p: a.provider_code })})`);
      clean(L, db);
    });
  }

  console.warn = realWarn; console.error = realErr;
  console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\npixelpay-void-sanitize: OK (${pass})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.warn = realWarn; console.log('TEST FAILED:', e && e.message); process.exit(1); });
